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
import { projectPublicationTransition, type PublicationRunRow } from "../src/publicationProjection";
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

async function syntheticDraftPayload(input: { run_id: string; article_id: string; recording_id: number; source_hash: string; title?: string; revision?: 1 | 2; parent_artifact_id?: string | null; parent_review_artifact_id?: string | null; parent_dispatch_artifact_id?: string | null }) {
  const title = input.title || "Synthetic editorial title";
  const blocks = await Promise.all([
    "A short synthetic paragraph.",
    "A second synthetic paragraph.",
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
  callIntentCount: number;
  revisionCount: number;
  projection: Record<string, unknown> | null;
  projectionEventHashes: string[];
  doEventHashes: string[];
  workflowError?: string;
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
      const draft = await syntheticDraftPayload({ run_id: input.run_id, article_id: input.article_id, recording_id: input.recording_id, source_hash: input.source_hash });
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
  const coordinator = runtimeEnv.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
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
  workflowInstance._agent = coordinator;
  const step = { do: async (...args: unknown[]) => await (args[args.length - 1] as () => Promise<unknown>)() };
  let result: Record<string, unknown>;
  let workflowError: string | undefined;
  try {
    result = await workflowInstance.run({ payload: params, instanceId: String(run.workflow_id) }, step) as Record<string, unknown>;
  } catch (error) {
    if (!options.reviewRoundOverride && !options.draftPinDrift && !options.reviewPinDrift) throw error;
    workflowError = error instanceof EditorialRuntimeError
      ? error.code
      : String((error as { code?: unknown })?.code || error);
    result = { state: "integrity_error", artifact_ids: [] };
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
    callIntentCount: Number(afterRun.call_intent_count),
    revisionCount: Number(afterRun.revision_count),
    projection,
    projectionEventHashes: (projectionEvents.results || []).map(row => row.payload_hash),
    doEventHashes: doEvents.flatMap(row => row.payload_hash ? [row.payload_hash] : []),
    workflowError,
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
