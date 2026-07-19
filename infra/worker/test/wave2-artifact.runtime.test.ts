import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  deriveArtifactId,
  normalizeArtifactEnvelope,
  revisionDispatchIdempotencyKey,
  sha256,
  toArtifactMetadata,
  type ArtifactObject,
} from "../src/wave2/artifactContracts";
import { ArtifactStoreError, putImmutableArtifact, readImmutableArtifact, toD1ArtifactMirror } from "../src/wave2/artifactStore";

class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  failPut = false;
  writeThenFail = false;
  failHead = false;
  failGet = false;
  failArrayBuffer = false;
  sizeOffset = 0;
  hideAfterPut = false;
  async head(key: string): Promise<any> {
    if (this.failHead) throw new Error("head unavailable");
    const value = this.objects.get(key);
    return value ? { size: value.bytes.byteLength + this.sizeOffset, customMetadata: value.metadata } : null;
  }
  async get(key: string): Promise<any> {
    if (this.failGet) throw new Error("get unavailable");
    const value = this.objects.get(key);
    if (!value || this.hideAfterPut) return null;
    return { customMetadata: value.metadata, arrayBuffer: async () => {
      if (this.failArrayBuffer) throw new Error("artifact body unavailable");
      return value.bytes.slice().buffer;
    } };
  }
  async put(key: string, value: Uint8Array, options: any): Promise<any> {
    if (this.failPut) throw new Error("simulated unknown write result");
    if (this.objects.has(key)) return null;
    this.objects.set(key, { bytes: new Uint8Array(value), metadata: options.customMetadata });
    if (this.writeThenFail) throw new Error("write committed before response was lost");
    return { size: value.byteLength, customMetadata: options.customMetadata };
  }
}

async function makeObject(body = "第一段", claimIds: string[] = [], claimLedger: Array<{ claim_id: string; block_id: string; classification: "author_view" | "source_fact" | "external_fact"; verification_status: "not_required" | "pending" | "verified" | "failed" }> = [], titleOptions: { titleCandidates?: string[]; selectedTitle?: string; coverTitle?: string[] } = {}): Promise<ArtifactObject> {
  const textHash = await sha256(body);
  const blocks = [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: body, text_hash: textHash, claim_ids: claimIds, image_ref_ids: [] }];
  const titleCandidates = titleOptions.titleCandidates ?? ["合成标题"];
  const selectedTitle = titleOptions.selectedTitle ?? "合成标题";
  const coverTitle = titleOptions.coverTitle ?? ["合成", "标题"];
  const payload = {
    article_id: "article_a", run_id: "run_a", recording_id: 1, revision: 1, parent_artifact_id: null, parent_review_artifact_id: null, parent_dispatch_artifact_id: null,
    title: "合成标题", body, blocks, title_candidates: titleCandidates, selected_title: selectedTitle, cover_title: coverTitle, adapter_version: "writing-v3.adapter.1.0.0", model_version: "glm-5.2", formatting_skill: { id: "md_to_wechat", version: "1.0.0" }, profile_pins: { style: { id: "writing-default", version: "1.0.0" }, formatting: { id: "md_to_wechat", version: "1.0.0" } }, style_profile_body_hash: await sha256("synthetic-style"), content_hash: await sha256(canonicalJson({ title: "合成标题", body, blocks })), claim_ledger: claimLedger, changed_block_ids: [], source_hash: await sha256("synthetic-source"),
  };
  const idempotencyKey = "draft:article_a:v1";
  const artifactId = await deriveArtifactId("article_draft", "run_a", idempotencyKey);
  return normalizeArtifactEnvelope({
    artifact_id: artifactId, kind: "article_draft", run_id: "run_a", article_id: "article_a", recording_id: 1, user_id: "user_a", workspace_id: "workspace_a", producer: { role: "writing", version: "writing.agent.v3" }, skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } }, input_artifact_ids: ["brief_a"], idempotency_key: idempotencyKey, created_at: "2026-07-20T00:00:00.000Z", payload,
  });
}

async function makeFrozen(options: { claimIds?: string[]; claimLedger?: Array<{ claim_id: string; block_id: string; classification: "author_view" | "source_fact" | "external_fact"; verification_status: "not_required" | "pending" | "verified" | "failed" }>; titleCandidates?: string[]; selectedTitle?: string; coverTitle?: string[]; profilePins?: Record<string, { id: string; version: string }>; htmlHash?: string | null } = {}): Promise<ArtifactObject> {
  const title = "合成冻结标题";
  const body = "冻结后的合成段落";
  const claimIds = options.claimIds ?? [];
  const blocks = [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: body, text_hash: await sha256(body), claim_ids: claimIds, image_ref_ids: [] }];
  const titleCandidates = options.titleCandidates ?? [title];
  const selectedTitle = options.selectedTitle ?? title;
  const coverTitle = options.coverTitle ?? ["合成冻结标题"];
  const payload = {
    article_id: "article_a", run_id: "run_a", recording_id: 1, version: 1, parent_artifact_id: null, draft_artifact_id: "draft_a", review_artifact_id: "review_a",
    title, body, blocks, title_candidates: titleCandidates, selected_title: selectedTitle, cover_title: coverTitle, claim_ledger: options.claimLedger ?? [], content_hash: await sha256(canonicalJson({ title, body, blocks })), formatting_skill: { id: "md_to_wechat", version: "1.0.0" }, html_hash: options.htmlHash ?? null, warnings: [], immutable: true, frozen_at: "2026-07-20T00:00:00.000Z", accepted_draft_payload_hash: await sha256("draft-payload"), accepted_review_payload_hash: await sha256("review-payload"), profile_pins: options.profilePins ?? { style: { id: "writing-default", version: "1.0.0" }, formatting: { id: "md_to_wechat", version: "1.0.0" } },
  };
  const idempotencyKey = "frozen:article_a:v1";
  return normalizeArtifactEnvelope({
    artifact_id: await deriveArtifactId("frozen_article_version", "run_a", idempotencyKey), kind: "frozen_article_version", run_id: "run_a", article_id: "article_a", recording_id: 1, user_id: "user_a", workspace_id: "workspace_a", producer: { role: "editorial_coordinator", version: "editorial-coordinator.agent.v3" }, skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } }, input_artifact_ids: ["draft_a", "review_a"], idempotency_key: idempotencyKey, created_at: "2026-07-20T00:00:00.000Z", payload,
  });
}

async function makeReviewObject(decision: "revise" | "block" = "revise"): Promise<ArtifactObject> {
  const evidenceText = "目标段落";
  const evidenceHash = await sha256(evidenceText);
  const payload = {
    article_id: "article_a", run_id: "run_a", recording_id: 1, input_artifact_id: "draft_a", input_payload_hash: await sha256("draft-payload"),
    review_round: 1, decision, findings: [{ finding_id: "finding_a", severity: "P1", code: "style_signal", target: "block_v1_1", evidence: { text_hash: evidenceHash, start: 0, end: evidenceText.length }, evidence_hash: evidenceHash, suggested_action: "rewrite", requires_human: false }],
    revision_targets: ["block_v1_1"], suggested_actions: ["rewrite"], reviewer_version: "editorial-review.adapter.1.0.0", rules_pins: { dbs_ai_check: { id: "dbs-ai-check", version: "1.0.0" }, humanizer: { id: "humanizer-zh", version: "1.0.0" } },
  };
  const idempotencyKey = "review:article_a:1";
  return normalizeArtifactEnvelope({
    artifact_id: await deriveArtifactId("review_report", "run_a", idempotencyKey), kind: "review_report", run_id: "run_a", article_id: "article_a", recording_id: 1, user_id: "user_a", workspace_id: "workspace_a", producer: { role: "editorial_review", version: "editorial-review.agent.v3" }, input_artifact_ids: ["draft_a"], idempotency_key: idempotencyKey, created_at: "2026-07-20T00:00:00.000Z", payload,
  });
}

async function makeBrief(style: { id: string; version: string }, body?: string): Promise<ArtifactObject> {
  const payload = {
    article_id: "article_a", run_id: "run_a", recording_id: 1, source_type: "text", language: "zh-CN", transcript_ref: "transcript_a", transcript_hash: await sha256("transcript"), source_hash: await sha256("source"), title_hint: null, content_goal: "合成测试", profile_pins: { style, formatting: { id: "md_to_wechat", version: "1.0.0" } }, ...(body === undefined ? {} : { style_profile_body: body, style_profile_body_hash: await sha256(body) }), block_strategy: "stable_block_v1",
  };
  const idempotencyKey = `brief:${style.id}`;
  return normalizeArtifactEnvelope({
    artifact_id: await deriveArtifactId("article_brief", "run_a", idempotencyKey), kind: "article_brief", run_id: "run_a", article_id: "article_a", recording_id: 1, user_id: "user_a", workspace_id: "workspace_a", producer: { role: "editorial_coordinator", version: "editorial-coordinator.agent.v3" }, input_artifact_ids: [], idempotency_key: idempotencyKey, created_at: "2026-07-20T00:00:00.000Z", payload,
  });
}

async function makeDispatch(producerPins = [{ id: "editorial_coordinator", version: "editorial-coordinator.agent.v3" }, { id: "writing", version: "writing.agent.v3" }, { id: "editorial_review", version: "editorial-review.agent.v3" }], target = ["block_v1_1"], targetBlockIds = target.filter(value => value !== "@title")): Promise<ArtifactObject> {
  const payload = {
    article_id: "article_a", run_id: "run_a", recording_id: 1, source_draft_artifact_id: "draft_a", source_draft_payload_hash: await sha256("draft"), source_review_artifact_id: "review_a", source_review_payload_hash: await sha256("review"), target_block_ids: targetBlockIds, target, issue_codes: ["rewrite"], protected_block_hashes: { block_v1_2: await sha256("second") }, revision_limit: 1, instruction_text: "只改第一段", workflow_version: "editorial-workflow.v3", policy_version: "editorial-policy.v3", producer_pins: producerPins,
  };
  const idempotencyKey = revisionDispatchIdempotencyKey("run_a", "review_a");
  return normalizeArtifactEnvelope({
    artifact_id: await deriveArtifactId("revision_dispatch", "run_a", idempotencyKey), kind: "revision_dispatch", run_id: "run_a", article_id: "article_a", recording_id: 1, user_id: "user_a", workspace_id: "workspace_a", producer: { role: "editorial_coordinator", version: "editorial-coordinator.agent.v3" }, input_artifact_ids: ["draft_a", "review_a"], idempotency_key: idempotencyKey, created_at: "2026-07-20T00:00:00.000Z", payload,
  });
}

function hasForbiddenMirrorField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenMirrorField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    ["payload", "title", "body", "text", "transcript", "instruction", "evidence"].includes(key)
      || hasForbiddenMirrorField(child));
}

describe("Wave 2A immutable R2 artifacts", () => {
  it("stores provenance separately and never mirrors text or payload to D1", async () => {
    const object = await makeObject();
    const metadata = toArtifactMetadata(object);
    const mirror = toD1ArtifactMirror(object);
    expect("payload" in metadata).toBe(false);
    expect(hasForbiddenMirrorField(mirror)).toBe(false);
    expect(JSON.stringify(mirror)).not.toContain("第一段");
    expect(mirror.input_artifact_ids_json).toBe('["brief_a"]');
    expect(mirror.skill_id).toBe("md_to_wechat");
  });

  it("uses deterministic canonical bytes and requires Coordinator time", async () => {
    const value = { "中文": "值", a: 2, "@title": "标题", A: 1, "é": "accent" };
    const bytes = canonicalJson(value);
    expect(bytes).toBe('{"@title":"标题","A":1,"a":2,"é":"accent","中文":"值"}');
    expect(await sha256(bytes)).toBe("sha256:9d0571a9957dfc769e97dd563e640a56f87b89c9281b1e73340ba9db3b2c7937");
    const object = await makeObject();
    const missingTime = { ...object.envelope, created_at: undefined, payload: object.payload };
    await expect(normalizeArtifactEnvelope(missingTime as any)).rejects.toMatchObject({ code: "created_at_required" });
  });

  it("requires a first-round pure P1 report to revise", async () => {
    await expect(makeReviewObject("block")).rejects.toMatchObject({ code: "invalid_review_decision" });
    await expect(makeReviewObject("revise")).resolves.toBeDefined();
  });

  it("requires block claims and claim ledger entries to match exactly", async () => {
    await expect(makeObject("声明段落", ["claim_1"], [])).rejects.toMatchObject({ code: "claim_ledger_mismatch" });
    await expect(makeObject("声明段落", [], [{ claim_id: "claim_orphan", block_id: "block_v1_1", classification: "source_fact", verification_status: "pending" }])).rejects.toMatchObject({ code: "claim_ledger_mismatch" });
    await expect(makeObject("声明段落", ["claim_1"], [{ claim_id: "claim_1", block_id: "block_v1_1", classification: "source_fact", verification_status: "pending" }])).resolves.toBeDefined();
  });

  it("requires complete Draft title metadata", async () => {
    await expect(makeObject("正文", [], [], { titleCandidates: [] })).rejects.toMatchObject({ code: "title_metadata_invalid" });
    await expect(makeObject("正文", [], [], { selectedTitle: "其他标题" })).rejects.toMatchObject({ code: "title_metadata_invalid" });
    await expect(makeObject("正文", [], [], { coverTitle: [] })).rejects.toMatchObject({ code: "cover_title_invalid" });
  });

  it("normalizes a complete immutable FrozenArticleVersion and rejects snapshot drift", async () => {
    const frozen = await makeFrozen({ claimIds: ["claim_1"], claimLedger: [{ claim_id: "claim_1", block_id: "block_v1_1", classification: "source_fact", verification_status: "pending" }] });
    expect(frozen.payload).toMatchObject({ title_candidates: ["合成冻结标题"], selected_title: "合成冻结标题", cover_title: ["合成冻结标题"], claim_ledger: [{ claim_id: "claim_1", block_id: "block_v1_1" }] });
    await expect(makeFrozen({ claimIds: ["claim_1"] })).rejects.toMatchObject({ code: "claim_ledger_mismatch" });
    await expect(makeFrozen({ selectedTitle: "漂移标题" })).rejects.toMatchObject({ code: "title_metadata_invalid" });
    await expect(makeFrozen({ titleCandidates: [] })).rejects.toMatchObject({ code: "title_metadata_invalid" });
    await expect(makeFrozen({ coverTitle: [] })).rejects.toMatchObject({ code: "cover_title_invalid" });
    await expect(makeFrozen({ profilePins: { formatting: { id: "md_to_wechat", version: "1.0.0" } } })).rejects.toMatchObject({ code: "style_profile_pin_required" });
    await expect(makeFrozen({ htmlHash: await sha256("rendered html") })).rejects.toMatchObject({ code: "html_hash_not_allowed" });
  });

  it("resolves default style by pin and requires body/hash only for custom styles", async () => {
    await expect(makeBrief({ id: "style_litianc_default", version: "2026-07-05" })).resolves.toBeDefined();
    await expect(makeBrief({ id: "style_litianc_default", version: "2026-07-05" }, "override")).rejects.toMatchObject({ code: "style_profile_pin_conflict" });
    await expect(makeBrief({ id: "style_custom", version: "v1" })).rejects.toMatchObject({ code: "style_profile_body_required" });
    await expect(makeBrief({ id: "style_custom", version: "v1" }, "custom body")).resolves.toBeDefined();
  });

  it("requires the exact coordinator/writing/review producer pin map for a dispatch", async () => {
    await expect(makeDispatch()).resolves.toBeDefined();
    await expect(makeDispatch([{ id: "editorial_coordinator", version: "editorial-coordinator.agent.v3" }, { id: "writing", version: "writing.agent.v3" }] as any)).rejects.toMatchObject({ code: "agent_version_conflict" });
    await expect(makeDispatch([{ id: "editorial_coordinator", version: "writing.agent.v3" }, { id: "writing", version: "writing.agent.v3" }, { id: "editorial_review", version: "editorial-review.agent.v3" }])).rejects.toMatchObject({ code: "agent_version_conflict" });
    await expect(makeDispatch(undefined, ["@title", "@title"], [])).rejects.toMatchObject({ code: "dispatch_target_invalid" });
  });

  it("replays the same envelope and rejects a different payload under the same key", async () => {
    const bucket = new FakeBucket();
    const first = await makeObject();
    expect((await putImmutableArtifact(bucket as any, first)).status).toBe("created");
    expect((await putImmutableArtifact(bucket as any, first)).status).toBe("replayed");
    await expect(putImmutableArtifact(bucket as any, await makeObject("第二段"))).rejects.toMatchObject({ code: "artifact_conflict", status: 409 });
  });

  it("reconciles a committed conditional write whose response is lost", async () => {
    const bucket = new FakeBucket();
    bucket.writeThenFail = true;
    const object = await makeObject();
    await expect(putImmutableArtifact(bucket as any, object)).resolves.toMatchObject({ status: "replayed" });
  });

  it("rejects raw-byte, metadata, and size mutations on readback", async () => {
    const rawBucket = new FakeBucket();
    const object = await makeObject();
    await putImmutableArtifact(rawBucket as any, object);
    const stored = rawBucket.objects.get(object.envelope.artifact_key)!;
    const parsed = JSON.parse(new TextDecoder().decode(stored.bytes));
    stored.bytes = new TextEncoder().encode(JSON.stringify({ payload: parsed.payload, envelope: parsed.envelope }));
    await expect(readImmutableArtifact(rawBucket as any, object)).rejects.toMatchObject({ code: "artifact_readback_mismatch" });

    const metadataBucket = new FakeBucket();
    await putImmutableArtifact(metadataBucket as any, object);
    metadataBucket.objects.get(object.envelope.artifact_key)!.metadata.payload_hash = "sha256:" + "0".repeat(64);
    await expect(readImmutableArtifact(metadataBucket as any, object)).rejects.toMatchObject({ code: "artifact_readback_mismatch" });

    const sizeBucket = new FakeBucket();
    await putImmutableArtifact(sizeBucket as any, object);
    sizeBucket.sizeOffset = 1;
    await expect(readImmutableArtifact(sizeBucket as any, object)).rejects.toMatchObject({ code: "artifact_readback_mismatch" });
  });

  it("holds unknown put and post-put read outcomes for reconciliation", async () => {
    const unknownBucket = new FakeBucket();
    unknownBucket.failPut = true;
    await expect(putImmutableArtifact(unknownBucket as any, await makeObject())).rejects.toMatchObject({ code: "artifact_reconciliation_required", status: 503 } satisfies Partial<ArtifactStoreError>);
    const hiddenBucket = new FakeBucket();
    hiddenBucket.hideAfterPut = true;
    await expect(putImmutableArtifact(hiddenBucket as any, await makeObject())).rejects.toMatchObject({ code: "artifact_reconciliation_required", status: 503 });
    const headBucket = new FakeBucket();
    headBucket.failHead = true;
    await expect(putImmutableArtifact(headBucket as any, await makeObject())).rejects.toMatchObject({ code: "artifact_reconciliation_required", status: 503 });
    const getBucket = new FakeBucket();
    getBucket.failGet = true;
    await expect(putImmutableArtifact(getBucket as any, await makeObject())).rejects.toMatchObject({ code: "artifact_reconciliation_required", status: 503 });
    const postPutBodyBucket = new FakeBucket();
    postPutBodyBucket.failArrayBuffer = true;
    await expect(putImmutableArtifact(postPutBodyBucket as any, await makeObject())).rejects.toMatchObject({ code: "artifact_reconciliation_required", status: 503 });
    const readBodyBucket = new FakeBucket();
    const readableObject = await makeObject();
    await putImmutableArtifact(readBodyBucket as any, readableObject);
    readBodyBucket.failArrayBuffer = true;
    await expect(readImmutableArtifact(readBodyBucket as any, readableObject)).rejects.toMatchObject({ code: "artifact_reconciliation_required", status: 503 });
  });
});
