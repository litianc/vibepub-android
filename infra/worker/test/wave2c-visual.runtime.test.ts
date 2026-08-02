import { describe, expect, it } from "vitest";
import { env as runtimeEnv } from "cloudflare:test";
import {
  ACTIVE_VISUAL_PINS,
  BODY_PROJECT_ADAPTER_MANIFEST,
  COVER_PROJECT_ADAPTER_MANIFEST,
  buildVisualPlan,
  decodeVisualPinSnapshot,
  encodeVisualPinSnapshot,
  makeVisualArtifactObject,
  normalizeVisualArtifact,
  visualBinaryKey,
  deriveVisualImageOperationKey,
  type VisualArtifactObject,
  type VisualPlanPayload,
} from "../src/wave2/visualContracts";
import { canonicalJson } from "../src/wave2/artifactContracts";
import {
  BinaryImageStoreError,
  MAX_PROVIDER_BASE64_CHARS,
  normalizePngWithImagesBinding,
  normalizePngToExactDimensions,
  putImmutableBinaryImage,
  readExistingImmutableBinaryImage,
  verifyPngOpaqueCoverage,
  verifyPngOpaqueCoverageWithImagesBinding,
  verifyPngWhiteBackground,
  verifyPngWhiteBackgroundWithImagesBinding,
} from "../src/wave2/binaryImageStore";
import { callVisualImageService, callVisualPlanService, reconcileVisualImageService, type VisualImageServiceEnv } from "../src/wave2/visualServiceClients";
import { putImmutableVisualArtifact, VisualArtifactStoreError } from "../src/wave2/visualArtifactStore";

const USER = "visual_user";
const WORKSPACE = "visual_workspace";
const RUN = "visual_run";
const FROZEN_HASH = "sha256:" + "a".repeat(64);

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function visualSlotSeed(slot: VisualPlanPayload["slots"][number], frozenHash = FROZEN_HASH): Promise<string> {
  return `visual_${(await hash(canonicalJson({
    run_id: RUN,
    frozen_hash: frozenHash,
    slot_id: slot.slot_id,
    prompt_hash: slot.prompt_hash,
    model: ACTIVE_VISUAL_PINS.model,
    adapter: ACTIVE_VISUAL_PINS.adapter,
    skills: { cover: ACTIVE_VISUAL_PINS.cover_skill, body: ACTIVE_VISUAL_PINS.body_skill },
    style: ACTIVE_VISUAL_PINS.cover_style,
  }))).slice(7, 31)}`;
}

async function frozen(body: string, blockCount: number): Promise<any> {
  const blocks = await Promise.all(Array.from({ length: blockCount }, async (_, index) => {
    const text = `合成段落 ${index + 1}`;
    return {
      block_id: `block_${index + 1}`,
      kind: "paragraph",
      order: index,
      text,
      text_hash: await hash(text),
      claim_ids: [],
      image_ref_ids: [],
    };
  }));
  return {
    article_id: "visual_article",
    run_id: RUN,
    recording_id: 7,
    version: 1,
    title: "合成视觉标题",
    body,
    blocks,
    title_candidates: ["合成视觉标题"],
    selected_title: "合成视觉标题",
    cover_title: ["合成视觉标题"],
    claim_ledger: [],
    content_hash: FROZEN_HASH,
    formatting_skill: { id: "md_to_wechat", version: "1.0.0" },
    profile_pins: { style: { id: "style_litianc_default", version: "2026-07-05" }, formatting: { id: "md_to_wechat", version: "1.0.0" } },
    immutable: true,
    frozen_at: "2026-07-20T00:00:00.000Z",
    html_hash: null,
  };
}

class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  failPut = false;
  writeThenFail = false;
  failArrayBuffer = false;

  async head(key: string): Promise<any> {
    const value = this.objects.get(key);
    return value ? { size: value.bytes.byteLength, customMetadata: { ...value.metadata } } : null;
  }

  async get(key: string): Promise<any> {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      customMetadata: { ...value.metadata },
      arrayBuffer: async () => {
        if (this.failArrayBuffer) throw new Error("body read lost");
        return value.bytes.slice().buffer;
      },
    };
  }

  async put(key: string, bytes: Uint8Array, options: any): Promise<any> {
    if (this.failPut) throw new Error("put outcome unknown");
    if (this.objects.has(key)) return null;
    this.objects.set(key, { bytes: new Uint8Array(bytes), metadata: { ...(options.customMetadata || {}) } });
    if (this.writeThenFail) throw new Error("write response lost");
    return { size: bytes.byteLength, customMetadata: options.customMetadata };
  }
}

function pngFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  let crc = 0xffffffff;
  for (const byte of bytes.slice(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

async function rgbaPngFixture(
  width: number,
  height: number,
  alpha: number,
  colorType: 2 | 6 = 6,
  pixel?: (x: number, y: number) => readonly [number, number, number, number],
  rawOverride?: Uint8Array,
): Promise<Uint8Array> {
  const channels = colorType === 2 ? 3 : 4;
  const rowLength = width * channels + 1;
  const raw = rawOverride ?? new Uint8Array(rowLength * height);
  if (!rawOverride) {
    for (let y = 0; y < height; y += 1) {
      raw[y * rowLength] = 0;
      for (let x = 0; x < width; x += 1) {
        const offset = y * rowLength + 1 + x * channels;
        const value = pixel?.(x, y) ?? [255, 255, 255, alpha];
        raw[offset] = value[0]; raw[offset + 1] = value[1]; raw[offset + 2] = value[2];
        if (colorType === 6) raw[offset + 3] = value[3];
      }
    }
  }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type);
    const value = new Uint8Array(12 + data.byteLength);
    const view = new DataView(value.buffer);
    view.setUint32(0, data.byteLength); value.set(typeBytes, 4); value.set(data, 8);
    view.setUint32(8 + data.byteLength, crc32(value.slice(4, 8 + data.byteLength)));
    return value;
  };
  const ihdr = new Uint8Array(13); const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr.set([8, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

async function decodeEncodedRgbaFixture(bytes: Uint8Array): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      if (bytes[dataStart + 8] !== 8 || bytes[dataStart + 9] !== 6) throw new Error("expected encoded RGBA fixture");
    } else if (type === "IDAT") {
      idat.push(bytes.slice(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  const compressed = new Uint8Array(idat.reduce((sum, item) => sum + item.byteLength, 0));
  let cursor = 0;
  for (const item of idat) { compressed.set(item, cursor); cursor += item.byteLength; }
  const raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const rowBytes = width * 4;
  if (!width || !height || raw.byteLength !== height * (rowBytes + 1)) throw new Error("invalid encoded RGBA fixture");
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (rowBytes + 1)] !== 1) throw new Error("expected Sub-filtered RGBA fixture");
    for (let x = 0; x < rowBytes; x += 1) {
      const target = y * rowBytes + x;
      const left = x >= 4 ? pixels[target - 4] : 0;
      pixels[target] = (raw[y * (rowBytes + 1) + x + 1] + left) & 255;
    }
  }
  return { width, height, pixels };
}

async function visualObject(plan: VisualPlanPayload, kind: "visual_plan" | "visual_asset" | "visual_qa_report", payload: any, inputIds: string[], key: string, binaryStorageRef?: string): Promise<VisualArtifactObject> {
  const object = await makeVisualArtifactObject({
    kind,
    payload,
    user_id: USER,
    workspace_id: WORKSPACE,
    input_artifact_ids: inputIds,
    idempotency_key: key,
    created_at: "2026-07-20T00:00:00.000Z",
    binary_storage_ref: binaryStorageRef,
  });
  return normalizeVisualArtifact({ ...object.envelope, payload: object.payload });
}

describe("Wave2C visual planning and immutable contracts", () => {
  it("uses Unicode code points and deterministic normal/long slot counts", async () => {
    const normal = await buildVisualPlan({ frozen: await frozen("😀".repeat(4999), 2), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_normal", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" });
    expect(normal.mode).toBe("normal");
    expect(normal.body_code_point_count).toBe(4999);
    expect(normal.slots).toHaveLength(3);
    const boundary = await buildVisualPlan({ frozen: await frozen("😀".repeat(5000), 5), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_long", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" });
    expect(boundary.mode).toBe("long");
    expect(boundary.body_code_point_count).toBe(5000);
    expect(boundary.slots).toHaveLength(6);
    expect(await buildVisualPlan({ frozen: await frozen("😀".repeat(5000), 5), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_long", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" })).toEqual(boundary);
    expect(1 + boundary.slots.length + 1).toBe(8);
  });

  it("compiles every frozen manifest field and section into deterministic prompts", async () => {
    const plan = await buildVisualPlan({ frozen: await frozen("short", 2), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_manifest", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" });
    const sections = ["output_contract", "immutable_input", "style_pins", "content", "slot_binding", "composition", "color_material", "text_policy", "negative_constraints", "final_check"];
    for (const slot of plan.slots) {
      const positions = sections.map(section => slot.prompt.indexOf(`[${section}]\n`));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect([...positions].sort((left, right) => left - right)).toEqual(positions);
      expect(slot.prompt).toContain('"output_count":1');
      expect(slot.prompt).toContain('"random_style_extension":"forbidden"');
      expect(slot.prompt).toContain('"prompt_serialization":"canonical_utf8_v1"');
      expect(slot.prompt).toContain('"version":"1.0.0"');
      expect(slot.prompt).toContain('"version_source":"project_adapter_manifest"');
    }
    expect(plan.slots[0].prompt).toContain(COVER_PROJECT_ADAPTER_MANIFEST.style.id);
    expect(plan.slots[1].prompt).toContain(BODY_PROJECT_ADAPTER_MANIFEST.subject.appearance);
    expect(plan.slots[1].prompt).toContain(plan.slots[1].content.concrete_action);
  });

  it("rejects a deleted manifest rule even when the caller recomputes prompt and slot hashes", async () => {
    const plan = await buildVisualPlan({ frozen: await frozen("short", 2), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_manifest_drift", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" });
    const drifted = structuredClone(plan);
    const slot = drifted.slots[1];
    slot.prompt = slot.prompt.replace('"random_style_extension":"forbidden",', "");
    slot.prompt_hash = await hash(slot.prompt);
    slot.slot_seed = await visualSlotSeed(slot);
    slot.idempotency_key = slot.slot_seed;
    await expect(visualObject(drifted, "visual_plan", drifted, ["frozen_manifest_drift"], "visual-plan:manifest-drift"))
      .rejects.toMatchObject({ code: "visual_slot_conflict" });
  });

  it("encodes a complete canonical D1 visual pin snapshot and rejects nested drift", () => {
    const snapshot = encodeVisualPinSnapshot();
    expect(decodeVisualPinSnapshot(snapshot)).toEqual(ACTIVE_VISUAL_PINS);
    const drifted = JSON.parse(snapshot) as Record<string, any>;
    drifted.body_skill.version_source = "caller_claim";
    expect(() => decodeVisualPinSnapshot(canonicalJson(drifted))).toThrowError(/visual pins are not active/);
    const extra = JSON.parse(snapshot) as Record<string, any>;
    extra.provider_endpoint = "forbidden";
    expect(() => decodeVisualPinSnapshot(canonicalJson(extra))).toThrowError(/visual pins are not active/);
  });

  it("rejects insufficient unique blocks before a plan or image call", async () => {
    await expect(buildVisualPlan({ frozen: await frozen("short", 1), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_short", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" })).rejects.toMatchObject({ code: "visual_plan_insufficient_unique_blocks" });
  });

  it("rejects plan-hash, slot, visible-text, and evidence drift before storage", async () => {
    const planPayload = await buildVisualPlan({ frozen: await frozen("short", 2), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_drift", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" });
    const plan = await visualObject(planPayload, "visual_plan", planPayload, ["frozen_drift"], "visual-plan:drift");
    const slot = planPayload.slots[1];
    const binaryKey = visualBinaryKey(USER, WORKSPACE, RUN, FROZEN_HASH, slot.slot_id);
    const imageOperationId = await deriveVisualImageOperationKey(RUN, FROZEN_HASH, plan.envelope.payload_hash, slot.slot_id, slot.prompt_hash);
    const assetPayload = {
      protocol_version: "visual_asset.v2", article_id: "visual_article", run_id: RUN, recording_id: 7,
      frozen_artifact_id: "frozen_drift", frozen_payload_hash: FROZEN_HASH, plan_artifact_id: plan.envelope.artifact_id, plan_payload_hash: plan.envelope.payload_hash,
      slot_id: slot.slot_id, order: slot.order, purpose: slot.purpose, aspect_ratio: slot.aspect_ratio, block_id: slot.block_id, block_text_hash: slot.block_text_hash,
      binary_storage_ref: `r2://${binaryKey}`, byte_hash: await hash("png"), byte_length: 33, mime: "image/png", width: slot.width, height: slot.height,
      prompt_hash: slot.prompt_hash, model_version: "gpt-image-2", adapter_version: "visual-generation.adapter.1.0.0", pins: ACTIVE_VISUAL_PINS,
      visible_text: [], visible_text_evidence: "prompt_contract", white_background_verified: true, created_at: "2026-07-20T00:00:00.000Z",
    };
    await expect(visualObject(planPayload, "visual_asset", { ...assetPayload, plan_payload_hash: "sha256:" + "f".repeat(64) }, ["frozen_drift", plan.envelope.artifact_id], imageOperationId, `r2://${binaryKey}`)).rejects.toMatchObject({ code: "visual_slot_conflict" });
    await expect(visualObject(planPayload, "visual_asset", { ...assetPayload, slot_id: "body_99" }, ["frozen_drift", plan.envelope.artifact_id], imageOperationId, `r2://${binaryKey}`)).rejects.toMatchObject({ code: "visual_asset_contract_invalid" });
    await expect(visualObject(planPayload, "visual_asset", { ...assetPayload, purpose: undefined }, ["frozen_drift", plan.envelope.artifact_id], imageOperationId, `r2://${binaryKey}`)).rejects.toMatchObject({ code: "visual_asset_contract_invalid" });
    await expect(visualObject(planPayload, "visual_asset", { ...assetPayload, purpose: "other" }, ["frozen_drift", plan.envelope.artifact_id], imageOperationId, `r2://${binaryKey}`)).rejects.toMatchObject({ code: "visual_asset_contract_invalid" });
    await expect(visualObject(planPayload, "visual_asset", { ...assetPayload, visible_text_evidence: "ocr" }, ["frozen_drift", plan.envelope.artifact_id], imageOperationId, `r2://${binaryKey}`)).rejects.toMatchObject({ code: "visual_asset_contract_invalid" });
    const invalidPlan = structuredClone(planPayload);
    delete (invalidPlan.slots[1] as Partial<(typeof invalidPlan.slots)[number]>).block_id;
    await expect(visualObject(invalidPlan, "visual_plan", invalidPlan, ["frozen_drift"], "visual-plan:missing-block")).rejects.toMatchObject({ code: "visual_slot_conflict" });
  });

  it("binds plan, one asset per slot, and QA to exact parents and pins", async () => {
    const planPayload = await buildVisualPlan({ frozen: await frozen("short", 2), user_id: USER, workspace_id: WORKSPACE, frozen_artifact_id: "frozen_a", frozen_payload_hash: FROZEN_HASH, created_at: "2026-07-20T00:00:00.000Z" });
    const plan = await visualObject(planPayload, "visual_plan", planPayload, ["frozen_a"], "visual-plan:key");
    expect(plan.envelope.schema_version).toBe("editorial-wave2c.v1");
    expect(plan.envelope.producer.role).toBe("visual_production");
    const jsonBucket = new FakeBucket();
    await expect(putImmutableVisualArtifact(jsonBucket as any, plan)).resolves.toMatchObject({ status: "created" });
    await expect(putImmutableVisualArtifact(jsonBucket as any, plan)).resolves.toMatchObject({ status: "replayed" });
    const jsonUnknown = new FakeBucket();
    jsonUnknown.failPut = true;
    await expect(putImmutableVisualArtifact(jsonUnknown as any, plan)).rejects.toMatchObject({ code: "visual_artifact_reconciliation_required", status: 503 } satisfies Partial<VisualArtifactStoreError>);
    const jsonLost = new FakeBucket();
    jsonLost.writeThenFail = true;
    await expect(putImmutableVisualArtifact(jsonLost as any, plan)).resolves.toMatchObject({ status: "replayed" });
    const slot = planPayload.slots[0];
    const binaryKey = visualBinaryKey(USER, WORKSPACE, RUN, FROZEN_HASH, slot.slot_id);
    const assetPayload = {
      protocol_version: "visual_asset.v2", article_id: "visual_article", run_id: RUN, recording_id: 7,
      frozen_artifact_id: "frozen_a", frozen_payload_hash: FROZEN_HASH, plan_artifact_id: plan.envelope.artifact_id, plan_payload_hash: plan.envelope.payload_hash,
      slot_id: slot.slot_id, order: slot.order, purpose: slot.purpose, aspect_ratio: slot.aspect_ratio, block_id: slot.block_id, block_text_hash: slot.block_text_hash,
      binary_storage_ref: `r2://${binaryKey}`, byte_hash: await hash("png"), byte_length: 33, mime: "image/png", width: slot.width, height: slot.height,
      prompt_hash: slot.prompt_hash, model_version: "gpt-image-2", adapter_version: "visual-generation.adapter.1.0.0", pins: ACTIVE_VISUAL_PINS,
      visible_text: ["合成视觉标题"], visible_text_evidence: "prompt_contract", white_background_verified: true, created_at: "2026-07-20T00:00:00.000Z",
    };
    const imageOperationId = await deriveVisualImageOperationKey(RUN, FROZEN_HASH, plan.envelope.payload_hash, slot.slot_id, slot.prompt_hash);
    const asset = await visualObject(planPayload, "visual_asset", assetPayload, ["frozen_a", plan.envelope.artifact_id], imageOperationId, `r2://${binaryKey}`);
    expect(asset.envelope.binary_storage_ref).toBe(`r2://${binaryKey}`);
    await expect(visualObject(planPayload, "visual_asset", { ...assetPayload, binary_storage_ref: "r2://wrong" }, ["frozen_a", plan.envelope.artifact_id], imageOperationId, "r2://wrong")).rejects.toMatchObject({ code: "visual_asset_contract_invalid" });
    const qaPayload = {
      protocol_version: "visual_qa_report.v2", article_id: "visual_article", run_id: RUN, recording_id: 7,
      frozen_artifact_id: "frozen_a", frozen_payload_hash: FROZEN_HASH, plan_artifact_id: plan.envelope.artifact_id, plan_payload_hash: plan.envelope.payload_hash,
      asset_artifact_ids: [asset.envelope.artifact_id], asset_byte_hashes: [assetPayload.byte_hash],
      checks: { ordered_slots: true, png_signature: true, dimensions: true, metadata: true, white_background: "verified", visible_text_pin: "evidence_only" },
      visible_text_evidence: "prompt_contract",
      passed: true, pins: ACTIVE_VISUAL_PINS, created_at: "2026-07-20T00:00:00.000Z",
    };
    await expect(visualObject(planPayload, "visual_qa_report", qaPayload, ["frozen_a", plan.envelope.artifact_id, asset.envelope.artifact_id], "visual-qa:key")).resolves.toBeDefined();
    await expect(visualObject(planPayload, "visual_qa_report", qaPayload, ["frozen_a", asset.envelope.artifact_id, plan.envelope.artifact_id], "visual-qa:key")).rejects.toMatchObject({ code: "visual_contract_invalid" });
  });

  it("keeps one immutable binary per slot and treats unknown writes as reconciliation", async () => {
    const bucket = new FakeBucket();
    const key = visualBinaryKey(USER, WORKSPACE, RUN, FROZEN_HASH, "body_01");
    const bytes = pngFixture(1536, 864);
    const expected = { mime: "image/png" as const, width: 1536, height: 864, user_id: USER, workspace_id: WORKSPACE, run_id: RUN, frozen_payload_hash: FROZEN_HASH, slot_id: "body_01" };
    await expect(putImmutableBinaryImage(bucket as any, key, bytes, expected)).resolves.toMatchObject({ status: "created" });
    await expect(putImmutableBinaryImage(bucket as any, key, bytes, expected)).resolves.toMatchObject({ status: "replayed" });
    await expect(putImmutableBinaryImage(bucket as any, key, new Uint8Array([...bytes, 1]), expected)).rejects.toMatchObject({ code: "binary_conflict" });
    const existing = await readExistingImmutableBinaryImage(bucket as any, key, { user_id: USER, workspace_id: WORKSPACE, run_id: RUN, frozen_payload_hash: FROZEN_HASH, slot_id: "body_01" });
    expect(existing?.metadata.byte_length).toBe(bytes.byteLength);
    const unknown = new FakeBucket();
    unknown.failPut = true;
    await expect(putImmutableBinaryImage(unknown as any, key, bytes, expected)).rejects.toMatchObject({ code: "binary_reconciliation_required", status: 503 } satisfies Partial<BinaryImageStoreError>);
    bucket.failArrayBuffer = true;
    await expect(readExistingImmutableBinaryImage(bucket as any, key, { user_id: USER, workspace_id: WORKSPACE, run_id: RUN, frozen_payload_hash: FROZEN_HASH, slot_id: "body_01" })).rejects.toMatchObject({ code: "binary_reconciliation_required", status: 503 });
    expect(await verifyPngOpaqueCoverage(new Uint8Array([137, 80, 78, 71]), 1536, 864)).toBe(false);
    expect(await verifyPngWhiteBackground(new Uint8Array([137, 80, 78, 71]), 1536, 864)).toBe(false);
    const nearTransparent = await rgbaPngFixture(2, 2, 1);
    expect(await verifyPngOpaqueCoverage(nearTransparent, 2, 2)).toBe(false);
    expect(await verifyPngWhiteBackground(nearTransparent, 2, 2)).toBe(false);
    const illustratedNearWhite = await rgbaPngFixture(100, 100, 255, 6, (x, y) =>
      x >= 20 && x < 80 && y >= 20 && y < 80 ? [17, 17, 17, 255] : [252, 252, 252, 255]);
    expect(await verifyPngWhiteBackground(illustratedNearWhite, 100, 100)).toBe(true);
    const tintedBackground = await rgbaPngFixture(100, 100, 255, 6, (x, y) =>
      x >= 40 && x < 60 && y >= 40 && y < 60 ? [17, 17, 17, 255] : [238, 242, 246, 255]);
    expect(await verifyPngWhiteBackground(tintedBackground, 100, 100)).toBe(false);
    const whiteFrameAroundDarkCanvas = await rgbaPngFixture(100, 100, 255, 6, (x, y) =>
      x >= 5 && x < 95 && y >= 5 && y < 95 ? [32, 64, 96, 255] : [255, 255, 255, 255]);
    expect(await verifyPngWhiteBackground(whiteFrameAroundDarkCanvas, 100, 100)).toBe(false);
  });

  it("fits only bounded or approved provider canvases without cropping or stretching", async () => {
    const source = await rgbaPngFixture(3, 3, 255, 2);
    const normalized = await normalizePngToExactDimensions(source, 4, 4);
    expect(normalized).not.toBe(source);
    expect(await verifyPngOpaqueCoverage(normalized, 4, 4)).toBe(true);
    expect(await normalizePngToExactDimensions(normalized, 4, 4)).toEqual(normalized);

    const fixedProviderCanvas = await rgbaPngFixture(1536, 1024, 255, 6, (x, y) => {
      if (x < 16) return y < 512 ? [255, 0, 0, 255] : [255, 0, 0, 0];
      if (x >= 504 && x < 520) return [0, 255, 0, 255];
      if (x >= 1520) return [0, 0, 255, 255];
      return [255, 255, 255, 255];
    });
    const wideCover = await normalizePngToExactDimensions(fixedProviderCanvas, 2256, 960, { backgroundRgb: [0xde, 0xd9, 0xcf], padding: "edge" });
    const cover = await decodeEncodedRgbaFixture(wideCover);
    const coverPixel = (x: number, y: number) => Array.from(cover.pixels.slice((y * cover.width + x) * 4, (y * cover.width + x) * 4 + 4));
    expect([cover.width, cover.height]).toEqual([2256, 960]);
    expect(coverPixel(0, 100)).toEqual([255, 0, 0, 255]);
    expect(coverPixel(408, 100)).toEqual([255, 0, 0, 255]);
    expect(coverPixel(888, 100)).toEqual([0, 255, 0, 255]);
    expect(coverPixel(2255, 100)).toEqual([0, 0, 255, 255]);
    expect(coverPixel(0, 800)).toEqual([0xde, 0xd9, 0xcf, 255]);
    expect(cover.pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);

    const body = await normalizePngToExactDimensions(fixedProviderCanvas, 1536, 864, { backgroundRgb: [255, 255, 255], padding: "solid" });
    const bodyPixels = await decodeEncodedRgbaFixture(body);
    const bodyPixel = (x: number, y: number) => Array.from(bodyPixels.pixels.slice((y * bodyPixels.width + x) * 4, (y * bodyPixels.width + x) * 4 + 4));
    expect(bodyPixel(0, 100)).toEqual([255, 255, 255, 255]);
    expect(bodyPixel(120, 100)).toEqual([255, 0, 0, 255]);
    expect(await verifyPngWhiteBackground(body, 1536, 864)).toBe(true);

    await expect(normalizePngToExactDimensions(await rgbaPngFixture(6, 6, 255, 2), 9, 4)).rejects.toMatchObject({ code: "binary_readback_mismatch" });
    await expect(normalizePngToExactDimensions(await rgbaPngFixture(2, 2, 255), 4, 4)).rejects.toMatchObject({ code: "binary_readback_mismatch" });
    await expect(normalizePngToExactDimensions(pngFixture(2700, 1149), 2256, 960)).rejects.toMatchObject({ code: "binary_readback_mismatch" });
    await expect(normalizePngToExactDimensions(new Uint8Array(8 * 1024 * 1024 + 1), 2256, 960)).rejects.toMatchObject({ code: "binary_readback_mismatch" });
    const inflateBomb = await rgbaPngFixture(3, 3, 255, 6, undefined, new Uint8Array(1024));
    await expect(normalizePngToExactDimensions(inflateBomb, 4, 4)).rejects.toMatchObject({ code: "binary_readback_mismatch" });
  });

  it("normalizes and samples provider canvases through the Cloudflare Images binding", async () => {
    const bodySource = await rgbaPngFixture(1536, 864, 255, 6, (x, y) =>
      x >= 400 && x < 1100 && y >= 250 && y < 650 ? [17, 17, 17, 255] : [255, 255, 255, 255]);
    const body = await normalizePngWithImagesBinding(runtimeEnv.IMAGES, bodySource, 1536, 864, { backgroundRgb: [255, 255, 255], padding: "solid" });
    expect(await verifyPngWhiteBackgroundWithImagesBinding(runtimeEnv.IMAGES, body, 1536, 864)).toBe(true);
    const coverSource = await rgbaPngFixture(1800, 766, 255, 6, (x, y) =>
      x >= 400 && x < 1400 && y >= 150 && y < 620 ? [17, 17, 17, 255] : [0xde, 0xd9, 0xcf, 255]);
    const cover = await normalizePngWithImagesBinding(runtimeEnv.IMAGES, coverSource, 2256, 960, { backgroundRgb: [0xde, 0xd9, 0xcf], padding: "edge" });
    expect(await verifyPngOpaqueCoverageWithImagesBinding(runtimeEnv.IMAGES, cover, 2256, 960)).toBe(true);
  });
});

describe("Wave2C controlled image service boundary", () => {
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("uses the dedicated binding token and rejects an unconfigured call before fetch", async () => {
    let auth = "";
    const binding: Fetcher = { fetch: async request => { auth = request.headers.get("authorization") || ""; return response(200, { protocol_version: "vibepub.visual.v3", operation: "plan", operation_id: "plan-1", attempt: 1, result: { adapter_version: "visual-generation.adapter.1.0.0", model_version: "gpt-image-2", prompt_hash: await hash(JSON.stringify(["sha256:slot"])) } }); } };
    await expect(callVisualPlanService({ IMAGE_GENERATION_ADAPTER: binding, VISUAL_PRODUCTION_TOKEN: "visual-token" }, { operation_id: "plan-1", attempt: 1, plan: { slots: [{ prompt_hash: "sha256:slot" }] } })).resolves.toMatchObject({ result: { model_version: "gpt-image-2" }, attempt: 1 });
    expect(auth).toBe("Bearer visual-token");
    let calls = 0;
    const noToken: VisualImageServiceEnv = { IMAGE_GENERATION_ADAPTER: { fetch: async () => { calls += 1; return response(200, {}); } } };
    await expect(callVisualPlanService(noToken, { operation_id: "plan-2" })).rejects.toMatchObject({ code: "service_unconfigured", retryable: false });
    expect(calls).toBe(0);
    await expect(callVisualImageService({ VISUAL_PRODUCTION_TOKEN: "visual-token" }, { operation_id: "image-no-binding", attempt: 1, prompt: "synthetic", size: "1536x864" })).rejects.toMatchObject({ code: "service_unconfigured", retryable: false });
  });

  it("rejects an oversized adapter base64 result before workflow decoding", async () => {
    const prompt = "synthetic";
    const binding: Fetcher = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocol_version: "vibepub.visual.v3",
          operation: "image",
          operation_id: "image-oversized",
          attempt: 1,
          result: {
            adapter_version: "visual-generation.adapter.1.0.0",
            model_version: "gpt-image-2",
            prompt_hash: await hash(prompt),
            b64_json: "A".repeat(MAX_PROVIDER_BASE64_CHARS + 1),
          },
        }),
      } as Response),
    };
    await expect(callVisualImageService({ IMAGE_GENERATION_ADAPTER: binding, VISUAL_PRODUCTION_TOKEN: "visual-token" }, { operation_id: "image-oversized", attempt: 1, prompt, size: "1536x864" })).rejects.toMatchObject({ code: "service_invalid_response", retryable: false });
  });

  it.each([[408, true], [429, true], [500, false], [502, false], [503, false], [504, true]])("classifies visual adapter status %s without using body to upgrade retryability", async (status, retryable) => {
    const env: VisualImageServiceEnv = { IMAGE_GENERATION_ADAPTER: { fetch: async () => response(status, { error: { code: status === 504 ? "upstream_timeout" : "unknown", retryable: true } }) }, VISUAL_PRODUCTION_TOKEN: "visual-token" };
    await expect(callVisualImageService(env, { operation_id: "image-1", attempt: 1, prompt: "synthetic", size: "1536x864" })).rejects.toMatchObject({ status, retryable });
  });

  it("uses a read-only reconcile request for an inflight operation without changing its operation identity", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let providerLikeCalls = 0;
    const binding: Fetcher = { fetch: async request => {
      requestBody = await request.json() as Record<string, unknown>;
      providerLikeCalls += 1;
      return response(200, {
        protocol_version: "vibepub.visual.v3",
        operation: "image",
        operation_id: "inflight-image",
        attempt: 1,
        result: { adapter_version: "visual-generation.adapter.1.0.0", model_version: "gpt-image-2", prompt_hash: await hash("synthetic prompt"), b64_json: "stored-result" },
      });
    } };
    await expect(reconcileVisualImageService({ IMAGE_GENERATION_ADAPTER: binding, VISUAL_PRODUCTION_TOKEN: "visual-token" }, {
      operation_id: "inflight-image", attempt: 1, prompt: "synthetic prompt", size: "1536x864",
    })).resolves.toMatchObject({ operation_id: "inflight-image", attempt: 1 });
    expect(requestBody).toMatchObject({ operation_id: "inflight-image", attempt: 1, reconcile_only: true });
    expect(providerLikeCalls).toBe(1);
  });

  it("rejects HTTP or non-provider URL fallback and never accepts a user endpoint", async () => {
    await expect(callVisualPlanService({ VISUAL_PRODUCTION_TOKEN: "visual-token" }, { operation_id: "plan-3", attempt: 1, plan: { slots: [] } })).rejects.toMatchObject({ code: "service_unconfigured", retryable: false });
    await expect(callVisualPlanService({ VISUAL_PRODUCTION_TOKEN: "visual-token" }, { operation_id: "plan-4", attempt: 1, plan: { slots: [] } })).rejects.toMatchObject({ code: "service_unconfigured", retryable: false });
  });
});
