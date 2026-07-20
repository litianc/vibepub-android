import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import {
  FiveAgentPublishingWorkflow,
  PRE_PERSISTENCE_INTEGRITY_ERROR_CODES,
  isPrePersistenceIntegrityError,
  normalizeFiveAgentStartBody,
  reconcilePreStartHold,
} from "../src/fiveAgentPublishing";
import projectionMigration from "../migrations/0011_five_agent_publication_projection.sql?raw";
import {
  PUBLICATION_AGENT_VERSIONS,
  PUBLICATION_SKILL_PINS,
  PUBLICATION_WAVE2_ADAPTER_PINS,
  canonicalJson,
  isExactWave2PublicationSkillPins,
} from "../src/editorialContracts";
import {
  artifactKey,
  deriveArtifactId,
  WAVE2_SCHEMA_VERSION,
} from "../src/wave2/artifactContracts";
import { applySystemPublicationTransition, projectPublicationTransition, type PublicationRunRow } from "../src/publicationProjection";
import { coordinatorShardName, EditorialRuntimeError } from "../src/editorialAgents";

const runtimeEnv = env as any;

async function applySqlScript(script: string): Promise<void> {
  const statements = script
    .split(/;\s*(?=(?:--|CREATE|DROP|INSERT|ALTER|UPDATE)\b)/i)
    .map(statement => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await runtimeEnv.DB.prepare(statement).run();
}

beforeAll(async () => {
  await applySqlScript(`
    CREATE TABLE IF NOT EXISTS editorial_recording_scopes (
      recording_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY (recording_id, user_id, workspace_id),
      UNIQUE (recording_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS editorial_runs (
      run_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      agent_versions_json TEXT NOT NULL,
      skill_pins_json TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, user_id, workspace_id, article_id, recording_id)
    );
    CREATE TABLE IF NOT EXISTS editorial_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      producer_agent_role TEXT NOT NULL,
      producer_agent_version TEXT NOT NULL,
      skill_id TEXT,
      skill_version TEXT,
      workflow_version TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      input_artifact_ids_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, kind, payload_hash)
    );
  `);
  await applySqlScript(projectionMigration);
});

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function syntheticVisualPng(width: number, height: number, mode: "valid" | "transparent" | "nonwhite"): Promise<string> {
  const rowLength = width * 4 + 1;
  const raw = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowLength + 1 + x * 4;
      const nonwhite = mode === "nonwhite";
      raw[offset] = nonwhite ? 32 : 255;
      raw[offset + 1] = nonwhite ? 64 : 255;
      raw[offset + 2] = nonwhite ? 96 : 255;
      raw[offset + 3] = mode === "transparent" ? 0 : 255;
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
  view.setUint32(0, width); view.setUint32(4, height); ihdr.set([8, 6, 0, 0, 0], 8);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  let binary = ""; for (let index = 0; index < output.byteLength; index += 0x8000) binary += String.fromCharCode(...output.slice(index, Math.min(index + 0x8000, output.byteLength)));
  return btoa(binary);
}

async function hashJson(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

function guardedEnv(overrides: Record<string, unknown>, access: { db: number; do: number; r2: number; workflow: number; service: number }): any {
  const value = Object.create(runtimeEnv);
  Object.assign(value, overrides);
  Object.defineProperty(value, "DB", {
    get() { access.db += 1; throw new Error("DB must not be touched"); },
  });
  Object.defineProperty(value, "EDITORIAL_COORDINATOR", {
    get() { access.do += 1; throw new Error("DO must not be touched"); },
  });
  Object.defineProperty(value, "FILES_BUCKET", {
    get() { access.r2 += 1; throw new Error("R2 must not be touched"); },
  });
  Object.defineProperty(value, "FIVE_AGENT_PUBLISHING_WORKFLOW", {
    get() { access.workflow += 1; throw new Error("Workflow must not be touched"); },
  });
  for (const name of ["WRITING_AGENT", "REVIEW_AGENT"] as const) {
    Object.defineProperty(value, name, {
      get() { access.service += 1; throw new Error("service binding must not be touched"); },
    });
  }
  return value;
}

function request(token: string, user = "runtime_gate_user", workspace = "runtime_gate_workspace"): Request {
  return new Request("https://example.test/api/internal/v3/publishing/runs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-vibepub-user-id": user,
      "x-vibepub-workspace-id": workspace,
      "content-type": "application/json",
    },
    body: "not-json-on-purpose",
  });
}

function publishingBody(runId: string, recordingId: number, transcriptRef: string, transcriptHash: string) {
  return {
    run_id: runId,
    article_id: `${runId}-article`,
    recording_id: recordingId,
    source_type: "text",
    language: "zh-CN",
    transcript_ref: transcriptRef,
    transcript_hash: transcriptHash,
    source_hash: transcriptHash,
    title_hint: "synthetic",
    content_goal: "runtime",
    profile_pins: {
      style: { id: "style_litianc_default", version: "2026-07-05" },
      formatting: { id: "md_to_wechat", version: "1.0.0" },
    },
  };
}

const PUBLIC_RUN_KEYS = [
    "run_id", "article_id", "recording_id", "workflow_id", "state", "run_status",
    "state_revision", "progress_percent", "last_successful_state", "last_successful_progress_percent",
    "resume_state", "retry_count", "revision_count", "approval_state", "next_action", "error_code",
    "created_at", "updated_at", "start_status", "start_ledger_status", "start_error_code",
    "start_next_action", "artifact_count", "receipt_count", "call_intent_count",
];

function expectPublicRunProjection(run: Record<string, any>, runId: string): void {
  expect(run).toMatchObject({ run_id: runId });
  expect(run.run).toBeUndefined();
  expect(Object.keys(run)).toEqual(PUBLIC_RUN_KEYS);
  expect(run.manifest_json).toBeUndefined();
  expect(run.user_id).toBeUndefined();
  expect(run.workspace_id).toBeUndefined();
  expect(run.payload_hash).toBeUndefined();
  expect(run.manifest_hash).toBeUndefined();
}

function expectStartResponseShape(body: Record<string, any>, runId: string): void {
  expectPublicRunProjection(body.run, runId);
  expect(body.brief).toEqual({
    artifact_id: expect.any(String),
    artifact_key: expect.any(String),
    payload_hash: expect.any(String),
  });
}

async function syntheticDraftPayload(input: { run_id: string; article_id: string; recording_id: number; source_hash: string; title?: string; revision?: 1 | 2; parent_artifact_id?: string | null; parent_review_artifact_id?: string | null; parent_dispatch_artifact_id?: string | null; long?: boolean; insufficient?: boolean }) {
  const title = input.title || "Synthetic editorial title";
  const sourceBlocks = input.insufficient
    ? ["Only one unique visual source block."]
    : input.long
    ? [`${"长文内容".repeat(1_700)}`, "第二个长文段落。", "第三个长文段落。", "第四个长文段落。", "第五个长文段落。"]
    : ["A short synthetic paragraph.", "A second synthetic paragraph."];
  const blocks = await Promise.all([
    ...sourceBlocks,
  ].map(async (text, index) => ({
    block_id: `block_v1_${index + 1}`,
    kind: "paragraph",
    order: index,
    text,
    text_hash: await sha256Text(text),
    claim_ids: [],
    image_ref_ids: [],
  })));
  const body = blocks.map(block => block.text).join("\n\n");
  return {
    article_id: input.article_id,
    run_id: input.run_id,
    recording_id: input.recording_id,
    revision: input.revision || 1,
    parent_artifact_id: input.parent_artifact_id ?? null,
    parent_review_artifact_id: input.parent_review_artifact_id ?? null,
    parent_dispatch_artifact_id: input.parent_dispatch_artifact_id ?? null,
    title,
    body,
    blocks,
    title_candidates: [title],
    selected_title: title,
    cover_title: ["Synthetic", "Title"],
    adapter_version: "writing-v3.adapter.1.0.0",
    model_version: "glm-5.2",
    formatting_skill: { id: "md_to_wechat", version: "1.0.0" },
    profile_pins: {
      style: { id: "style_litianc_default", version: "2026-07-05" },
      formatting: { id: "md_to_wechat", version: "1.0.0" },
    },
    content_hash: await hashJson({ title, body, blocks }),
    claim_ledger: [],
    changed_block_ids: [],
    source_hash: input.source_hash,
  };
}

function serviceBinding(response: (request: Request) => Promise<Response>): Fetcher {
  return { fetch: response } as unknown as Fetcher;
}

async function executeSyntheticScenario(
  scenario: "p0" | "p1_pass" | "p1_block" | "p0_round2" | "p2_pass",
  failure?: { role: "writing" | "review"; retryable: boolean },
  artifactUnknown = false,
  options: {
    reviewRoundOverride?: Partial<Record<1 | 2, 1 | 2>>;
    draftPinDrift?: "model" | "adapter" | "style" | "formatting" | "style_body_hash";
    reviewPinDrift?: "reviewer_version" | "rules_pins";
    visual?: boolean;
    visualReplay?: boolean;
    visualLong?: boolean;
    visualResponseLoss?: boolean;
    visualJsonResponseLoss?: boolean;
    visualBinaryResponseLoss?: boolean;
    visualProjectionResponseLoss?: boolean;
    visualReceiptResponseLoss?: boolean;
    visualExtraScope?: boolean;
    visualHistoricalScope?: boolean;
    visualPlanTamper?: boolean;
    visualInsufficientBlocks?: boolean;
    visualAllowlistMismatch?: boolean;
    visualAdapterResponseLoss?: boolean;
    visualCoverTransparent?: boolean;
    visualBodyNonWhite?: boolean;
    visualFailure?: "nonretry" | "retryable" | "unknown";
    visualPreCancelled?: boolean;
    visualCancellationReadFailure?: boolean;
    visualQaExactSetFailure?: boolean;
    visualWholeRunRestartAt?: "plan" | "cover" | "unknown";
    visualBindingFetchThrow?: boolean;
    visualAssetIntentRestart?: boolean;
    visualWholeRunSuccessfulReconcile?: boolean;
    visualFrozenReadHold?: boolean;
    visualQaWholeRunRecovery?: boolean;
  } = {},
): Promise<{
  runId: string;
  articleId: string;
  userId: string;
  workspaceId: string;
  result: Record<string, unknown>;
  writingCalls: number;
  reviewCalls: number;
  artifactCount: number;
  receiptCount: number;
  artifactIds: string[];
  visualCalls: number;
  visualExecuteCalls: number;
  visualProviderOperations: number;
  visualReconcileCalls: number;
  projectionFaultTriggered: boolean;
  callIntentCount: number;
  revisionCount: number;
  projection: Record<string, unknown> | null;
  projectionEventHashes: string[];
  doEventHashes: string[];
  visualReplayDelta?: Record<string, number>;
  visualReplayError?: string;
  workflowError?: string;
  visualIntentCheckpoint?: { asset_intents: number; binary_objects: number };
}> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runId = `runtime-v3-${scenario}-${suffix}`;
  const articleId = `runtime-v3-${scenario}-article-${suffix}`;
  const userId = `runtime_v3_${scenario}_user`;
  const workspaceId = `runtime_v3_${scenario}_workspace`;
  const recordingId = scenario === "p0" ? 1905 : scenario === "p1_pass" ? 1906 : scenario === "p1_block" ? 1907 : scenario === "p0_round2" ? 1908 : 1909;
  const transcriptRef = `runtime:v3:${scenario}-${suffix}`;
  const transcriptText = `Synthetic transcript for ${scenario}.`;
  const transcriptHash = await sha256Text(transcriptText);
  await runtimeEnv.FILES_BUCKET.put(transcriptRef, transcriptText, { customMetadata: { user_id: userId, workspace_id: workspaceId } });
  let writingCalls = 0;
  let reviewCalls = 0;
  let visualCalls = 0;
  let visualExecuteCalls = 0;
  let visualProviderOperations = 0;
  let visualReconcileCalls = 0;
  let visualAdapterResponseLost = false;
  let visualSuccessfulResponseLost = false;
  let visualFirstBodyFailureInjected = false;
  let visualBindingThrowInjected = false;
  const visualDurableResponses = new Map<string, string>();
  let projectionFaultTriggered = false;
  const writing = serviceBinding(async (request) => {
    writingCalls += 1;
    const input = await request.json() as Record<string, any>;
    if (failure?.role === "writing") {
      return Response.json({ error: {
        code: failure.retryable ? "upstream_timeout" : "unauthorized",
        retryable: failure.retryable,
      } }, { status: failure.retryable ? 503 : 401 });
    }
    if (input.mode === "initial") {
      const draft = await syntheticDraftPayload({ run_id: input.run_id, article_id: input.article_id, recording_id: input.recording_id, source_hash: input.source_hash, long: options.visualLong, insufficient: options.visualInsufficientBlocks });
      if (scenario === "p2_pass" && options.draftPinDrift === "model") draft.model_version = "unbound-model";
      if (scenario === "p2_pass" && options.draftPinDrift === "adapter") draft.adapter_version = "unbound-adapter";
      if (scenario === "p2_pass" && options.draftPinDrift === "style") draft.profile_pins.style = { id: "unbound-style", version: "0.0.0" };
      if (scenario === "p2_pass" && options.draftPinDrift === "formatting") draft.formatting_skill = { id: "unbound-formatting", version: "0.0.0" };
      if (scenario === "p2_pass" && options.draftPinDrift === "style_body_hash") draft.style_profile_body_hash = `sha256:${"0".repeat(64)}`;
      return new Response(JSON.stringify({
        protocol_version: "vibepub.editorial.v3",
        result: draft,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const current = input.current_draft.payload;
    const dispatch = input.revision_dispatch.payload;
    const blocks = await Promise.all(current.blocks.map(async (block: Record<string, unknown>) => block.block_id === "block_v1_1"
      ? { ...block, text: "A revised synthetic paragraph.", text_hash: await sha256Text("A revised synthetic paragraph.") }
      : { ...block }));
    const body = blocks.map((block: Record<string, unknown>) => block.text).join("\n\n");
    const revisionResult = {
      ...current,
      revision: 2,
      parent_artifact_id: input.current_draft.artifact_id,
      parent_review_artifact_id: input.review_report.artifact_id,
      parent_dispatch_artifact_id: input.revision_dispatch.artifact_id,
      blocks,
      body,
      content_hash: await hashJson({ title: current.title, body, blocks }),
      changed_block_ids: dispatch.target_block_ids,
    } as Record<string, any>;
    if (options.draftPinDrift === "model") revisionResult.model_version = "unbound-model";
    if (options.draftPinDrift === "adapter") revisionResult.adapter_version = "unbound-adapter";
    if (options.draftPinDrift === "style") revisionResult.profile_pins = { ...revisionResult.profile_pins, style: { id: "unbound-style", version: "0.0.0" } };
    if (options.draftPinDrift === "formatting") revisionResult.formatting_skill = { id: "unbound-formatting", version: "0.0.0" };
    if (options.draftPinDrift === "style_body_hash") revisionResult.style_profile_body_hash = `sha256:${"0".repeat(64)}`;
    return new Response(JSON.stringify({
      protocol_version: "vibepub.editorial.v3",
      result: revisionResult,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const review = serviceBinding(async (request) => {
    reviewCalls += 1;
    const input = await request.json() as Record<string, any>;
    if (failure?.role === "review") {
      return Response.json({ error: {
        code: failure.retryable ? "upstream_timeout" : "unauthorized",
        retryable: failure.retryable,
      } }, { status: failure.retryable ? 503 : 401 });
    }
    const draft = input.input_payload;
    const firstRoundP0 = input.review_round === 1 && scenario === "p0";
    const secondRoundP0 = input.review_round === 2 && scenario === "p0_round2";
    const blocked = firstRoundP0 || secondRoundP0 || (input.review_round === 2 && scenario === "p1_block");
    const p1 = (input.review_round === 1 && (scenario === "p1_pass" || scenario === "p1_block" || scenario === "p0_round2")) ||
      (input.review_round === 2 && scenario === "p1_block");
    const p2 = input.review_round === 1 && scenario === "p2_pass";
    const finding = blocked || p1 || p2 ? {
      finding_id: `finding-${input.review_round}`,
      severity: firstRoundP0 || secondRoundP0 ? "P0" : p2 ? "P2" : "P1",
      code: firstRoundP0 || secondRoundP0 ? "privacy_risk" : p2 ? "style_note" : "clarity_risk",
      target: "block_v1_1",
      evidence: { text_hash: draft.blocks[0].text_hash, start: 0, end: 1 },
      evidence_hash: draft.blocks[0].text_hash,
      suggested_action: "Clarify the target block.",
      requires_human: blocked,
    } : null;
    const findings = finding ? [finding] : [];
    const responseRound = options.reviewRoundOverride?.[input.review_round as 1 | 2] || input.review_round;
    const reviewPinDrift = (scenario === "p2_pass" || input.review_round === 2) ? options.reviewPinDrift : undefined;
    return new Response(JSON.stringify({
      protocol_version: "vibepub.editorial.review.v1",
      result: {
        article_id: input.article_id,
        run_id: input.run_id,
        recording_id: input.recording_id,
        input_artifact_id: input.input_artifact_id,
        input_payload_hash: input.input_payload_hash,
        review_round: responseRound,
        decision: blocked ? "block" : p1 ? "revise" : "pass",
        findings,
        revision_targets: p1 ? ["block_v1_1"] : [],
        suggested_actions: p1 ? ["Clarify the target block."] : [],
        reviewer_version: reviewPinDrift === "reviewer_version" ? "unbound-review-adapter" : "editorial-review.adapter.1.0.0",
        rules_pins: {
          dbs_ai_check: { id: "dbs-ai-check", version: reviewPinDrift === "rules_pins" ? "0.0.0" : "1.0.0" },
          humanizer: { id: "humanizer-zh", version: "1.0.0" },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const visualAdapter = runtimeEnv.IMAGE_GENERATION_ADAPTER;
  const countedVisualAdapter = visualAdapter ? { fetch: async (request: Request) => {
    visualCalls += 1;
    let body: Record<string, unknown> | null = null;
    try {
      body = await request.clone().json() as Record<string, unknown>;
      const responseKey = `${String(body.operation_id)}:${String(body.attempt)}`;
      if (body.reconcile_only === true) {
        visualReconcileCalls += 1;
        const stored = visualDurableResponses.get(responseKey);
        if (!stored) return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
        return new Response(stored, { status: 200, headers: { "content-type": "application/json" } });
      }
      else {
        visualExecuteCalls += 1;
        if (request.url.endsWith("/internal/v3/visual/image")) visualProviderOperations += 1;
      }
    } catch { /* service boundary owns response validation */ }
    if (body && body.reconcile_only !== true && options.visualBindingFetchThrow && !visualBindingThrowInjected &&
        request.url.endsWith("/internal/v3/visual/image") && body.size === "1536x864") {
      visualBindingThrowInjected = true;
      throw new Error("synthetic service binding response unknown");
    }
    if (body && body.reconcile_only !== true && request.url.endsWith("/internal/v3/visual/image") &&
        body.size === "1536x864" && options.visualFailure &&
        (options.visualFailure === "retryable" || !visualFirstBodyFailureInjected)) {
      visualFirstBodyFailureInjected = true;
      if (options.visualFailure === "unknown") {
        return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
      }
      if (options.visualFailure === "retryable") {
        return Response.json({ error: { code: "upstream_retryable", retryable: true } }, { status: 503 });
      }
      return Response.json({ error: { code: "invalid_request", retryable: false } }, { status: 400 });
    }
    const response = await visualAdapter.fetch(request);
    if (body && body.reconcile_only !== true) {
      const responseBody = await response.clone().text();
      visualDurableResponses.set(`${String(body.operation_id)}:${String(body.attempt)}`, responseBody);
      if (options.visualAdapterResponseLoss && !visualAdapterResponseLost && request.url.endsWith("/internal/v3/visual/plan")) {
        visualAdapterResponseLost = true;
        return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
      }
      if (options.visualWholeRunSuccessfulReconcile && !visualSuccessfulResponseLost &&
          request.url.endsWith("/internal/v3/visual/image") && body.size === "1536x864") {
        visualSuccessfulResponseLost = true;
        return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
      }
    }
    if (request.url.endsWith("/internal/v3/visual/image") && body && body.reconcile_only !== true && (options.visualCoverTransparent || options.visualBodyNonWhite)) {
      const value = await response.json() as Record<string, any>;
      const size = typeof body.size === "string" && /^\d+x\d+$/.test(body.size) ? body.size.split("x").map(Number) as [number, number] : [1536, 864];
      const mode = size[0] === 2256 ? (options.visualCoverTransparent ? "transparent" : "valid") : (options.visualBodyNonWhite ? "nonwhite" : "valid");
      value.result.b64_json = await syntheticVisualPng(size[0], size[1], mode);
      return Response.json(value);
    }
    return response;
  } } : undefined;
  const workflow = { get: async () => ({ status: async () => ({ status: "queued" }) }), create: async (input: { id: string }) => ({ id: input.id }) };
  const testEnv = Object.create(runtimeEnv);
  Object.assign(testEnv, {
    FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
    FIVE_AGENT_PUBLISHING_V3: "true",
    FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
    FIVE_AGENT_PUBLISHING_WORKFLOW: workflow,
    WRITING_AGENT: writing,
    REVIEW_AGENT: review,
    WRITING_AGENT_TOKEN: "synthetic-writing-token",
    REVIEW_AGENT_TOKEN: "synthetic-review-token",
    IMAGE_GENERATION_ADAPTER: countedVisualAdapter,
    VISUAL_PRODUCTION_V3: options.visual && !options.visualPreCancelled && !options.visualCancellationReadFailure ? "true" : "false",
    VISUAL_PRODUCTION_V3_ALLOWLIST: options.visual && !options.visualAllowlistMismatch ? `${userId}:${workspaceId}` : options.visual ? `${userId}:another-workspace` : "",
    VISUAL_PRODUCTION_TOKEN: "test-visual-token",
    GLM_MODEL: "glm-5.2",
  });
  if (artifactUnknown) {
    const realBucket = runtimeEnv.FILES_BUCKET;
    const unknownBucket = Object.create(realBucket);
    const unreadableKeys = new Set<string>();
    Object.defineProperty(unknownBucket, "put", {
      value: async (key: string, value: unknown, options?: unknown) => {
        await realBucket.put(key, value as any, options as any);
        if (key.includes("article_draft")) {
          unreadableKeys.add(key);
          throw new Error("synthetic draft artifact response lost after commit");
        }
      },
    });
    Object.defineProperty(unknownBucket, "get", {
      value: (key: string) => unreadableKeys.has(key) ? Promise.reject(new Error("synthetic draft read outcome unknown")) : realBucket.get(key),
    });
    Object.defineProperty(unknownBucket, "head", {
      value: (key: string) => unreadableKeys.has(key) ? Promise.reject(new Error("synthetic draft head outcome unknown")) : realBucket.head(key),
    });
    Object.defineProperty(unknownBucket, "list", { value: (options?: unknown) => realBucket.list(options as any) });
    Object.defineProperty(testEnv, "FILES_BUCKET", { value: unknownBucket, configurable: true });
  }
  const body = publishingBody(runId, recordingId, transcriptRef, transcriptHash);
  body.article_id = articleId;
  const start = await worker.fetch(new Request("https://example.test/api/internal/v3/publishing/runs", {
    method: "POST",
    headers: { authorization: "Bearer dedicated-v3-token", "x-vibepub-user-id": userId, "x-vibepub-workspace-id": workspaceId, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), testEnv, {} as any);
  expect([200, 202]).toContain(start.status);
  expectStartResponseShape(await start.json() as Record<string, any>, runId);

  if (options.visualFrozenReadHold) {
    const baseBucket = testEnv.FILES_BUCKET;
    const frozenReadBucket = Object.create(baseBucket);
    let failed = false;
    Object.defineProperty(frozenReadBucket, "get", {
      value: async (key: string) => {
        const projection = key.includes("frozen_article_version")
          ? await runtimeEnv.DB.prepare(`SELECT state FROM publication_runs WHERE run_id = ? LIMIT 1`).bind(runId).first<{ state: string }>()
          : null;
        if (!failed && projection?.state === "visual_planning") {
          failed = true;
          throw new Error("synthetic frozen artifact read outcome unknown");
        }
        return baseBucket.get(key);
      },
    });
    Object.defineProperty(frozenReadBucket, "head", { value: (key: string) => baseBucket.head(key) });
    Object.defineProperty(frozenReadBucket, "put", { value: (key: string, value: unknown, optionsArg?: unknown) => baseBucket.put(key, value as any, optionsArg as any) });
    Object.defineProperty(frozenReadBucket, "list", { value: (optionsArg?: unknown) => baseBucket.list(optionsArg as any) });
    Object.defineProperty(testEnv, "FILES_BUCKET", { value: frozenReadBucket, configurable: true });
  }

  if (options.visualJsonResponseLoss || options.visualBinaryResponseLoss || options.visualQaExactSetFailure || options.visualQaWholeRunRecovery) {
    const baseBucket = testEnv.FILES_BUCKET;
    const visualBucket = Object.create(baseBucket);
    let jsonWriteLost = false;
    let jsonReadLost = false;
    let binaryWriteLost = false;
    let binaryReadLost = false;
    let qaListLost = false;
    Object.defineProperty(visualBucket, "put", {
      value: async (key: string, value: unknown, optionsArg?: unknown) => {
        const isJson = key.includes("/visual/");
        const isBinary = key.includes("/visual-binary/");
        const result = await baseBucket.put(key, value as any, optionsArg as any);
        if (isJson && options.visualJsonResponseLoss && !jsonWriteLost) {
          jsonWriteLost = true;
          throw new Error("synthetic visual JSON write response lost");
        }
        if (isBinary && options.visualBinaryResponseLoss && !binaryWriteLost) {
          binaryWriteLost = true;
          throw new Error("synthetic visual binary write response lost");
        }
        return result;
      },
    });
    Object.defineProperty(visualBucket, "get", {
      value: async (key: string) => {
        if (key.includes("/visual/") && jsonWriteLost && !jsonReadLost) {
          jsonReadLost = true;
          throw new Error("synthetic visual JSON read outcome unknown");
        }
        if (key.includes("/visual-binary/") && binaryWriteLost && !binaryReadLost) {
          binaryReadLost = true;
          throw new Error("synthetic visual binary read outcome unknown");
        }
        return baseBucket.get(key);
      },
    });
    Object.defineProperty(visualBucket, "head", {
      value: async (key: string) => baseBucket.head(key),
    });
    Object.defineProperty(visualBucket, "list", {
      value: async (optionsArg?: { prefix?: string }) => {
        const page = await baseBucket.list(optionsArg as any);
        if (options.visualQaWholeRunRecovery && !qaListLost && optionsArg?.prefix?.includes("/visual/") && page.objects.some((item: { key: string }) => item.key.includes("/visual_qa_report/"))) {
          qaListLost = true;
          throw new Error("synthetic post-QA exact-set read outcome unknown");
        }
        if (options.visualQaExactSetFailure && optionsArg?.prefix?.includes("/visual/") && page.objects.some((item: { key: string }) => item.key.includes("/visual_qa_report/"))) {
          return { ...page, objects: [...page.objects, { key: `${optionsArg.prefix}synthetic-current-scope-extra.json` }] };
        }
        return page;
      },
    });
    Object.defineProperty(testEnv, "FILES_BUCKET", { value: visualBucket, configurable: true });
  }

  if (options.visualProjectionResponseLoss) {
    const baseDb = testEnv.DB;
    const rawPrepared = new WeakMap<object, object>();
    const boundValues = new WeakMap<object, readonly unknown[]>();
    const wrapStatement = (statement: any, values: readonly unknown[] = []): any => {
      const wrapped = new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...nextValues: unknown[]) => wrapStatement(target.bind(...nextValues), nextValues);
          const value = target[property as keyof typeof target];
          if (typeof value === "function") return (...args: unknown[]) => value.apply(target, args);
          return value;
        },
      });
      rawPrepared.set(wrapped, statement);
      boundValues.set(wrapped, values);
      return wrapped;
    };
    let dropped = false;
    let visualProjectionBatchCount = 0;
    const projectionDb = new Proxy(baseDb, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
        if (property === "batch") return async (statements: unknown[]) => {
          const result = await target.batch(statements.map(statement => rawPrepared.get(statement as object) || statement) as any);
          const visualTransition = statements.some(statement => boundValues.get(statement as object)?.[0] === "visual_planning");
          if (visualTransition) visualProjectionBatchCount += 1;
          if (visualTransition && visualProjectionBatchCount === 2 && !dropped) {
            dropped = true;
            projectionFaultTriggered = true;
            throw new Error("synthetic publication projection response lost");
          }
          return result;
        };
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(testEnv, "DB", { value: projectionDb, configurable: true });
  }

  const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
  let workflowCoordinator = coordinator;
  let assetIntentReached: (() => void) | undefined;
  let releaseAssetIntent: (() => void) | undefined;
  const assetIntentCheckpoint = new Promise<void>(resolve => { assetIntentReached = resolve; });
  const assetIntentRelease = new Promise<void>(resolve => { releaseAssetIntent = resolve; });
  let assetIntentPaused = false;
  if (options.visualAssetIntentRestart) {
    workflowCoordinator = new Proxy(coordinator as any, {
      get(target, property, receiver) {
        if (property === "prepareFiveAgentVisualArtifact") return async (input: { metadata?: { kind?: string } }) => {
          const result = await target.prepareFiveAgentVisualArtifact(input);
          if (!assetIntentPaused && input.metadata?.kind === "visual_asset") {
            assetIntentPaused = true;
            assetIntentReached?.();
            await assetIntentRelease;
          }
          return result;
        };
        return Reflect.get(target, property, receiver);
      },
    }) as typeof coordinator;
  } else if (options.visualResponseLoss) {
    let dropped = false;
    workflowCoordinator = new Proxy(coordinator as any, {
      get(target, property, receiver) {
        if (property === "completeFiveAgentCall") return async (input: { call_id: string; status: string }) => {
          const result = await target.completeFiveAgentCall(input);
          if (!dropped && input.status === "succeeded" && input.call_id.includes(":visual_plan:")) {
            dropped = true;
            throw new Error("synthetic visual call result response lost");
          }
          return result;
        };
        if (property === "completeFiveAgentVisualArtifact" && options.visualReceiptResponseLoss) return async (input: Record<string, unknown>) => {
          const result = await target.completeFiveAgentVisualArtifact(input);
          if (!dropped) {
            dropped = true;
            throw new Error("synthetic visual receipt response lost");
          }
          return result;
        };
        return Reflect.get(target, property, receiver);
      },
    }) as typeof coordinator;
  } else if (options.visualReceiptResponseLoss) {
    let dropped = false;
    workflowCoordinator = new Proxy(coordinator as any, {
      get(target, property, receiver) {
        if (property === "completeFiveAgentVisualArtifact") return async (input: Record<string, unknown>) => {
          const result = await target.completeFiveAgentVisualArtifact(input);
          if (!dropped) {
            dropped = true;
            throw new Error("synthetic visual receipt response lost");
          }
          return result;
        };
        return Reflect.get(target, property, receiver);
      },
    }) as typeof coordinator;
  }
  const run = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
  const brief = (await coordinator.listFiveAgentArtifacts(runId, userId, workspaceId)).find(item => item.kind === "article_brief");
  expect(brief).toBeDefined();
  const getResponse = await worker.fetch(new Request(`https://example.test/api/internal/v3/publishing/runs/${runId}?article_id=${articleId}`, {
    headers: {
      authorization: "Bearer dedicated-v3-token",
      "x-vibepub-user-id": userId,
      "x-vibepub-workspace-id": workspaceId,
    },
  }), testEnv, {} as any);
  expect(getResponse.status).toBe(200);
  const getBody = await getResponse.json() as Record<string, any>;
  expectPublicRunProjection(getBody.run, runId);
  const startEvidence = await coordinator.getFiveAgentStartEvidence(runId, String(run.workflow_id));
  expect(startEvidence.events.filter(event => event.event_type === "workflow_start_confirmed")).toHaveLength(1);
  const params = {
    run_id: runId, article_id: articleId, recording_id: recordingId, user_id: userId, workspace_id: workspaceId,
    payload_hash: String(run.payload_hash), manifest_hash: String(run.manifest_hash), manifest_json: String(run.manifest_json),
    workflow_id: String(run.workflow_id), created_at: String(run.created_at), transcript_ref: transcriptRef, transcript_hash: transcriptHash,
    source_hash: transcriptHash, brief_artifact_id: String(brief!.artifact_id), brief_artifact_key: String(brief!.artifact_key), brief_payload_hash: String(brief!.payload_hash),
  };
  const workflowInstance = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
  workflowInstance.env = testEnv;
  workflowInstance._agent = workflowCoordinator;
  let wholeRunRestartInjected = false;
  let checkpointReached: (() => void) | undefined;
  let releaseCheckpoint: (() => void) | undefined;
  const checkpoint = new Promise<void>(resolve => { checkpointReached = resolve; });
  const checkpointRelease = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  const executeStep = async (args: unknown[], pauseAtCheckpoint: boolean): Promise<unknown> => {
    const stepName = String(args[0]);
    const closure = args[args.length - 1] as () => Promise<unknown>;
    const attempts = options.visualResponseLoss || options.visualJsonResponseLoss || options.visualBinaryResponseLoss || options.visualProjectionResponseLoss || options.visualReceiptResponseLoss || options.visualAdapterResponseLoss || (options.visualFailure === "unknown" && options.visualWholeRunRestartAt !== "unknown") ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const value = await closure();
        const restartStep = options.visualWholeRunRestartAt === "plan" ? "visual-plan" : options.visualWholeRunRestartAt === "cover" ? "visual-asset-cover_01" : null;
        if (pauseAtCheckpoint && !wholeRunRestartInjected && restartStep === stepName) {
          wholeRunRestartInjected = true;
          checkpointReached?.();
          await checkpointRelease;
        }
        return value;
      } catch (error) { lastError = error; }
    }
    throw lastError;
  };
  const step = { do: (...args: unknown[]) => executeStep(args, true) };
  const resumedStep = { do: (...args: unknown[]) => executeStep(args, false) };
  let result: Record<string, unknown>;
  let workflowError: string | undefined;
  let visualIntentCheckpoint: { asset_intents: number; binary_objects: number } | undefined;
  try {
    if (options.visualAssetIntentRestart) {
      const interruptedRun = workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Promise<Record<string, unknown>>;
      await assetIntentCheckpoint;
      const checkpointLedger = await coordinator.getFiveAgentVisualLedger(runId, userId, workspaceId);
      const pendingAsset = checkpointLedger.artifacts.find(item => item.kind === "visual_asset");
      const binaryPrefix = pendingAsset?.binary_storage_ref?.replace(/^r2:\/\//, "").replace(/\/[^/]+\/[^/]+$/, "/") || `missing-${runId}`;
      visualIntentCheckpoint = {
        asset_intents: checkpointLedger.artifacts.filter(item => item.kind === "visual_asset").length,
        binary_objects: (await testEnv.FILES_BUCKET.list({ prefix: binaryPrefix })).objects.length,
      };
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, resumedStep) as Record<string, unknown>;
      releaseAssetIntent?.();
      await interruptedRun.catch(() => undefined);
    } else if (options.visualWholeRunRestartAt === "plan" || options.visualWholeRunRestartAt === "cover") {
      const interruptedRun = workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Promise<Record<string, unknown>>;
      await checkpoint;
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, resumedStep) as Record<string, unknown>;
      releaseCheckpoint?.();
      await interruptedRun.catch(() => undefined);
    } else {
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
    }
    if ((options.visualWholeRunRestartAt === "unknown" || options.visualBindingFetchThrow || options.visualWholeRunSuccessfulReconcile || options.visualFrozenReadHold || options.visualQaWholeRunRecovery) && result.state === "needs_action") {
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
    }
    if (options.visualPreCancelled || options.visualCancellationReadFailure) {
      Object.assign(testEnv, { VISUAL_PRODUCTION_V3: "true" });
      if (options.visualPreCancelled) {
        const current = await runtimeEnv.DB.prepare(`SELECT state_revision, updated_at FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
          .bind(runId, userId, workspaceId).first<{ state_revision: number; updated_at: string }>();
        const cancelEventKey = `visual-cancel:${runId}`;
        const cancelEventTime = new Date(Math.max(Date.now(), Date.parse(String(current?.updated_at || "")) + 1)).toISOString();
        await applySystemPublicationTransition(runtimeEnv.DB, {
          runId,
          auth: { userId, workspaceId },
          targetState: "cancelled",
          expectedStateRevision: Number(current?.state_revision || 0),
          options: {
            eventId: `${runId}:event:${Number(current?.state_revision || 0) + 1}`,
            eventType: "action_cancel",
            eventIdempotencyKey: cancelEventKey,
            eventPayloadHash: await sha256Text(cancelEventKey),
            eventCreatedAt: cancelEventTime,
          },
        });
      }
      if (options.visualCancellationReadFailure) {
        const baseDb = runtimeEnv.DB;
        const failingDb = new Proxy(baseDb as any, {
          get(target, property, receiver) {
            if (property === "prepare") return (sql: string) => {
              if (sql.includes("SELECT state FROM publication_runs")) throw new Error("synthetic cancellation state read failure");
              return target.prepare(sql);
            };
            return Reflect.get(target, property, receiver);
          },
        });
        Object.defineProperty(testEnv, "DB", { value: failingDb, configurable: true });
      }
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
    }
  } catch (error) {
    if (!options.reviewRoundOverride && !options.draftPinDrift && !options.reviewPinDrift && !options.visualCancellationReadFailure) throw error;
    workflowError = error instanceof EditorialRuntimeError
      ? error.code
      : String((error as { code?: unknown })?.code || error);
    result = { state: "integrity_error", artifact_ids: [] };
  }
  let visualReplayDelta: Record<string, number> | undefined;
  let visualReplayError: string | undefined;
  if (options.visualReplay && result.state === "visual_ready") {
    const beforeLedger = await coordinator.getFiveAgentVisualLedger(runId, userId, workspaceId);
    const beforePlan = beforeLedger.artifacts.find(item => item.kind === "visual_plan");
    const beforeJsonCount = beforePlan ? (await testEnv.FILES_BUCKET.list({ prefix: beforePlan.artifact_key.slice(0, beforePlan.artifact_key.indexOf("/visual/") + "/visual/".length) })).objects.length : 0;
    const beforeBinary = beforeLedger.artifacts.find(item => item.kind === "visual_asset")?.binary_storage_ref?.replace(/^r2:\/\//, "");
    const beforeBinaryCount = beforeBinary ? (await testEnv.FILES_BUCKET.list({ prefix: beforeBinary.slice(0, beforeBinary.lastIndexOf("/") + 1) })).objects.length : 0;
    const beforeD1 = await testEnv.DB.prepare(`SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ? AND kind IN ('visual_plan', 'visual_asset', 'visual_qa_report')`).bind(runId).first<{ count: number }>();
    const beforePublication = await testEnv.DB.prepare(`SELECT count(*) AS count FROM publication_run_events WHERE run_id = ? AND event_type IN ('visual_planning', 'visual_generating', 'visual_ready', 'visual_plan_committed', 'visual_asset_committed', 'visual_qa_committed')`).bind(runId).first<{ count: number }>();
    if (options.visualExtraScope && beforePlan) {
      const original = await testEnv.FILES_BUCKET.get(beforePlan.artifact_key);
      if (!original) throw new Error("visual scope fixture plan is unavailable");
      const extraKey = `${beforePlan.artifact_key}.extra`;
      await testEnv.FILES_BUCKET.put(extraKey, await original.text(), { customMetadata: { synthetic: "extra-current-scope" } });
    }
    if (options.visualHistoricalScope && beforePlan) {
      const original = await testEnv.FILES_BUCKET.get(beforePlan.artifact_key);
      if (!original) throw new Error("visual historical fixture plan is unavailable");
      const historical = JSON.parse(await original.text()) as Record<string, any>;
      historical.payload.frozen_payload_hash = `sha256:${"b".repeat(64)}`;
      await testEnv.FILES_BUCKET.put(`${beforePlan.artifact_key}.historical`, JSON.stringify(historical), { customMetadata: { synthetic: "historical-frozen-scope" } });
    }
    if (options.visualPlanTamper && beforePlan) {
      const original = await testEnv.FILES_BUCKET.get(beforePlan.artifact_key);
      if (!original) throw new Error("visual plan tamper fixture is unavailable");
      const tampered = JSON.parse(await original.text()) as { envelope: Record<string, unknown>; payload: Record<string, unknown> };
      tampered.payload.body_code_point_count = Number(tampered.payload.body_code_point_count || 0) + 1;
      tampered.envelope.payload_hash = await sha256Text(canonicalJson(tampered.payload));
      tampered.envelope.payload_length = new TextEncoder().encode(canonicalJson(tampered.payload)).byteLength;
      await testEnv.FILES_BUCKET.put(beforePlan.artifact_key, canonicalJson(tampered), { customMetadata: { synthetic: "tampered-plan-recomputed-hash" } });
    }
    const beforeVisualCalls = visualCalls;
    try {
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
    } catch (error) {
      visualReplayError = error instanceof EditorialRuntimeError ? error.code : String((error as { code?: unknown })?.code || error);
      result = { state: "visual_reconciliation_required", artifact_ids: [] };
    }
    const afterLedger = await coordinator.getFiveAgentVisualLedger(runId, userId, workspaceId);
    const afterJsonCount = beforePlan ? (await testEnv.FILES_BUCKET.list({ prefix: beforePlan.artifact_key.slice(0, beforePlan.artifact_key.indexOf("/visual/") + "/visual/".length) })).objects.length : 0;
    const afterBinary = afterLedger.artifacts.find(item => item.kind === "visual_asset")?.binary_storage_ref?.replace(/^r2:\/\//, "");
    const afterBinaryCount = afterBinary ? (await testEnv.FILES_BUCKET.list({ prefix: afterBinary.slice(0, afterBinary.lastIndexOf("/") + 1) })).objects.length : 0;
    const afterD1 = await testEnv.DB.prepare(`SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ? AND kind IN ('visual_plan', 'visual_asset', 'visual_qa_report')`).bind(runId).first<{ count: number }>();
    const afterPublication = await testEnv.DB.prepare(`SELECT count(*) AS count FROM publication_run_events WHERE run_id = ? AND event_type IN ('visual_planning', 'visual_generating', 'visual_ready', 'visual_plan_committed', 'visual_asset_committed', 'visual_qa_committed')`).bind(runId).first<{ count: number }>();
    visualReplayDelta = {
      adapter_calls: visualCalls - beforeVisualCalls,
      do_artifacts: afterLedger.artifacts.length - beforeLedger.artifacts.length,
      do_receipts: afterLedger.receipt_ids.length - beforeLedger.receipt_ids.length,
      do_events: afterLedger.event_ids.length - beforeLedger.event_ids.length,
      d1_rows: Number(afterD1?.count || 0) - Number(beforeD1?.count || 0),
      publication_events: Number(afterPublication?.count || 0) - Number(beforePublication?.count || 0),
      json_objects: afterJsonCount - beforeJsonCount,
      binary_objects: afterBinaryCount - beforeBinaryCount,
    };
  }
  const ledger = await coordinator.getFiveAgentArtifactLedger(runId, userId, workspaceId);
  const afterRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
  const projection = await runtimeEnv.DB.prepare(`SELECT state, progress_percent, state_revision, retry_count, error_code, next_action
    FROM publication_runs WHERE run_id = ?`).bind(runId).first<Record<string, unknown>>();
  const projectionEvents = await runtimeEnv.DB.prepare(`SELECT payload_hash FROM publication_run_events WHERE run_id = ? ORDER BY revision`).bind(runId).all<{ payload_hash: string }>();
  const doEvents = await coordinator.listFiveAgentEvents(runId, userId, workspaceId);
  return {
    runId,
    articleId,
    userId,
    workspaceId,
    result,
    writingCalls,
    reviewCalls,
    artifactCount: ledger.artifacts.length,
    receiptCount: ledger.receipt_ids.length,
    artifactIds: ledger.artifacts.map(item => item.artifact_id),
    visualCalls,
    visualExecuteCalls,
    visualProviderOperations,
    visualReconcileCalls,
    projectionFaultTriggered,
    callIntentCount: Number(afterRun.call_intent_count),
    revisionCount: Number(afterRun.revision_count),
    projection,
    projectionEventHashes: (projectionEvents.results || []).map(row => row.payload_hash),
    doEventHashes: doEvents.flatMap(row => row.payload_hash ? [row.payload_hash] : []),
    visualReplayDelta,
    visualReplayError,
    workflowError,
    visualIntentCheckpoint,
  };
}

async function replayFailedAdapterCall(
  outcome: Awaited<ReturnType<typeof executeSyntheticScenario>>,
  callKind: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
    await coordinatorShardName(outcome.userId, outcome.workspaceId, outcome.articleId, outcome.runId),
  );
  const replay = await coordinator.prepareFiveAgentCall({
    run_id: outcome.runId,
    call_kind: callKind,
    idempotency_key: idempotencyKey,
    attempt: 1,
    created_at: "2026-07-20T00:03:00.000Z",
  });
  return replay as Record<string, unknown>;
}

async function metadataFor(
  runId: string,
  articleId: string,
  recordingId: number,
  userId: string,
  workspaceId: string,
  kind: "article_brief" | "article_draft" | "review_report" | "frozen_article_version",
  inputIds: string[],
  createdAt: string,
) {
  const artifactId = await deriveArtifactId(kind, runId, `${kind}:pass`);
  const artifactKeyValue = artifactKey(userId, workspaceId, runId, kind, artifactId);
  const producer = kind === "review_report"
    ? { role: "editorial_review", version: PUBLICATION_AGENT_VERSIONS.editorial_review }
    : kind === "article_draft"
      ? { role: "writing", version: PUBLICATION_AGENT_VERSIONS.writing }
      : { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator };
  const skillPins = kind === "review_report"
    ? { review: PUBLICATION_SKILL_PINS.review }
    : { style: { id: "style_litianc_default", version: "2026-07-05" }, formatting: PUBLICATION_SKILL_PINS.formatting };
  const inputArtifactIdsJson = canonicalJson(inputIds);
  const base = {
    schema_version: WAVE2_SCHEMA_VERSION,
    artifact_id: artifactId,
    artifact_key: artifactKeyValue,
    kind,
    run_id: runId,
    article_id: articleId,
    recording_id: recordingId,
    user_id: userId,
    workspace_id: workspaceId,
    producer_role: producer.role,
    producer_version: producer.version,
    workflow_version: "editorial-workflow.v3",
    policy_version: "editorial-policy.v3",
    input_artifact_ids_json: inputArtifactIdsJson,
    payload_hash: await sha256Text(`${kind}:synthetic-payload`),
    payload_length: 32,
    idempotency_key: `${kind}:pass`,
    storage_ref: `r2://${artifactKeyValue}`,
    created_at: createdAt,
    skill_pins_hash: await hashJson(skillPins),
  };
  return {
    ...base,
    envelope_identity_hash: await hashJson(base),
  };
}

describe("Wave2B publishing runtime boundary", () => {
  it("rejects extra nested dynamic pin keys", () => {
    const valid = {
      ...PUBLICATION_SKILL_PINS,
      style: { id: "style_litianc_default", version: "2026-07-05" },
      adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
      model_pins: { writing: "glm-5.2", editorial_review: "rules-only" },
    };
    expect(isExactWave2PublicationSkillPins(valid)).toBe(true);
    expect(isExactWave2PublicationSkillPins({
      ...valid,
      style: { ...valid.style, source: "untrusted" },
    })).toBe(false);
    expect(isExactWave2PublicationSkillPins({
      ...valid,
      model_pins: { ...valid.model_pins, fallback: "glm-5.2" },
    })).toBe(false);
  });

  it("authenticates before the V3 flag and keeps disabled requests at zero storage access", async () => {
    const access = { db: 0, do: 0, r2: 0, workflow: 0, service: 0 };
    const offEnv = guardedEnv({
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FILES_TOKEN: "files-token",
      MINING_SERVICE_TOKEN: "old-internal-token",
      FIVE_AGENT_PUBLISHING_V3: "false",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "runtime_gate_user:runtime_gate_workspace",
    }, access);
    const off = await worker.fetch(request("dedicated-v3-token"), offEnv, {} as any);
    expect(off.status).toBe(404);

    const unauthorizedEnv = guardedEnv({
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FILES_TOKEN: "files-token",
      MINING_SERVICE_TOKEN: "old-internal-token",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "runtime_gate_user:runtime_gate_workspace",
    }, access);
    for (const token of ["files-token", "old-internal-token"]) {
      const unauthorized = await worker.fetch(request(token), unauthorizedEnv, {} as any);
      expect(unauthorized.status).toBe(401);
    }
    const miss = await worker.fetch(request("dedicated-v3-token", "runtime_gate_other_user"), unauthorizedEnv, {} as any);
    expect(miss.status).toBe(404);
    const malformed = await worker.fetch(request("dedicated-v3-token"), unauthorizedEnv, {} as any);
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("invalid_json");
    const validBody = publishingBody("title-hint-contract", 1, "runtime:title-hint", `sha256:${"0".repeat(64)}`);
    expect(() => normalizeFiveAgentStartBody({ ...validBody, title_hint: { invalid: true } })).toThrowError(/title_hint/);
    expect(() => normalizeFiveAgentStartBody({ ...validBody, title_hint: "x".repeat(501) })).toThrowError(/title_hint/);
    expect(access).toEqual({ db: 0, do: 0, r2: 0, workflow: 0, service: 0 });
  });

  it("blocks an unconfirmed Workflow before transcript or business side effects", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `runtime-v3-unconfirmed-${suffix}`;
    const articleId = `${runId}-article`;
    const userId = "runtime_v3_unconfirmed_user";
    const workspaceId = "runtime_v3_unconfirmed_workspace";
    const recordingId = 1910;
    const workflowId = `five-agent-${runId}`;
    const skillPins = {
      ...PUBLICATION_SKILL_PINS,
      style: { id: "style_litianc_default", version: "2026-07-05" },
      adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
      model_pins: { writing: "glm-5.2", editorial_review: "rules-only" },
    };
    const manifest = {
      schema_version: "editorial-orchestration.v3",
      run_id: runId,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      workflow_version: "editorial-workflow.v3",
      policy_version: "editorial-policy.v3",
      agent_versions: PUBLICATION_AGENT_VERSIONS,
      skill_pins: skillPins,
      adapter_pins: skillPins.adapter_pins,
      model_pins: skillPins.model_pins,
      idempotency_key: `run:${runId}`,
    };
    const manifestJson = canonicalJson(manifest);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
      await coordinatorShardName(userId, workspaceId, articleId, runId),
    );
    const createdAt = "2026-07-20T00:00:00.000Z";
    await coordinator.startFiveAgentRun({
      run_id: runId,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      payload_hash: await sha256Text(`run:${runId}`),
      manifest_hash: await sha256Text(manifestJson),
      manifest_json: manifestJson,
      workflow_id: workflowId,
      created_at: createdAt,
    }, false);

    const access = { db: 0, do: 0, r2: 0, workflow: 0, service: 0 };
    const guarded = guardedEnv({}, access);
    const workflowInstance = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    workflowInstance.env = guarded;
    workflowInstance._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    await expect(workflowInstance.run({
      payload: {
        run_id: runId,
        article_id: articleId,
        recording_id: recordingId,
        user_id: userId,
        workspace_id: workspaceId,
        payload_hash: await sha256Text(`run:${runId}`),
        manifest_hash: await sha256Text(manifestJson),
        manifest_json: manifestJson,
        workflow_id: workflowId,
        created_at: createdAt,
        transcript_ref: `runtime:v3:unconfirmed:${suffix}`,
        transcript_hash: await sha256Text("unread transcript"),
        source_hash: await sha256Text("unread transcript"),
        brief_artifact_id: `brief-${runId}`,
        brief_artifact_key: `editorial/v3/runtime/${runId}/brief.json`,
        brief_payload_hash: await sha256Text("unread brief"),
      },
      instanceId: workflowId,
    }, step)).rejects.toMatchObject({ code: "workflow_start_unconfirmed" });
    expect(access).toEqual({ db: 0, do: 0, r2: 0, workflow: 0, service: 0 });
    const run = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    expect(run.state).toBe("queued");
    expect(run.state_revision).toBe(0);
    expect((await coordinator.listFiveAgentArtifacts(runId, userId, workspaceId))).toHaveLength(0);
  });

  it("writes a redacted four-artifact pass ledger with strict DO metadata", async () => {
    const runId = `runtime-v3-pass-${Date.now()}`;
    const articleId = `runtime-v3-article-${Date.now()}`;
    const userId = "runtime_v3_user";
    const workspaceId = "runtime_v3_workspace";
    const recordingId = 1901;
    const workflowId = `five-agent-${runId}`;
    const style = { id: "style_litianc_default", version: "2026-07-05" };
    const skillPins = {
      ...PUBLICATION_SKILL_PINS,
      style,
      adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
      model_pins: { writing: "glm-5.2", editorial_review: "rules-only" },
    };
    const manifest = {
      schema_version: "editorial-orchestration.v3",
      run_id: runId,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      workflow_version: "editorial-workflow.v3",
      policy_version: "editorial-policy.v3",
      agent_versions: PUBLICATION_AGENT_VERSIONS,
      skill_pins: skillPins,
      adapter_pins: skillPins.adapter_pins,
      model_pins: skillPins.model_pins,
      idempotency_key: `run:${runId}`,
    };
    const manifestJson = canonicalJson(manifest);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
    await coordinator.startFiveAgentRun({
      run_id: runId,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      payload_hash: await sha256Text(`run:${runId}`),
      manifest_hash: await sha256Text(manifestJson),
      manifest_json: manifestJson,
      workflow_id: workflowId,
      created_at: "2026-07-20T00:00:00.000Z",
    }, false);

    const brief = await metadataFor(runId, articleId, recordingId, userId, workspaceId, "article_brief", [], "2026-07-20T00:00:01.000Z");
    const draft = await metadataFor(runId, articleId, recordingId, userId, workspaceId, "article_draft", [brief.artifact_id], "2026-07-20T00:00:02.000Z");
    const review = await metadataFor(runId, articleId, recordingId, userId, workspaceId, "review_report", [draft.artifact_id], "2026-07-20T00:00:03.000Z");
    const frozen = await metadataFor(runId, articleId, recordingId, userId, workspaceId, "frozen_article_version", [draft.artifact_id, review.artifact_id], "2026-07-20T00:00:04.000Z");
    for (const metadata of [brief, draft, review, frozen]) {
      const result = await coordinator.prepareFiveAgentArtifact({ run_id: runId, metadata, envelope_json: canonicalJson(metadata) });
      expect(result.status).toBe("prepared");
    }
    const ledger = await coordinator.getFiveAgentArtifactLedger(runId, userId, workspaceId);
    expect(ledger.artifacts).toHaveLength(4);
    expect(ledger.receipt_ids).toHaveLength(0);
    for (const artifact of ledger.artifacts) {
      expect(artifact).not.toHaveProperty("payload");
      expect(artifact).toHaveProperty("envelope_identity_hash");
    }
  });

  it("executes the synthetic service-backed pass path with four exact artifacts and content_frozen=62", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `runtime-v3-path-${suffix}`;
    const articleId = `runtime-v3-path-article-${suffix}`;
    const userId = "runtime_v3_path_user";
    const workspaceId = "runtime_v3_path_workspace";
    const recordingId = 1904;
    const transcriptRef = `runtime:v3:path-${suffix}`;
    const transcriptText = "Synthetic transcript for the Wave2B pass path.";
    const transcriptHash = await sha256Text(transcriptText);
    await runtimeEnv.FILES_BUCKET.put(transcriptRef, transcriptText, { customMetadata: { user_id: userId, workspace_id: workspaceId } });

    let writingCalls = 0;
    let reviewCalls = 0;
    const writing = serviceBinding(async (request) => {
      writingCalls += 1;
      const input = await request.json() as { run_id: string; article_id: string; recording_id: number; source_hash: string };
      return new Response(JSON.stringify({
        protocol_version: "vibepub.editorial.v3",
        result: await syntheticDraftPayload({ run_id: input.run_id, article_id: input.article_id, recording_id: input.recording_id, source_hash: input.source_hash }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const review = serviceBinding(async (request) => {
      reviewCalls += 1;
      const input = await request.json() as { article_id: string; run_id: string; recording_id: number; input_artifact_id: string; input_payload_hash: string; review_round: number };
      return new Response(JSON.stringify({
        protocol_version: "vibepub.editorial.review.v1",
        result: {
          article_id: input.article_id,
          run_id: input.run_id,
          recording_id: input.recording_id,
          input_artifact_id: input.input_artifact_id,
          input_payload_hash: input.input_payload_hash,
          review_round: input.review_round,
          decision: "pass",
          findings: [],
          revision_targets: [],
          suggested_actions: [],
          reviewer_version: "editorial-review.adapter.1.0.0",
          rules_pins: {
            dbs_ai_check: { id: "dbs-ai-check", version: "1.0.0" },
            humanizer: { id: "humanizer-zh", version: "1.0.0" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const workflow = {
      get: async () => ({ status: async () => ({ status: "queued" }) }),
      create: async (input: { id: string }) => ({ id: input.id }),
    };
    const testEnv = Object.create(runtimeEnv);
    Object.assign(testEnv, {
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      FIVE_AGENT_PUBLISHING_WORKFLOW: workflow,
      WRITING_AGENT: writing,
      REVIEW_AGENT: review,
      WRITING_AGENT_TOKEN: "synthetic-writing-token",
      REVIEW_AGENT_TOKEN: "synthetic-review-token",
      GLM_MODEL: "glm-5.2",
    });
    const body = publishingBody(runId, recordingId, transcriptRef, transcriptHash);
    body.article_id = articleId;
    const start = await worker.fetch(new Request("https://example.test/api/internal/v3/publishing/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer dedicated-v3-token",
        "x-vibepub-user-id": userId,
        "x-vibepub-workspace-id": workspaceId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }), testEnv, {} as any);
    expect([200, 202]).toContain(start.status);

    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
    const run = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    const brief = (await coordinator.listFiveAgentArtifacts(runId, userId, workspaceId)).find(item => item.kind === "article_brief");
    expect(brief).toBeDefined();
    const params = {
      run_id: runId,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      payload_hash: String(run.payload_hash),
      manifest_hash: String(run.manifest_hash),
      manifest_json: String(run.manifest_json),
      workflow_id: String(run.workflow_id),
      created_at: String(run.created_at),
      transcript_ref: transcriptRef,
      transcript_hash: transcriptHash,
      source_hash: transcriptHash,
      brief_artifact_id: String(brief!.artifact_id),
      brief_artifact_key: String(brief!.artifact_key),
      brief_payload_hash: String(brief!.payload_hash),
    };
    const workflowInstance = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    workflowInstance.env = testEnv;
    workflowInstance._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    const result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step);
    expect(result).toMatchObject({ run_id: runId, state: "content_frozen", artifact_ids: expect.any(Array) });
    expect(result.artifact_ids).toHaveLength(4);
    expect(writingCalls).toBe(1);
    expect(reviewCalls).toBe(1);
    const projection = await runtimeEnv.DB.prepare(`SELECT state, progress_percent, state_revision, retry_count
      FROM publication_runs WHERE run_id = ?`).bind(runId).first<Record<string, number | string>>();
    expect(projection).toMatchObject({ state: "content_frozen", progress_percent: 62, retry_count: 0 });
    const ledger = await coordinator.getFiveAgentArtifactLedger(runId, userId, workspaceId);
    expect(ledger.artifacts).toHaveLength(4);
    expect(ledger.receipt_ids).toHaveLength(4);
    const d1 = await runtimeEnv.DB.prepare(`SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ?`).bind(runId).first<{ count: number }>();
    expect(d1?.count).toBe(4);
  });

  it("keeps exact artifact counts for first-round P0, one P1 revision, and second-round P1 block", async () => {
    const p0 = await executeSyntheticScenario("p0");
    expect(p0.result).toMatchObject({ state: "needs_action", artifact_ids: expect.any(Array) });
    expect(p0.result.artifact_ids).toHaveLength(3);
    expect(p0.artifactCount).toBe(3);
    expect(p0.receiptCount).toBe(3);
    expect(p0.writingCalls).toBe(1);
    expect(p0.reviewCalls).toBe(1);
    expect(p0.projection).toMatchObject({ state: "needs_action", progress_percent: 50, error_code: "review_round_1_blocked" });
    expect(new Set(p0.projectionEventHashes).size).toBe(p0.projectionEventHashes.length);
    expect(new Set(p0.doEventHashes).size).toBe(p0.doEventHashes.length);

    const revised = await executeSyntheticScenario("p1_pass");
    expect(revised.result).toMatchObject({ state: "content_frozen", artifact_ids: expect.any(Array) });
    expect(revised.result.artifact_ids).toHaveLength(7);
    expect(revised.artifactCount).toBe(7);
    expect(revised.receiptCount).toBe(7);
    expect(revised.writingCalls).toBe(2);
    expect(revised.reviewCalls).toBe(2);
    expect(revised.projection).toMatchObject({ state: "content_frozen", progress_percent: 62 });
    expect(revised.revisionCount).toBe(1);
    expect(new Set(revised.projectionEventHashes).size).toBe(revised.projectionEventHashes.length);
    expect(new Set(revised.doEventHashes).size).toBe(revised.doEventHashes.length);

    const secondBlock = await executeSyntheticScenario("p1_block");
    expect(secondBlock.result).toMatchObject({ state: "needs_action", artifact_ids: expect.any(Array) });
    expect(secondBlock.result.artifact_ids).toHaveLength(6);
    expect(secondBlock.artifactCount).toBe(6);
    expect(secondBlock.receiptCount).toBe(6);
    expect(secondBlock.writingCalls).toBe(2);
    expect(secondBlock.reviewCalls).toBe(2);
    expect(secondBlock.projection).toMatchObject({ state: "needs_action", progress_percent: 50, error_code: "review_round_2_blocked" });
    expect(new Set(secondBlock.projectionEventHashes).size).toBe(secondBlock.projectionEventHashes.length);
    expect(new Set(secondBlock.doEventHashes).size).toBe(secondBlock.doEventHashes.length);
    const secondBlockCalls = { writing: secondBlock.writingCalls, review: secondBlock.reviewCalls };
    expect(secondBlockCalls).toEqual({ writing: 2, review: 2 });

    const secondP0 = await executeSyntheticScenario("p0_round2");
    expect(secondP0.result).toMatchObject({ state: "needs_action", artifact_ids: expect.any(Array) });
    expect(secondP0.result.artifact_ids).toHaveLength(6);
    expect(secondP0.artifactCount).toBe(6);
    expect(secondP0.receiptCount).toBe(6);
    expect(secondP0.writingCalls).toBe(2);
    expect(secondP0.reviewCalls).toBe(2);
    expect(secondP0.projection).toMatchObject({ state: "needs_action", progress_percent: 50, error_code: "review_round_2_blocked" });
    expect(new Set(secondP0.projectionEventHashes).size).toBe(secondP0.projectionEventHashes.length);
    expect(new Set(secondP0.doEventHashes).size).toBe(secondP0.doEventHashes.length);
  });

  it("projects Writing and Review failures from the real Workflow with one or three provider calls", async () => {
    const writingNonRetry = await executeSyntheticScenario("p2_pass", { role: "writing", retryable: false });
    expect(writingNonRetry.result).toMatchObject({ state: "failed", artifact_ids: expect.any(Array) });
    expect(writingNonRetry.result.artifact_ids).toHaveLength(1);
    expect(writingNonRetry.writingCalls).toBe(1);
    expect(writingNonRetry.reviewCalls).toBe(0);
    expect(writingNonRetry.projection).toMatchObject({
      state: "failed", error_code: "writing_adapter_non_retryable", retry_count: 1,
      progress_percent: 28,
    });

    const writingRetry = await executeSyntheticScenario("p2_pass", { role: "writing", retryable: true });
    expect(writingRetry.result).toMatchObject({ state: "failed" });
    expect(writingRetry.writingCalls).toBe(3);
    expect(writingRetry.reviewCalls).toBe(0);
    expect(writingRetry.projection).toMatchObject({
      state: "failed", error_code: "writing_adapter_retry_exhausted", retry_count: 3,
      progress_percent: 28,
    });

    const reviewNonRetry = await executeSyntheticScenario("p2_pass", { role: "review", retryable: false });
    expect(reviewNonRetry.result).toMatchObject({ state: "failed" });
    expect(reviewNonRetry.artifactCount).toBe(2);
    expect(reviewNonRetry.writingCalls).toBe(1);
    expect(reviewNonRetry.reviewCalls).toBe(1);
    expect(reviewNonRetry.projection).toMatchObject({
      state: "failed", error_code: "review_adapter_non_retryable", retry_count: 1,
      progress_percent: 50,
    });

    const reviewRetry = await executeSyntheticScenario("p2_pass", { role: "review", retryable: true });
    expect(reviewRetry.result).toMatchObject({ state: "failed" });
    expect(reviewRetry.artifactCount).toBe(2);
    expect(reviewRetry.writingCalls).toBe(1);
    expect(reviewRetry.reviewCalls).toBe(3);
    expect(reviewRetry.projection).toMatchObject({
      state: "failed", error_code: "review_adapter_retry_exhausted", retry_count: 3,
      progress_percent: 50,
    });
  });

  it("holds an unknown draft artifact write and replays the durable call without a provider call", async () => {
    const held = await executeSyntheticScenario("p2_pass", undefined, true);
    expect(held.result).toMatchObject({ state: "needs_action", artifact_ids: [expect.any(String)] });
    expect(held.writingCalls).toBe(1);
    expect(held.reviewCalls).toBe(0);
    expect(held.projection).toMatchObject({
      state: "needs_action",
      error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect",
    });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
      await coordinatorShardName(held.userId, held.workspaceId, held.articleId, held.runId),
    );
    const artifacts = await coordinator.listFiveAgentArtifacts(held.runId, held.userId, held.workspaceId);
    const brief = artifacts.find(item => item.kind === "article_brief");
    expect(brief).toBeDefined();
    const replay = await coordinator.prepareFiveAgentCall({
      run_id: held.runId,
      call_kind: "writing_initial",
      idempotency_key: `draft:1:${brief!.artifact_id}`,
      attempt: 1,
      created_at: "2026-07-20T00:02:00.000Z",
    });
    expect(replay).toMatchObject({ status: "needs_action", error_code: "external_side_effect_unknown", retryable: false });
    const replayedRun = await coordinator.getFiveAgentRun(held.runId, held.userId, held.workspaceId) as Record<string, unknown>;
    expect(replayedRun.call_intent_count).toBe(1);
    expect(artifacts.filter(item => item.kind === "review_report")).toHaveLength(0);
  });

  it("treats a first-round P2-only finding as non-blocking and freezes four artifacts", async () => {
    const p2 = await executeSyntheticScenario("p2_pass");
    expect(p2.result).toMatchObject({ state: "content_frozen", artifact_ids: expect.any(Array) });
    expect(p2.result.artifact_ids).toHaveLength(4);
    expect(p2.artifactCount).toBe(4);
    expect(p2.receiptCount).toBe(4);
    expect(p2.writingCalls).toBe(1);
    expect(p2.reviewCalls).toBe(1);
    expect(p2.projection).toMatchObject({ state: "content_frozen", progress_percent: 62 });
    expect(new Set(p2.projectionEventHashes).size).toBe(p2.projectionEventHashes.length);
    expect(new Set(p2.doEventHashes).size).toBe(p2.doEventHashes.length);
  });

  it("runs the same frozen result through the gated visual chain to visual_ready with exact visual artifacts", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualReplay: true });
    expect(visual.result).toMatchObject({ state: "visual_ready", artifact_ids: expect.any(Array) });
    expect(visual.result.artifact_ids).toHaveLength(9);
    expect(visual.projection).toMatchObject({ state: "visual_ready", progress_percent: 80, error_code: null, next_action: null });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(5);
    expect(ledger.receipt_ids).toHaveLength(5);
    expect(ledger.event_ids).toHaveLength(5);
    expect(ledger.artifacts.filter(item => item.kind === "visual_plan")).toHaveLength(1);
    expect(ledger.artifacts.filter(item => item.kind === "visual_asset")).toHaveLength(3);
    expect(ledger.artifacts.filter(item => item.kind === "visual_qa_report")).toHaveLength(1);
    expect(visual.visualCalls).toBe(4);
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReplayDelta).toEqual({ adapter_calls: 0, do_artifacts: 0, do_receipts: 0, do_events: 0, d1_rows: 0, publication_events: 0, json_objects: 0, binary_objects: 0 });
    const binaryRef = ledger.artifacts.find(item => item.kind === "visual_asset")!.binary_storage_ref!;
    const binaryPrefix = binaryRef.replace(/^r2:\/\//, "").replace(/\/[^/]+\/[^/]+$/, "/");
    const binaries = await runtimeEnv.FILES_BUCKET.list({ prefix: binaryPrefix });
    expect(binaries.objects).toHaveLength(3);
    const jsonPrefix = ledger.artifacts.find(item => item.kind === "visual_plan")!.artifact_key.split("/visual/")[0] + "/visual/";
    const jsonObjects = await runtimeEnv.FILES_BUCKET.list({ prefix: jsonPrefix });
    expect(jsonObjects.objects.filter((item: { key: string }) => item.key.endsWith(".json")).length).toBe(5);
  });

  it("runs the long visual chain with five body slots and exact JSON/PNG counts", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualLong: true });
    expect(visual.result).toMatchObject({ state: "visual_ready", artifact_ids: expect.any(Array) });
    expect(visual.result.artifact_ids).toHaveLength(12);
    expect(visual.visualCalls).toBe(7);
    expect(visual.visualExecuteCalls).toBe(7);
    expect(visual.visualProviderOperations).toBe(6);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(8);
    expect(ledger.artifacts.filter(item => item.kind === "visual_asset")).toHaveLength(6);
    const binaryRef = ledger.artifacts.find(item => item.kind === "visual_asset")!.binary_storage_ref!;
    const binaryPrefix = binaryRef.replace(/^r2:\/\//, "").replace(/\/[^/]+\/[^/]+$/, "/");
    expect((await runtimeEnv.FILES_BUCKET.list({ prefix: binaryPrefix })).objects).toHaveLength(6);
    const jsonPrefix = ledger.artifacts.find(item => item.kind === "visual_plan")!.artifact_key.split("/visual/")[0] + "/visual/";
    expect((await runtimeEnv.FILES_BUCKET.list({ prefix: jsonPrefix })).objects.filter((item: { key: string }) => item.key.endsWith(".json")).length).toBe(8);
  });

  it.each([
    ["visual_planning after the committed plan", "plan"],
    ["visual_generating after the committed cover", "cover"],
  ] as const)("resumes the whole Workflow from %s without replaying completed provider work", async (_label, restartAt) => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualWholeRunRestartAt: restartAt,
    });
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReconcileCalls).toBe(0);
    expect(visual.projection?.error_code).toBeNull();
    expect({ result: visual.result, projection: visual.projection }).toMatchObject({ result: { state: "visual_ready" }, projection: { state: "visual_ready" } });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(5);
    expect(ledger.receipt_ids).toHaveLength(5);
    expect(ledger.event_ids).toHaveLength(5);
  });

  it("resumes a visual external-side-effect hold through D1 retrying without another execute", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualFailure: "unknown",
      visualWholeRunRestartAt: "unknown",
    });
    expect(visual.result).toMatchObject({ state: "needs_action" });
    expect(visual.projection).toMatchObject({
      state: "needs_action",
      error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect",
    });
    expect(visual.visualExecuteCalls).toBe(3);
    expect(visual.visualProviderOperations).toBe(2);
    expect(visual.visualReconcileCalls).toBe(1);
    expect(visual.visualCalls).toBe(4);
  });

  it("keeps a binding fetch exception inflight and reconciles the exact attempt without advancing", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualBindingFetchThrow: true,
    });
    expect(visual.result).toMatchObject({ state: "needs_action" });
    expect(visual.projection).toMatchObject({
      state: "needs_action",
      error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect",
    });
    expect(visual.visualExecuteCalls).toBe(3);
    expect(visual.visualProviderOperations).toBe(2);
    expect(visual.visualReconcileCalls).toBe(1);
    expect(visual.visualCalls).toBe(4);
  });

  it("does not create a visual call while reconciling a hold that has no durable call intent", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualFrozenReadHold: true,
    });
    expect(visual.result).toMatchObject({ state: "needs_action" });
    expect(visual.projection).toMatchObject({
      state: "needs_action",
      error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect",
    });
    expect(visual.visualCalls).toBe(0);
    expect(visual.visualExecuteCalls).toBe(0);
    expect(visual.visualProviderOperations).toBe(0);
    expect(visual.visualReconcileCalls).toBe(0);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const calls = await coordinator.listFiveAgentCallAttempts(visual.runId, visual.userId, visual.workspaceId);
    expect(calls.filter(call => call.call_kind.startsWith("visual_"))).toHaveLength(0);
  });

  it("reconciles an adapter-stored image result on whole-Workflow re-entry and reaches visual_ready", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualWholeRunSuccessfulReconcile: true,
    });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.projection).toMatchObject({ state: "visual_ready", progress_percent: 80, error_code: null });
    expect(visual.visualCalls).toBe(5);
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReconcileCalls).toBe(1);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(5);
    expect(ledger.receipt_ids).toHaveLength(5);
    expect(ledger.event_ids).toHaveLength(5);
    const publicationEvents = await runtimeEnv.DB.prepare(`SELECT payload_hash, created_at FROM publication_run_events WHERE run_id = ? ORDER BY revision`).bind(visual.runId).all<{ payload_hash: string; created_at: string }>();
    const publicationTimes = (publicationEvents.results || []).map(event => Date.parse(event.created_at));
    expect(publicationTimes.every((time, index) => index === 0 || time > publicationTimes[index - 1])).toBe(true);
    const stateEvents = await coordinator.listFiveAgentEvents(visual.runId, visual.userId, visual.workspaceId);
    const durableEvents = [...stateEvents, ...ledger.visual_events].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
    const durableTimes = durableEvents.map(event => Date.parse(event.created_at));
    expect(durableTimes.every((time, index) => index === 0 || time > durableTimes[index - 1])).toBe(true);
    const publicationTimeByPayload = new Map((publicationEvents.results || []).map(event => [event.payload_hash, event.created_at]));
    const eventTimeMismatches = durableEvents
      .filter(event => !event.payload_hash || publicationTimeByPayload.get(event.payload_hash) !== event.created_at)
      .map(event => ({ event_type: event.event_type, state_revision: event.state_revision, payload_hash: event.payload_hash, do_created_at: event.created_at, d1_created_at: event.payload_hash ? publicationTimeByPayload.get(event.payload_hash) : null }));
    expect(eventTimeMismatches).toEqual([]);
  });

  it("recovers a post-QA exact-set hold locally without another adapter or provider call", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualQaWholeRunRecovery: true,
    });
    expect(visual.projection).toMatchObject({ state: "visual_ready", progress_percent: 80, error_code: null, next_action: null });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.visualCalls).toBe(4);
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReconcileCalls).toBe(0);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(5);
    expect(ledger.receipt_ids).toHaveLength(5);
    expect(ledger.event_ids).toHaveLength(5);
    expect(ledger.artifacts.filter(item => item.kind === "visual_qa_report")).toHaveLength(1);
  });

  it("writes the visual asset intent before binary storage and recovers that checkpoint without another provider operation", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualAssetIntentRestart: true,
    });
    expect(visual.visualIntentCheckpoint).toEqual({ asset_intents: 1, binary_objects: 0 });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReconcileCalls).toBe(1);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(5);
    expect(ledger.receipt_ids).toHaveLength(5);
    expect(ledger.event_ids).toHaveLength(5);
  });

  it("replays after the main visual call ledger success response is lost", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualResponseLoss: true });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.result.artifact_ids).toHaveLength(9);
    expect(visual.visualReconcileCalls).toBe(0);
    expect(visual.visualCalls).toBe(4);
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.artifactCount).toBe(4);
  });

  it("reconciles an adapter execute response loss without another provider operation", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualAdapterResponseLoss: true });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.visualCalls).toBe(5);
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReconcileCalls).toBe(1);
    expect(visual.artifactCount).toBe(4);
  });

  it.each([
    ["visual JSON", { visualJsonResponseLoss: true }],
    ["visual binary", { visualBinaryResponseLoss: true }],
    ["publication projection", { visualProjectionResponseLoss: true }],
    ["DO visual receipt", { visualReceiptResponseLoss: true }],
  ])("reconciles %s response loss without an additional provider operation", async (_label, fault) => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, ...fault });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.result.artifact_ids).toHaveLength(9);
    expect(visual.visualCalls).toBe(5);
    expect(visual.visualExecuteCalls).toBe(4);
    expect(visual.visualProviderOperations).toBe(3);
    expect(visual.visualReconcileCalls).toBeGreaterThanOrEqual(1);
    if (_label === "publication projection") expect(visual.projectionFaultTriggered).toBe(true);
    expect(visual.artifactCount).toBe(4);
  });

  it("rejects an extra object in the current frozen/plan scope while preserving completed artifacts", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualReplay: true, visualExtraScope: true });
    expect(visual.result).toMatchObject({ state: "visual_reconciliation_required" });
    expect(visual.visualReplayError).toBe("visual_artifact_reconciliation_required");
    expect(visual.visualCalls).toBe(4);
    expect(visual.artifactCount).toBe(4);
  });

  it("recomputes a completed plan instead of trusting a self-rehashed plan payload", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualReplay: true, visualPlanTamper: true });
    expect(visual.result).toMatchObject({ state: "visual_reconciliation_required" });
    expect(["visual_artifact_identity_conflict", "visual_artifact_reconciliation_required"]).toContain(visual.visualReplayError);
    expect(visual.visualCalls).toBe(4);
    expect(visual.visualReplayDelta).toMatchObject({ adapter_calls: 0, do_artifacts: 0, do_receipts: 0, do_events: 0, d1_rows: 0, publication_events: 0, binary_objects: 0 });
  });

  it("allows an older frozen scope to remain beside the current visual execution", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualReplay: true, visualHistoricalScope: true });
    expect(visual.result).toMatchObject({ state: "visual_ready" });
    expect(visual.visualReplayError).toBeUndefined();
    expect(visual.visualCalls).toBe(4);
    expect(visual.visualReplayDelta).toMatchObject({ adapter_calls: 0, do_artifacts: 0, do_receipts: 0, do_events: 0, d1_rows: 0, publication_events: 0, binary_objects: 0 });
    expect(visual.visualReplayDelta?.json_objects).toBe(1);
  });

  it.each([
    ["cover transparency", { visualCoverTransparent: true }],
    ["body non-white", { visualBodyNonWhite: true }],
  ])("persists a complete QA failure report for %s", async (_label, fault) => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, ...fault });
    expect(visual.result).toMatchObject({ state: "needs_action" });
    expect(visual.projection).toMatchObject({ state: "needs_action", error_code: "visual_qa_failed", next_action: "review_visual_assets" });
    expect(visual.visualCalls).toBe(4);
    expect(visual.artifactCount).toBe(4);
    expect(visual.receiptCount).toBe(4);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts).toHaveLength(5);
    expect(ledger.receipt_ids).toHaveLength(5);
    expect(ledger.artifacts.filter(item => item.kind === "visual_qa_report")).toHaveLength(1);
    const qa = ledger.artifacts.find(item => item.kind === "visual_qa_report");
    expect(qa?.payload_summary.qa_decision).toBe("failed");
    expect(qa?.payload_summary.qa_version).toBe("visual_qa_report.v2");
    const plan = ledger.artifacts.find(item => item.kind === "visual_plan")!;
    const jsonPrefix = plan.artifact_key.split("/visual/")[0] + "/visual/";
    expect((await runtimeEnv.FILES_BUCKET.list({ prefix: jsonPrefix })).objects.filter((item: { key: string }) => item.key.endsWith(".json"))).toHaveLength(5);
    const binaryRef = ledger.artifacts.find(item => item.kind === "visual_asset")!.binary_storage_ref!;
    const binaryPrefix = binaryRef.replace(/^r2:\/\//, "").replace(/\/[^/]+\/[^/]+$/, "/");
    expect((await runtimeEnv.FILES_BUCKET.list({ prefix: binaryPrefix })).objects).toHaveLength(3);
    const qaObject = await runtimeEnv.FILES_BUCKET.get(qa!.artifact_key);
    expect(qaObject).toBeTruthy();
    const qaPayload = JSON.parse(await qaObject!.text()).payload;
    expect(qaPayload).toMatchObject({ passed: false, asset_artifact_ids: expect.any(Array), asset_byte_hashes: expect.any(Array) });
    expect(qaPayload.asset_artifact_ids).toHaveLength(3);
    expect(qaPayload.asset_byte_hashes).toHaveLength(3);
  });

  it("returns the persisted QA artifact when post-QA exact-set reconciliation holds", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualQaExactSetFailure: true });
    expect(visual.result).toMatchObject({ state: "needs_action", artifact_ids: expect.any(Array) });
    expect(visual.result.artifact_ids).toHaveLength(9);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    const qa = ledger.artifacts.find(item => item.kind === "visual_qa_report");
    expect(qa).toBeDefined();
    expect(visual.result.artifact_ids).toContain(qa!.artifact_id);
  });

  it("holds after visual planning when there are not enough unique blocks", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualInsufficientBlocks: true });
    expect(visual.result).toMatchObject({ state: "needs_action" });
    expect(visual.projection).toMatchObject({ state: "needs_action", error_code: "visual_plan_insufficient_unique_blocks", next_action: "revise_content_before_visuals" });
    expect(visual.visualCalls).toBe(0);
    expect(visual.visualExecuteCalls).toBe(0);
    expect(visual.visualProviderOperations).toBe(0);
    expect(visual.artifactCount).toBe(4);
    expect(visual.receiptCount).toBe(4);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    await expect(coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId)).resolves.toMatchObject({ artifacts: [], receipt_ids: [], event_ids: [] });
  });

  it("keeps the completed freeze and stops after a known body image failure", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualFailure: "nonretry" });
    expect(visual.result).toMatchObject({ state: "failed" });
    expect(visual.projection).toMatchObject({ state: "failed", error_code: "visual_generation_non_retryable", retry_count: 1 });
    expect(visual.visualExecuteCalls).toBe(3);
    expect(visual.visualProviderOperations).toBe(2);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts.filter(item => item.kind === "visual_plan")).toHaveLength(1);
    expect(ledger.artifacts.filter(item => item.kind === "visual_asset")).toHaveLength(1);
    expect(ledger.artifacts.some(item => item.payload_summary.slot_id === "body_02")).toBe(false);
    expect(visual.artifactCount).toBe(4);
  });

  it("exhausts exactly three body image attempts and stops before the next slot", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualFailure: "retryable" });
    expect(visual.result).toMatchObject({ state: "failed" });
    expect(visual.projection).toMatchObject({ state: "failed", error_code: "visual_generation_retry_exhausted", retry_count: 3, next_action: "retry" });
    expect(visual.visualExecuteCalls).toBe(5);
    expect(visual.visualProviderOperations).toBe(4);
    expect(visual.artifactCount).toBe(4);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const calls = await coordinator.listFiveAgentCallAttempts(visual.runId, visual.userId, visual.workspaceId);
    const imageCalls = calls.filter(call => call.call_kind === "visual_image");
    expect(imageCalls).toHaveLength(4);
    expect(imageCalls.map(call => call.attempt).sort((left, right) => left - right)).toEqual([1, 1, 2, 3]);
    const attemptsByOperation = new Map<string, number[]>();
    for (const call of imageCalls) {
      const attempts = attemptsByOperation.get(call.idempotency_key) || [];
      attempts.push(call.attempt);
      attemptsByOperation.set(call.idempotency_key, attempts);
    }
    expect([...attemptsByOperation.values()].map(attempts => attempts.sort((left, right) => left - right)).sort((left, right) => left.length - right.length)).toEqual([[1], [1, 2, 3]]);
    expect(imageCalls.some(call => call.attempt > 3)).toBe(false);
  });

  it("holds unknown body image side effects and never executes a later slot", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualFailure: "unknown" });
    expect(visual.result).toMatchObject({ state: "needs_action" });
    expect(visual.projection).toMatchObject({ state: "needs_action", error_code: "external_side_effect_unknown", next_action: "reconcile_external_side_effect" });
    expect(visual.visualExecuteCalls).toBe(3);
    expect(visual.visualProviderOperations).toBe(2);
    expect(visual.visualReconcileCalls).toBeGreaterThanOrEqual(1);
    expect(visual.artifactCount).toBe(4);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    const ledger = await coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId);
    expect(ledger.artifacts.filter(item => item.kind === "visual_asset")).toHaveLength(1);
    expect(ledger.artifacts.some(item => item.payload_summary.slot_id === "body_02")).toBe(false);
  });

  it("stops visual work after a content_frozen cancel without writing visual artifacts", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualPreCancelled: true });
    expect(visual.result).toMatchObject({ state: "cancelled" });
    expect(visual.projection).toMatchObject({ state: "cancelled" });
    expect(visual.visualCalls).toBe(0);
    expect(visual.visualExecuteCalls).toBe(0);
    expect(visual.visualProviderOperations).toBe(0);
    expect(visual.visualReconcileCalls).toBe(0);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    await expect(coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId)).resolves.toMatchObject({ artifacts: [], receipt_ids: [], event_ids: [] });
    const d1 = await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ? AND kind IN ('visual_plan', 'visual_asset', 'visual_qa_report')").bind(visual.runId).first<{ count: number }>();
    expect(Number(d1?.count || 0)).toBe(0);
  });

  it("fails closed when the cancellation projection read is unavailable", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualCancellationReadFailure: true });
    expect(visual.workflowError).toBe("external_side_effect_unknown");
    expect(visual.visualCalls).toBe(0);
    expect(visual.visualExecuteCalls).toBe(0);
    expect(visual.visualProviderOperations).toBe(0);
    expect(visual.artifactCount).toBe(4);
    expect(visual.projection).toMatchObject({ state: "content_frozen" });
  });

  it("keeps content_frozen when the visual flag is on but the tenant is not allowlisted", async () => {
    const visual = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualAllowlistMismatch: true });
    expect(visual.result).toMatchObject({ state: "content_frozen" });
    expect(visual.visualCalls).toBe(0);
    expect(visual.visualExecuteCalls).toBe(0);
    expect(visual.visualProviderOperations).toBe(0);
    expect(visual.visualReconcileCalls).toBe(0);
    expect(visual.artifactCount).toBe(4);
    expect(visual.receiptCount).toBe(4);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(visual.userId, visual.workspaceId, visual.articleId, visual.runId));
    await expect(coordinator.getFiveAgentVisualLedger(visual.runId, visual.userId, visual.workspaceId)).resolves.toMatchObject({ artifacts: [], receipt_ids: [], event_ids: [] });
    const d1 = await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ? AND kind IN ('visual_plan', 'visual_asset', 'visual_qa_report')").bind(visual.runId).first<{ count: number }>();
    expect(Number(d1?.count || 0)).toBe(0);
    const r2 = await runtimeEnv.FILES_BUCKET.list({ prefix: "editorial/" });
    expect(r2.objects.filter((item: { key: string }) => item.key.includes(visual.runId) && (item.key.includes("/visual/") || item.key.includes("/visual-binary/")))).toHaveLength(0);
  });

  it("keeps the Wave2B freeze result and performs no visual adapter call when the visual gate is off", async () => {
    const baseline = await executeSyntheticScenario("p2_pass");
    expect(baseline.result).toMatchObject({ state: "content_frozen" });
    expect(baseline.projection).toMatchObject({ state: "content_frozen", progress_percent: 62 });
    expect(baseline.artifactIds).toHaveLength(4);
    expect(baseline.visualCalls).toBe(0);
  });

  it("rejects a review response from the wrong round before immutable persistence", async () => {
    const firstRound = await executeSyntheticScenario("p2_pass", undefined, false, {
      reviewRoundOverride: { 1: 2 },
    });
    expect(firstRound.result).toMatchObject({ state: "failed" });
    expect(firstRound.artifactCount).toBe(2);
    expect(firstRound.receiptCount).toBe(2);
    expect(firstRound.reviewCalls).toBe(1);
    expect(firstRound.callIntentCount).toBe(2);
    expect(firstRound.projection).toMatchObject({
      state: "failed",
      error_code: "review_adapter_non_retryable",
      next_action: "retry_after_service_fix",
      retry_count: 1,
    });
    expect(firstRound.revisionCount).toBe(0);
    const firstDraftId = firstRound.artifactIds.find(artifactId => artifactId.includes("article_draft"));
    expect(firstDraftId).toBeDefined();
    expect(await replayFailedAdapterCall(firstRound, "editorial_review_1", `review:1:${firstDraftId}`)).toMatchObject({
      status: "failed",
      error_code: "review_adapter_non_retryable",
      retryable: false,
      attempt: 1,
    });

    const secondRound = await executeSyntheticScenario("p1_pass", undefined, false, {
      reviewRoundOverride: { 2: 1 },
    });
    expect(secondRound.result).toMatchObject({ state: "failed" });
    expect(secondRound.artifactCount).toBe(5);
    expect(secondRound.receiptCount).toBe(5);
    expect(secondRound.writingCalls).toBe(2);
    expect(secondRound.reviewCalls).toBe(2);
    expect(secondRound.callIntentCount).toBe(4);
    expect(secondRound.revisionCount).toBe(1);
    expect(secondRound.projection).toMatchObject({
      state: "failed",
      error_code: "review_adapter_non_retryable",
      next_action: "retry_after_service_fix",
      retry_count: 1,
    });
    const secondDraftIds = secondRound.artifactIds.filter(artifactId => artifactId.includes("article_draft"));
    const secondDraftId = secondDraftIds[secondDraftIds.length - 1];
    expect(secondDraftId).toBeDefined();
    expect(await replayFailedAdapterCall(secondRound, "editorial_review_2", `review:2:${secondDraftId}`)).toMatchObject({
      status: "failed",
      error_code: "review_adapter_non_retryable",
      retryable: false,
      attempt: 1,
    });
  });

  it("rejects initial and revision drafts whose pins drift from the run manifest before storage", async () => {
    const drifts = ["model", "adapter", "style", "formatting", "style_body_hash"] as const;
    for (const drift of drifts) {
      const initial = await executeSyntheticScenario("p2_pass", undefined, false, { draftPinDrift: drift });
      expect(initial.result, `initial ${drift}`).toMatchObject({ state: "failed" });
      expect(initial.artifactCount, `initial ${drift} artifacts`).toBe(1);
      expect(initial.receiptCount, `initial ${drift} receipts`).toBe(1);
      expect(initial.writingCalls, `initial ${drift} calls`).toBe(1);
      expect(initial.reviewCalls, `initial ${drift} review calls`).toBe(0);
      expect(initial.callIntentCount, `initial ${drift} intents`).toBe(1);
      expect(initial.projection, `initial ${drift} state`).toMatchObject({
        state: "failed",
        error_code: "writing_adapter_non_retryable",
        next_action: "retry_after_service_fix",
        retry_count: 1,
      });
      const initialBriefId = initial.artifactIds.find(artifactId => artifactId.includes("article_brief"));
      expect(initialBriefId).toBeDefined();
      expect(await replayFailedAdapterCall(initial, "writing_initial", `draft:1:${initialBriefId}`)).toMatchObject({
        status: "failed",
        error_code: "writing_adapter_non_retryable",
        retryable: false,
        attempt: 1,
      });
    }
    for (const drift of drifts) {
      const revision = await executeSyntheticScenario("p1_pass", undefined, false, { draftPinDrift: drift });
      expect(revision.result, `revision ${drift}`).toMatchObject({ state: "failed" });
      expect(revision.artifactCount, `revision ${drift} artifacts`).toBe(4);
      expect(revision.receiptCount, `revision ${drift} receipts`).toBe(4);
      expect(revision.writingCalls, `revision ${drift} calls`).toBe(2);
      expect(revision.reviewCalls, `revision ${drift} reviews`).toBe(1);
      expect(revision.callIntentCount, `revision ${drift} intents`).toBe(3);
      expect(revision.revisionCount, `revision ${drift} count`).toBe(1);
      expect(revision.projection, `revision ${drift} state`).toMatchObject({
        state: "failed",
        error_code: "writing_adapter_non_retryable",
        next_action: "retry_after_service_fix",
        retry_count: 1,
      });
      const dispatchId = revision.artifactIds.find(artifactId => artifactId.includes("revision_dispatch"));
      expect(dispatchId).toBeDefined();
      expect(await replayFailedAdapterCall(revision, "writing_revision", `draft:2:${dispatchId}`)).toMatchObject({
        status: "failed",
        error_code: "writing_adapter_non_retryable",
        retryable: false,
        attempt: 1,
      });
    }
  });

  it("classifies all response pre-persistence integrity assertions and excludes run/config holds", () => {
    expect(PRE_PERSISTENCE_INTEGRITY_ERROR_CODES).toEqual([
      "draft_manifest_pin_conflict",
      "frozen_draft_pin_conflict",
      "frozen_style_profile_conflict",
      "review_round_conflict",
      "frozen_review_pin_conflict",
    ]);
    for (const code of PRE_PERSISTENCE_INTEGRITY_ERROR_CODES) {
      expect(isPrePersistenceIntegrityError(new EditorialRuntimeError(code, code))).toBe(true);
    }
    for (const code of ["manifest_invalid", "manifest_pin_conflict", "external_side_effect_unknown", "artifact_reconciliation_required"]) {
      expect(isPrePersistenceIntegrityError(new EditorialRuntimeError(code, code))).toBe(false);
    }
  });

  it("records first and second review pin drift as durable non-retryable failures", async () => {
    const firstRound = await executeSyntheticScenario("p2_pass", undefined, false, { reviewPinDrift: "reviewer_version" });
    expect(firstRound.result).toMatchObject({ state: "failed" });
    expect(firstRound.artifactCount).toBe(2);
    expect(firstRound.receiptCount).toBe(2);
    expect(firstRound.writingCalls).toBe(1);
    expect(firstRound.reviewCalls).toBe(1);
    expect(firstRound.callIntentCount).toBe(2);
    expect(firstRound.projection).toMatchObject({
      state: "failed",
      error_code: "review_adapter_non_retryable",
      next_action: "retry_after_service_fix",
      retry_count: 1,
    });
    const firstDraftId = firstRound.artifactIds.find(artifactId => artifactId.includes("article_draft"));
    expect(firstDraftId).toBeDefined();
    expect(await replayFailedAdapterCall(firstRound, "editorial_review_1", `review:1:${firstDraftId}`)).toMatchObject({
      status: "failed",
      error_code: "review_adapter_non_retryable",
      retryable: false,
      attempt: 1,
    });

    const secondRound = await executeSyntheticScenario("p1_pass", undefined, false, { reviewPinDrift: "rules_pins" });
    expect(secondRound.result).toMatchObject({ state: "failed" });
    expect(secondRound.artifactCount).toBe(5);
    expect(secondRound.receiptCount).toBe(5);
    expect(secondRound.writingCalls).toBe(2);
    expect(secondRound.reviewCalls).toBe(2);
    expect(secondRound.callIntentCount).toBe(4);
    expect(secondRound.revisionCount).toBe(1);
    expect(secondRound.projection).toMatchObject({
      state: "failed",
      error_code: "review_adapter_non_retryable",
      next_action: "retry_after_service_fix",
      retry_count: 1,
    });
    const secondDraftIds = secondRound.artifactIds.filter(artifactId => artifactId.includes("article_draft"));
    const secondDraftId = secondDraftIds[secondDraftIds.length - 1];
    expect(await replayFailedAdapterCall(secondRound, "editorial_review_2", `review:2:${secondDraftId}`)).toMatchObject({
      status: "failed",
      error_code: "review_adapter_non_retryable",
      retryable: false,
      attempt: 1,
    });
  });

  it("replays durable failed adapter attempts without a new call and projects their count", async () => {
    const runId = `runtime-v3-failed-${Date.now()}`;
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(`runtime-v3-${runId}`);
    const manifest = canonicalJson({
      schema_version: "editorial-orchestration.v3",
      run_id: runId,
      article_id: "runtime-v3-failed-article",
      recording_id: 1902,
      user_id: "runtime_v3_user",
      workspace_id: "runtime_v3_workspace",
      workflow_version: "editorial-workflow.v3",
      policy_version: "editorial-policy.v3",
      agent_versions: PUBLICATION_AGENT_VERSIONS,
      skill_pins: {
        ...PUBLICATION_SKILL_PINS,
        style: { id: "style_litianc_default", version: "2026-07-05" },
        adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
        model_pins: { writing: "glm-5.2", editorial_review: "rules-only" },
      },
      adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
      model_pins: { writing: "glm-5.2", editorial_review: "rules-only" },
      idempotency_key: `run:${runId}`,
    });
    await coordinator.startFiveAgentRun({
      run_id: runId,
      article_id: "runtime-v3-failed-article",
      recording_id: 1902,
      user_id: "runtime_v3_user",
      workspace_id: "runtime_v3_workspace",
      payload_hash: await sha256Text(`run:${runId}`),
      manifest_hash: await sha256Text(manifest),
      manifest_json: manifest,
      workflow_id: `five-agent-${runId}`,
      created_at: "2026-07-20T00:01:00.000Z",
    }, false);

    const first = await coordinator.prepareFiveAgentCall({
      run_id: runId,
      call_kind: "writing_initial",
      idempotency_key: `draft:1:${runId}`,
      attempt: 1,
      created_at: "2026-07-20T00:01:01.000Z",
    });
    await coordinator.completeFiveAgentCall({
      call_id: first.call_id,
      run_id: runId,
      status: "failed",
      error_code: "invalid_model_response",
      retryable: false,
      recorded_at: "2026-07-20T00:01:02.000Z",
    });
    const failedReplay = await coordinator.prepareFiveAgentCall({
      run_id: runId,
      call_kind: "writing_initial",
      idempotency_key: `draft:1:${runId}`,
      attempt: 1,
      created_at: "2026-07-20T00:01:03.000Z",
    });
    expect(failedReplay).toMatchObject({ status: "failed", error_code: "writing_adapter_non_retryable", retryable: false, attempt: 1 });

    const exhaustedKey = `draft:retryable:${runId}`;
    for (const attempt of [1, 2, 3]) {
      const prepared = await coordinator.prepareFiveAgentCall({ run_id: runId, call_kind: "writing_initial", idempotency_key: exhaustedKey, attempt, created_at: `2026-07-20T00:01:0${attempt}Z` });
      await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: runId, status: "failed", error_code: "upstream_timeout", retryable: true, recorded_at: `2026-07-20T00:01:1${attempt}Z` });
    }
    const exhaustedReplay = await coordinator.prepareFiveAgentCall({ run_id: runId, call_kind: "writing_initial", idempotency_key: exhaustedKey, attempt: 1, created_at: "2026-07-20T00:01:20.000Z" });
    expect(exhaustedReplay).toMatchObject({ status: "failed", error_code: "writing_adapter_retry_exhausted", retryable: false, attempt: 3 });

    const reentryKey = `visual:reentry:${runId}`;
    const attemptOne = await coordinator.prepareFiveAgentCall({ run_id: runId, call_kind: "visual_image", idempotency_key: reentryKey, attempt: 1, created_at: "2026-07-20T00:01:24.000Z" });
    await coordinator.completeFiveAgentCall({ call_id: attemptOne.call_id, run_id: runId, status: "failed", error_code: "upstream_retryable", retryable: true, recorded_at: "2026-07-20T00:01:25.000Z" });
    const attemptTwo = await coordinator.prepareFiveAgentCall({ run_id: runId, call_kind: "visual_image", idempotency_key: reentryKey, attempt: 2, created_at: "2026-07-20T00:01:26.000Z" });
    await coordinator.completeFiveAgentCall({ call_id: attemptTwo.call_id, run_id: runId, status: "failed", error_code: "upstream_retryable", retryable: true, recorded_at: "2026-07-20T00:01:27.000Z" });
    const lowerAttemptReplay = await coordinator.prepareFiveAgentCall({ run_id: runId, call_kind: "visual_image", idempotency_key: reentryKey, attempt: 1, created_at: "2026-07-20T00:01:28.000Z" });
    expect(lowerAttemptReplay).toMatchObject({ status: "failed", retryable: true, attempt: 2 });
    const resumedAttempt = await coordinator.prepareFiveAgentCall({ run_id: runId, call_kind: "visual_image", idempotency_key: reentryKey, attempt: 3, created_at: "2026-07-20T00:01:29.000Z" });
    expect(resumedAttempt.status).toBe("prepared");
    expect(resumedAttempt.call_id).toContain(":attempt:3");

    const skippedKey = `draft:skipped:${runId}`;
    const skipped = await coordinator.prepareFiveAgentCall({
      run_id: runId, call_kind: "visual_image", idempotency_key: skippedKey, attempt: 2, created_at: "2026-07-20T00:01:21.000Z",
    });
    expect(skipped).toMatchObject({ status: "failed", error_code: "attempt_order_invalid", retryable: false, attempt: 2 });
    const intent = await coordinator.prepareFiveAgentCall({
      run_id: runId, call_kind: "visual_image", idempotency_key: skippedKey, attempt: 1, created_at: "2026-07-20T00:01:22.000Z",
    });
    const intentReplay = await coordinator.prepareFiveAgentCall({
      run_id: runId, call_kind: "visual_image", idempotency_key: skippedKey, attempt: 2, created_at: "2026-07-20T00:01:23.000Z",
    });
    expect(intent).toMatchObject({ status: "prepared" });
    expect(intentReplay).toMatchObject({ status: "needs_action", call_id: intent.call_id, attempt: 1, error_code: "external_side_effect_unknown" });

    const current: PublicationRunRow = {
      run_id: "projection-failure", user_id: "u", workspace_id: "w", article_id: "a", recording_id: 1,
      source_run_id: null, source_manifest_hash: null, source_state: "writing", source_state_revision: 3,
      schema_version: "publication-projection.v1", workflow_version: "publishing-workflow.v1", policy_version: "publishing-policy.v1",
      agent_versions_json: "{}", skill_pins_json: "{}", state: "writing", run_status: "active", state_revision: 3,
      progress_percent: 28, resume_state: null, last_successful_state: "writing", last_successful_progress_percent: 28,
      retry_count: 0, next_action: null, error_code: null, idempotency_key: "projection-failure", payload_hash: "sha256:payload",
      created_at: "2026-07-20T00:00:00.000Z", updated_at: "2026-07-20T00:00:01.000Z",
    };
    const failed = projectPublicationTransition(current, "failed", {
      eventId: "projection-failure:event:4", eventType: "failed", eventIdempotencyKey: "failed:1",
      eventPayloadHash: "sha256:error", eventCreatedAt: "2026-07-20T00:00:02.000Z", retryCount: 3,
    });
    expect(failed).toMatchObject({ state: "failed", retry_count: 3, progress_percent: 28, last_successful_progress_percent: 28 });
    const nonRetry = projectPublicationTransition(current, "failed", {
      eventId: "projection-failure:event:4b", eventType: "failed", eventIdempotencyKey: "failed:1b",
      eventPayloadHash: "sha256:error", eventCreatedAt: "2026-07-20T00:00:02.000Z", retryCount: 1,
    });
    expect(nonRetry.retry_count).toBe(1);
  });

  it("reconciles create-response loss through one existing workflow and confirms it once", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `runtime-v3-workflow-unknown-${suffix}`;
    const articleId = `${runId}-article`;
    const userId = `runtime_v3_workflow_user_${suffix}`;
    const workspaceId = `runtime_v3_workflow_workspace_${suffix}`;
    const recordingId = 1910;
    const transcriptRef = `runtime:v3:workflow-${suffix}`;
    const transcriptText = "synthetic workflow creation response loss";
    const transcriptHash = await sha256Text(transcriptText);
    await runtimeEnv.DB.prepare(`INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id) VALUES (?, ?, ?)`)
      .bind(recordingId, userId, workspaceId).run();
    await runtimeEnv.FILES_BUCKET.put(transcriptRef, transcriptText, {
      customMetadata: { user_id: userId, workspace_id: workspaceId },
    });

    let workflowCreated = false;
    let createCalls = 0;
    let statusCalls = 0;
    const workflow = {
      get: async () => ({ status: async () => {
        statusCalls += 1;
        if (!workflowCreated) throw Object.assign(new Error("workflow lookup failed"), { status: 404, code: "NOT_FOUND" });
        if (statusCalls === 2) throw new Error("workflow status temporarily unavailable");
        return { status: "queued" };
      } }),
      create: async () => {
        createCalls += 1;
        workflowCreated = true;
        // The provider accepted the create but the response is unusable. The
        // SDK fails while recording the tracking row; status is still unknown
        // until the next route request reconciles the deterministic ID.
        return {};
      },
    };
    let serviceAccess = 0;
    const testEnv = Object.create(runtimeEnv);
    Object.assign(testEnv, {
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      FIVE_AGENT_PUBLISHING_WORKFLOW: workflow,
      GLM_MODEL: "glm-5.2",
    });
    for (const name of ["WRITING_AGENT", "REVIEW_AGENT"] as const) {
      Object.defineProperty(testEnv, name, {
        get() {
          serviceAccess += 1;
          throw new Error("adapter must not run before workflow confirmation");
        },
      });
    }
    const body = publishingBody(runId, recordingId, transcriptRef, transcriptHash);
    body.article_id = articleId;
    const startRequest = () => new Request("https://example.test/api/internal/v3/publishing/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer dedicated-v3-token",
        "x-vibepub-user-id": userId,
        "x-vibepub-workspace-id": workspaceId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const first = await worker.fetch(startRequest(), testEnv, {} as any);
    expect(first.status).toBe(202);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
    expect(await coordinator.getFiveAgentRun(runId, userId, workspaceId)).toMatchObject({
      state: "queued", state_revision: 0, start_ledger_status: "needs_action",
      start_status: "workflow_create_unknown",
    });
    expect((await coordinator.getFiveAgentStartEvidence(runId, `five-agent-${runId}`)).events.map(event => event.event_type))
      .toEqual(["start_reconciliation_required"]);
    expect(createCalls).toBe(1);
    expect(serviceAccess).toBe(0);

    const second = await worker.fetch(startRequest(), testEnv, {} as any);
    expect(second.status).toBe(200);
    expectStartResponseShape(await second.json() as Record<string, any>, runId);
    const confirmedRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    expect(confirmedRun).toMatchObject({
      state: "queued", state_revision: 0, start_ledger_status: "started", start_status: "workflow_started",
    });
    const evidence = await coordinator.getFiveAgentStartEvidence(runId, `five-agent-${runId}`);
    expect(evidence.events.map(event => event.event_type)).toEqual([
      "start_reconciliation_required", "start_reconciled", "workflow_start_confirmed",
    ]);
    expect(evidence.events.filter(event => event.event_type === "workflow_start_confirmed")).toHaveLength(1);
    expect(createCalls).toBe(1);
    expect(serviceAccess).toBe(0);
    expect(statusCalls).toBe(4);
    expect(await runtimeEnv.DB.prepare(`SELECT state, state_revision, error_code, next_action FROM publication_runs WHERE run_id = ?`)
      .bind(runId).first()).toMatchObject({ state: "queued", state_revision: 4, error_code: null, next_action: null });
    const confirmation = await coordinator.getFiveAgentWorkflowStartConfirmation({
      run_id: runId,
      workflow_id: `five-agent-${runId}`,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      payload_hash: String(confirmedRun.payload_hash),
      manifest_hash: String(confirmedRun.manifest_hash),
    });
    expect(confirmation.confirmed).toBe(true);
    const confirmedEvent = evidence.events.find(event => event.event_type === "workflow_start_confirmed");
    const confirmedLedger = await coordinator.getFiveAgentStartLedger(runId, `five-agent-${runId}`);
    expect(confirmedEvent).toBeDefined();
    expect(confirmedLedger).toBeDefined();
    const third = await worker.fetch(startRequest(), testEnv, {} as any);
    const fourth = await worker.fetch(startRequest(), testEnv, {} as any);
    expect(third.status).toBe(200);
    expect(fourth.status).toBe(200);
    expectStartResponseShape(await third.json() as Record<string, any>, runId);
    expectStartResponseShape(await fourth.json() as Record<string, any>, runId);
    const replayEvidence = await coordinator.getFiveAgentStartEvidence(runId, `five-agent-${runId}`);
    const replayLedger = await coordinator.getFiveAgentStartLedger(runId, `five-agent-${runId}`);
    expect(replayEvidence.events).toEqual(evidence.events);
    expect(replayLedger?.updated_at).toBe(confirmedLedger?.updated_at);
    expect(createCalls).toBe(1);
    expect(serviceAccess).toBe(0);
  });

  it("fails closed when a workflow error only mentions 404 without structured not-found status", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `runtime-v3-message-only-${suffix}`;
    const userId = `runtime_v3_message_user_${suffix}`;
    const workspaceId = `runtime_v3_message_workspace_${suffix}`;
    const articleId = `${runId}-article`;
    const recordingId = 1911;
    const transcriptRef = `runtime:v3:message-only-${suffix}`;
    const transcriptText = "synthetic message-only workflow status";
    const transcriptHash = await sha256Text(transcriptText);
    await runtimeEnv.DB.prepare(`INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id) VALUES (?, ?, ?)`)
      .bind(recordingId, userId, workspaceId).run();
    await runtimeEnv.FILES_BUCKET.put(transcriptRef, transcriptText, { customMetadata: { user_id: userId, workspace_id: workspaceId } });
    let createCalls = 0;
    const workflow = {
      get: async () => ({ status: async () => { throw new Error("404 not found"); } }),
      create: async () => { createCalls += 1; return {}; },
    };
    const testEnv = Object.create(runtimeEnv);
    Object.assign(testEnv, {
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      FIVE_AGENT_PUBLISHING_WORKFLOW: workflow,
    });
    const body = publishingBody(runId, recordingId, transcriptRef, transcriptHash);
    body.article_id = articleId;
    const response = await worker.fetch(new Request("https://example.test/api/internal/v3/publishing/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer dedicated-v3-token",
        "x-vibepub-user-id": userId,
        "x-vibepub-workspace-id": workspaceId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }), testEnv, {} as any);
    expect(response.status).toBe(202);
    const result = await response.json() as Record<string, any>;
    expectStartResponseShape(result, runId);
    expect(result.run).toMatchObject({ start_ledger_status: "needs_action", start_status: "workflow_create_unknown" });
    expect(createCalls).toBe(0);
  });

  it("holds a brief R2 lost-response before workflow creation and replays without duplicates", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `runtime-v3-brief-unknown-${suffix}`;
    const articleId = `${runId}-article`;
    const userId = "runtime_v3_brief_user";
    const workspaceId = "runtime_v3_brief_workspace";
    const recordingId = 1903;
    const transcriptRef = `runtime:v3:transcript-${suffix}`;
    const transcriptText = "synthetic transcript for brief reconciliation";
    const transcriptHash = await sha256Text(transcriptText);
    await runtimeEnv.DB.prepare(`INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id) VALUES (?, ?, ?)`)
      .bind(recordingId, userId, workspaceId).run();
    await runtimeEnv.FILES_BUCKET.put(transcriptRef, transcriptText, {
      customMetadata: { user_id: userId, workspace_id: workspaceId },
    });

    const realBucket = runtimeEnv.FILES_BUCKET;
    const lostResponseBucket = Object.create(realBucket);
    const artifactPrefix = "editorial/v3/";
    let r2PutCount = 0;
    Object.defineProperty(lostResponseBucket, "get", {
      value: async (key: string) => {
        if (key.startsWith(artifactPrefix)) throw new Error("synthetic R2 read response lost");
        return realBucket.get(key);
      },
    });
    Object.defineProperty(lostResponseBucket, "head", {
      value: (key: string) => realBucket.head(key),
    });
    Object.defineProperty(lostResponseBucket, "put", {
      value: async (key: string, value: unknown, options?: unknown) => {
        r2PutCount += 1;
        await realBucket.put(key, value as any, options as any);
        throw new Error("synthetic R2 put response lost after commit");
      },
    });
    Object.defineProperty(lostResponseBucket, "list", {
      value: (options?: unknown) => realBucket.list(options as any),
    });

    let workflowAccess = 0;
    const testEnv = Object.create(runtimeEnv);
    Object.assign(testEnv, {
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      FILES_BUCKET: lostResponseBucket,
    });
    Object.defineProperty(testEnv, "FIVE_AGENT_PUBLISHING_WORKFLOW", {
      get() { workflowAccess += 1; throw new Error("workflow must not start while brief is unreconciled"); },
    });

    const body = publishingBody(runId, recordingId, transcriptRef, transcriptHash);
    const bodyJson = JSON.stringify(body);
    const startRequest = new Request("https://example.test/api/internal/v3/publishing/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer dedicated-v3-token",
        "x-vibepub-user-id": userId,
        "x-vibepub-workspace-id": workspaceId,
        "content-type": "application/json",
      },
      body: bodyJson,
    });
    const first = await worker.fetch(startRequest, testEnv, {} as any);
    expect(first.status).toBe(202);
    const firstResponse = await first.json() as { run: Record<string, unknown> };
    expect(firstResponse).toMatchObject({ run: {
      run_id: runId,
      state: "queued",
      state_revision: 0,
      start_ledger_status: "needs_action",
      start_status: "brief_storage_unknown",
      start_error_code: "external_side_effect_unknown",
      start_next_action: "reconcile_external_side_effect",
    } });
    expect(r2PutCount).toBe(1);
    expect(await runtimeEnv.DB.prepare(`SELECT state, state_revision, last_successful_state, resume_state, error_code, next_action
      FROM publication_runs WHERE run_id = ?`).bind(runId).first()).toMatchObject({
      state: "needs_action",
      state_revision: 1,
      last_successful_state: "queued",
      resume_state: null,
      error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect",
    });

    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
    const firstDoRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    const firstDoArtifacts = await coordinator.listFiveAgentArtifacts(runId, userId, workspaceId);
    const firstCanonical = await runtimeEnv.DB.prepare(`SELECT created_at, payload_hash
      FROM editorial_runs WHERE run_id = ?`).bind(runId).first<Record<string, string>>();
    const firstBriefMirror = await runtimeEnv.DB.prepare(`SELECT artifact_id, created_at, payload_hash, storage_ref
      FROM editorial_artifacts WHERE run_id = ? AND kind = 'article_brief'`).bind(runId).first<Record<string, string>>();
    expect(firstDoRun).toMatchObject({ state: "queued", state_revision: 0, start_ledger_status: "needs_action", start_status: "brief_storage_unknown" });
    expect(firstDoRun.created_at).toBe(firstCanonical?.created_at);
    expect(firstDoArtifacts).toHaveLength(1);
    expect(firstBriefMirror).toBeNull();
    expect(firstDoArtifacts[0].created_at).toBe(firstCanonical?.created_at);
    const eventCount = await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM publication_run_events WHERE run_id = ?").bind(runId).first<{ count: number }>();
    const doEventCount = await (await coordinator.getFiveAgentRun(runId, userId, workspaceId) as any).state_revision;
    expect(eventCount?.count).toBe(2);
    expect(doEventCount).toBe(0);
    expect(workflowAccess).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 20));
    const secondAttemptNow = new Date().toISOString();
    const replay = await worker.fetch(new Request(startRequest.url, {
      method: "POST",
      headers: startRequest.headers,
      body: bodyJson,
    }), testEnv, {} as any);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ run: {
      state: "queued", state_revision: 0,
      start_ledger_status: "needs_action", start_status: "brief_storage_unknown",
    } });
    expect(await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM publication_run_events WHERE run_id = ?").bind(runId).first()).toEqual({ count: 2 });
    const secondDoRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    const secondDoArtifacts = await coordinator.listFiveAgentArtifacts(runId, userId, workspaceId);
    const secondCanonical = await runtimeEnv.DB.prepare(`SELECT created_at, payload_hash
      FROM editorial_runs WHERE run_id = ?`).bind(runId).first<Record<string, string>>();
    const secondBriefMirror = await runtimeEnv.DB.prepare(`SELECT artifact_id, created_at, payload_hash, storage_ref
      FROM editorial_artifacts WHERE run_id = ? AND kind = 'article_brief'`).bind(runId).first<Record<string, string>>();
    expect(secondDoRun).toMatchObject({ state: "queued", state_revision: 0, start_ledger_status: "needs_action", start_status: "brief_storage_unknown" });
    expect(String(firstDoRun.created_at) < secondAttemptNow).toBe(true);
    expect(secondDoRun.created_at).toBe(firstDoRun.created_at);
    expect(secondDoRun.workflow_id).toBe(firstDoRun.workflow_id);
    expect(secondDoRun.payload_hash).toBe(firstDoRun.payload_hash);
    expect(secondDoRun.manifest_hash).toBe(firstDoRun.manifest_hash);
    expect(secondDoRun.manifest_json).toBe(firstDoRun.manifest_json);
    expect(secondDoArtifacts).toEqual(firstDoArtifacts);
    expect(secondCanonical).toEqual(firstCanonical);
    expect(secondBriefMirror).toEqual(firstBriefMirror);
    expect(r2PutCount).toBe(1);
    expect(workflowAccess).toBe(0);

    const recoveredBrief = await realBucket.get(firstDoArtifacts[0].artifact_key);
    expect(recoveredBrief).not.toBeNull();
    const reconcileParams = {
      run_id: runId,
      article_id: articleId,
      recording_id: recordingId,
      user_id: userId,
      workspace_id: workspaceId,
      payload_hash: String(firstDoRun.payload_hash),
      manifest_hash: String(firstDoRun.manifest_hash),
      manifest_json: String(firstDoRun.manifest_json),
      workflow_id: String(firstDoRun.workflow_id),
      created_at: String(firstDoRun.created_at),
      transcript_ref: transcriptRef,
      transcript_hash: transcriptHash,
      source_hash: transcriptHash,
      brief_artifact_id: firstDoArtifacts[0].artifact_id,
      brief_artifact_key: firstDoArtifacts[0].artifact_key,
      brief_payload_hash: firstDoArtifacts[0].payload_hash,
    };
    const realDb = runtimeEnv.DB;
    function dbWithResponseLoss(): D1Database {
      const database = Object.create(realDb) as D1Database & { batch: D1Database["batch"] };
      let loseResponse = true;
      Object.defineProperty(database, "batch", {
        value: async (statements: D1PreparedStatement[]) => {
          const result = await realDb.batch(statements);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("synthetic D1 response lost after commit");
          }
          return result;
        },
      });
      return database;
    }
    const reconciledResponseLostEnv = Object.create(runtimeEnv);
    Object.defineProperty(reconciledResponseLostEnv, "DB", { value: dbWithResponseLoss() });
    await expect(reconcilePreStartHold(reconciledResponseLostEnv, coordinator, reconcileParams)).rejects.toThrow("response lost");
    expect(await runtimeEnv.DB.prepare(`SELECT state, state_revision, resume_state, error_code, next_action FROM publication_runs WHERE run_id = ?`).bind(runId).first()).toEqual({
      state: "needs_action", state_revision: 2, resume_state: null,
      error_code: "start_side_effect_reconciled", next_action: "resume_reconciled_start",
    });
    expect(await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM publication_run_events WHERE run_id = ?").bind(runId).first()).toEqual({ count: 3 });
    expect(await coordinator.getFiveAgentRun(runId, userId, workspaceId)).toMatchObject({ state: "queued", state_revision: 0, start_ledger_status: "needs_action" });
    expect((await coordinator.getFiveAgentStartEvidence(runId, String(firstDoRun.workflow_id))).receipts).toHaveLength(1);

    const retryingResponseLostEnv = Object.create(runtimeEnv);
    Object.defineProperty(retryingResponseLostEnv, "DB", { value: dbWithResponseLoss() });
    await expect(reconcilePreStartHold(retryingResponseLostEnv, coordinator, reconcileParams)).rejects.toThrow("response lost");
    expect(await runtimeEnv.DB.prepare(`SELECT state, state_revision, resume_state, error_code, next_action FROM publication_runs WHERE run_id = ?`).bind(runId).first()).toEqual({
      state: "retrying", state_revision: 3, resume_state: "queued",
      error_code: null, next_action: null,
    });
    expect(await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM publication_run_events WHERE run_id = ?").bind(runId).first()).toEqual({ count: 4 });
    expect((await coordinator.getFiveAgentStartEvidence(runId, String(firstDoRun.workflow_id))).receipts).toHaveLength(1);

    const queuedResponseLostEnv = Object.create(runtimeEnv);
    Object.defineProperty(queuedResponseLostEnv, "DB", { value: dbWithResponseLoss() });
    await expect(reconcilePreStartHold(queuedResponseLostEnv, coordinator, reconcileParams)).rejects.toThrow("response lost");
    expect(await runtimeEnv.DB.prepare(`SELECT state, state_revision, resume_state, error_code, next_action FROM publication_runs WHERE run_id = ?`).bind(runId).first()).toEqual({
      state: "queued", state_revision: 4, resume_state: null,
      error_code: null, next_action: null,
    });
    expect(await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM publication_run_events WHERE run_id = ?").bind(runId).first()).toEqual({ count: 5 });

    const finalizeLossCoordinator = new Proxy(coordinator as any, {
      get(target, property, receiver) {
        if (property === "finalizeFiveAgentStartReconciliation") {
          return async (...args: unknown[]) => {
            await target[property](...args);
            throw new Error("synthetic DO finalize response lost after commit");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(reconcilePreStartHold(runtimeEnv, finalizeLossCoordinator as any, reconcileParams)).rejects.toThrow("finalize response lost");
    expect(await runtimeEnv.DB.prepare("SELECT count(*) AS count FROM publication_run_events WHERE run_id = ?").bind(runId).first()).toEqual({ count: 5 });
    expect(await coordinator.getFiveAgentRun(runId, userId, workspaceId)).toMatchObject({
      state: "queued", state_revision: 0, start_ledger_status: "reconciled", start_status: "reconciled_resuming",
    });
    const finalizedReplay = await coordinator.finalizeFiveAgentStartReconciliation({
      run_id: runId,
      workflow_id: String(firstDoRun.workflow_id),
      start_status: "brief_storage_unknown",
      reconciliation_key: `brief_storage_unknown:${firstDoRun.workflow_id}`,
      evidence_hash: String(firstDoArtifacts[0].payload_hash),
      created_at: String(firstDoRun.created_at),
    });
    expect(finalizedReplay.replayed).toBe(true);
    const startEvidence = await coordinator.getFiveAgentStartEvidence(runId, String(firstDoRun.workflow_id));
    expect(startEvidence.receipts).toHaveLength(1);
    expect(startEvidence.events).toHaveLength(2);
    expect(startEvidence.events.map(row => row.event_type)).toEqual(["start_reconciliation_required", "start_reconciled"]);
    const resumedDoRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    expect(resumedDoRun).toMatchObject({ state: "queued", state_revision: 0, start_ledger_status: "reconciled" });
    expect(resumedDoRun.created_at).toBe(firstDoRun.created_at);
    expect(resumedDoRun.workflow_id).toBe(firstDoRun.workflow_id);
    expect(resumedDoRun.payload_hash).toBe(firstDoRun.payload_hash);
    expect(resumedDoRun.manifest_hash).toBe(firstDoRun.manifest_hash);
    expect(resumedDoRun.manifest_json).toBe(firstDoRun.manifest_json);
    expect(await coordinator.listFiveAgentArtifacts(runId, userId, workspaceId)).toEqual(firstDoArtifacts);

    let resumedWritingCalls = 0;
    let resumedReviewCalls = 0;
    const resumedWriting = serviceBinding(async (request) => {
      resumedWritingCalls += 1;
      const input = await request.json() as Record<string, any>;
      const draft = await syntheticDraftPayload({
        run_id: input.run_id,
        article_id: input.article_id,
        recording_id: input.recording_id,
        source_hash: input.source_hash,
      });
      return new Response(JSON.stringify({
        protocol_version: "vibepub.editorial.v3",
        result: draft,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const resumedReview = serviceBinding(async (request) => {
      resumedReviewCalls += 1;
      const input = await request.json() as Record<string, any>;
      return new Response(JSON.stringify({
        protocol_version: "vibepub.editorial.review.v1",
        result: {
          article_id: input.article_id,
          run_id: input.run_id,
          recording_id: input.recording_id,
          input_artifact_id: input.input_artifact_id,
          input_payload_hash: input.input_payload_hash,
          review_round: input.review_round,
          decision: "pass",
          findings: [],
          revision_targets: [],
          suggested_actions: [],
          reviewer_version: "editorial-review.adapter.1.0.0",
          rules_pins: {
            dbs_ai_check: { id: "dbs-ai-check", version: "1.0.0" },
            humanizer: { id: "humanizer-zh", version: "1.0.0" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const resumedWorkflow = {
      get: async () => ({ status: async () => ({ status: "queued" }) }),
      create: async (input: { id: string }) => ({ id: input.id }),
    };
    const resumedEnv = Object.create(runtimeEnv);
    Object.assign(resumedEnv, {
      FIVE_AGENT_PUBLISHING_TOKEN: "dedicated-v3-token",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      FIVE_AGENT_PUBLISHING_WORKFLOW: resumedWorkflow,
      FILES_BUCKET: realBucket,
      WRITING_AGENT: resumedWriting,
      REVIEW_AGENT: resumedReview,
      WRITING_AGENT_TOKEN: "synthetic-writing-token",
      REVIEW_AGENT_TOKEN: "synthetic-review-token",
      GLM_MODEL: "glm-5.2",
    });
    Object.defineProperty(resumedEnv, "FILES_BUCKET", { value: realBucket, configurable: true });
    const resumedRoute = await worker.fetch(new Request("https://example.test/api/internal/v3/publishing/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer dedicated-v3-token",
        "x-vibepub-user-id": userId,
        "x-vibepub-workspace-id": workspaceId,
        "content-type": "application/json",
      },
      body: bodyJson,
    }), resumedEnv, {} as any);
    expect(resumedRoute.status).toBe(200);
    const startedAgain = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
    expect(startedAgain).toMatchObject({ start_ledger_status: "started", start_status: "workflow_started" });
    expect((await coordinator.getFiveAgentStartEvidence(runId, String(firstDoRun.workflow_id))).events
      .filter(event => event.event_type === "workflow_start_confirmed")).toHaveLength(1);

    const resumedWorkflowInstance = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    resumedWorkflowInstance.env = resumedEnv;
    resumedWorkflowInstance._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    const resumedResult = await resumedWorkflowInstance.run({ payload: reconcileParams, instanceId: String(firstDoRun.workflow_id) }, step) as Record<string, unknown>;
    expect(resumedResult).toMatchObject({ run_id: runId, state: "content_frozen", artifact_ids: expect.any(Array) });
    expect(resumedResult.artifact_ids).toHaveLength(4);
    expect(resumedWritingCalls).toBe(1);
    expect(resumedReviewCalls).toBe(1);
    expect(await runtimeEnv.DB.prepare(`SELECT state, progress_percent FROM publication_runs WHERE run_id = ?`)
      .bind(runId).first()).toMatchObject({ state: "content_frozen", progress_percent: 62 });
  });
});
