import {
  canonicalJson,
  PUBLICATION_AGENT_VERSIONS,
  PUBLICATION_SKILL_PINS,
} from "./editorialContracts";

export const PUBLICATION_SCHEMA_VERSION = "publication-projection.v1";
export const PUBLICATION_WORKFLOW_VERSION = "publishing-workflow.v1";
export const PUBLICATION_POLICY_VERSION = "publishing-policy.v1";

export const PUBLICATION_STATES = [
  "queued",
  "transcribing",
  "transcript_ready",
  "writing",
  "draft_generated",
  "reviewing",
  "revising",
  "reviewed",
  "content_frozen",
  "visual_planning",
  "visual_generating",
  "visual_ready",
  "formatting",
  "visual_qa",
  "draft_syncing",
  "draft_verifying",
  "draft_ready",
  "retrying",
  "needs_action",
  "failed",
  "cancelled",
] as const;

export type PublicationState = (typeof PUBLICATION_STATES)[number];
export type PublicationAction = "retry" | "cancel";

export type PublicationAuthContext = {
  userId: string;
  workspaceId: string;
};

export type PublicationRunRow = {
  run_id: string;
  user_id: string;
  workspace_id: string;
  article_id: string;
  recording_id: number;
  source_run_id: string | null;
  source_manifest_hash: string | null;
  source_state: string;
  source_state_revision: number;
  schema_version: string;
  workflow_version: string;
  policy_version: string;
  agent_versions_json: string;
  skill_pins_json: string;
  state: PublicationState;
  run_status: "active" | "retrying" | "needs_action" | "failed" | "cancelled" | "ready";
  state_revision: number;
  progress_percent: number;
  resume_state: PublicationState | null;
  last_successful_state: PublicationState;
  last_successful_progress_percent: number;
  retry_count: number;
  next_action: string | null;
  error_code: string | null;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
  updated_at: string;
};

type PublicationEventRow = {
  event_id: string;
  run_id: string;
  user_id: string;
  workspace_id: string;
  revision: number;
  event_type: string;
  state: PublicationState;
  publication_stage: string;
  progress_percent: number;
  retry_count: number;
  next_action: string | null;
  error_code: string | null;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
};

type PublicationActionRow = {
  action_id: string;
  run_id: string;
  user_id: string;
  workspace_id: string;
  action: string;
  idempotency_key: string;
  payload_hash: string;
  result_json: string;
  created_at: string;
};

export class PublicationProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "PublicationProjectionError";
  }
}

const STAGE_BY_STATE: Record<PublicationState, string> = {
  queued: "upload",
  transcribing: "transcription",
  transcript_ready: "transcription",
  writing: "writing",
  draft_generated: "writing",
  reviewing: "review",
  revising: "review",
  reviewed: "review",
  content_frozen: "review",
  visual_planning: "visual",
  visual_generating: "visual",
  visual_ready: "visual",
  formatting: "publishing",
  visual_qa: "publishing",
  draft_syncing: "publishing",
  draft_verifying: "publishing",
  draft_ready: "ready",
  retrying: "retrying",
  needs_action: "action_required",
  failed: "failed",
  cancelled: "cancelled",
};

const PROGRESS_BY_STATE: Record<PublicationState, number> = {
  queued: 0,
  transcribing: 14,
  transcript_ready: 20,
  writing: 28,
  draft_generated: 36,
  reviewing: 44,
  revising: 50,
  reviewed: 56,
  content_frozen: 62,
  visual_planning: 68,
  visual_generating: 74,
  visual_ready: 80,
  formatting: 84,
  visual_qa: 90,
  draft_syncing: 96,
  draft_verifying: 98,
  draft_ready: 100,
  retrying: 0,
  needs_action: 0,
  failed: 0,
  cancelled: 0,
};

const STATE_RANK: Record<PublicationState, number> = {
  queued: 0,
  transcribing: 1,
  transcript_ready: 2,
  writing: 3,
  draft_generated: 4,
  reviewing: 5,
  revising: 6,
  reviewed: 7,
  content_frozen: 8,
  visual_planning: 9,
  visual_generating: 10,
  visual_ready: 11,
  formatting: 12,
  visual_qa: 13,
  draft_syncing: 14,
  draft_verifying: 15,
  draft_ready: 16,
  retrying: -1,
  needs_action: -2,
  failed: -3,
  cancelled: -4,
};

const TERMINAL_STATES = new Set<PublicationState>(["draft_ready", "failed", "cancelled"]);

export function publicationStage(state: PublicationState): string {
  return STAGE_BY_STATE[state];
}

export function publicationProgress(state: PublicationState): number {
  return PROGRESS_BY_STATE[state];
}

export function publicationAgentVersions(): Record<string, string> {
  return { ...PUBLICATION_AGENT_VERSIONS };
}

export function publicationSkillPins(): Record<string, { id: string; version: string }> {
  return JSON.parse(JSON.stringify(PUBLICATION_SKILL_PINS));
}

export function isPublicationState(value: unknown): value is PublicationState {
  return typeof value === "string" && PUBLICATION_STATES.includes(value as PublicationState);
}

export function publicationFeatureEnabled(
  env: { FIVE_AGENT_PUBLISHING_V3?: string; FIVE_AGENT_PUBLISHING_V3_ALLOWLIST?: string },
  userId: string,
  workspaceId: string,
): boolean {
  if (env.FIVE_AGENT_PUBLISHING_V3?.trim().toLowerCase() !== "true") return false;
  const allowlist = (env.FIVE_AGENT_PUBLISHING_V3_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowlist.includes(`${userId}:${workspaceId}`);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isMissingPublicationTable(error: unknown): boolean {
  return String((error as { message?: unknown })?.message || error).includes("no such table: publication_");
}

function publicationResponse(row: PublicationRunRow, legacy = false): Record<string, unknown> {
  const successfulState = row.last_successful_state || (legacy ? legacyState(row.source_state) : row.state);
  const successfulProgress = row.last_successful_progress_percent ?? publicationProgress(successfulState);
  return {
    run_id: row.run_id,
    article_id: row.article_id,
    recording_id: row.recording_id,
    source_run_id: row.source_run_id,
    source_manifest_hash: row.source_manifest_hash,
    source_state: row.source_state,
    source_state_revision: row.source_state_revision,
    schema_version: row.schema_version,
    workflow_version: row.workflow_version,
    policy_version: row.policy_version,
    agent_versions: parseJson(row.agent_versions_json, {}),
    skill_pins: parseJson(row.skill_pins_json, {}),
    state: row.state,
    run_status: row.run_status || (legacy ? "needs_action" : "active"),
    publication_stage: publicationStage(successfulState),
    state_revision: row.state_revision,
    progress_percent: successfulProgress,
    last_successful_stage: publicationStage(successfulState),
    last_successful_state: successfulState,
    retry_count: row.retry_count,
    next_action: row.next_action,
    error_code: row.error_code,
    updated_at: row.updated_at,
    created_at: row.created_at,
    legacy,
    identity_status: legacy ? "legacy_unpinned" : "v3_pinned",
    capabilities: legacy ? { read_only: true, actions: [] } : { read_only: false, actions: ["retry", "cancel"] },
  };
}

function legacyState(value: unknown): PublicationState {
  switch (value) {
    case "queued": return "queued";
    case "draft_generated": return "draft_generated";
    case "review_pending": return "reviewing";
    case "revision_pending": return "revising";
    case "reviewed": return "reviewed";
    case "content_frozen": return "content_frozen";
    case "awaiting_human_confirmation": return "content_frozen";
    case "approved_for_phase3": return "content_frozen";
    case "failed": return "failed";
    default: return "queued";
  }
}

function legacyProjection(row: Record<string, unknown>): PublicationRunRow {
  const state = legacyState(row.state);
  return {
    run_id: String(row.run_id),
    user_id: String(row.user_id),
    workspace_id: String(row.workspace_id),
    article_id: String(row.article_id),
    recording_id: Number(row.recording_id),
    source_run_id: null,
    source_manifest_hash: null,
    source_state: String(row.state || "queued"),
    source_state_revision: Number(row.state_revision || 0),
    schema_version: String(row.schema_version || "editorial-orchestration.v2"),
    workflow_version: String(row.workflow_version || "editorial-workflow.v2"),
    policy_version: String(row.policy_version || "editorial-policy.v2"),
    agent_versions_json: String(row.agent_versions_json || "{}"),
    skill_pins_json: String(row.skill_pins_json || "{}"),
    state,
    run_status: "needs_action",
    state_revision: Number(row.state_revision || 0),
    progress_percent: publicationProgress(state),
    resume_state: null,
    last_successful_state: state,
    last_successful_progress_percent: publicationProgress(state),
    retry_count: 0,
    next_action: "v3_projection_required",
    error_code: null,
    idempotency_key: String(row.idempotency_key || `legacy:${row.run_id}`),
    payload_hash: String(row.payload_hash || "legacy"),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || row.created_at || ""),
  };
}

async function first<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  values: unknown[] = [],
): Promise<T | null> {
  return (await db.prepare(sql).bind(...values).first<T>()) || null;
}

async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  return result.results || [];
}

export async function getPublicationRunForRecording(
  db: D1Database,
  auth: PublicationAuthContext,
  recordingId: number,
): Promise<Record<string, unknown>> {
  let row: PublicationRunRow | null = null;
  try {
    row = await first<PublicationRunRow>(db, `
      SELECT p.* FROM publication_runs p
      JOIN publication_current_runs c ON c.current_run_id = p.run_id
      WHERE c.recording_id = ? AND c.user_id = ? AND c.workspace_id = ?
      LIMIT 1
    `, [recordingId, auth.userId, auth.workspaceId]);
  } catch (error) {
    if (!isMissingPublicationTable(error)) throw error;
    try {
      row = await first<PublicationRunRow>(db, `
        SELECT * FROM publication_runs
        WHERE recording_id = ? AND user_id = ? AND workspace_id = ?
        ORDER BY created_at DESC LIMIT 1
      `, [recordingId, auth.userId, auth.workspaceId]);
    } catch (fallbackError) {
      if (!isMissingPublicationTable(fallbackError)) throw fallbackError;
      row = null;
    }
  }
  if (row) return { run: publicationResponse(row) };

  const legacy = await first<Record<string, unknown>>(db, `
    SELECT * FROM editorial_runs
    WHERE recording_id = ? AND user_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `, [recordingId, auth.userId, auth.workspaceId]);
  if (!legacy) throw new PublicationProjectionError("publication_run_not_found", "publication run not found", 404);
  return { run: publicationResponse(legacyProjection(legacy), true) };
}

export async function getPublicationRun(
  db: D1Database,
  auth: PublicationAuthContext,
  runId: string,
): Promise<Record<string, unknown>> {
  let row: PublicationRunRow | null = null;
  try {
    row = await first<PublicationRunRow>(db, `
      SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1
    `, [runId, auth.userId, auth.workspaceId]);
  } catch (error) {
    if (!isMissingPublicationTable(error)) throw error;
  }
  if (row) return { run: publicationResponse(row) };
  const legacy = await first<Record<string, unknown>>(db, `
    SELECT * FROM editorial_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1
  `, [runId, auth.userId, auth.workspaceId]);
  if (!legacy) throw new PublicationProjectionError("publication_run_not_found", "publication run not found", 404);
  return { run: publicationResponse(legacyProjection(legacy), true) };
}

export async function getPublicationRunEvents(
  db: D1Database,
  auth: PublicationAuthContext,
  runId: string,
  afterRevision: number,
  limit = 50,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(afterRevision) || afterRevision < -1) {
    throw new PublicationProjectionError("after_revision_invalid", "after_revision must be an integer >= -1", 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new PublicationProjectionError("event_limit_invalid", "limit must be between 1 and 100", 400);
  }
  const run = await getPublicationRun(db, auth, runId);
  if ((run.run as Record<string, unknown>).legacy) return { run_id: runId, events: [], after_revision: afterRevision, has_more: false, next_after_revision: afterRevision };
  let events: PublicationEventRow[] = [];
  try {
    events = await all<PublicationEventRow>(db, `
      SELECT event_id, run_id, user_id, workspace_id, revision, event_type, state,
             publication_stage, progress_percent, retry_count, next_action, error_code,
             idempotency_key, payload_hash, created_at
      FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND revision > ?
      ORDER BY revision ASC LIMIT ?
    `, [runId, auth.userId, auth.workspaceId, afterRevision, limit + 1]);
  } catch (error) {
    if (!isMissingPublicationTable(error)) throw error;
  }
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  return {
    run_id: runId,
    events: page.map((event) => ({ ...event, publication_stage: event.publication_stage })),
    after_revision: afterRevision,
    has_more: hasMore,
    next_after_revision: page.length > 0 ? page[page.length - 1].revision : afterRevision,
  };
}

export type CreatePublicationRunInput = {
  runId: string;
  articleId: string;
  recordingId: number;
  userId: string;
  workspaceId: string;
  idempotencyKey: string;
  payloadHash: string;
};

async function sourceRun(
  db: D1Database,
  input: { sourceRunId: string; userId: string; workspaceId: string; articleId: string; recordingId: number },
): Promise<{ run_id: string; manifest_json: string; state: string; state_revision: number; created_at: string } | null> {
  const row = await first<{
    run_id: string;
    schema_version: string;
    workflow_version: string;
    policy_version: string;
    agent_versions_json: string;
    skill_pins_json: string;
    status: string;
    idempotency_key: string;
    payload_hash: string;
    created_at: string;
  }>(db, `
    SELECT run_id, schema_version, workflow_version, policy_version,
           agent_versions_json, skill_pins_json, status, idempotency_key,
           payload_hash, created_at
    FROM editorial_runs
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND article_id = ? AND recording_id = ?
    LIMIT 1
  `, [input.sourceRunId, input.userId, input.workspaceId, input.articleId, input.recordingId]);
  if (!row) return null;
  const state = row.status === "planned"
    ? "queued"
    : row.status === "completed"
      ? "content_frozen"
      : row.status === "failed"
        ? "failed"
        : "writing";
  return {
    run_id: row.run_id,
    manifest_json: canonicalJson({
      schema_version: row.schema_version,
      run_id: row.run_id,
      article_id: input.articleId,
      recording_id: input.recordingId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      workflow_version: row.workflow_version,
      policy_version: row.policy_version,
      agent_versions: parseJson(row.agent_versions_json, {}),
      skill_pins: parseJson(row.skill_pins_json, {}),
      idempotency_key: row.idempotency_key,
      payload_hash: row.payload_hash,
    }),
    state,
    state_revision: 0,
    created_at: row.created_at,
  };
}

async function manifestHash(manifest: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createPublicationRun(
  db: D1Database,
  input: CreatePublicationRunInput,
): Promise<Record<string, unknown>> {
  const canonical = await sourceRun(db, {
    sourceRunId: input.runId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    articleId: input.articleId,
    recordingId: input.recordingId,
  });
  if (!canonical) {
    throw new PublicationProjectionError("publication_source_run_not_found", "canonical editorial run not found", 404);
  }
  const sourceManifestHash = await manifestHash(canonical.manifest_json);
  const existing = await first<PublicationRunRow>(db, `
    SELECT * FROM publication_runs
    WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1
  `, [input.userId, input.workspaceId, input.articleId, input.idempotencyKey]);
  if (existing) {
    if (existing.payload_hash !== input.payloadHash) {
      throw new PublicationProjectionError("idempotency_conflict", "publication run idempotency key conflicts", 409);
    }
    return { run: publicationResponse(existing), replayed: true };
  }
  const now = new Date().toISOString();
  const agents = JSON.stringify(publicationAgentVersions());
  const skills = JSON.stringify(publicationSkillPins());
  await db.batch([
    db.prepare(`INSERT INTO publication_runs
      (run_id, source_run_id, user_id, workspace_id, article_id, recording_id,
       source_manifest_hash, source_state, source_state_revision, schema_version,
       workflow_version, policy_version, agent_versions_json, skill_pins_json, state,
       run_status, state_revision, progress_percent, last_successful_state,
       last_successful_progress_percent, retry_count, next_action, error_code,
       idempotency_key, payload_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'active', 0, 0, 'queued', 0, 0, NULL, NULL, ?, ?, ?, ?)`)
      .bind(input.runId, input.runId, input.userId, input.workspaceId, input.articleId, input.recordingId,
        sourceManifestHash, canonical.state, canonical.state_revision,
        PUBLICATION_SCHEMA_VERSION, PUBLICATION_WORKFLOW_VERSION, PUBLICATION_POLICY_VERSION,
        agents, skills, input.idempotencyKey, input.payloadHash, now, now),
    db.prepare(`INSERT INTO publication_run_events
      (event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state,
       publication_stage, progress_percent, retry_count, next_action, error_code,
       idempotency_key, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 'run_queued', 'queued', 'upload', 0, 0, NULL, NULL, ?, ?, ?)`)
      .bind(`${input.runId}:event:0`, input.runId, input.userId, input.workspaceId, input.recordingId,
        `${input.runId}:event:0`, input.payloadHash, now),
    db.prepare(`INSERT INTO publication_current_runs
      (recording_id, user_id, workspace_id, current_run_id, current_run_created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(recording_id, user_id, workspace_id) DO UPDATE SET
        current_run_id = excluded.current_run_id,
        current_run_created_at = excluded.current_run_created_at,
        updated_at = excluded.updated_at
      WHERE excluded.current_run_created_at > publication_current_runs.current_run_created_at
         OR (excluded.current_run_created_at = publication_current_runs.current_run_created_at
             AND excluded.current_run_id > publication_current_runs.current_run_id)`)
      .bind(input.recordingId, input.userId, input.workspaceId, input.runId, canonical.created_at, now),
  ]);
  const created = await first<PublicationRunRow>(db, `SELECT * FROM publication_runs WHERE run_id = ? LIMIT 1`, [input.runId]);
  if (!created) throw new PublicationProjectionError("publication_run_unavailable", "publication run was not created", 503);
  return { run: publicationResponse(created), replayed: false };
}

function actionResult(row: PublicationRunRow, action: PublicationAction, replayed: boolean): Record<string, unknown> {
  return { action, run: publicationResponse(row), replayed };
}

async function existingAction(
  db: D1Database,
  input: { runId: string; userId: string; workspaceId: string; idempotencyKey: string; payloadHash: string },
): Promise<Record<string, unknown> | null> {
  const action = await first<PublicationActionRow>(db, `
    SELECT * FROM publication_run_actions
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1
  `, [input.runId, input.userId, input.workspaceId, input.idempotencyKey]);
  if (!action) return null;
  if (action.payload_hash !== input.payloadHash) {
    throw new PublicationProjectionError("idempotency_conflict", "publication action idempotency key conflicts", 409);
  }
  return { ...parseJson<Record<string, unknown>>(action.result_json, {}), replayed: true };
}

export async function applyPublicationAction(
  db: D1Database,
  auth: PublicationAuthContext,
  runId: string,
  action: PublicationAction,
  idempotencyKey: string,
  payloadHash: string,
  expectedStateRevision: number,
): Promise<Record<string, unknown>> {
  const replay = await existingAction(db, { runId, ...auth, idempotencyKey, payloadHash });
  if (replay) return replay;
  const current = await first<PublicationRunRow>(db, `
    SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1
  `, [runId, auth.userId, auth.workspaceId]);
  if (!current) throw new PublicationProjectionError("publication_run_not_found", "publication run not found", 404);
  if (current.state_revision !== expectedStateRevision) {
    throw new PublicationProjectionError("publication_revision_conflict", "publication run revision is stale", 409);
  }
  const canonical = current.source_run_id
    ? await sourceRun(db, {
        sourceRunId: current.source_run_id,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        articleId: current.article_id,
        recordingId: current.recording_id,
      })
    : null;
  if (!canonical || (await manifestHash(canonical.manifest_json)) !== current.source_manifest_hash) {
    throw new PublicationProjectionError("publication_source_conflict", "canonical editorial run changed", 409);
  }

  let nextState: PublicationState;
  const nextRunStatus: PublicationRunRow["run_status"] = action === "retry" ? "retrying" : "cancelled";
  let nextAction: string | null = null;
  let errorCode = current.error_code;
  let retryCount = current.retry_count;
  const resumeState = action === "retry" ? current.last_successful_state : null;
  if (action === "retry") {
    if (!(current.state === "failed" || current.state === "needs_action")) {
      throw new PublicationProjectionError("publication_retry_not_allowed", "publication run is not retryable", 409);
    }
    nextState = "retrying";
    retryCount += 1;
    errorCode = null;
  } else {
    if (TERMINAL_STATES.has(current.state)) {
      throw new PublicationProjectionError("publication_cancel_not_allowed", "publication run is already terminal", 409);
    }
    nextState = "cancelled";
    nextAction = null;
  }

  const revision = current.state_revision + 1;
  const now = new Date().toISOString();
  const eventId = `${runId}:event:${revision}`;
  const actionId = `${runId}:action:${idempotencyKey}`;
  const projected = {
    ...current,
    state: nextState,
    run_status: nextRunStatus,
    state_revision: revision,
    progress_percent: current.last_successful_progress_percent,
    resume_state: resumeState,
    retry_count: retryCount,
    next_action: nextAction,
    error_code: errorCode,
    updated_at: now,
  };
  const result = actionResult(projected, action, false);
  const resultJson = JSON.stringify(result);
  const batch = await db.batch([
    db.prepare(`UPDATE publication_runs
      SET state = ?, run_status = ?, state_revision = ?, progress_percent = ?, resume_state = ?, retry_count = ?,
          next_action = ?, error_code = ?, updated_at = ?
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?`)
      .bind(nextState, nextRunStatus, revision, current.last_successful_progress_percent, resumeState, retryCount, nextAction, errorCode, now,
        runId, auth.userId, auth.workspaceId, current.state_revision),
    db.prepare(`INSERT INTO publication_run_events
      (event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state,
       publication_stage, progress_percent, retry_count, next_action, error_code,
       idempotency_key, payload_hash, created_at)
      SELECT ?, run_id, user_id, workspace_id, recording_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM publication_runs
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?`)
      .bind(eventId, revision, `action_${action}`, nextState, publicationStage(current.last_successful_state), current.last_successful_progress_percent, retryCount, nextAction, errorCode, idempotencyKey, payloadHash, now, runId, auth.userId, auth.workspaceId, revision),
    db.prepare(`INSERT INTO publication_run_actions
      (action_id, run_id, user_id, workspace_id, recording_id, action, idempotency_key, payload_hash, result_json, created_at)
      SELECT ?, run_id, user_id, workspace_id, recording_id, ?, ?, ?, ?, ?
      FROM publication_runs
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?`)
      .bind(actionId, action, idempotencyKey, payloadHash, resultJson, now, runId, auth.userId, auth.workspaceId, revision),
  ]);
  const changed = Number((batch[0] as { meta?: { changes?: number } })?.meta?.changes || 0);
  if (changed !== 1) {
    throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during action", 409);
  }
  return result;
}

export const HUMAN_ACTION_CONTRACT_VERSION = "publication-human-action.v1";
export const HUMAN_ACTIONS = ["confirm", "abandon", "resume"] as const;
export type HumanActionIntent = (typeof HUMAN_ACTIONS)[number];

export async function recordPublicationActionIntent(
  db: D1Database,
  auth: PublicationAuthContext,
  runId: string,
  action: HumanActionIntent,
  idempotencyKey: string,
  payloadHash: string,
  expectedStateRevision: number,
): Promise<Record<string, unknown>> {
  if (!HUMAN_ACTIONS.includes(action)) {
    throw new PublicationProjectionError("publication_action_invalid", "unsupported human action intent", 400);
  }
  const replay = await existingAction(db, { runId, ...auth, idempotencyKey, payloadHash });
  if (replay) return replay;
  const current = await first<PublicationRunRow>(db, `
    SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1
  `, [runId, auth.userId, auth.workspaceId]);
  if (!current) throw new PublicationProjectionError("publication_run_not_found", "publication run not found", 404);
  if (current.state_revision !== expectedStateRevision) {
    throw new PublicationProjectionError("publication_revision_conflict", "publication run revision is stale", 409);
  }
  const canonical = current.source_run_id
    ? await sourceRun(db, { sourceRunId: current.source_run_id, userId: auth.userId, workspaceId: auth.workspaceId, articleId: current.article_id, recordingId: current.recording_id })
    : null;
  if (!canonical || (await manifestHash(canonical.manifest_json)) !== current.source_manifest_hash) {
    throw new PublicationProjectionError("publication_source_conflict", "canonical editorial run changed", 409);
  }
  const actionId = `${runId}:action:${idempotencyKey}`;
  const result = {
    action,
    action_contract_version: HUMAN_ACTION_CONTRACT_VERSION,
    intent_recorded: true,
    canonical_workflow_advanced: false,
    run: publicationResponse(current),
    replayed: false,
  };
  await db.prepare(`INSERT INTO publication_run_actions
    (action_id, run_id, user_id, workspace_id, recording_id, action, action_contract_version,
     idempotency_key, payload_hash, intent_json, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(actionId, runId, auth.userId, auth.workspaceId, current.recording_id, action, HUMAN_ACTION_CONTRACT_VERSION,
      idempotencyKey, payloadHash, JSON.stringify({ action, action_contract_version: HUMAN_ACTION_CONTRACT_VERSION }), JSON.stringify(result), new Date().toISOString())
    .run();
  return result;
}

export async function enrichRecordingList(
  db: D1Database,
  auth: PublicationAuthContext,
  recordings: unknown[],
): Promise<unknown[]> {
  const ids = recordings.map((item) => Number((item as Record<string, unknown>)?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return recordings;
  const placeholders = ids.map(() => "?").join(",");
  let rows: PublicationRunRow[] = [];
  try {
    rows = await all<PublicationRunRow>(db, `
      SELECT p.* FROM publication_runs p
      JOIN publication_current_runs c ON c.current_run_id = p.run_id
      WHERE c.user_id = ? AND c.workspace_id = ? AND c.recording_id IN (${placeholders})
    `, [auth.userId, auth.workspaceId, ...ids]);
  } catch (error) {
    if (!isMissingPublicationTable(error)) throw error;
    try {
      rows = await all<PublicationRunRow>(db, `
        SELECT * FROM publication_runs
        WHERE user_id = ? AND workspace_id = ? AND recording_id IN (${placeholders})
        ORDER BY created_at DESC
      `, [auth.userId, auth.workspaceId, ...ids]);
    } catch (fallbackError) {
      if (!isMissingPublicationTable(fallbackError)) throw fallbackError;
    }
  }
  const byRecording = new Map<number, PublicationRunRow>();
  for (const row of rows) if (!byRecording.has(row.recording_id)) byRecording.set(row.recording_id, row);
  return recordings.map((item) => {
    const recording = item as Record<string, unknown>;
    const row = byRecording.get(Number(recording.id));
    if (!row) return { ...recording, run_id: null, publication_stage: null, state_revision: null, progress_percent: null, retry_count: 0, next_action: null };
    const publicRun = publicationResponse(row) as Record<string, unknown>;
    return {
      ...recording,
      run_id: publicRun.run_id,
      publication_stage: publicRun.publication_stage,
      state_revision: publicRun.state_revision,
      progress_percent: publicRun.progress_percent,
      retry_count: publicRun.retry_count,
      next_action: publicRun.next_action,
    };
  });
}

export async function assertPublicationAction(
  db: D1Database,
  auth: PublicationAuthContext,
  runId: string,
  action: string,
  idempotencyKey: string,
  payloadHash: string,
  expectedStateRevision: number,
): Promise<Record<string, unknown>> {
  if (action !== "retry" && action !== "cancel") {
    throw new PublicationProjectionError("publication_action_invalid", "action must be retry or cancel", 400);
  }
  if (!idempotencyKey || idempotencyKey.length > 160) {
    throw new PublicationProjectionError("idempotency_key_invalid", "idempotency key is invalid", 400);
  }
  return applyPublicationAction(db, auth, runId, action, idempotencyKey, payloadHash, expectedStateRevision);
}
