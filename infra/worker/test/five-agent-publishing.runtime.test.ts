import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import {
  FiveAgentPublishingWorkflow,
  PRE_PERSISTENCE_INTEGRITY_ERROR_CODES,
  isPrePersistenceIntegrityError,
  normalizeFiveAgentStartBody,
  persistWechatArtifactForVerification,
  reconcilePreStartHold,
  visualProductionFeatureEnabled,
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
import { applySystemPublicationTransition, projectPublicationTransition, publicationFeatureEnabled, publicationSourceFeatureEnabled, type PublicationRunRow } from "../src/publicationProjection";
import { coordinatorShardName, EditorialRuntimeError } from "../src/editorialAgents";
import { wechatDraftFeatureEnabled } from "../src/wave2/wechatServiceClients";
import { makeWechatArtifact } from "../src/wave2/wechatContracts";

const runtimeEnv = env as any;
const originalImageGenerationAdapter = runtimeEnv.IMAGE_GENERATION_ADAPTER;
let nextWechatFixtureRecordingId = 90_000;

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
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      wechat_draft_id TEXT,
      cover_image_url TEXT
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

async function persistForgedWechatArtifact(
  drafted: Record<string, any>,
  coordinator: any,
  sourceKind: string,
  suffix: string,
  executionScope: string,
  recoveryCycle: string | null,
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
): Promise<any> {
  const ledger = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
  const source = ledger.artifacts.find((item: any) => item.kind === sourceKind);
  if (!source) throw new Error(`missing ${sourceKind} fixture`);
  const stored = await drafted.testEnv.FILES_BUCKET.get(source.artifact_key);
  if (!stored) throw new Error(`missing ${sourceKind} object fixture`);
  const raw = JSON.parse(await stored.text()) as { payload: Record<string, unknown> };
  const current = await drafted.testEnv.DB.prepare(`SELECT updated_at FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(drafted.runId, drafted.userId, drafted.workspaceId).first<{ updated_at: string }>();
  const createdAt = new Date(Date.parse(String(current?.updated_at || "2026-07-21T00:00:00.000Z")) + 1).toISOString();
  const payload = mutate({ ...raw.payload, execution_scope: executionScope, recovery_cycle: recoveryCycle, created_at: createdAt });
  const object = await makeWechatArtifact({
    owner: { run_id: drafted.runId, article_id: drafted.articleId, recording_id: drafted.recordingId, user_id: drafted.userId, workspace_id: drafted.workspaceId },
    kind: source.kind,
    payload: payload as any,
    input_artifact_ids: [...source.input_artifact_ids],
    idempotency_key: `wave2d:test-${suffix}:${drafted.runId}`,
    created_at: createdAt,
  });
  await persistWechatArtifactForVerification(drafted.testEnv, coordinator, drafted.testParams, object, "draft_ready", "wechat_artifact_committed");
  const mirrored = await drafted.testEnv.DB.prepare(`SELECT artifact_id FROM editorial_artifacts WHERE artifact_id = ? LIMIT 1`)
    .bind(object.envelope.artifact_id).first<{ artifact_id: string }>();
  expect(mirrored?.artifact_id).toBe(object.envelope.artifact_id);
  expect((await drafted.testEnv.FILES_BUCKET.get(object.envelope.artifact_key))).not.toBeNull();
  expect((await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId)).receipt_ids).toContain(object.envelope.artifact_id);
  return object;
}

const syntheticVisualPngCache = new Map<string, Promise<string>>();

function syntheticVisualPng(width: number, height: number, mode: "valid" | "transparent" | "nonwhite", seed = "visual-fixture"): Promise<string> {
  const cacheKey = `${width}x${height}:${mode}:${seed}`;
  const cached = syntheticVisualPngCache.get(cacheKey);
  if (cached) return cached;
  const generated = buildSyntheticVisualPng(width, height, mode, seed);
  syntheticVisualPngCache.set(cacheKey, generated);
  return generated;
}

async function buildSyntheticVisualPng(width: number, height: number, mode: "valid" | "transparent" | "nonwhite", seed: string): Promise<string> {
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
  if (mode === "valid") {
    // The stable prompt hash gives each slot distinct bytes while preserving
    // byte-for-byte cache hits for the same content across runs.
    let marker = 0;
    for (const character of seed) marker = (marker * 31 + character.charCodeAt(0)) >>> 0;
    const x = marker % width;
    const y = Math.floor(marker / width) % height;
    const offset = y * rowLength + 1 + x * 4;
    raw[offset] = 17;
    raw[offset + 1] = 17;
    raw[offset + 2] = 17;
    raw[offset + 3] = 255;
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

type StatefulWechatAdapter = {
  drafts: Map<string, Record<string, unknown>>;
  mappings: Map<string, string>;
  uploadCache: Map<string, { media_id?: string; media_url: string }>;
  operationResults: Map<string, Record<string, unknown>>;
  lastUnknownAdd: Record<string, unknown> | null;
};

function statefulWechatAdapter(): StatefulWechatAdapter {
  return { drafts: new Map(), mappings: new Map(), uploadCache: new Map(), operationResults: new Map(), lastUnknownAdd: null };
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
    wechat?: boolean;
    wechatAccountDenied?: boolean;
    wechatAccountRepairResume?: boolean;
    wechatImageRejected?: boolean;
    wechatAccessTokenRejected?: boolean;
    wechatUploadMediaUrl?: string;
    wechatMediaAllowlist?: string;
    wechatAccountRejected?: boolean;
    wechatLegacyClue?: boolean;
    wechatSameContent?: boolean;
    wechatAddUnknown?: "unique" | "zero" | "multiple";
    wechatAddUnknownLaterUnique?: boolean;
    wechatAddUnknownTwoRecoveryCycles?: boolean;
    wechatRecoveryResponseLoss?: "reconciled" | "retrying" | "resumed" | "do_final";
    wechatReadbackDrift?: boolean;
    wechatReadbackDriftRepair?: boolean;
    wechatReadFailure?: "retryable" | "exhausted" | "known";
    wechatKnownReadRepair?: boolean;
    wechatAccountConfigRepairResume?: boolean;
    wechatReceiptResponseLoss?: "upload" | "package" | "readback";
    wechatReceiptBeforeCompletionLoss?: "upload" | "package" | "readback";
    wechatDraftSyncingBeforeDoLoss?: boolean;
    wechatUnsafeUploadUrl?: boolean;
    wechatDraftReadyReplayMismatch?: "draft" | "cover";
    wechatCompletedEvidenceTamper?: "failed_readback" | "missing_upload_slot" | "duplicate_upload_slot" | "recovery_cycle_splice";
    wechatCoverCasConflict?: boolean;
    wechatFinalProjectionRevisionRace?: boolean;
    wechatState?: StatefulWechatAdapter;
    wechatArticleId?: string;
    wechatDraftTitle?: string;
  } = {},
): Promise<{
  runId: string;
  articleId: string;
  recordingId: number;
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
  wechatCalls: number;
  wechatOperations: Record<string, number>;
  wechatProviderOperations: Record<string, number>;
  wechatUploadStates: Array<{ projection: string | null; coordinator: string | null }>;
  projectionFaultTriggered: boolean;
  callIntentCount: number;
  revisionCount: number;
  projection: Record<string, unknown> | null;
  projectionEventHashes: string[];
  doEventHashes: string[];
  visualReplayDelta?: Record<string, number>;
  visualReplayError?: string;
  workflowError?: string;
  wechatReplayDelta?: { service_calls: number; provider_uploads: number; provider_writes: number; provider_reads: number };
  wechatCheckpointRecoveryDelta?: {
    provider_operation: number;
    r2_exact_object_count: number;
    d1_event_delta: number;
    do_artifact_delta: number;
    do_receipt_delta: number;
    do_event_delta: number;
  };
  visualIntentCheckpoint?: { asset_intents: number; binary_objects: number };
}> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runId = `runtime-v3-${scenario}-${suffix}`;
  const articleId = options.wechatArticleId || `runtime-v3-${scenario}-article-${suffix}`;
  const userId = `runtime_v3_${scenario}_user`;
  const workspaceId = `runtime_v3_${scenario}_workspace`;
  const recordingId = options.wechat
    ? nextWechatFixtureRecordingId++
    : scenario === "p0" ? 1905 : scenario === "p1_pass" ? 1906 : scenario === "p1_block" ? 1907 : scenario === "p0_round2" ? 1908 : 1909;
  const transcriptRef = `runtime:v3:${scenario}-${suffix}`;
  const transcriptText = `Synthetic transcript for ${scenario}.`;
  const transcriptHash = await sha256Text(transcriptText);
  await runtimeEnv.FILES_BUCKET.put(transcriptRef, transcriptText, { customMetadata: { user_id: userId, workspace_id: workspaceId } });
  await runtimeEnv.DB.prepare(`INSERT OR IGNORE INTO recordings (id, user_id, workspace_id, wechat_draft_id, cover_image_url) VALUES (?, ?, ?, ?, ?)`)
    .bind(
      recordingId,
      userId,
      workspaceId,
      options.wechatLegacyClue ? "legacy-draft-synthetic" : null,
      options.wechatCoverCasConflict ? "https://wechat.example/pre-existing-cover.png" : null,
    ).run();
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
  let visualImageFixtureOrdinal = 0;
  const visualDurableResponses = new Map<string, string>();
  let wechatCalls = 0;
  const wechatOperations: Record<string, number> = {};
  const wechatProviderOperations: Record<string, number> = {};
  const wechatProviderOperationCounts: Record<string, number> = {};
  const wechatUploadStates: Array<{ projection: string | null; coordinator: string | null }> = [];
  const wechatState = options.wechatState || statefulWechatAdapter();
  const syntheticWechatDrafts = wechatState.drafts;
  const syntheticWechatMappings = wechatState.mappings;
  let wechatReadbackDriftActive = options.wechatReadbackDrift === true;
  let wechatReadFailureActive = options.wechatReadFailure;
  let wechatAccountRejectedActive = options.wechatAccountRejected === true;
  let wechatConfigEpoch = 0;
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
      const draft = await syntheticDraftPayload({ run_id: input.run_id, article_id: input.article_id, recording_id: input.recording_id, source_hash: input.source_hash, title: options.wechatDraftTitle, long: options.visualLong, insufficient: options.visualInsufficientBlocks });
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
  const visualAdapter = originalImageGenerationAdapter;
  const countedVisualAdapter = visualAdapter ? { fetch: async (request: Request) => {
    visualCalls += 1;
    let body: Record<string, unknown> | null = null;
    try {
      body = await request.clone().json() as Record<string, unknown>;
      const responseKey = `${String(body.operation_id)}:${String(body.attempt)}`;
      if (request.url.endsWith("/internal/v3/visual/image") &&
          (body.run_id !== runId || body.user_id !== userId || body.workspace_id !== workspaceId)) {
        return Response.json({ error: { code: "run_scope_invalid", retryable: false } }, { status: 400 });
      }
      if (body.reconcile_only === true) {
        visualReconcileCalls += 1;
        const stored = visualDurableResponses.get(responseKey);
        if (!stored) return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
        return new Response(stored, { status: 200, headers: { "content-type": "application/json" } });
      }
      else {
        visualExecuteCalls += 1;
        if (request.url.endsWith("/internal/v3/visual/image")) {
          visualProviderOperations += 1;
        }
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
    let response = await visualAdapter.fetch(request);
    if (request.url.endsWith("/internal/v3/visual/image") && body && body.reconcile_only !== true && response.ok) {
      const value = await response.json() as Record<string, any>;
      const size = typeof body.size === "string" && /^\d+x\d+$/.test(body.size) ? body.size.split("x").map(Number) as [number, number] : [1536, 864];
      visualImageFixtureOrdinal += 1;
      const mode = size[0] === 2256
        ? (options.visualCoverTransparent ? "transparent" : "valid")
        : (options.visualBodyNonWhite ? "nonwhite" : "valid");
      value.result.b64_json = await syntheticVisualPng(size[0], size[1], mode, `visual-fixture-slot-${visualImageFixtureOrdinal}`);
      response = Response.json(value);
    }
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
    return response;
  } } : undefined;
  const wechatAdapter = serviceBinding(async (request) => {
    wechatCalls += 1;
    if (request.headers.get("authorization") !== "Bearer synthetic-wechat-token") {
      return Response.json({ error: { code: "unauthorized", retryable: false } }, { status: 401 });
    }
    let input: Record<string, any>;
    try {
      input = await request.json() as Record<string, any>;
    } catch {
      return Response.json({ error: { code: "invalid_json", retryable: false } }, { status: 400 });
    }
    const operation = String(input.operation || "");
    wechatOperations[operation] = (wechatOperations[operation] || 0) + 1;
    const operationId = String(input.operation_id || "synthetic-wechat-operation");
    const attempt = Number(input.attempt || 1);
    const syntheticConfigHash = `sha256:${(wechatConfigEpoch === 0 ? "a" : "c").repeat(64)}`;
    const syntheticReceiptHash = await hashJson({
      version: "wechat-account-resolution.v1",
      user_id: userId,
      workspace_id: workspaceId,
      article_id: articleId,
      account_binding_id: "wab_synthetic",
      config_hash: syntheticConfigHash,
    });
    const response = (result: Record<string, unknown>) => Response.json({
      protocol_version: "vibepub.wechat.v3",
      operation,
      operation_id: operationId,
      attempt,
      ...(operation === "resolve_account" ? {} : {
        account_binding_id: "wab_synthetic",
        account_receipt_hash: syntheticReceiptHash,
        result_ref: `wechat-adapter/v1/result/${operationId}/${attempt}.json`,
        result_hash: `sha256:${"f".repeat(64)}`,
      }),
      result,
    });
    const resultKey = `${operation}:${operationId}:${attempt}`;
    if (input.reconcile_only === true) {
      const stored = wechatState.operationResults.get(resultKey);
      return stored
        ? response(stored)
        : Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
    }
    const completed = wechatState.operationResults.get(resultKey);
    if (completed) return response(completed);
    const durableResponse = (result: Record<string, unknown>) => {
      wechatState.operationResults.set(resultKey, result);
      return response(result);
    };
    if (operation === "resolve_account") {
      return response({
        account_binding_id: "wab_synthetic",
        config_hash: syntheticConfigHash,
        credential_hash: `sha256:${"b".repeat(64)}`,
        receipt_hash: syntheticReceiptHash,
        version: "wechat-account-resolution.v1",
      });
    }
    if (input.account_binding_id !== "wab_synthetic" || input.account_receipt_hash !== syntheticReceiptHash) {
      return Response.json({ error: { code: "wechat_account_receipt_invalid", retryable: false } }, { status: 409 });
    }
    const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? input.payload as Record<string, any>
      : {};
    if (operation === "upload_image") {
      const projection = await runtimeEnv.DB.prepare(`SELECT state FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
        .bind(runId, userId, workspaceId).first<{ state: string }>();
      const durableRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
      wechatUploadStates.push({ projection: projection?.state || null, coordinator: typeof durableRun.state === "string" ? durableRun.state : null });
      if (wechatAccountRejectedActive) {
        return Response.json({ error: { code: "wechat_publishing_account_rejected", retryable: false } }, { status: 409 });
      }
      if (options.wechatAccessTokenRejected) {
        wechatProviderOperations.access_token = (wechatProviderOperations.access_token || 0) + 1;
        return Response.json({ error: { code: "wechat_access_token_rejected", retryable: false } }, { status: 409 });
      }
      if (options.wechatImageRejected) {
        wechatProviderOperations.upload_image = (wechatProviderOperations.upload_image || 0) + 1;
        return Response.json({ error: { code: "wechat_image_upload_non_retryable", retryable: false } }, { status: 422 });
      }
      const cacheKey = `${input.account_binding_id}:${String(payload.purpose)}:${String(payload.byte_hash)}`;
      let cached = wechatState.uploadCache.get(cacheKey);
      if (!cached) {
        wechatProviderOperations.upload_image = (wechatProviderOperations.upload_image || 0) + 1;
        wechatProviderOperationCounts[operationId] = (wechatProviderOperationCounts[operationId] || 0) + 1;
        cached = {
          media_url: options.wechatUploadMediaUrl || (options.wechatUnsafeUploadUrl ? `data:image/png;base64,unsafe-${operationId}` : `https://wechat.example/${operationId}.png`),
          ...(payload.purpose === "cover" ? { media_id: `media-${operationId}` } : {}),
        };
        wechatState.uploadCache.set(cacheKey, cached);
      }
      return durableResponse(cached);
    }
    if (operation === "write_draft") {
      wechatProviderOperations.write_draft = (wechatProviderOperations.write_draft || 0) + 1;
      wechatProviderOperationCounts[operationId] = (wechatProviderOperationCounts[operationId] || 0) + 1;
      if (options.wechatAddUnknown === "unique" || options.wechatAddUnknown === "zero" || options.wechatAddUnknown === "multiple") {
        if (payload.mutation === "add") {
          const recovered = {
            media_id: "draft-recovered-synthetic",
            title: payload.title,
            canonical_html: payload.canonical_html,
            html_hash: payload.html_hash,
            body_urls: [...String(payload.canonical_html || "").matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]),
            thumb_media_id: payload.thumb_media_id,
            article_index: 0,
          };
          if (options.wechatAddUnknown === "unique") syntheticWechatDrafts.set("draft-recovered-synthetic", recovered);
          if (options.wechatAddUnknown === "multiple") {
            syntheticWechatDrafts.set("draft-recovered-synthetic-a", { ...recovered, media_id: "draft-recovered-synthetic-a" });
            syntheticWechatDrafts.set("draft-recovered-synthetic-b", { ...recovered, media_id: "draft-recovered-synthetic-b" });
          }
          wechatState.lastUnknownAdd = recovered;
          return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
        }
      }
      const mediaId = payload.mutation === "update" ? String(payload.media_id) : `draft-${operationId}`;
      syntheticWechatDrafts.set(mediaId, {
        media_id: mediaId,
        title: payload.title,
        canonical_html: payload.canonical_html,
        html_hash: payload.html_hash,
        body_urls: [...String(payload.canonical_html || "").matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]),
        thumb_media_id: payload.thumb_media_id,
        article_index: 0,
      });
      if (typeof payload.draft_identity_hash === "string") syntheticWechatMappings.set(payload.draft_identity_hash, mediaId);
      return durableResponse({ media_id: mediaId, mutation: payload.mutation });
    }
    if (operation === "get_draft") {
      const draftIdentity = typeof payload.draft_identity_hash === "string" ? payload.draft_identity_hash : null;
      const mappedId = draftIdentity ? syntheticWechatMappings.get(draftIdentity) : undefined;
      const mediaId = typeof payload.media_id === "string" && payload.media_id.length > 0 ? payload.media_id : mappedId;
      // The adapter-owned verified mapping is local durable state. It is not a
      // WeChat draft/get request until a concrete media id must be verified.
      if (!mediaId && !options.wechatSameContent) return durableResponse({ not_found: true });
      if (!mediaId && options.wechatSameContent && draftIdentity) {
        wechatProviderOperations.get_draft = (wechatProviderOperations.get_draft || 0) + 1;
        return durableResponse({ media_id: "draft-mapped-synthetic", title: payload.title, canonical_html: payload.canonical_html, html_hash: payload.html_hash, body_urls: [...String(payload.canonical_html || "").matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]), thumb_media_id: payload.thumb_media_id, article_index: 0 });
      }
      wechatProviderOperations.get_draft = (wechatProviderOperations.get_draft || 0) + 1;
      wechatProviderOperationCounts[operationId] = (wechatProviderOperationCounts[operationId] || 0) + 1;
      if (mediaId && wechatReadFailureActive === "known") {
        return Response.json({ error: { code: "draft_readback_unavailable", retryable: false } }, { status: 409 });
      }
      if (mediaId && wechatReadFailureActive === "exhausted") {
        return Response.json({ error: { code: "upstream_retryable", retryable: true } }, { status: 503 });
      }
      if (mediaId && wechatReadFailureActive === "retryable" && attempt < 3) {
        return Response.json({ error: { code: "upstream_retryable", retryable: true } }, { status: 503 });
      }
      const draft = mediaId ? syntheticWechatDrafts.get(mediaId) : undefined;
      if (draft) {
        const responseDraft = wechatReadbackDriftActive && mediaId.startsWith("draft-")
          ? { ...draft, title: "drifted title" }
          : draft;
        if (draftIdentity && responseDraft.title === payload.title && responseDraft.canonical_html === payload.canonical_html && responseDraft.thumb_media_id === payload.thumb_media_id) {
          syntheticWechatMappings.set(draftIdentity, String(responseDraft.media_id));
        }
        return durableResponse(responseDraft);
      }
      if (mediaId === "legacy-draft-synthetic") {
        const legacyHtml = "<section style=\"max-width:677px;margin:0 auto;color:#202020;font-size:16px;line-height:1.75;overflow-wrap:anywhere\"><p style=\"margin:10px 0\">Legacy draft body</p></section>";
        return durableResponse({ media_id: mediaId, title: "Legacy draft title", canonical_html: legacyHtml, html_hash: await sha256Text(legacyHtml), body_urls: [], thumb_media_id: "legacy-thumb", article_index: 0 });
      }
      if (!draft) return durableResponse({ not_found: true });
    }
    if (operation === "find_draft") {
      wechatProviderOperations.find_draft = (wechatProviderOperations.find_draft || 0) + 1;
      wechatProviderOperationCounts[operationId] = (wechatProviderOperationCounts[operationId] || 0) + 1;
      const candidates = [...syntheticWechatDrafts.values()];
      if (candidates.length === 1) return durableResponse(candidates[0]);
      return Response.json({ error: { code: "draft_identity_unresolved", retryable: false } }, { status: 409 });
    }
    return Response.json({ error: { code: "external_side_effect_unknown", retryable: false } }, { status: 503 });
  });
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
    WECHAT_DRAFT_SYNC_V3: options.wechat ? "true" : "false",
    WECHAT_DRAFT_SYNC_V3_ALLOWLIST: options.wechat ? `${userId}:${workspaceId}` : "",
    WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST: options.wechat && !options.wechatAccountDenied ? "wab_synthetic" : "wab_denied",
    WECHAT_MEDIA_URL_HOST_ALLOWLIST: options.wechat ? options.wechatMediaAllowlist ?? "wechat.example" : "",
    WECHAT_PUBLISHING_TOKEN: "synthetic-wechat-token",
    WECHAT_PUBLISHING_ADAPTER: wechatAdapter,
    GLM_MODEL: "glm-5.2",
  });
  expect(wechatDraftFeatureEnabled(testEnv, userId, workspaceId)).toBe(options.wechat === true);
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
  let wechatCheckpointSnapshot: {
    artifactId: string; artifactKey: string; eventKey: string; payloadHash: string; operationId?: string;
    providerOperationCount: number; d1EventCount: number; doArtifactCount: number; doReceiptCount: number; doEventCount: number;
  } | undefined;
  const captureWechatCheckpoint = async (target: typeof coordinator, artifactId: string) => {
    const ledger = await target.getFiveAgentWechatLedger(runId, userId, workspaceId);
    const artifact = ledger.artifacts.find(item => item.artifact_id === artifactId);
    if (!artifact) throw new Error("WeChat checkpoint artifact is unavailable");
    const eventKey = String(artifact.idempotency_key);
    const payloadHash = String(artifact.payload_hash);
    const operationId = typeof artifact.payload_summary.operation_id === "string" ? artifact.payload_summary.operation_id : undefined;
    const d1 = await testEnv.DB.prepare(`SELECT count(*) AS count FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? AND payload_hash = ?`)
      .bind(runId, userId, workspaceId, eventKey, payloadHash).first<{ count: number }>();
    wechatCheckpointSnapshot = {
      artifactId,
      artifactKey: artifact.artifact_key,
      eventKey,
      payloadHash,
      operationId,
      providerOperationCount: operationId ? wechatProviderOperationCounts[operationId] || 0 : 0,
      d1EventCount: Number(d1?.count || 0),
      doArtifactCount: ledger.artifacts.filter(item => item.artifact_id === artifactId).length,
      doReceiptCount: ledger.receipt_ids.filter(id => id === artifactId).length,
      doEventCount: ledger.wechat_events.filter(event => event.idempotency_key === eventKey && event.payload_hash === payloadHash).length,
    };
  };
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
  } else if (options.wechatReceiptResponseLoss || options.wechatReceiptBeforeCompletionLoss || options.wechatDraftSyncingBeforeDoLoss) {
    let dropped = false;
    const checkpoint = options.wechatReceiptResponseLoss || options.wechatReceiptBeforeCompletionLoss;
    const expectedPrefix = checkpoint === "upload" ? "wave2d:upload:" :
      checkpoint === "package" ? "wave2d:package:" : "wave2d:readback-qa:";
    workflowCoordinator = new Proxy(coordinator as any, {
      get(target, property, receiver) {
        if (property === "recordFiveAgentState" && options.wechatDraftSyncingBeforeDoLoss) return async (input: { event_type: string }) => {
          if (!dropped && input.event_type === "draft_syncing") {
            dropped = true;
            throw new Error("synthetic draft_syncing D1 response lost before Coordinator state receipt");
          }
          return target.recordFiveAgentState(input);
        };
        if (property === "completeFiveAgentWechatArtifact") return async (input: { event_idempotency_key: string; artifact_id: string }) => {
          if (!dropped && options.wechatReceiptBeforeCompletionLoss && input.event_idempotency_key.startsWith(expectedPrefix)) {
            await captureWechatCheckpoint(target, input.artifact_id);
            dropped = true;
            throw new Error("synthetic WeChat receipt request lost before durable completion");
          }
          const result = await target.completeFiveAgentWechatArtifact(input);
          if (!dropped && options.wechatReceiptResponseLoss && input.event_idempotency_key.startsWith(expectedPrefix)) {
            await captureWechatCheckpoint(target, input.artifact_id);
            dropped = true;
            throw new Error("synthetic WeChat receipt response lost after durable completion");
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
  expect(wechatDraftFeatureEnabled(workflowInstance.env, userId, workspaceId)).toBe(options.wechat === true);
  if (options.wechatFinalProjectionRevisionRace) {
    const baseDb = testEnv.DB;
    let raced = false;
    const rawStatements = new WeakMap<object, object>();
    const statementSql = new WeakMap<object, string>();
    const wrapStatement = (statement: any, sql: string): any => {
      const wrapped = new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
          const value = target[property as keyof typeof target];
          return typeof value === "function" ? value.bind(target) : Reflect.get(target, property, receiver);
        },
      });
      rawStatements.set(wrapped, statement);
      statementSql.set(wrapped, sql);
      return wrapped;
    };
    const raceDb = new Proxy(baseDb as any, {
      get(target, property, receiver) {
        if (property === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
        if (property === "batch") return async (statements: unknown[]) => {
          const draftReadyBatch = statements.some(statement => statementSql.get(statement as object)?.includes("UPDATE recordings SET"));
          if (draftReadyBatch && !raced) {
            raced = true;
            const current = await runtimeEnv.DB.prepare(`SELECT state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
              .bind(runId, userId, workspaceId).first<{ state_revision: number }>();
            const revision = Number(current?.state_revision || 0);
            await applySystemPublicationTransition(runtimeEnv.DB, {
              runId,
              auth: { userId, workspaceId },
              targetState: "failed",
              expectedStateRevision: revision,
              options: {
                eventId: `${runId}:event:${revision + 1}`,
                eventType: "synthetic_competing_transition",
                eventIdempotencyKey: `synthetic:competitor:${runId}:${revision}`,
                eventPayloadHash: await sha256Text(`synthetic:competitor:${runId}:${revision}`),
                eventCreatedAt: new Date(Date.now() + 1).toISOString(),
                errorCode: "synthetic_competing_transition",
                nextAction: "retry",
              },
            });
          }
          return target.batch(statements.map(statement => rawStatements.get(statement as object) || statement) as any);
        };
        const value = target[property as keyof typeof target];
        return typeof value === "function" ? value.bind(target) : Reflect.get(target, property, receiver);
      },
    });
    Object.defineProperty(testEnv, "DB", { value: raceDb, configurable: true });
  }
  workflowInstance._agent = workflowCoordinator;
  let wholeRunRestartInjected = false;
  let checkpointReached: (() => void) | undefined;
  let releaseCheckpoint: (() => void) | undefined;
  const checkpoint = new Promise<void>(resolve => { checkpointReached = resolve; });
  const checkpointRelease = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  const executeStep = async (args: unknown[], pauseAtCheckpoint: boolean): Promise<unknown> => {
    const stepName = String(args[0]);
    const closure = args[args.length - 1] as () => Promise<unknown>;
    const attempts = options.visualResponseLoss || options.visualJsonResponseLoss || options.visualBinaryResponseLoss || options.visualProjectionResponseLoss || options.visualReceiptResponseLoss || options.visualAdapterResponseLoss || options.wechatReceiptResponseLoss || options.wechatReceiptBeforeCompletionLoss || options.wechatDraftSyncingBeforeDoLoss || (options.visualFailure === "unknown" && options.visualWholeRunRestartAt !== "unknown") ? 2 : 1;
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
  let wechatReplayDelta: { service_calls: number; provider_uploads: number; provider_writes: number; provider_reads: number } | undefined;
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
      try {
        result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
      } catch (error) {
        if (!options.wechatFinalProjectionRevisionRace) throw error;
        workflowError = error instanceof EditorialRuntimeError
          ? error.code
          : String((error as { code?: unknown })?.code || error);
        result = { run_id: runId, state: "failed" };
      }
    }
    if ((options.visualWholeRunRestartAt === "unknown" || options.visualBindingFetchThrow || options.visualWholeRunSuccessfulReconcile || options.visualFrozenReadHold || options.visualQaWholeRunRecovery || options.wechatReceiptResponseLoss || options.wechatReceiptBeforeCompletionLoss) && result.state === "needs_action") {
      try {
        result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
      } catch (error) {
        throw error;
      }
    }
    if (options.wechatAccountRepairResume && result.state === "needs_action") {
      Object.assign(testEnv, { WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST: "wab_synthetic" });
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
    }
    if ((options.wechatReadbackDriftRepair || options.wechatKnownReadRepair || options.wechatAccountConfigRepairResume) && result.state === "needs_action") {
      wechatReadbackDriftActive = false;
      if (options.wechatKnownReadRepair) wechatReadFailureActive = undefined;
      if (options.wechatAccountConfigRepairResume) {
        wechatAccountRejectedActive = false;
        wechatConfigEpoch = 1;
      }
      result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
    }
    if ((options.wechatAddUnknownLaterUnique || options.wechatAddUnknownTwoRecoveryCycles) && result.state === "needs_action" && wechatState.lastUnknownAdd) {
      if (options.wechatAddUnknownTwoRecoveryCycles) {
        result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
      }
      wechatState.drafts.clear();
      wechatState.drafts.set("draft-later-reconciled", { ...wechatState.lastUnknownAdd, media_id: "draft-later-reconciled" });
      if (options.wechatRecoveryResponseLoss) {
        if (options.wechatRecoveryResponseLoss === "do_final") {
          let dropped = false;
          const baseCoordinator = workflowInstance._agent;
          workflowInstance._agent = new Proxy(baseCoordinator as object, {
            get(target, property, receiver) {
              if (property === "recordFiveAgentState") return async (input: { event_type: string }) => {
                const value = await (target as any).recordFiveAgentState(input);
                if (!dropped && input.event_type === "draft_syncing") {
                  dropped = true;
                  throw new Error("synthetic WeChat recovery Coordinator response lost after commit");
                }
                return value;
              };
              return Reflect.get(target, property, receiver);
            },
          });
        } else {
          const phaseIndex = { reconciled: 1, retrying: 2, resumed: 3 }[options.wechatRecoveryResponseLoss];
          let batches = 0;
          const baseDb = testEnv.DB;
          const recoveryDb = new Proxy(baseDb as object, {
            get(target, property, receiver) {
              if (property === "batch") return async (statements: unknown[]) => {
                const value = await (target as any).batch(statements);
                batches += 1;
                if (batches === phaseIndex) throw new Error(`synthetic WeChat ${options.wechatRecoveryResponseLoss} D1 response lost after commit`);
                return value;
              };
              return Reflect.get(target, property, receiver);
            },
          });
          Object.defineProperty(testEnv, "DB", { value: recoveryDb, configurable: true });
        }
      }
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
    if (options.wechatDraftReadyReplayMismatch && result.state === "draft_ready") {
      if (options.wechatDraftReadyReplayMismatch === "draft") {
        await runtimeEnv.DB.prepare(`UPDATE recordings SET wechat_draft_id = ? WHERE id = ? AND user_id = ? AND workspace_id = ?`)
          .bind("wrong-draft-evidence", recordingId, userId, workspaceId).run();
      } else {
        await runtimeEnv.DB.prepare(`UPDATE recordings SET cover_image_url = ? WHERE id = ? AND user_id = ? AND workspace_id = ?`)
          .bind("https://wechat.example/wrong-cover.png", recordingId, userId, workspaceId).run();
      }
      try {
        await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step);
      } catch (error) {
        workflowError = error instanceof EditorialRuntimeError
          ? error.code
          : String((error as { code?: unknown })?.code || error);
      }
    }
    if (options.wechatCompletedEvidenceTamper && result.state === "draft_ready") {
      const wechatLedger = await coordinator.getFiveAgentWechatLedger(runId, userId, workspaceId);
      const readbacks = wechatLedger.artifacts.filter(item => item.kind === "wechat_draft_readback_qa" && wechatLedger.receipt_ids.includes(item.artifact_id));
      const readback = options.wechatCompletedEvidenceTamper === "recovery_cycle_splice"
        ? readbacks.find(item => item.payload_summary.decision === "failed")
        : readbacks[0];
      if (!readback) throw new Error("readback evidence fixture is unavailable");
      const stored = await testEnv.FILES_BUCKET.get(readback.artifact_key);
      if (!stored) throw new Error("readback R2 evidence fixture is unavailable");
      const altered = JSON.parse(await stored.text()) as { envelope: Record<string, unknown>; payload: Record<string, unknown> };
      if (options.wechatCompletedEvidenceTamper === "failed_readback") {
        altered.payload.decision = "failed";
        altered.payload.checks = { ...(altered.payload.checks as Record<string, unknown>), html: false };
      } else if (options.wechatCompletedEvidenceTamper === "recovery_cycle_splice") {
        altered.payload.recovery_cycle = "f".repeat(32);
      } else {
        const uploads = Array.isArray(altered.payload.upload_receipt_ids) ? [...altered.payload.upload_receipt_ids] : [];
        altered.payload.upload_receipt_ids = options.wechatCompletedEvidenceTamper === "missing_upload_slot"
          ? uploads.slice(1)
          : uploads.length > 0 ? [uploads[0], ...uploads] : uploads;
      }
      altered.envelope.payload_hash = await sha256Text(canonicalJson(altered.payload));
      altered.envelope.payload_length = new TextEncoder().encode(canonicalJson(altered.payload)).byteLength;
      await testEnv.FILES_BUCKET.put(readback.artifact_key, canonicalJson(altered), {
        customMetadata: stored.customMetadata,
      });
      const beforeService = wechatCalls;
      const beforeUploads = wechatProviderOperations.upload_image || 0;
      const beforeWrites = wechatProviderOperations.write_draft || 0;
      const beforeReads = wechatProviderOperations.get_draft || 0;
      try {
        await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step);
      } catch (error) {
        workflowError = error instanceof EditorialRuntimeError
          ? error.code
          : String((error as { code?: unknown })?.code || error);
      }
      wechatReplayDelta = {
        service_calls: wechatCalls - beforeService,
        provider_uploads: (wechatProviderOperations.upload_image || 0) - beforeUploads,
        provider_writes: (wechatProviderOperations.write_draft || 0) - beforeWrites,
        provider_reads: (wechatProviderOperations.get_draft || 0) - beforeReads,
      };
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
  let wechatCheckpointRecoveryDelta: {
    provider_operation: number; r2_exact_object_count: number; d1_event_delta: number;
    do_artifact_delta: number; do_receipt_delta: number; do_event_delta: number;
  } | undefined;
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
  if (wechatCheckpointSnapshot) {
    const wechatLedger = await coordinator.getFiveAgentWechatLedger(runId, userId, workspaceId);
    const [r2, d1] = await Promise.all([
      testEnv.FILES_BUCKET.get(wechatCheckpointSnapshot.artifactKey),
      testEnv.DB.prepare(`SELECT count(*) AS count FROM publication_run_events
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? AND payload_hash = ?`)
        .bind(runId, userId, workspaceId, wechatCheckpointSnapshot.eventKey, wechatCheckpointSnapshot.payloadHash).first<{ count: number }>(),
    ]);
    wechatCheckpointRecoveryDelta = {
      provider_operation: wechatCheckpointSnapshot.operationId
        ? (wechatProviderOperationCounts[wechatCheckpointSnapshot.operationId] || 0) - wechatCheckpointSnapshot.providerOperationCount
        : 0,
      r2_exact_object_count: r2 ? 1 : 0,
      d1_event_delta: Number(d1?.count || 0) - wechatCheckpointSnapshot.d1EventCount,
      do_artifact_delta: wechatLedger.artifacts.filter(item => item.artifact_id === wechatCheckpointSnapshot!.artifactId).length - wechatCheckpointSnapshot.doArtifactCount,
      do_receipt_delta: wechatLedger.receipt_ids.filter(id => id === wechatCheckpointSnapshot!.artifactId).length - wechatCheckpointSnapshot.doReceiptCount,
      do_event_delta: wechatLedger.wechat_events.filter(event => event.idempotency_key === wechatCheckpointSnapshot!.eventKey && event.payload_hash === wechatCheckpointSnapshot!.payloadHash).length - wechatCheckpointSnapshot.doEventCount,
    };
  }
  const afterRun = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
  const projection = await runtimeEnv.DB.prepare(`SELECT state, progress_percent, state_revision, retry_count, error_code, next_action
    FROM publication_runs WHERE run_id = ?`).bind(runId).first<Record<string, unknown>>();
  const projectionEvents = await runtimeEnv.DB.prepare(`SELECT payload_hash FROM publication_run_events WHERE run_id = ? ORDER BY revision`).bind(runId).all<{ payload_hash: string }>();
  const doEvents = await coordinator.listFiveAgentEvents(runId, userId, workspaceId);
  return {
    runId,
    articleId,
    recordingId,
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
    wechatCalls,
    wechatOperations,
    wechatProviderOperations,
    wechatUploadStates,
    projectionFaultTriggered,
    callIntentCount: Number(afterRun.call_intent_count),
    revisionCount: Number(afterRun.revision_count),
    projection,
    projectionEventHashes: (projectionEvents.results || []).map(row => row.payload_hash),
    doEventHashes: doEvents.flatMap(row => row.payload_hash ? [row.payload_hash] : []),
    visualReplayDelta,
    visualReplayError,
    workflowError,
    wechatReplayDelta,
    wechatCheckpointRecoveryDelta,
    visualIntentCheckpoint,
    testParams: params,
    testEnv,
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
  it("auto-expires one exact staging canary scope across publication and visual gates", () => {
    const runId = `run_v3_${"a".repeat(64)}`;
    const userId = "staging_canary_user";
    const workspaceId = "staging_canary_workspace";
    const sourceKey = `users/${userId}/text-submissions/canary.json`;
    const canary = {
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      VISUAL_PRODUCTION_V3: "true",
      VISUAL_PRODUCTION_V3_ALLOWLIST: `${userId}:${workspaceId}`,
      DEPLOY_ENVIRONMENT: "staging",
      STAGING_IMAGE_CANARY_MODE: "staging_single_run",
      STAGING_IMAGE_CANARY_RUN_ID: runId,
      STAGING_IMAGE_CANARY_USER_ID: userId,
      STAGING_IMAGE_CANARY_WORKSPACE_ID: workspaceId,
      STAGING_IMAGE_CANARY_SOURCE_KEY: sourceKey,
      STAGING_IMAGE_CANARY_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    } as any;
    expect(publicationFeatureEnabled(canary, userId, workspaceId)).toBe(false);
    expect(publicationFeatureEnabled(canary, userId, workspaceId, runId)).toBe(true);
    expect(publicationSourceFeatureEnabled(canary, userId, workspaceId, sourceKey)).toBe(true);
    expect(publicationSourceFeatureEnabled(canary, userId, workspaceId, `users/${userId}/text-submissions/other.json`)).toBe(false);
    expect(visualProductionFeatureEnabled(canary, userId, workspaceId, runId)).toBe(true);
    expect(publicationFeatureEnabled(canary, userId, workspaceId, `run_v3_${"b".repeat(64)}`)).toBe(false);
    expect(visualProductionFeatureEnabled(canary, userId, workspaceId, `run_v3_${"b".repeat(64)}`)).toBe(false);
    expect(publicationFeatureEnabled({ ...canary, DEPLOY_ENVIRONMENT: "production" }, userId, workspaceId, runId)).toBe(false);
    expect(publicationFeatureEnabled({ ...canary, STAGING_IMAGE_CANARY_EXPIRES_AT: new Date(Date.now() - 1).toISOString() }, userId, workspaceId, runId)).toBe(false);
    expect(visualProductionFeatureEnabled({ ...canary, STAGING_IMAGE_CANARY_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000 + 1).toISOString() }, userId, workspaceId, runId)).toBe(false);
  });

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
  }, 20_000);

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

  it("runs the normal visual result through private WeChat drafting with nine logical receipts", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true });
    expect(drafted.projection?.error_code).toBeNull();
    expect(drafted.result).toMatchObject({ state: "draft_ready", artifact_ids: expect.any(Array) });
    expect(drafted.result.artifact_ids).toHaveLength(18);
    expect(drafted.artifactCount).toBe(4);
    expect(drafted.receiptCount).toBe(4);
    // Account resolution plus local mapping lookup are adapter calls; the
    // external mutation budget remains three uploads, one add, and one get.
    expect(drafted.wechatCalls).toBe(7);
    expect(drafted.wechatProviderOperations).toMatchObject({ upload_image: 3, write_draft: 1, get_draft: 1 });
    expect(drafted.wechatUploadStates).toEqual([
      { projection: "draft_syncing", coordinator: "draft_syncing" },
      { projection: "draft_syncing", coordinator: "draft_syncing" },
      { projection: "draft_syncing", coordinator: "draft_syncing" },
    ]);
    expect(drafted.projection).toMatchObject({ state: "draft_ready", progress_percent: 100, error_code: null, next_action: null });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
    expect(ledger.artifacts).toHaveLength(9);
    expect(ledger.receipt_ids).toHaveLength(9);
    expect(ledger.artifacts.filter(item => item.kind === "wechat_image_upload_receipt")).toHaveLength(3);
  });

  it("replays a D1-committed draft_syncing checkpoint before any upload and completes only the missing DO state event", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatDraftSyncingBeforeDoLoss: true,
    });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.wechatUploadStates).toEqual([
      { projection: "draft_syncing", coordinator: "draft_syncing" },
      { projection: "draft_syncing", coordinator: "draft_syncing" },
      { projection: "draft_syncing", coordinator: "draft_syncing" },
    ]);
    expect(drafted.wechatProviderOperations).toMatchObject({ upload_image: 3, write_draft: 1, get_draft: 1 });
    const rows = await runtimeEnv.DB.prepare(`SELECT idempotency_key, event_type, state FROM publication_run_events
      WHERE run_id = ? AND event_type = 'draft_syncing'`).bind(drafted.runId).all<{ idempotency_key: string; event_type: string; state: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results?.[0]).toMatchObject({ event_type: "draft_syncing", state: "draft_syncing" });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId));
    const events = await coordinator.listFiveAgentEvents(drafted.runId, drafted.userId, drafted.workspaceId);
    expect(events.filter(event => event.event_type === "draft_syncing")).toHaveLength(1);
  });

  it("fails unsafe uploaded HTML URLs through the real WeChat phase before a draft mutation", async () => {
    const failed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatUnsafeUploadUrl: true,
    });
    expect(failed.result).toMatchObject({ state: "failed" });
    expect(failed.projection).toMatchObject({
      state: "failed",
      error_code: "wechat_html_contract_invalid",
      next_action: "retry_after_service_fix",
    });
    expect(failed.wechatProviderOperations.upload_image).toBe(1);
    expect(failed.wechatProviderOperations.write_draft || 0).toBe(0);
  });

  it.each([
    ["lookalike host", "https://wechat.example.evil/body.png", "wechat.example"],
    ["private IPv4 host", "https://127.0.0.1/body.png", "wechat.example"],
    ["local host", "https://localhost/body.png", "wechat.example"],
    ["IPv6 literal host", "https://[::1]/body.png", "wechat.example"],
    ["empty deployment allowlist", "https://wechat.example/body.png", ""],
  ] as const)("fails closed on %s media evidence before a draft mutation", async (_label, mediaUrl, mediaAllowlist) => {
    const failed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatUploadMediaUrl: mediaUrl,
      wechatMediaAllowlist: mediaAllowlist,
    });
    expect(failed.result).toMatchObject({ state: "failed" });
    expect(failed.projection).toMatchObject({
      state: "failed",
      error_code: "wechat_html_contract_invalid",
      next_action: "retry_after_service_fix",
    });
    expect(failed.wechatProviderOperations).toMatchObject({ upload_image: 1 });
    expect(failed.wechatProviderOperations.write_draft || 0).toBe(0);
  });

  it("projects a confirmed image-provider rejection as account repair without a draft write", async () => {
    const failed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatImageRejected: true,
    });
    expect(failed.result).toMatchObject({ state: "failed" });
    expect(failed.projection).toMatchObject({
      state: "failed",
      error_code: "wechat_image_upload_non_retryable",
      next_action: "repair_publishing_account",
      retry_count: 1,
    });
    expect(failed.wechatProviderOperations).toMatchObject({ upload_image: 1 });
    expect(failed.wechatProviderOperations.write_draft || 0).toBe(0);
  });

  it("projects an explicit access-token rejection as a resumable account repair hold", async () => {
    const held = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatAccessTokenRejected: true,
    });
    expect(held.result).toMatchObject({ state: "needs_action" });
    expect(held.projection).toMatchObject({
      state: "needs_action",
      error_code: "wechat_access_token_rejected",
      next_action: "repair_publishing_account",
      retry_count: 1,
    });
    expect(held.wechatProviderOperations).toMatchObject({ access_token: 1 });
    expect(held.wechatProviderOperations.upload_image || 0).toBe(0);
    expect(held.wechatProviderOperations.write_draft || 0).toBe(0);
  });

  it("runs the long visual result through private WeChat drafting with twelve logical receipts", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, visualLong: true, wechat: true });
    expect(drafted.projection?.error_code).toBeNull();
    expect(drafted.result).toMatchObject({ state: "draft_ready", artifact_ids: expect.any(Array) });
    expect(drafted.result.artifact_ids).toHaveLength(24);
    expect(drafted.artifactCount).toBe(4);
    expect(drafted.receiptCount).toBe(4);
    expect(drafted.wechatCalls).toBe(10);
    expect(drafted.wechatProviderOperations).toMatchObject({ upload_image: 6, write_draft: 1, get_draft: 1 });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
    expect(ledger.artifacts).toHaveLength(12);
    expect(ledger.artifacts.filter(item => item.kind === "wechat_image_upload_receipt")).toHaveLength(6);
  });

  it("maps a denied account directly from visual_ready to needs_action without synthetic publishing progress", async () => {
    const held = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatAccountDenied: true });
    expect(held.result).toMatchObject({ state: "needs_action" });
    expect(held.artifactCount).toBe(4);
    expect(held.receiptCount).toBe(4);
    expect(held.result.artifact_ids).toHaveLength(9);
    expect(held.wechatCalls).toBe(1);
    expect(held.projection).toMatchObject({
      state: "needs_action",
      progress_percent: 80,
      error_code: "wechat_publishing_account_not_allowed",
      next_action: "request_account_enablement",
    });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(held.userId, held.workspaceId, held.articleId, held.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(held.runId, held.userId, held.workspaceId);
    expect(ledger.artifacts).toHaveLength(0);
  });

  it("repairs an account hold through the trusted Wave2D checkpoint without replaying visual work", async () => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatAccountDenied: true, wechatAccountRepairResume: true,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.projection).toMatchObject({ state: "draft_ready", error_code: null, next_action: null });
    expect(resumed.visualExecuteCalls).toBe(4);
    expect(resumed.wechatOperations.resolve_account).toBe(2);
    expect(resumed.wechatOperations.upload_image).toBe(3);
    expect(resumed.wechatOperations.write_draft).toBe(1);
    expect(resumed.wechatUploadStates).toEqual([
      { projection: "draft_syncing", coordinator: "draft_syncing" },
      { projection: "draft_syncing", coordinator: "draft_syncing" },
      { projection: "draft_syncing", coordinator: "draft_syncing" },
    ]);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(resumed.userId, resumed.workspaceId, resumed.articleId, resumed.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(resumed.runId, resumed.userId, resumed.workspaceId);
    const passingReadbacks = ledger.artifacts.filter(item =>
      item.kind === "wechat_draft_readback_qa" && item.payload_summary.decision === "pass",
    );
    expect(passingReadbacks).toHaveLength(1);
    const activeScope = String(passingReadbacks[0].payload_summary.execution_scope);
    const recoveryCycle = String(passingReadbacks[0].payload_summary.recovery_cycle);
    expect(recoveryCycle).toMatch(/^[a-f0-9]{32}$/);
    const events = await runtimeEnv.DB.prepare(`SELECT revision, idempotency_key, payload_hash, event_type
      FROM publication_run_events WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key LIKE 'wave2d:%'`)
      .bind(resumed.runId, resumed.userId, resumed.workspaceId)
      .all<{ revision: number; idempotency_key: string; payload_hash: string; event_type: string }>();
    const resumedRows = (events.results || []).filter(row =>
      row.idempotency_key.startsWith(`wave2d:resumed:${recoveryCycle}:`) && row.idempotency_key.endsWith(`:${resumed.runId}`),
    );
    expect(resumedRows).toHaveLength(1);
    const triplet = (events.results || []).filter(row => row.idempotency_key.includes(`:${recoveryCycle}:`))
      .sort((left, right) => left.revision - right.revision);
    expect(triplet.map(row => row.event_type)).toEqual([
      "wechat_side_effect_reconciled",
      "wechat_reconciliation_retrying",
      "wechat_reconciliation_resumed",
    ]);
    const hold = (events.results || []).find(row => row.revision === triplet[0].revision - 1);
    expect(hold).toBeTruthy();
    const recovered = [hold!, ...triplet];
    expect(recovered.map(row => row.event_type)).toEqual([
      "needs_action",
      "wechat_side_effect_reconciled",
      "wechat_reconciliation_retrying",
      "wechat_reconciliation_resumed",
    ]);
    expect(recovered.map(row => row.revision)).toEqual([
      recovered[0].revision,
      recovered[0].revision + 1,
      recovered[0].revision + 2,
      recovered[0].revision + 3,
    ]);
    const holdParts = recovered[0].idempotency_key.split(":");
    expect(Number(holdParts.at(-2)) + 1).toBe(recovered[0].revision);
    const activeRevisions = ledger.artifacts
      .filter(item => item.payload_summary.execution_scope === activeScope)
      .map(item => (events.results || []).find(row =>
        row.idempotency_key === item.idempotency_key && row.payload_hash === item.payload_hash,
      )?.revision);
    expect(activeRevisions).toHaveLength(9);
    expect(activeRevisions.every((revision): revision is number => Number.isInteger(revision))).toBe(true);
    expect(resumedRows[0].revision).toBeLessThan(Math.min(...(activeRevisions as number[])));
  });

  it("maps an explicit provider account rejection to an account repair hold without later slots or draft calls", async () => {
    const held = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatAccountRejected: true });
    expect(held.result).toMatchObject({ state: "needs_action" });
    expect(held.projection).toMatchObject({
      state: "needs_action",
      error_code: "wechat_publishing_account_rejected",
      next_action: "repair_publishing_account",
    });
    expect(held.wechatOperations).toMatchObject({ resolve_account: 1, upload_image: 1 });
    expect(held.wechatOperations.write_draft || 0).toBe(0);
    expect(held.wechatUploadStates).toEqual([{ projection: "draft_syncing", coordinator: "draft_syncing" }]);
  });

  it("does one verified mapping read for same content and performs no draft mutation", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatSameContent: true });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.wechatOperations).toMatchObject({ resolve_account: 1, upload_image: 3, get_draft: 1 });
    expect(drafted.wechatOperations.write_draft || 0).toBe(0);
    expect(drafted.wechatCalls).toBe(5);
  });

  it("verifies a legacy recording clue before updating the same draft identity", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatLegacyClue: true });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.wechatOperations).toMatchObject({ resolve_account: 1, upload_image: 3, get_draft: 2, write_draft: 1 });
    expect(drafted.wechatCalls).toBe(7);
    const recording = await runtimeEnv.DB.prepare(`SELECT wechat_draft_id FROM recordings WHERE id = ? AND user_id = ? AND workspace_id = ?`)
      .bind(drafted.recordingId, drafted.userId, drafted.workspaceId).first<{ wechat_draft_id: string | null }>();
    // The compatibility projection is owner-bound and only replaces NULL or the same verified id.
    expect(recording).toBeTruthy();
  });

  it("reuses a verified account/article mapping across runs for update and same-content validation", async () => {
    const state = statefulWechatAdapter();
    const articleId = `runtime-wechat-mapping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const first = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatState: state, wechatArticleId: articleId, wechatDraftTitle: "Mapping version one",
    });
    expect(first.result).toMatchObject({ state: "draft_ready" });
    expect(first.wechatProviderOperations.write_draft).toBe(1);

    const changed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatState: state, wechatArticleId: articleId, wechatDraftTitle: "Mapping version two",
    });
    expect(changed.result).toMatchObject({ state: "draft_ready" });
    expect(changed.wechatOperations.write_draft).toBe(1);
    expect(changed.wechatProviderOperations.write_draft).toBe(1);
    const firstMediaId = [...state.drafts.keys()][0];
    expect(firstMediaId).toBeDefined();
    expect(state.drafts.size).toBe(1);
    expect(state.drafts.get(firstMediaId!)?.title).toBe("Mapping version two");

    const same = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatState: state, wechatArticleId: articleId, wechatDraftTitle: "Mapping version two",
    });
    expect(same.result).toMatchObject({ state: "draft_ready" });
    expect(same.wechatOperations).toMatchObject({ get_draft: 1, upload_image: 3 });
    expect(same.wechatOperations.write_draft || 0).toBe(0);
    expect(same.wechatProviderOperations.upload_image || 0).toBe(0);
    expect(same.wechatProviderOperations.write_draft || 0).toBe(0);
    expect(same.wechatProviderOperations.get_draft || 0).toBe(1);
  }, 20_000);

  it.each(["upload", "package", "readback"] as const)("replays a completed WeChat %s receipt after its Durable Object response is lost", async (checkpoint) => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatReceiptResponseLoss: checkpoint,
    });
    expect(drafted.projection?.error_code).toBeNull();
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.wechatProviderOperations).toEqual({ upload_image: 3, write_draft: 1, get_draft: 1 });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
    expect(ledger.artifacts).toHaveLength(9);
    expect(ledger.receipt_ids).toHaveLength(9);
    expect(ledger.wechat_events).toHaveLength(9);
    expect(drafted.wechatCheckpointRecoveryDelta).toEqual({
      provider_operation: 0, r2_exact_object_count: 1, d1_event_delta: 0,
      do_artifact_delta: 0, do_receipt_delta: 0, do_event_delta: 0,
    });
  });

  it.each(["upload", "package", "readback"] as const)("reconciles a D1-projected WeChat %s checkpoint by completing only its missing Durable Object receipt", async (checkpoint) => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatReceiptBeforeCompletionLoss: checkpoint,
    });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.projection).toMatchObject({ state: "draft_ready", error_code: null, next_action: null });
    expect(drafted.wechatProviderOperations).toEqual({ upload_image: 3, write_draft: 1, get_draft: 1 });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
    expect(ledger.artifacts).toHaveLength(9);
    expect(ledger.receipt_ids).toHaveLength(9);
    expect(ledger.wechat_events).toHaveLength(9);
    expect(drafted.wechatCheckpointRecoveryDelta).toEqual({
      provider_operation: 0, r2_exact_object_count: 1, d1_event_delta: 0,
      do_artifact_delta: 0, do_receipt_delta: 1, do_event_delta: 1,
    });
  });

  it.each(["draft", "cover"] as const)("fails closed when draft-ready recording %s evidence drifts from immutable readback", async (field) => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatDraftReadyReplayMismatch: field,
    });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.workflowError).toBe("wechat_artifact_reconciliation_required");
    expect(drafted.wechatProviderOperations).toMatchObject({ upload_image: expect.any(Number), write_draft: 1 });
  });

  it.each([
    ["failed readback QA", "failed_readback", false],
    ["missing normal receipt slot", "missing_upload_slot", false],
    ["duplicate long receipt slot", "duplicate_upload_slot", true],
  ] as const)("fails closed on completed immutable WeChat evidence with %s", async (_label, tamper, visualLong) => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      visualLong,
      wechat: true,
      wechatCompletedEvidenceTamper: tamper,
    });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.workflowError).toBe("wechat_artifact_identity_conflict");
    expect(drafted.wechatReplayDelta).toEqual({
      service_calls: 0,
      provider_uploads: 0,
      provider_writes: 0,
      provider_reads: 0,
    });
  });

  it("rejects a spliced historical recovery epoch without reissuing WeChat work", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatReadbackDrift: true,
      wechatReadbackDriftRepair: true,
      wechatCompletedEvidenceTamper: "recovery_cycle_splice",
    });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.workflowError).toBe("wechat_artifact_identity_conflict");
    expect(drafted.wechatReplayDelta).toEqual({
      service_calls: 0,
      provider_uploads: 0,
      provider_writes: 0,
      provider_reads: 0,
    });
  });

  it("fails closed on a DO/R2/D1-consistent extra initial WeChat scope without new adapter work", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
      await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId),
    );
    const ledger = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
    const template = ledger.artifacts.find(item => item.kind === "wechat_render_template");
    if (!template) throw new Error("missing active template fixture");
    const stored = await drafted.testEnv.FILES_BUCKET.get(template.artifact_key);
    if (!stored) throw new Error("missing active template object fixture");
    const raw = JSON.parse(await stored.text()) as { payload: Record<string, unknown> };
    const updated = await drafted.testEnv.DB.prepare(`SELECT updated_at FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(drafted.runId, drafted.userId, drafted.workspaceId).first<{ updated_at: string }>();
    const createdAt = new Date(Date.parse(String(updated?.updated_at || "2026-07-21T00:00:00.000Z")) + 1).toISOString();
    const orphanPayload = { ...raw.payload, execution_scope: `sha256:${"a".repeat(64)}`, recovery_cycle: null, created_at: createdAt };
    const orphan = await makeWechatArtifact({
      owner: { run_id: drafted.runId, article_id: drafted.articleId, recording_id: drafted.recordingId, user_id: drafted.userId, workspace_id: drafted.workspaceId },
      kind: "wechat_render_template",
      payload: orphanPayload,
      input_artifact_ids: [...template.input_artifact_ids],
      idempotency_key: `wave2d:test-extra-initial:${drafted.runId}`,
      created_at: createdAt,
    });
    await persistWechatArtifactForVerification(drafted.testEnv, coordinator, drafted.testParams, orphan, "draft_ready", "wechat_artifact_committed");
    const persisted = await coordinator.getFiveAgentWechatLedger(drafted.runId, drafted.userId, drafted.workspaceId);
    const d1 = await drafted.testEnv.DB.prepare(`SELECT artifact_id FROM editorial_artifacts WHERE artifact_id = ? LIMIT 1`).bind(orphan.envelope.artifact_id).first<{ artifact_id: string }>();
    expect(persisted.artifacts.some(item => item.artifact_id === orphan.envelope.artifact_id)).toBe(true);
    expect(persisted.receipt_ids).toContain(orphan.envelope.artifact_id);
    expect(d1?.artifact_id).toBe(orphan.envelope.artifact_id);
    const before = { ...drafted.wechatProviderOperations };
    const workflow = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    workflow.env = drafted.testEnv;
    workflow._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    await expect(workflow.run({ payload: drafted.testParams, instanceId: String((await coordinator.getFiveAgentRun(drafted.runId, drafted.userId, drafted.workspaceId) as Record<string, unknown>).workflow_id) }, step))
      .rejects.toMatchObject({ code: "wechat_artifact_reconciliation_required" });
    expect(drafted.wechatProviderOperations).toEqual(before);
  });

  it("fails closed on a DO/R2/D1-consistent second passing readback scope without new adapter work", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
      await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId),
    );
    await persistForgedWechatArtifact(
      drafted,
      coordinator,
      "wechat_draft_readback_qa",
      "second-pass",
      `sha256:${"b".repeat(64)}`,
      "c".repeat(32),
      payload => payload,
    );
    const before = { ...drafted.wechatProviderOperations };
    const workflow = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    workflow.env = drafted.testEnv;
    workflow._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    await expect(workflow.run({ payload: drafted.testParams, instanceId: String((await coordinator.getFiveAgentRun(drafted.runId, drafted.userId, drafted.workspaceId) as Record<string, unknown>).workflow_id) }, step))
      .rejects.toMatchObject({ code: "wechat_artifact_reconciliation_required" });
    expect(drafted.wechatProviderOperations).toEqual(before);
  });

  it("fails closed on a DO/R2/D1-consistent historical scope with a missing template root", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
      await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId),
    );
    await persistForgedWechatArtifact(
      drafted,
      coordinator,
      "wechat_render_qa_report",
      "missing-template",
      `sha256:${"d".repeat(64)}`,
      "e".repeat(32),
      payload => payload,
    );
    const before = { ...drafted.wechatProviderOperations };
    const workflow = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    workflow.env = drafted.testEnv;
    workflow._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    await expect(workflow.run({ payload: drafted.testParams, instanceId: String((await coordinator.getFiveAgentRun(drafted.runId, drafted.userId, drafted.workspaceId) as Record<string, unknown>).workflow_id) }, step))
      .rejects.toMatchObject({ code: "wechat_artifact_reconciliation_required" });
    expect(drafted.wechatProviderOperations).toEqual(before);
  });

  it("fails closed on a DO/R2/D1-consistent cross-scope render-QA parent splice", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(
      await coordinatorShardName(drafted.userId, drafted.workspaceId, drafted.articleId, drafted.runId),
    );
    const scope = `sha256:${"f".repeat(64)}`;
    const cycle = "1".repeat(32);
    await persistForgedWechatArtifact(
      drafted,
      coordinator,
      "wechat_render_template",
      "splice-template",
      scope,
      cycle,
      payload => payload,
    );
    // The QA object is structurally normalized and persisted in all three
    // ledgers, but intentionally retains the active template parent.
    await persistForgedWechatArtifact(
      drafted,
      coordinator,
      "wechat_render_qa_report",
      "splice-render-qa",
      scope,
      cycle,
      payload => payload,
    );
    const before = { ...drafted.wechatProviderOperations };
    const workflow = Object.create(FiveAgentPublishingWorkflow.prototype) as any;
    workflow.env = drafted.testEnv;
    workflow._agent = coordinator;
    const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
    await expect(workflow.run({ payload: drafted.testParams, instanceId: String((await coordinator.getFiveAgentRun(drafted.runId, drafted.userId, drafted.workspaceId) as Record<string, unknown>).workflow_id) }, step))
      .rejects.toMatchObject({ code: "wechat_artifact_reconciliation_required" });
    expect(drafted.wechatProviderOperations).toEqual(before);
  });

  it("keeps recording, publication state, and draft-ready event atomic when the verified cover CAS conflicts", async () => {
    const conflict = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatCoverCasConflict: true,
    });
    const recording = await runtimeEnv.DB.prepare(`SELECT wechat_draft_id, cover_image_url FROM recordings
      WHERE id = ? AND user_id = ? AND workspace_id = ?`).bind(conflict.recordingId, conflict.userId, conflict.workspaceId)
      .first<{ wechat_draft_id: string | null; cover_image_url: string | null }>();
    const readyEvents = await runtimeEnv.DB.prepare(`SELECT event_id FROM publication_run_events
      WHERE run_id = ? AND state = 'draft_ready'`).bind(conflict.runId).all<{ event_id: string }>();
    expect(recording).toEqual({ wechat_draft_id: null, cover_image_url: "https://wechat.example/pre-existing-cover.png" });
    expect(readyEvents.results).toEqual([]);
    expect(conflict.projection?.state).not.toBe("draft_ready");
  });

  it("does not commit a recording-only compatibility projection when draft-ready loses its run revision CAS", async () => {
    const raced = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatFinalProjectionRevisionRace: true,
    });
    const recording = await runtimeEnv.DB.prepare(`SELECT wechat_draft_id, cover_image_url FROM recordings
      WHERE id = ? AND user_id = ? AND workspace_id = ?`).bind(raced.recordingId, raced.userId, raced.workspaceId)
      .first<{ wechat_draft_id: string | null; cover_image_url: string | null }>();
    const readyEvents = await runtimeEnv.DB.prepare(`SELECT event_id FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state = 'draft_ready'`)
      .bind(raced.runId, raced.userId, raced.workspaceId).all<{ event_id: string }>();
    const competitor = await runtimeEnv.DB.prepare(`SELECT event_id FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key LIKE 'synthetic:competitor:%'`)
      .bind(raced.runId, raced.userId, raced.workspaceId).all<{ event_id: string }>();
    expect(recording).toEqual({ wechat_draft_id: null, cover_image_url: null });
    expect(readyEvents.results).toEqual([]);
    expect(competitor.results).toHaveLength(1);
    expect(raced.projection?.state).not.toBe("draft_ready");
  });

  it("reconciles an ambiguous add through bounded identity lookup without a second add", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatAddUnknown: "unique" });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.wechatOperations).toMatchObject({ write_draft: 1, find_draft: 1, get_draft: 2, upload_image: 3 });
    expect(drafted.wechatOperations.write_draft).toBe(1);
  });

  it("retries a post-write draft read through three durable attempts without repeating the draft mutation", async () => {
    const drafted = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatReadFailure: "retryable",
    });
    expect(drafted.result).toMatchObject({ state: "draft_ready" });
    expect(drafted.wechatProviderOperations).toMatchObject({ upload_image: 3, write_draft: 1, get_draft: 3 });
  });

  it.each([
    ["known read rejection", "known", "needs_action", "draft_readback_unavailable", "reconcile_draft", 1],
    ["read retry exhaustion", "exhausted", "failed", "wechat_operation_retry_exhausted", "retry", 3],
  ] as const)("keeps %s distinct from a draft-write failure", async (_label, failure, state, errorCode, nextAction, reads) => {
    const result = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatReadFailure: failure,
    });
    expect(result.result).toMatchObject({ state });
    expect(result.projection).toMatchObject({ state, error_code: errorCode, next_action: nextAction });
    expect(result.wechatProviderOperations).toMatchObject({ upload_image: 3, write_draft: 1, get_draft: reads });
  });

  it.each(["zero", "multiple"] as const)("holds an ambiguous add when bounded identity lookup is %s", async (mode) => {
    const held = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatAddUnknown: mode });
    expect(held.result).toMatchObject({ state: "needs_action" });
    expect(held.projection).toMatchObject({ state: "needs_action", error_code: "draft_identity_unresolved", next_action: "reconcile_draft_identity" });
    expect(held.wechatOperations.write_draft).toBe(1);
    expect(held.wechatOperations.find_draft).toBe(1);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(held.userId, held.workspaceId, held.articleId, held.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(held.runId, held.userId, held.workspaceId);
    expect(ledger.artifacts).toHaveLength(7);
  });

  it("reconciles a later-unique unknown add without issuing a second draft write", async () => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatAddUnknown: "zero", wechatAddUnknownLaterUnique: true,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.wechatProviderOperations.write_draft).toBe(1);
    expect(resumed.wechatOperations.write_draft).toBe(1);
    expect(resumed.wechatOperations.find_draft).toBe(2);
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(resumed.userId, resumed.workspaceId, resumed.articleId, resumed.runId));
    expect((await coordinator.getFiveAgentWechatLedger(resumed.runId, resumed.userId, resumed.workspaceId)).artifacts).toHaveLength(9);
  });

  it("binds each repeated draft_syncing hold to an independent complete recovery cycle without repeating confirmed writes", async () => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatAddUnknown: "zero",
      wechatAddUnknownTwoRecoveryCycles: true,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.wechatProviderOperations).toMatchObject({ upload_image: 3, write_draft: 1 });
    const rows = await runtimeEnv.DB.prepare(`SELECT idempotency_key, event_type, state FROM publication_run_events
      WHERE run_id = ? AND idempotency_key LIKE 'wave2d:%' ORDER BY revision`).bind(resumed.runId)
      .all<{ idempotency_key: string; event_type: string; state: string }>();
    const recovery = rows.results?.filter(row => /^(wave2d:reconciled:|wave2d:retrying:|wave2d:resumed:)/.test(row.idempotency_key)) || [];
    expect(recovery).toHaveLength(6);
    const cycles = new Set(recovery.map(row => row.idempotency_key.split(":")[2]));
    expect(cycles.size).toBe(2);
    for (const cycle of cycles) {
      const group = recovery.filter(row => row.idempotency_key.split(":")[2] === cycle);
      expect(group.map(row => row.event_type)).toEqual([
        "wechat_side_effect_reconciled",
        "wechat_reconciliation_retrying",
        "wechat_reconciliation_resumed",
      ]);
    }
  });

  it.each(["reconciled", "retrying", "resumed", "do_final"] as const)("reconciles a %s recovery response loss without a second hold or WeChat mutation", async (phase) => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true,
      wechat: true,
      wechatAddUnknown: "zero",
      wechatAddUnknownLaterUnique: true,
      wechatRecoveryResponseLoss: phase,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.projection).toMatchObject({ state: "draft_ready", error_code: null, next_action: null });
    expect(resumed.wechatProviderOperations).toMatchObject({ upload_image: 3, write_draft: 1 });
    const rows = await runtimeEnv.DB.prepare(`SELECT event_type, state, error_code, idempotency_key
      FROM publication_run_events WHERE run_id = ? AND idempotency_key LIKE 'wave2d:%' ORDER BY revision`)
      .bind(resumed.runId).all<{ event_type: string; state: string; error_code: string | null; idempotency_key: string }>();
    const holds = (rows.results || []).filter(row => row.event_type === "needs_action" && row.error_code === "draft_identity_unresolved");
    const recovery = (rows.results || []).filter(row => /^(wave2d:reconciled:|wave2d:retrying:|wave2d:resumed:)/.test(row.idempotency_key));
    expect(holds).toHaveLength(1);
    expect(recovery).toHaveLength(3);
    const cycle = recovery[0]?.idempotency_key.split(":")[2];
    expect(new Set(recovery.map(row => row.idempotency_key.split(":")[2]))).toEqual(new Set([cycle]));
    expect(recovery.map(row => row.event_type)).toEqual([
      "wechat_side_effect_reconciled",
      "wechat_reconciliation_retrying",
      "wechat_reconciliation_resumed",
    ]);
  });

  it("persists a failed readback QA before holding on canonical HTML drift", async () => {
    const held = await executeSyntheticScenario("p2_pass", undefined, false, { visual: true, wechat: true, wechatReadbackDrift: true });
    expect(held.result).toMatchObject({ state: "needs_action" });
    expect(held.projection).toMatchObject({ state: "needs_action", error_code: "draft_readback_mismatch", next_action: "reconcile_draft" });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(held.userId, held.workspaceId, held.articleId, held.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(held.runId, held.userId, held.workspaceId);
    expect(ledger.artifacts).toHaveLength(9);
    const readback = ledger.artifacts.find(item => item.kind === "wechat_draft_readback_qa");
    expect(readback?.payload_summary.decision).toBe("failed");
  });

  it("keeps a failed readback QA as historical evidence and completes a corrected draft in a fresh active epoch", async () => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatReadbackDrift: true, wechatReadbackDriftRepair: true,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.wechatProviderOperations).toEqual({ upload_image: 3, write_draft: 1, get_draft: 2 });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(resumed.userId, resumed.workspaceId, resumed.articleId, resumed.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(resumed.runId, resumed.userId, resumed.workspaceId);
    const readbacks = ledger.artifacts.filter(item => item.kind === "wechat_draft_readback_qa");
    expect(readbacks.map(item => item.payload_summary.decision).sort()).toEqual(["failed", "pass"]);
    const passingScope = readbacks.find(item => item.payload_summary.decision === "pass")?.payload_summary.execution_scope;
    expect(ledger.artifacts.filter(item => item.payload_summary.execution_scope === passingScope)).toHaveLength(9);
    expect(ledger.artifacts).toHaveLength(18);
  });

  it("derives a fresh read operation after a durable known read failure without another draft write", async () => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatReadFailure: "known", wechatKnownReadRepair: true,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.wechatProviderOperations).toEqual({ upload_image: 3, write_draft: 1, get_draft: 2 });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(resumed.userId, resumed.workspaceId, resumed.articleId, resumed.runId));
    const attempts = await coordinator.listFiveAgentCallAttempts(resumed.runId, resumed.userId, resumed.workspaceId);
    const reads = attempts.filter(item => item.call_kind === "wechat_get_draft");
    expect(new Set(reads.map(item => item.idempotency_key)).size).toBeGreaterThan(1);
    expect(reads.some(item => item.status === "failed" && item.error_code === "draft_readback_unavailable")).toBe(true);
  });

  it("rotates the trusted account receipt into a new execution scope without replaying a confirmed draft write", async () => {
    const resumed = await executeSyntheticScenario("p2_pass", undefined, false, {
      visual: true, wechat: true, wechatAccountRejected: true, wechatAccountConfigRepairResume: true,
    });
    expect(resumed.result).toMatchObject({ state: "draft_ready" });
    expect(resumed.wechatProviderOperations).toEqual({ upload_image: 3, write_draft: 1, get_draft: 1 });
    const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(resumed.userId, resumed.workspaceId, resumed.articleId, resumed.runId));
    const ledger = await coordinator.getFiveAgentWechatLedger(resumed.runId, resumed.userId, resumed.workspaceId);
    const scopes = new Set(ledger.artifacts.map(item => item.payload_summary.execution_scope));
    expect(scopes.size).toBe(2);
    const active = ledger.artifacts.find(item => item.kind === "wechat_draft_readback_qa" && item.payload_summary.decision === "pass")?.payload_summary.execution_scope;
    expect(ledger.artifacts.filter(item => item.payload_summary.execution_scope === active)).toHaveLength(9);
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
