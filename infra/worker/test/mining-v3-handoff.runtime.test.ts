import { describe, expect, it } from "vitest";
import {
  handleMiningV3HandoffInternalRoute,
  miningV3HandoffTesting,
} from "../src/miningV3Handoff";
import {
  buildFiveAgentBriefObject,
  FIVE_AGENT_PUBLISHING_POLICY_VERSION,
  FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
} from "../src/fiveAgentPublishing";
import { putImmutableArtifact } from "../src/wave2/artifactStore";
import { canonicalJson, sha256 } from "../src/wave2/artifactContracts";
import {
  PUBLICATION_AGENT_VERSIONS,
  PUBLICATION_SKILL_PINS,
  PUBLICATION_WAVE2_ADAPTER_PINS,
} from "../src/editorialContracts";
import { PUBLICATION_SCHEMA_VERSION } from "../src/publicationProjection";

type Stored = { bytes: Uint8Array; metadata: Record<string, string> };

class MemoryBucket {
  readonly objects = new Map<string, Stored>();

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      customMetadata: stored.metadata,
      arrayBuffer: async () => stored.bytes.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.bytes.byteLength,
      customMetadata: stored.metadata,
    } as unknown as R2Object;
  }

  async put(key: string, value: string | ArrayBufferView, options?: R2PutOptions): Promise<R2Object | null> {
    if (options?.onlyIf && this.objects.has(key)) throw new Error("precondition failed");
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: { ...(options?.customMetadata || {}) } });
    return { key } as R2Object;
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix || "";
    return { objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key }) as R2Object), truncated: false } as R2Objects;
  }
}

const userId = "handoff_user";
const workspaceId = "handoff_workspace";
const sourceKey = `users/${userId}/inbox/source.mp3`;

function recording(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 41001,
    user_id: userId,
    workspace_id: workspaceId,
    filename: "source.mp3",
    r2_key: sourceKey,
    source_type: "AUDIO",
    article_title: "标题",
    style_profile_id: null,
    style_profile_version: null,
    layout_profile_id: null,
    layout_profile_version: null,
    ...overrides,
  };
}

type DbState = {
  canonical?: Record<string, unknown> | null;
  publication?: Record<string, unknown> | null;
  current?: Record<string, unknown> | null;
  publicationEvents?: Array<Record<string, unknown>>;
  briefs?: Array<Record<string, unknown>>;
  artifactMirrors?: Array<Record<string, unknown>>;
  coordinator?: {
    run?: Record<string, unknown> | null;
    mainEvents?: Array<Record<string, unknown>>;
    ledger?: Record<string, unknown> | null;
    evidence?: {
      workflow_start_status: string | null;
      events: Array<{ event_type: string; idempotency_key: string; evidence_hash: string; created_at: string }>;
      receipts: Array<{ receipt_id: string; reconciliation_key: string; evidence_hash: string }>;
    };
    confirmation?: { confirmed: boolean; event_id: string | null };
    confirmationError?: { status?: number };
    artifacts?: Array<Record<string, unknown>>;
  };
  historyProbe?: {
    canonical?: Record<string, unknown> | null;
    publication?: Record<string, unknown> | null;
    current?: Record<string, unknown> | null;
  };
  historyError?: boolean;
};

function validV3Publication(state: DbState): Record<string, unknown> | null {
  const canonical = state.canonical;
  const publication = state.publication;
  if (!canonical || !publication || canonical.schema_version !== "editorial-orchestration.v3" ||
      publication.schema_version !== PUBLICATION_SCHEMA_VERSION || publication.source_run_id !== canonical.run_id) {
    return null;
  }
  return publication;
}

function testEnv(bucket: MemoryBucket, row = recording(), enabled = true, state: DbState = {}): any {
  return {
    DB: {
      prepare(sql: string) {
        return { bind(..._args: unknown[]) { return {
          all: async () => {
            if (sql.includes("FROM recordings")) return { results: _args[0] === row.r2_key ? [row] : [] };
            if (sql.includes("FROM publication_run_events")) return { results: state.publicationEvents || [] };
            if (sql.includes("FROM editorial_artifacts")) {
              const rows = [...(state.briefs || []), ...(state.artifactMirrors || [])];
              return { results: sql.includes("kind = 'article_brief'") ? rows.filter(item => item.kind === "article_brief") : rows };
            }
            return { results: [] };
          },
          first: async () => {
            if (state.historyError && (sql.includes("editorial_runs") || sql.includes("publication_runs") || sql.includes("publication_current_runs"))) {
              throw new Error("no such table");
            }
            if (sql.includes("SELECT p.run_id FROM publication_runs p")) return state.historyProbe ? state.historyProbe.publication || null : validV3Publication(state);
            if (sql.includes("SELECT c.current_run_id FROM publication_current_runs c")) {
              if (state.historyProbe) return state.historyProbe.current || null;
              const publication = validV3Publication(state);
              return publication && state.current?.current_run_id === publication.run_id ? state.current : null;
            }
            if (sql.includes("SELECT run_id FROM editorial_runs") && sql.includes("schema_version = ?")) {
              if (state.historyProbe) return state.historyProbe.canonical || null;
              return state.canonical?.schema_version === "editorial-orchestration.v3" ? state.canonical : null;
            }
            if (sql.includes("FROM editorial_runs")) return state.canonical || null;
            if (sql.includes("FROM publication_runs")) return state.publication || null;
            if (sql.includes("FROM publication_current_runs")) return state.current || null;
            return null;
          },
        }; } };
      },
    },
    EDITORIAL_COORDINATOR: {
      getByName() {
        return {
          getFiveAgentRun: async () => state.coordinator?.run || null,
          getFiveAgentStartLedger: async () => state.coordinator?.ledger || null,
          getFiveAgentStartEvidence: async () => state.coordinator?.evidence || {
            workflow_start_status: null,
            events: [],
            receipts: [],
          },
          getFiveAgentWorkflowStartConfirmation: async () => {
            if (state.coordinator?.confirmationError) throw state.coordinator.confirmationError;
            return state.coordinator?.confirmation || { confirmed: false, event_id: null };
          },
          listFiveAgentEvents: async () => state.coordinator?.mainEvents || [],
          getFiveAgentArtifactLedger: async () => ({ artifacts: state.coordinator?.artifacts || [], receipt_ids: (state.coordinator?.artifacts || []).map(item => item.artifact_id) }),
        };
      },
    },
    FILES_BUCKET: bucket,
    FIVE_AGENT_PUBLISHING_V3: enabled ? "true" : "false",
    FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: `${userId}:${workspaceId}`,
  };
}

function request(action: string, body: Record<string, unknown>): Request {
  return new Request(`https://internal/api/internal/v3/mining-handoffs/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function invoke(action: string, body: Record<string, unknown>, env: any): Promise<Response> {
  return handleMiningV3HandoffInternalRoute(request(action, body), env, new URL(`https://internal/api/internal/v3/mining-handoffs/${action}`));
}

function seedSource(
  bucket: MemoryBucket,
  bytes = new TextEncoder().encode("audio-source"),
  metadata: Record<string, string> = {},
  key = sourceKey,
): void {
  bucket.objects.set(key, { bytes, metadata: { userId, workspaceId, ...metadata } });
}

async function seedAcceptedRun(
  bucket: MemoryBucket,
  row: Record<string, unknown>,
  marker: any,
  transcriptText: string,
  state: DbState,
): Promise<{ runId: string; briefId: string; briefHash: string; payloadHash: string; manifestHash: string; legacyManifestHash: string }> {
  const transcript = await miningV3HandoffTesting.persistTranscript(testEnv(bucket, row), marker, transcriptText);
  const start = await miningV3HandoffTesting.startBody(marker, transcript);
  const createdAt = "2026-07-22T00:00:00.000Z";
  const brief = await buildFiveAgentBriefObject({ ...start, user_id: marker.user_id, workspace_id: marker.workspace_id, created_at: createdAt });
  await putImmutableArtifact(bucket as unknown as R2Bucket, brief, { userId: marker.user_id, workspaceId: marker.workspace_id, runId: start.run_id });
  const payloadHash = await sha256(canonicalJson({ ...start, user_id: marker.user_id, workspace_id: marker.workspace_id }));
  const skillPins = {
    ...PUBLICATION_SKILL_PINS,
    style: start.profile_pins.style,
    formatting: start.profile_pins.formatting,
    adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
    model_pins: { writing: "glm-5.2", editorial_review: "rules-only" },
  };
  const manifest = {
    schema_version: "editorial-orchestration.v3",
    run_id: start.run_id,
    article_id: marker.article_id,
    recording_id: marker.recording_id,
    user_id: marker.user_id,
    workspace_id: marker.workspace_id,
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    agent_versions: PUBLICATION_AGENT_VERSIONS,
    skill_pins: skillPins,
    adapter_pins: skillPins.adapter_pins,
    model_pins: skillPins.model_pins,
    idempotency_key: `run:${start.run_id}`,
    payload_hash: payloadHash,
  };
  const manifestHash = await sha256(canonicalJson(manifest));
  const { payload_hash: _payloadHash, ...legacyManifest } = manifest;
  const legacyManifestHash = await sha256(canonicalJson(legacyManifest));
  const workflowId = `five-agent-${start.run_id}`;
  state.canonical = {
    run_id: start.run_id, user_id: marker.user_id, workspace_id: marker.workspace_id,
    article_id: marker.article_id, recording_id: marker.recording_id, created_at: createdAt,
    schema_version: "editorial-orchestration.v3",
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    agent_versions_json: canonicalJson(PUBLICATION_AGENT_VERSIONS),
    skill_pins_json: canonicalJson(skillPins),
    idempotency_key: `run:${start.run_id}`,
    payload_hash: payloadHash,
  };
  state.publication = {
    run_id: start.run_id, user_id: marker.user_id, workspace_id: marker.workspace_id,
    article_id: marker.article_id, recording_id: marker.recording_id, state: "queued",
    state_revision: 0, last_successful_state: "queued", error_code: null, next_action: null,
    schema_version: PUBLICATION_SCHEMA_VERSION, source_run_id: start.run_id, source_manifest_hash: manifestHash,
    last_event_id: `${start.run_id}:event:0`, last_event_type: "run_queued",
    last_event_idempotency_key: `${start.run_id}:event:0`, last_event_payload_hash: payloadHash,
    last_event_created_at: createdAt,
  };
  state.publicationEvents = [{
    event_id: `${start.run_id}:event:0`, run_id: start.run_id, user_id: marker.user_id,
    workspace_id: marker.workspace_id, recording_id: marker.recording_id, revision: 0,
    event_type: "run_queued", state: "queued", idempotency_key: `${start.run_id}:event:0`,
    payload_hash: payloadHash, error_code: null, next_action: null, created_at: createdAt,
  }];
  state.current = { current_run_id: start.run_id };
  const confirmationEvidence = await sha256(canonicalJson({
    workflow_id: workflowId,
    run_id: start.run_id,
    article_id: marker.article_id,
    recording_id: marker.recording_id,
    user_id: marker.user_id,
    workspace_id: marker.workspace_id,
    payload_hash: payloadHash,
    manifest_hash: manifestHash,
    event_type: "workflow_start_confirmed",
  }));
  state.coordinator = {
    run: {
      run_id: start.run_id, user_id: marker.user_id, workspace_id: marker.workspace_id,
      article_id: marker.article_id, recording_id: marker.recording_id, workflow_id: workflowId,
      payload_hash: payloadHash, manifest_hash: manifestHash, state: "queued", state_revision: 0,
      error_code: null, next_action: null,
      start_ledger_status: "started", start_status: "workflow_started",
      start_error_code: null, start_next_action: null,
    },
    ledger: { workflow_id: workflowId, run_id: start.run_id, status: "started", start_status: null, error_code: null, next_action: null },
    evidence: {
      workflow_start_status: "started",
      events: [{ event_type: "workflow_start_confirmed", idempotency_key: `workflow-start-confirmed:${workflowId}`, evidence_hash: confirmationEvidence, created_at: createdAt }],
      receipts: [],
    },
    confirmation: { confirmed: true, event_id: `${workflowId}:start-event:workflow-start-confirmed:${workflowId}` },
    mainEvents: [{
      event_type: "run_queued", state: "queued", state_revision: 0, artifact_id: null,
      payload_hash: payloadHash, error_code: null, next_action: null, created_at: createdAt,
    }],
  };
  state.briefs = [{
    artifact_id: brief.envelope.artifact_id, kind: "article_brief", run_id: start.run_id,
    article_id: marker.article_id, recording_id: marker.recording_id,
    user_id: marker.user_id, workspace_id: marker.workspace_id,
    payload_hash: brief.envelope.payload_hash, storage_ref: brief.envelope.storage_ref,
  }];
  return {
    runId: start.run_id,
    briefId: brief.envelope.artifact_id,
    briefHash: brief.envelope.payload_hash,
    payloadHash,
    manifestHash,
    legacyManifestHash,
  };
}

async function setWorkflowCreateUnknownProof(
  state: DbState,
  marker: Record<string, unknown>,
  evidence: Awaited<ReturnType<typeof seedAcceptedRun>>,
): Promise<void> {
  const workflowId = `five-agent-${evidence.runId}`;
  const createdAt = "2026-07-22T00:00:01.000Z";
  const holdHash = await sha256(canonicalJson({
    run_payload_hash: evidence.payloadHash,
    event_type: "start_reconciliation_required",
    start_status: "workflow_create_unknown",
    target_state: "needs_action",
  }));
  const coordinatorHoldHash = await sha256(canonicalJson({
    workflow_id: workflowId,
    run_id: evidence.runId,
    event_type: "start_reconciliation_required",
    start_status: "workflow_create_unknown",
    error_code: "external_side_effect_unknown",
    next_action: "reconcile_external_side_effect",
  }));
  state.publication = {
    ...state.publication!,
    state: "needs_action", state_revision: 1,
    last_successful_state: "queued",
    error_code: "external_side_effect_unknown",
    next_action: "reconcile_external_side_effect",
    last_event_id: `${evidence.runId}:event:1`, last_event_type: "start_reconciliation_required",
    last_event_idempotency_key: `start-required:workflow_create_unknown:${evidence.runId}`,
    last_event_payload_hash: holdHash, last_event_created_at: createdAt,
  };
  state.publicationEvents = [
    ...(state.publicationEvents || []),
    {
      event_id: `${evidence.runId}:event:1`, run_id: evidence.runId, user_id: userId,
      workspace_id: workspaceId, recording_id: marker.recording_id, revision: 1,
      event_type: "start_reconciliation_required", state: "needs_action",
      idempotency_key: `start-required:workflow_create_unknown:${evidence.runId}`,
      payload_hash: holdHash, error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect", created_at: createdAt,
    },
  ];
  state.coordinator = {
    run: {
      run_id: evidence.runId,
      user_id: userId,
      workspace_id: workspaceId,
      article_id: marker.article_id,
      recording_id: marker.recording_id,
      workflow_id: workflowId,
      payload_hash: evidence.payloadHash,
      manifest_hash: evidence.manifestHash,
      state: "queued", state_revision: 0, error_code: null, next_action: null,
      start_ledger_status: "needs_action",
      start_status: "workflow_create_unknown",
      start_error_code: "external_side_effect_unknown",
      start_next_action: "reconcile_external_side_effect",
    },
    ledger: {
      workflow_id: workflowId,
      run_id: evidence.runId,
      status: "needs_action",
      start_status: "workflow_create_unknown",
      error_code: "external_side_effect_unknown",
      next_action: "reconcile_external_side_effect",
    },
    evidence: {
      workflow_start_status: "unknown",
      events: [{
        event_type: "start_reconciliation_required",
        idempotency_key: `start-required:${workflowId}:workflow_create_unknown`,
        evidence_hash: coordinatorHoldHash,
        created_at: createdAt,
      }],
      receipts: [],
    },
    confirmation: { confirmed: false, event_id: null },
    mainEvents: [{
      event_type: "run_queued", state: "queued", state_revision: 0, artifact_id: null,
      payload_hash: evidence.payloadHash, error_code: null, next_action: null, created_at: "2026-07-22T00:00:00.000Z",
    }],
  };
}

function setPublicationCurrent(state: DbState, event: Record<string, unknown>): void {
  state.publication = {
    ...state.publication!,
    state: event.state,
    state_revision: event.revision,
    error_code: event.error_code,
    next_action: event.next_action,
    last_event_id: event.event_id,
    last_event_type: event.event_type,
    last_event_idempotency_key: event.idempotency_key,
    last_event_payload_hash: event.payload_hash,
    last_event_created_at: event.created_at,
  };
}

function appendCoordinatorBusinessEvent(
  state: DbState,
  eventType: string,
  stateName: string,
  payloadHash: string,
  errorCode: string | null = null,
  nextAction: string | null = null,
): void {
  const previous = state.coordinator!.mainEvents || [];
  const revision = previous.length;
  const event = {
    event_type: eventType, state: stateName, state_revision: revision, artifact_id: null,
    payload_hash: payloadHash, error_code: errorCode, next_action: nextAction,
    created_at: `2026-07-22T00:00:0${revision}.000Z`,
  };
  state.coordinator!.mainEvents = [...previous, event];
  state.coordinator!.run = {
    ...state.coordinator!.run!, state: stateName, state_revision: revision,
    error_code: errorCode, next_action: nextAction,
  };
}

function appendPublicationBusinessEvent(
  state: DbState,
  runId: string,
  recordingId: number,
  eventType: string,
  stateName: string,
  payloadHash: string,
  errorCode: string | null = null,
  nextAction: string | null = null,
): void {
  const previous = state.publicationEvents || [];
  const revision = previous.length;
  const event = {
    event_id: `${runId}:event:${revision}`, run_id: runId, user_id: userId, workspace_id: workspaceId,
    recording_id: recordingId, revision, event_type: eventType, state: stateName,
    idempotency_key: `${eventType}:fixture:${revision}:${runId}`, payload_hash: payloadHash,
    error_code: errorCode, next_action: nextAction, created_at: `2026-07-22T00:00:0${revision}.000Z`,
  };
  state.publicationEvents = [...previous, event];
  setPublicationCurrent(state, event);
}

async function appendVisualRecoveryGroup(
  state: DbState,
  marker: Record<string, unknown>,
  evidence: Awaited<ReturnType<typeof seedAcceptedRun>>,
): Promise<void> {
  const target = "visual_planning";
  const phase = 19;
  const checkpointHash = "sha256:" + "9".repeat(64);
  appendPublicationBusinessEvent(state, evidence.runId, Number(marker.recording_id), target, target, checkpointHash);
  appendCoordinatorBusinessEvent(state, target, target, checkpointHash);

  const append = (event: Record<string, unknown>) => {
    state.publicationEvents = [...(state.publicationEvents || []), event];
    setPublicationCurrent(state, event);
  };
  const holdRevision = state.publicationEvents!.length;
  const holdKey = `wave2d:needs-action:${phase}:external_side_effect_unknown:${holdRevision - 1}:${evidence.runId}`;
  const holdHash = await sha256(canonicalJson({
    run_payload_hash: evidence.payloadHash, event_type: "needs_action", phase, target_state: "needs_action",
    error_code: "external_side_effect_unknown", next_action: "reconcile_external_side_effect",
    revision_count: null, retry_count: 1,
  }));
  append({
    event_id: `${evidence.runId}:event:${holdRevision}`, run_id: evidence.runId, user_id: userId, workspace_id: workspaceId,
    recording_id: marker.recording_id, revision: holdRevision, event_type: "needs_action", state: "needs_action",
    idempotency_key: holdKey, payload_hash: holdHash, error_code: "external_side_effect_unknown",
    next_action: "reconcile_external_side_effect", retry_count: 1, created_at: `2026-07-22T00:00:0${holdRevision}.000Z`,
  });
  appendCoordinatorBusinessEvent(state, "needs_action", "needs_action", holdHash, "external_side_effect_unknown", "reconcile_external_side_effect");

  const recoveredRevision = state.publicationEvents!.length;
  const hashes = await Promise.all([
    sha256(canonicalJson({ run_payload_hash: evidence.payloadHash, event_type: "visual_side_effect_reconciled", target_state: "needs_action", resume_state: target })),
    sha256(canonicalJson({ run_payload_hash: evidence.payloadHash, event_type: "visual_reconciliation_retrying", target_state: "retrying", resume_state: target })),
    sha256(canonicalJson({ run_payload_hash: evidence.payloadHash, event_type: "visual_reconciliation_resumed", target_state: target })),
  ]);
  const rows = [
    { event_type: "visual_side_effect_reconciled", state: "needs_action", idempotency_key: `wave2c-reconciled:${target}:${evidence.runId}`, payload_hash: hashes[0], error_code: "visual_side_effect_reconciled", next_action: "resume_reconciled_visual" },
    { event_type: "visual_reconciliation_retrying", state: "retrying", idempotency_key: `wave2c-retrying:${target}:${evidence.runId}`, payload_hash: hashes[1], error_code: null, next_action: null },
    { event_type: "visual_reconciliation_resumed", state: target, idempotency_key: `wave2c-resumed:${target}:${evidence.runId}`, payload_hash: hashes[2], error_code: null, next_action: null },
  ];
  for (const [index, row] of rows.entries()) {
    const revision = recoveredRevision + index;
    append({
      event_id: `${evidence.runId}:event:${revision}`, run_id: evidence.runId, user_id: userId, workspace_id: workspaceId,
      recording_id: marker.recording_id, revision, ...row, retry_count: 1, created_at: `2026-07-22T00:00:${String(revision).padStart(2, "0")}.000Z`,
    });
  }
  appendCoordinatorBusinessEvent(state, target, target, hashes[2]);
}

async function appendWechatRecoveryGroup(
  state: DbState,
  marker: Record<string, unknown>,
  evidence: Awaited<ReturnType<typeof seedAcceptedRun>>,
): Promise<void> {
  const target = "draft_verifying";
  const phase = 25;
  const errorCode = "draft_readback_unavailable";
  const nextAction = "reconcile_draft";
  const checkpointHash = "sha256:" + "8".repeat(64);
  appendPublicationBusinessEvent(state, evidence.runId, Number(marker.recording_id), target, target, checkpointHash);
  appendCoordinatorBusinessEvent(state, target, target, checkpointHash);

  const append = (event: Record<string, unknown>) => {
    state.publicationEvents = [...(state.publicationEvents || []), event];
    setPublicationCurrent(state, event);
  };
  const holdRevision = state.publicationEvents!.length;
  const holdKey = `wave2d:needs-action:${phase}:${errorCode}:${holdRevision - 1}:${evidence.runId}`;
  const holdHash = await sha256(canonicalJson({
    run_payload_hash: evidence.payloadHash, event_type: "needs_action", phase, target_state: "needs_action",
    error_code: errorCode, next_action: nextAction, revision_count: null, retry_count: 1,
  }));
  const hold = {
    event_id: `${evidence.runId}:event:${holdRevision}`, run_id: evidence.runId, user_id: userId, workspace_id: workspaceId,
    recording_id: marker.recording_id, revision: holdRevision, event_type: "needs_action", state: "needs_action",
    idempotency_key: holdKey, payload_hash: holdHash, error_code: errorCode, next_action: nextAction,
    retry_count: 1, created_at: `2026-07-22T00:00:${String(holdRevision).padStart(2, "0")}.000Z`,
  };
  append(hold);
  appendCoordinatorBusinessEvent(state, "needs_action", "needs_action", holdHash, errorCode, nextAction);

  const cycle = (await sha256(canonicalJson({
    run_id: evidence.runId, target, hold_revision: holdRevision, hold_idempotency_key: holdKey, hold_payload_hash: holdHash,
  }))).slice(7, 39);
  const eventPayload = (event: string) => ({
    run_payload_hash: evidence.payloadHash, event, target, recovery_cycle: cycle,
    recovered_hold: { revision: holdRevision, idempotency_key: holdKey, payload_hash: holdHash },
  });
  const hashes = await Promise.all([
    sha256(canonicalJson(eventPayload("wechat_side_effect_reconciled"))),
    sha256(canonicalJson(eventPayload("wechat_reconciliation_retrying"))),
    sha256(canonicalJson(eventPayload("wechat_reconciliation_resumed"))),
  ]);
  const firstRevision = state.publicationEvents!.length;
  const rows = [
    { event_type: "wechat_side_effect_reconciled", state: "needs_action", idempotency_key: `wave2d:reconciled:${cycle}:${target}:${evidence.runId}`, payload_hash: hashes[0], error_code: "wechat_side_effect_reconciled", next_action: "resume_reconciled_wechat" },
    { event_type: "wechat_reconciliation_retrying", state: "retrying", idempotency_key: `wave2d:retrying:${cycle}:${target}:${evidence.runId}`, payload_hash: hashes[1], error_code: null, next_action: null },
    { event_type: "wechat_reconciliation_resumed", state: target, idempotency_key: `wave2d:resumed:${cycle}:${target}:${evidence.runId}`, payload_hash: hashes[2], error_code: null, next_action: null },
  ];
  for (const [index, row] of rows.entries()) {
    const revision = firstRevision + index;
    append({
      event_id: `${evidence.runId}:event:${revision}`, run_id: evidence.runId, user_id: userId, workspace_id: workspaceId,
      recording_id: marker.recording_id, revision, ...row, retry_count: 1, created_at: `2026-07-22T00:00:${String(revision).padStart(2, "0")}.000Z`,
    });
  }
  appendCoordinatorBusinessEvent(state, target, target, hashes[2]);
}

async function appendPreStartRecoveryPrefix(
  state: DbState,
  marker: Record<string, unknown>,
  evidence: Awaited<ReturnType<typeof seedAcceptedRun>>,
  throughRevision: 2 | 3 | 4,
  confirm = false,
): Promise<void> {
  const workflowId = `five-agent-${evidence.runId}`;
  const reconciliationKey = `workflow_create_unknown:${workflowId}`;
  const append = async (eventType: string, stateName: string, key: string, payload: Record<string, unknown>, errorCode: string | null, nextAction: string | null) => {
    const previous = state.publicationEvents || [];
    const revision = previous.length;
    const payloadHash = await sha256(canonicalJson(payload));
    const event = {
      event_id: `${evidence.runId}:event:${revision}`, run_id: evidence.runId, user_id: userId, workspace_id: workspaceId,
      recording_id: marker.recording_id, revision, event_type: eventType, state: stateName, idempotency_key: key,
      payload_hash: payloadHash, error_code: errorCode, next_action: nextAction,
      created_at: `2026-07-22T00:00:0${revision}.000Z`,
    };
    state.publicationEvents = [...previous, event];
    setPublicationCurrent(state, event);
  };
  const reconciledEvidenceHash = await sha256(canonicalJson({
    workflow_id: workflowId, run_id: evidence.runId, event_type: "start_reconciled",
    start_status: "workflow_create_unknown", reconciliation_key: reconciliationKey, evidence_hash: evidence.manifestHash,
  }));
  state.coordinator!.evidence = {
    ...state.coordinator!.evidence!,
    events: [
      ...state.coordinator!.evidence!.events,
      { event_type: "start_reconciled", idempotency_key: `start-reconciled:${workflowId}:${reconciliationKey}`,
        evidence_hash: reconciledEvidenceHash, created_at: "2026-07-22T00:00:02.000Z" },
    ],
    receipts: [{ receipt_id: `${workflowId}:start-reconcile:${reconciliationKey}`, reconciliation_key: reconciliationKey, evidence_hash: evidence.manifestHash }],
  };
  await append("start_reconciled", "needs_action", `start-reconcile:workflow_create_unknown:reconciled:${evidence.runId}`, {
    run_payload_hash: evidence.payloadHash, event_type: "start_reconciled", start_status: "workflow_create_unknown",
    target_state: "needs_action", error_code: "start_side_effect_reconciled", next_action: "resume_reconciled_start",
  }, "start_side_effect_reconciled", "resume_reconciled_start");
  if (throughRevision >= 3) {
    await append("start_reconciliation_retrying", "retrying", `start-reconcile:workflow_create_unknown:retrying:${evidence.runId}`, {
      run_payload_hash: evidence.payloadHash, event_type: "start_reconciliation_retrying",
      start_status: "workflow_create_unknown", target_state: "retrying",
    }, "external_side_effect_unknown", "reconcile_external_side_effect");
  }
  if (throughRevision >= 4) {
    await append("start_reconciliation_queued", "queued", `start-reconcile:workflow_create_unknown:queued:${evidence.runId}`, {
      run_payload_hash: evidence.payloadHash, event_type: "start_reconciliation_queued",
      start_status: "workflow_create_unknown", target_state: "queued",
    }, null, null);
  }
  if (confirm) {
    const confirmationHash = await sha256(canonicalJson({
      workflow_id: workflowId, run_id: evidence.runId, article_id: marker.article_id, recording_id: marker.recording_id,
      user_id: userId, workspace_id: workspaceId, payload_hash: evidence.payloadHash,
      manifest_hash: evidence.manifestHash, event_type: "workflow_start_confirmed",
    }));
    state.coordinator!.run = {
      ...state.coordinator!.run!, state: "queued", state_revision: 0, error_code: null, next_action: null,
      start_ledger_status: "started", start_status: "workflow_started", start_error_code: null, start_next_action: null,
    };
    state.coordinator!.ledger = { workflow_id: workflowId, run_id: evidence.runId, status: "started", start_status: null, error_code: null, next_action: null };
    state.coordinator!.evidence = {
      workflow_start_status: "started",
      events: [...state.coordinator!.evidence!.events, {
        event_type: "workflow_start_confirmed", idempotency_key: `workflow-start-confirmed:${workflowId}`,
        evidence_hash: confirmationHash, created_at: "2026-07-22T00:00:05.000Z",
      }],
      receipts: state.coordinator!.evidence!.receipts,
    };
    state.coordinator!.confirmation = { confirmed: true, event_id: `${workflowId}:start-event:workflow-start-confirmed:${workflowId}` };
  }
}

describe("Mining V3 handoff Worker boundary", () => {
  it("rejects a syntactically valid unknown status source before marker or R2 access", async () => {
    const bucket = new MemoryBucket();
    let reads = 0;
    const originalGet = bucket.get.bind(bucket);
    bucket.get = async key => {
      reads += 1;
      return originalGet(key);
    };

    const env = testEnv(bucket);
    env.DB = {
      prepare(sql: string) {
        expect(sql).toContain("s.workspace_id AS workspace_id");
        expect(sql).not.toContain("r.workspace_id");
        expect(sql).not.toContain("s.workspace_id = r.workspace_id");
        return { bind() { return { all: async () => ({ results: [] }) }; } };
      },
    };
    const response = await invoke(
      "status",
      { source_key: `users/${userId}/inbox/nonexistent-status-source.txt` },
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "mining_handoff_recording_not_found" });
    expect(reads).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("writes an owner-scoped marker only for an eligible source and replays the same handoff", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const env = testEnv(bucket);
    const first = await invoke("eligibility", { source_key: sourceKey }, env);
    const body = await first.json() as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(body.decision).toBe("v3");
    expect(String(body.handoff_id)).toMatch(/^handoff_v3_[a-f0-9]{64}$/);
    const markerKeys = [...bucket.objects.keys()].filter(key => key.includes("/markers/"));
    expect(markerKeys).toHaveLength(1);
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKeys[0])!.bytes));
    expect(marker.user_id).toBe(userId);
    expect(marker.workspace_id).toBe(workspaceId);
    expect(marker.profile_pins).toEqual({ style: { id: "style_litianc_default", version: "2026-07-05" }, formatting: { id: "md_to_wechat", version: "1.0.0" } });
    expect(marker.source_hash).toBe(await sha256(new TextEncoder().encode("audio-source")));
    expect(marker.style_profile_body).toBeUndefined();

    const replay = await invoke("eligibility", { source_key: sourceKey }, env);
    expect(await replay.json()).toMatchObject({ decision: "v3", handoff_id: body.handoff_id });
    expect([...bucket.objects.keys()].filter(key => key.includes("/markers/"))).toHaveLength(1);
  });

  it("maps the actual App layout pin to the V3 formatting skill before marker/start preparation", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket, new TextEncoder().encode("app-default-audio"), {
      styleprofileid: "style_litianc_default",
      styleprofileversion: "2026-07-05",
      layoutprofileid: "wechat_clean_article",
      layoutprofileversion: "2026-07-05",
    });
    const appRecording = recording({
      style_profile_id: "style_litianc_default",
      style_profile_version: "2026-07-05",
      layout_profile_id: "wechat_clean_article",
      layout_profile_version: "2026-07-05",
    });
    const accepted = await invoke("eligibility", { source_key: sourceKey }, testEnv(bucket, appRecording));
    expect(accepted.status).toBe(200);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    expect(marker.app_layout_mapping_version).toBe("app-layout-to-v3-formatting.v1");
    expect(marker.profile_pins.formatting).toEqual({ id: "md_to_wechat", version: "1.0.0" });
    const prepared = await miningV3HandoffTesting.startBody(marker, {
      transcript_ref: "editorial/v3/test/transcript.txt",
      transcript_hash: await sha256(new TextEncoder().encode("canonical transcript")),
      transcript_text: "canonical transcript",
    });
    expect(prepared.profile_pins.formatting).toEqual({ id: "md_to_wechat", version: "1.0.0" });

    seedSource(bucket, new TextEncoder().encode("mismatched-layout"), {
      styleprofileid: "style_litianc_default",
      styleprofileversion: "2026-07-05",
      layoutprofileid: "unknown_layout",
      layoutprofileversion: "2026-07-05",
    });
    const mismatch = await invoke("eligibility", { source_key: sourceKey }, testEnv(bucket, appRecording));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: "mining_handoff_profile_pin_conflict" });

    const unknownRecording = recording({ layout_profile_id: "unknown_layout", layout_profile_version: "2026-07-05" });
    seedSource(bucket, new TextEncoder().encode("unknown-recording-layout"));
    const unknown = await invoke("eligibility", { source_key: sourceKey }, testEnv(bucket, unknownRecording));
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: "mining_handoff_profile_pin_conflict" });
  });

  it("fails closed on a changed source rather than accepting a handoff-id collision", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const env = testEnv(bucket);
    const marked = await (await invoke("eligibility", { source_key: sourceKey }, env)).json() as Record<string, unknown>;
    seedSource(bucket, new TextEncoder().encode("different original bytes"));
    const status = await invoke("status", { source_key: sourceKey, handoff_id: marked.handoff_id }, env);
    expect(status.status).toBe(409);
    expect(await status.json()).toEqual({ error: "mining_handoff_source_conflict" });
  });

  it("creates a distinct V3 marker epoch when the immutable source bytes or pins change", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket, new TextEncoder().encode("first bytes"));
    const env = testEnv(bucket);
    const first = await (await invoke("eligibility", { source_key: sourceKey }, env)).json() as Record<string, unknown>;
    seedSource(bucket, new TextEncoder().encode("second bytes"));
    const second = await (await invoke("eligibility", { source_key: sourceKey }, env)).json() as Record<string, unknown>;
    expect(second.handoff_id).not.toBe(first.handoff_id);
    expect([...bucket.objects.keys()].filter(key => key.includes("/markers/"))).toHaveLength(2);
    expect(await (await invoke("status", { source_key: sourceKey }, env)).json()).toMatchObject({ decision: "v3_hold" });
  });

  it("returns explicit legacy only before a marker and keeps a marker as V3 hold after disable", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const disabled = testEnv(bucket, recording(), false);
    expect(await (await invoke("eligibility", { source_key: sourceKey }, disabled)).json()).toEqual({ decision: "legacy" });
    expect([...bucket.objects.keys()].filter(key => key.includes("/markers/"))).toHaveLength(0);

    const enabled = testEnv(bucket);
    const marked = await (await invoke("eligibility", { source_key: sourceKey }, enabled)).json() as Record<string, unknown>;
    const held = await invoke("status", { source_key: sourceKey, handoff_id: marked.handoff_id }, disabled);
    expect(await held.json()).toMatchObject({ decision: "v3_hold", handoff_id: marked.handoff_id });
  });

  it("resolves a custom audio sidecar exactly and rejects a missing custom body", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket, new TextEncoder().encode("custom audio"), { styleProfileId: "owner_style", styleProfileVersion: "9" });
    const customRecording = recording({ style_profile_id: "owner_style", style_profile_version: "9" });
    const sidecar = `users/${userId}/profile-selections/source.mp3.json`;
    bucket.objects.set(sidecar, { bytes: new TextEncoder().encode(JSON.stringify({ userId, workspaceId, filename: "source.mp3", styleProfileId: "owner_style", styleProfileVersion: "9", styleProfileBody: "custom writing rules" })), metadata: {} });
    const accepted = await invoke("eligibility", { source_key: sourceKey }, testEnv(bucket, customRecording));
    expect(accepted.status).toBe(200);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    expect(marker.style_profile_body_hash).toBe(await sha256("custom writing rules"));

    const missing = new MemoryBucket();
    seedSource(missing, new TextEncoder().encode("custom audio"), { styleProfileId: "owner_style", styleProfileVersion: "9" });
    await expect(miningV3HandoffTesting.makeMarker(testEnv(missing, customRecording), customRecording)).rejects.toMatchObject({ code: "mining_handoff_custom_profile_missing", status: 409 });

    const sourceMismatch = new MemoryBucket();
    seedSource(sourceMismatch, new TextEncoder().encode("custom audio"), { styleProfileId: "another_style", styleProfileVersion: "9" });
    sourceMismatch.objects.set(sidecar, { bytes: new TextEncoder().encode(JSON.stringify({ userId, workspaceId, filename: "source.mp3", styleProfileId: "owner_style", styleProfileVersion: "9", styleProfileBody: "custom writing rules" })), metadata: {} });
    await expect(miningV3HandoffTesting.makeMarker(testEnv(sourceMismatch, customRecording), customRecording)).rejects.toMatchObject({ code: "mining_handoff_profile_pin_conflict", status: 409 });

    const sourceMissingPin = new MemoryBucket();
    seedSource(sourceMissingPin, new TextEncoder().encode("custom audio"));
    sourceMissingPin.objects.set(sidecar, { bytes: new TextEncoder().encode(JSON.stringify({ userId, workspaceId, filename: "source.mp3", styleProfileId: "owner_style", styleProfileVersion: "9", styleProfileBody: "custom writing rules" })), metadata: {} });
    await expect(miningV3HandoffTesting.makeMarker(testEnv(sourceMissingPin, customRecording), customRecording)).rejects.toMatchObject({ code: "mining_handoff_profile_pin_conflict", status: 409 });
  });

  it("stores canonical transcript bytes once with exact owner and source metadata", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const env = testEnv(bucket);
    const marker = await miningV3HandoffTesting.makeMarker(env, recording());
    const transcript = await miningV3HandoffTesting.persistTranscript(env, marker, "\r\n  第一行\r\n第二行  \r\n");
    expect(transcript.transcript_text).toBe("第一行\n第二行");
    expect(transcript.transcript_hash).toBe(await sha256(new TextEncoder().encode("第一行\n第二行")));
    const stored = bucket.objects.get(transcript.transcript_ref)!;
    expect(stored.metadata).toEqual({ user_id: userId, workspace_id: workspaceId, source_key: sourceKey, source_hash: marker.source_hash, handoff_id: marker.handoff_id });
    await expect(miningV3HandoffTesting.persistTranscript(env, marker, "第一行\n第二行")).resolves.toMatchObject({ transcript_ref: transcript.transcript_ref });
    await expect(miningV3HandoffTesting.persistTranscript(env, marker, "different")).rejects.toMatchObject({ code: "mining_handoff_transcript_conflict" });
  });

  it("accepts a valid plain UTF-8 text source through deterministic start proof and status replay", async () => {
    const bucket = new MemoryBucket();
    const textKey = `users/${userId}/text-submissions/plain-source.txt`;
    const textRow = recording({
      filename: "plain-source.txt",
      r2_key: textKey,
      source_type: "TEXT",
      style_profile_id: "style_litianc_default",
      style_profile_version: "2026-07-05",
      layout_profile_id: "wechat_clean_article",
      layout_profile_version: "2026-07-05",
    });
    seedSource(bucket, new TextEncoder().encode("\r\n  这是一份兼容的纯文本投稿。\r\n"), {}, textKey);
    const state: DbState = {};
    const env = testEnv(bucket, textRow, true, state);
    const eligibility = await invoke("eligibility", { source_key: textKey }, env);
    expect(eligibility.status).toBe(200);
    const handoff = await eligibility.json() as Record<string, unknown>;
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    expect(miningV3HandoffTesting.parseTextSource(new TextEncoder().encode("  纯文本  "))).toEqual({ text: "纯文本" });
    const evidence = await seedAcceptedRun(bucket, textRow, marker, "这是一份兼容的纯文本投稿。", state);
    let starts = 0;
    const started = await miningV3HandoffTesting.startWithInvoker(env, textKey, String(handoff.handoff_id), undefined, async (_marker: unknown, _transcript: unknown) => {
      starts += 1;
      return Response.json({ run: {
        run_id: evidence.runId, article_id: marker.article_id,
        recording_id: marker.recording_id, state: "queued",
      } }, { status: 202 });
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ decision: "accepted", run_id: evidence.runId });
    expect(starts).toBe(1);
    const replay = await invoke("status", { source_key: textKey, handoff_id: handoff.handoff_id }, env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ decision: "accepted", run_id: evidence.runId });
    expect(starts).toBe(1);
  });

  it("rejects malformed object-looking, empty, and invalid UTF-8 text sources", async () => {
    const textKey = `users/${userId}/text-submissions/invalid-source.txt`;
    const textRow = recording({ filename: "invalid-source.txt", r2_key: textKey, source_type: "TEXT" });
    for (const [bytes, code] of [
      [new TextEncoder().encode('{"text":'), "mining_handoff_text_source_invalid"],
      [new Uint8Array(), "mining_handoff_text_source_empty"],
      [new Uint8Array([0xc3, 0x28]), "mining_handoff_text_source_invalid"],
    ] as const) {
      const bucket = new MemoryBucket();
      seedSource(bucket, bytes, {}, textKey);
      const failed = await invoke("eligibility", { source_key: textKey }, testEnv(bucket, textRow));
      expect(failed.status).toBe(409);
      expect(await failed.json()).toEqual({ error: code });
    }
  });

  it("keeps exact V3 history out of legacy routing while retaining V2-only compatibility", async () => {
    const v2Canonical = { run_id: "run_v2", schema_version: "editorial-orchestration.v2" };
    const v2Publication = { run_id: "run_v2", source_run_id: "run_v2", schema_version: PUBLICATION_SCHEMA_VERSION };
    for (const state of [
      { canonical: v2Canonical, historyProbe: { canonical: null } },
      { canonical: v2Canonical, publication: v2Publication, historyProbe: { canonical: null, publication: null } },
      { canonical: v2Canonical, publication: v2Publication, current: { current_run_id: "run_v2" }, historyProbe: { canonical: null, publication: null, current: null } },
    ]) {
      const bucket = new MemoryBucket();
      seedSource(bucket);
      const result = await invoke("eligibility", { source_key: sourceKey }, testEnv(bucket, recording(), false, state));
      expect(await result.json()).toEqual({ decision: "legacy" });
      const status = await invoke("status", { source_key: sourceKey }, testEnv(bucket, recording(), false, state));
      expect(await status.json()).toEqual({ decision: "legacy" });
    }
    for (const state of [
      { historyProbe: { canonical: { run_id: "run_v3_canonical" } } },
      { historyProbe: { canonical: null, publication: { run_id: "run_v3_publication" } } },
      { historyProbe: { canonical: null, publication: null, current: { current_run_id: "run_v3_current" } } },
    ]) {
      const bucket = new MemoryBucket();
      seedSource(bucket);
      const result = await invoke("eligibility", { source_key: sourceKey }, testEnv(bucket, recording(), false, state));
      expect(result.status).toBe(202);
      expect(await result.json()).toEqual({ decision: "v3_hold", reason: "v3_history_without_handoff_marker" });
      const status = await invoke("status", { source_key: sourceKey }, testEnv(bucket, recording(), false, state));
      expect(status.status).toBe(202);
      expect(await status.json()).toEqual({ decision: "v3_hold", reason: "v3_history_without_handoff_marker" });
      expect([...bucket.objects.keys()].filter(key => key.includes("/markers/"))).toHaveLength(0);
    }
    const noHistoryBucket = new MemoryBucket();
    seedSource(noHistoryBucket);
    expect(await (await invoke("eligibility", { source_key: sourceKey }, testEnv(noHistoryBucket, recording(), false))).json()).toEqual({ decision: "legacy" });
    expect(await (await invoke("status", { source_key: sourceKey }, testEnv(noHistoryBucket, recording(), false))).json()).toEqual({ decision: "legacy" });

    const unavailableBucket = new MemoryBucket();
    seedSource(unavailableBucket);
    const unavailable = await invoke("eligibility", { source_key: sourceKey }, testEnv(unavailableBucket, recording(), false, { historyError: true }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "mining_handoff_history_unavailable" });
  });

  it("requires canonical, publication, and immutable Brief evidence before any 202 start or status acceptance", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    await invoke("eligibility", { source_key: sourceKey }, env);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "durable transcript", state);
    const normalState = structuredClone(state);
    const publicRun = {
      run_id: evidence.runId, user_id: userId, workspace_id: workspaceId,
      article_id: marker.article_id, recording_id: marker.recording_id,
    };
    const redactedRun = {
      run_id: evidence.runId, article_id: marker.article_id, recording_id: marker.recording_id,
    };
    const queued = await miningV3HandoffTesting.startWithInvoker(env, sourceKey, marker.handoff_id, undefined, async () => Response.json({ run: { ...redactedRun, state: "queued" } }, { status: 202 }));
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ decision: "accepted", run_id: evidence.runId });

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    const hold = await miningV3HandoffTesting.startWithInvoker(env, sourceKey, marker.handoff_id, undefined, async () => Response.json({
      run: {
        ...redactedRun, state: "needs_action", start_ledger_status: "needs_action", start_status: "workflow_create_unknown",
        start_error_code: "external_side_effect_unknown", start_next_action: "reconcile_external_side_effect",
      }, workflow_status: "unknown",
    }, { status: 202 }));
    expect(hold.status).toBe(202);
    expect(await hold.json()).toMatchObject({ decision: "accepted", run_id: evidence.runId });

    Object.assign(state, structuredClone(normalState));
    await expect(miningV3HandoffTesting.startWithInvoker(env, sourceKey, marker.handoff_id, undefined, async () => Response.json({ run: { ...redactedRun, run_id: "run_v3_other" } }, { status: 202 })))
      .rejects.toMatchObject({ code: "mining_handoff_start_response_invalid", status: 502 });

    state.publication = null;
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, (await miningV3HandoffTesting.existingTranscript(env, marker))!)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    state.canonical = null;
    state.publication = { ...publicRun, state: "queued" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, (await miningV3HandoffTesting.existingTranscript(env, marker))!)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(normalState));
    state.briefs = [];
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, (await miningV3HandoffTesting.existingTranscript(env, marker))!)).rejects.toMatchObject({ code: "mining_handoff_start_reconciliation_required", status: 503 });
    state.briefs = [{
      artifact_id: evidence.briefId, kind: "article_brief", run_id: evidence.runId,
      article_id: marker.article_id, recording_id: marker.recording_id,
      user_id: userId, workspace_id: workspaceId,
      payload_hash: "sha256:" + "f".repeat(64), storage_ref: "editorial/v3/tampered.json",
    }];
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, (await miningV3HandoffTesting.existingTranscript(env, marker))!)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
  });

  it("accepts only a durable Coordinator start matrix and reconciles progressed status without a new start", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    const eligible = await invoke("eligibility", { source_key: sourceKey }, env);
    const handoff = await eligible.json() as Record<string, unknown>;
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "durable start matrix", state);
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;
    const baseline = structuredClone(state);

    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ run_id: evidence.runId, state: "queued" });

    state.canonical = { ...state.canonical!, schema_version: "editorial-orchestration.v2" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(baseline));

    state.publication = { ...state.publication!, schema_version: "publication-projection.v0" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(baseline));

    state.publication = { ...state.publication!, source_run_id: "run_v3_wrong_source" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(baseline));

    state.current = { current_run_id: "run_v3_wrong_pointer" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(baseline));

    state.coordinator!.ledger = null;
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(baseline));

    state.coordinator!.ledger = { ...state.coordinator!.ledger!, status: "started", start_status: "workflow_create_unknown" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
    Object.assign(state, structuredClone(baseline));

    state.coordinator!.ledger = {
      ...state.coordinator!.ledger!, status: "needs_action", start_status: "brief_storage_unknown",
      error_code: "external_side_effect_unknown", next_action: "reconcile_external_side_effect",
    };
    state.coordinator!.run = {
      ...state.coordinator!.run!, state: "needs_action", start_ledger_status: "needs_action", start_status: "brief_storage_unknown",
      start_error_code: "external_side_effect_unknown", start_next_action: "reconcile_external_side_effect",
    };
    state.coordinator!.confirmation = { confirmed: false, event_id: null };
    state.coordinator!.evidence = { workflow_start_status: "unknown", events: [], receipts: [] };
    state.publication = {
      ...state.publication!, state: "needs_action", last_successful_state: "queued",
      error_code: "external_side_effect_unknown", next_action: "reconcile_external_side_effect",
    };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).rejects.toMatchObject({ code: "mining_handoff_start_reconciliation_required", status: 503 });
    Object.assign(state, structuredClone(baseline));

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ run_id: evidence.runId, state: "needs_action" });
    Object.assign(state, structuredClone(baseline));

    const progressedHash = "sha256:" + "a".repeat(64);
    appendPublicationBusinessEvent(state, evidence.runId, marker.recording_id, "transcription_started", "transcribing", progressedHash);
    appendCoordinatorBusinessEvent(state, "transcription_started", "transcribing", progressedHash);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ run_id: evidence.runId, state: "transcribing" });
    const status = await invoke("status", { source_key: sourceKey, handoff_id: handoff.handoff_id }, env);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ decision: "accepted", run_id: evidence.runId });
  });

  it("routes only the exact unresolved legacy manifest back through the guarded start repair", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    const eligible = await invoke("eligibility", { source_key: sourceKey }, env);
    const handoff = await eligible.json() as Record<string, unknown>;
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const proof = await seedAcceptedRun(bucket, recording(), marker, "legacy manifest transcript", state);
    await setWorkflowCreateUnknownProof(state, marker, proof);
    state.coordinator!.run = { ...state.coordinator!.run!, manifest_hash: proof.legacyManifestHash };
    state.coordinator!.confirmationError = { status: 409 };
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;

    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toBeNull();
    const status = await invoke("status", { source_key: sourceKey, handoff_id: handoff.handoff_id }, env);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ decision: "v3_pending_start", handoff_id: handoff.handoff_id });

    state.coordinator!.run = { ...state.coordinator!.run!, manifest_hash: "sha256:" + "f".repeat(64) };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });

    state.coordinator!.run = { ...state.coordinator!.run!, manifest_hash: proof.legacyManifestHash };
    state.coordinator!.evidence!.receipts = [{
      receipt_id: "unexpected", reconciliation_key: "unexpected", evidence_hash: proof.legacyManifestHash,
    }];
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
  });

  it("accepts only exact unresolved and reconciled pre-start prefixes", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    await invoke("eligibility", { source_key: sourceKey }, env);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "start prefix transcript", state);
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;
    const baseline = structuredClone(state);

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ state: "needs_action" });

    for (const checkpoint of [2, 3, 4] as const) {
      Object.assign(state, structuredClone(baseline));
      await setWorkflowCreateUnknownProof(state, marker, evidence);
      await appendPreStartRecoveryPrefix(state, marker, evidence, checkpoint);
      await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ run_id: evidence.runId });
    }

    Object.assign(state, structuredClone(baseline));
    await setWorkflowCreateUnknownProof(state, marker, evidence);
    await appendPreStartRecoveryPrefix(state, marker, evidence, 4, true);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ state: "queued" });
    const payload = "sha256:" + "b".repeat(64);
    appendPublicationBusinessEvent(state, evidence.runId, marker.recording_id, "transcription_started", "transcribing", payload);
    appendCoordinatorBusinessEvent(state, "transcription_started", "transcribing", payload);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ state: "transcribing" });
  });

  it("maps an exact visual recovery group as a verified D1-only offset", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    await invoke("eligibility", { source_key: sourceKey }, env);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "visual recovery transcript", state);
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;

    await appendVisualRecoveryGroup(state, marker, evidence);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ state: "visual_planning" });

    state.publicationEvents![4] = { ...state.publicationEvents![4], payload_hash: "sha256:" + "e".repeat(64) };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
  });

  it("maps an exact WeChat recovery group without treating the offset as a raw revision equality", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    await invoke("eligibility", { source_key: sourceKey }, env);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "wechat recovery transcript", state);
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;

    await appendWechatRecoveryGroup(state, marker, evidence);
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ state: "draft_verifying" });

    state.publicationEvents![4] = { ...state.publicationEvents![4], idempotency_key: `wave2d:retrying:${"0".repeat(32)}:draft_verifying:${evidence.runId}` };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
  });

  it("cross-checks artifact-committed Coordinator events against the D1 artifact identity", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    await invoke("eligibility", { source_key: sourceKey }, env);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "artifact mapping transcript", state);
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;
    const payloadHash = "sha256:" + "7".repeat(64);
    const artifact = {
      artifact_id: "artifact_draft_1", run_id: evidence.runId, article_id: marker.article_id, recording_id: marker.recording_id,
      user_id: userId, workspace_id: workspaceId, kind: "article_draft", producer_role: "writing",
      producer_version: "writing.agent.v3", workflow_version: "editorial-workflow.v3", policy_version: "editorial-policy.v3",
      input_artifact_ids_json: "[]", payload_hash: payloadHash, storage_ref: "r2://editorial/v3/test/artifact_draft_1",
    };
    state.coordinator!.artifacts = [artifact];
    state.artifactMirrors = [{
      ...artifact, producer_agent_role: artifact.producer_role, producer_agent_version: artifact.producer_version,
    }];
    appendPublicationBusinessEvent(state, evidence.runId, marker.recording_id, "draft_generated", "draft_generated", payloadHash);
    const revision = state.coordinator!.mainEvents!.length;
    state.coordinator!.mainEvents = [...state.coordinator!.mainEvents!, {
      event_type: "artifact_committed", state: "draft_generated", state_revision: revision, artifact_id: artifact.artifact_id,
      payload_hash: payloadHash, error_code: null, next_action: null, created_at: `2026-07-22T00:00:0${revision}.000Z`,
    }];
    state.coordinator!.run = { ...state.coordinator!.run!, state: "draft_generated", state_revision: revision, error_code: null, next_action: null };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript)).resolves.toMatchObject({ state: "draft_generated" });

    state.artifactMirrors![0] = { ...state.artifactMirrors![0], producer_agent_version: "writing.agent.v99" };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });
  });

  it("fails closed on gapped, extra, mismatched, and unmapped V3 event chains", async () => {
    const bucket = new MemoryBucket();
    seedSource(bucket);
    const state: DbState = {};
    const env = testEnv(bucket, recording(), true, state);
    await invoke("eligibility", { source_key: sourceKey }, env);
    const markerKey = [...bucket.objects.keys()].find(key => key.includes("/markers/"))!;
    const marker = JSON.parse(new TextDecoder().decode(bucket.objects.get(markerKey)!.bytes));
    const evidence = await seedAcceptedRun(bucket, recording(), marker, "chain negative transcript", state);
    const transcript = (await miningV3HandoffTesting.existingTranscript(env, marker))!;
    const baseline = structuredClone(state);
    const reject = async () => expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_identity_conflict", status: 409 });

    state.publicationEvents = [{ ...state.publicationEvents![0], revision: 1 }];
    await reject();
    Object.assign(state, structuredClone(baseline));

    state.publicationEvents = [...state.publicationEvents!, { ...state.publicationEvents![0], event_id: `${evidence.runId}:event:1`, revision: 1 }];
    await reject();
    Object.assign(state, structuredClone(baseline));

    state.coordinator!.mainEvents = [{ ...state.coordinator!.mainEvents![0], state_revision: 1 }];
    await reject();
    Object.assign(state, structuredClone(baseline));

    state.coordinator!.mainEvents = [{ ...state.coordinator!.mainEvents![0], event_type: "unknown_event" }];
    await reject();
    Object.assign(state, structuredClone(baseline));

    state.publicationEvents = [{ ...state.publicationEvents![0], event_type: "unknown_event" }];
    await reject();
    Object.assign(state, structuredClone(baseline));

    state.publication = { ...state.publication!, last_event_payload_hash: "sha256:" + "c".repeat(64) };
    await reject();
    Object.assign(state, structuredClone(baseline));

    const businessHash = "sha256:" + "d".repeat(64);
    appendPublicationBusinessEvent(state, evidence.runId, marker.recording_id, "transcription_started", "transcribing", businessHash);
    appendCoordinatorBusinessEvent(state, "writing_started", "writing", businessHash);
    await reject();
    Object.assign(state, structuredClone(baseline));

    for (let index = 0; index < 4; index += 1) {
      appendPublicationBusinessEvent(state, evidence.runId, marker.recording_id, "transcription_started", "transcribing", `sha256:${String(index).padStart(64, "1")}`);
    }
    for (let index = 0; index < 9; index += 1) {
      appendCoordinatorBusinessEvent(state, "transcription_started", "transcribing", `sha256:${String(index).padStart(64, "1")}`);
    }
    await reject();
    Object.assign(state, structuredClone(baseline));

    state.publication = { ...state.publication!, error_code: "unexpected_error" };
    await reject();
    Object.assign(state, structuredClone(baseline));

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    state.publicationEvents![1] = { ...state.publicationEvents![1], user_id: "other_user" };
    await reject();
    Object.assign(state, structuredClone(baseline));

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    await appendPreStartRecoveryPrefix(state, marker, evidence, 4, true);
    appendPublicationBusinessEvent(state, evidence.runId, marker.recording_id, "transcription_started", "transcribing", "sha256:" + "e".repeat(64));
    appendCoordinatorBusinessEvent(state, "transcription_started", "transcribing", "sha256:" + "f".repeat(64));
    await reject();
    Object.assign(state, structuredClone(baseline));

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    await appendPreStartRecoveryPrefix(state, marker, evidence, 4, true);
    state.coordinator!.evidence = { ...state.coordinator!.evidence!, events: [...state.coordinator!.evidence!.events].reverse() };
    await reject();
    Object.assign(state, structuredClone(baseline));

    await setWorkflowCreateUnknownProof(state, marker, evidence);
    await appendPreStartRecoveryPrefix(state, marker, evidence, 2);
    state.coordinator!.evidence = { ...state.coordinator!.evidence!, receipts: [] };
    await expect(miningV3HandoffTesting.acceptedRunProof(env, marker, transcript))
      .rejects.toMatchObject({ code: "mining_handoff_start_reconciliation_required", status: 503 });
  });
});
