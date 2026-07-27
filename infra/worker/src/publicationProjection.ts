import {
  canonicalJson,
  isExactWave1PublicationSkillPins,
  isExactWave2PublicationSkillPins,
  PUBLICATION_AGENT_VERSIONS,
  PUBLICATION_SKILL_PINS,
} from "./editorialContracts";

export const PUBLICATION_SCHEMA_VERSION = "publication-projection.v1";
export const PUBLICATION_WORKFLOW_VERSION = "publishing-workflow.v1";
export const PUBLICATION_POLICY_VERSION = "publishing-policy.v1";
export const CANONICAL_EDITORIAL_SCHEMA_VERSION = "editorial-orchestration.v3";
export const CANONICAL_EDITORIAL_WORKFLOW_VERSION = "editorial-workflow.v3";
export const CANONICAL_EDITORIAL_POLICY_VERSION = "editorial-policy.v3";

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
export type PublicationAction = "retry" | "cancel" | "resume";

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
  last_event_id?: string;
  last_event_type?: string;
  last_event_idempotency_key?: string;
  last_event_payload_hash?: string;
  last_event_created_at?: string;
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
  reviewing: 50,
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
const SUCCESSFUL_STATES = new Set<PublicationState>(PUBLICATION_STATES.filter((state) =>
  !["retrying", "needs_action", "failed", "cancelled"].includes(state),
));

const ALLOWED_PROJECTION_TRANSITIONS: Record<PublicationState, readonly PublicationState[]> = {
  queued: ["transcribing", "needs_action", "failed", "cancelled"],
  transcribing: ["transcript_ready", "failed", "cancelled"],
  transcript_ready: ["writing", "failed", "cancelled"],
  writing: ["draft_generated", "needs_action", "failed", "cancelled"],
  draft_generated: ["reviewing", "failed", "cancelled"],
  reviewing: ["revising", "reviewed", "needs_action", "failed", "cancelled"],
  revising: ["reviewing", "needs_action", "failed", "cancelled"],
  reviewed: ["content_frozen", "needs_action", "failed", "cancelled"],
  content_frozen: ["visual_planning", "failed", "cancelled"],
  visual_planning: ["visual_generating", "needs_action", "failed", "cancelled"],
  visual_generating: ["visual_ready", "needs_action", "failed", "cancelled"],
  visual_ready: ["formatting", "needs_action", "failed", "cancelled"],
  formatting: ["visual_qa", "needs_action", "failed", "cancelled"],
  visual_qa: ["draft_syncing", "needs_action", "failed", "cancelled"],
  draft_syncing: ["draft_verifying", "needs_action", "failed", "cancelled"],
  draft_verifying: ["draft_ready", "needs_action", "failed", "cancelled"],
  draft_ready: [],
  retrying: [],
  needs_action: ["retrying", "cancelled"],
  failed: ["retrying", "cancelled"],
  cancelled: [],
};

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

type PublicationFeatureEnv = {
  FIVE_AGENT_PUBLISHING_V3?: string;
  FIVE_AGENT_PUBLISHING_V3_ALLOWLIST?: string;
  DEPLOY_ENVIRONMENT?: string;
  STAGING_IMAGE_CANARY_MODE?: string;
  STAGING_IMAGE_CANARY_RUN_ID?: string;
  STAGING_IMAGE_CANARY_USER_ID?: string;
  STAGING_IMAGE_CANARY_WORKSPACE_ID?: string;
  STAGING_IMAGE_CANARY_SOURCE_KEY?: string;
  STAGING_IMAGE_CANARY_EXPIRES_AT?: string;
};

const STAGING_IMAGE_CANARY_MODE = "staging_single_run";
const STAGING_IMAGE_CANARY_MAX_TTL_MS = 60 * 60 * 1000;

function stagingImageCanaryConfigured(env: PublicationFeatureEnv): boolean {
  return [
    env.STAGING_IMAGE_CANARY_MODE,
    env.STAGING_IMAGE_CANARY_RUN_ID,
    env.STAGING_IMAGE_CANARY_USER_ID,
    env.STAGING_IMAGE_CANARY_WORKSPACE_ID,
    env.STAGING_IMAGE_CANARY_SOURCE_KEY,
    env.STAGING_IMAGE_CANARY_EXPIRES_AT,
  ].some(value => Boolean(value?.trim()));
}

function stagingImageCanaryBaseEnabled(
  env: PublicationFeatureEnv,
  userId: string,
  workspaceId: string,
): boolean {
  const expiresAt = env.STAGING_IMAGE_CANARY_EXPIRES_AT?.trim() || "";
  const expiresAtMs = Date.parse(expiresAt);
  const sourceKey = env.STAGING_IMAGE_CANARY_SOURCE_KEY?.trim() || "";
  const now = Date.now();
  return env.DEPLOY_ENVIRONMENT?.trim() === "staging" &&
    env.STAGING_IMAGE_CANARY_MODE?.trim() === STAGING_IMAGE_CANARY_MODE &&
    env.STAGING_IMAGE_CANARY_USER_ID?.trim() === userId &&
    env.STAGING_IMAGE_CANARY_WORKSPACE_ID?.trim() === workspaceId &&
    /^run_v3_[a-f0-9]{64}$/.test(env.STAGING_IMAGE_CANARY_RUN_ID?.trim() || "") &&
    sourceKey === `users/${userId}/text-submissions/${sourceKey.split("/").at(-1)}` && !sourceKey.includes("..") &&
    Number.isFinite(expiresAtMs) && new Date(expiresAtMs).toISOString() === expiresAt &&
    expiresAtMs > now && expiresAtMs <= now + STAGING_IMAGE_CANARY_MAX_TTL_MS;
}

export function stagingImageCanaryScopeEnabled(
  env: PublicationFeatureEnv,
  userId: string,
  workspaceId: string,
  runId?: string,
): boolean {
  if (!stagingImageCanaryConfigured(env)) return true;
  return stagingImageCanaryBaseEnabled(env, userId, workspaceId) &&
    typeof runId === "string" && env.STAGING_IMAGE_CANARY_RUN_ID?.trim() === runId;
}

export function publicationTenantFeatureEnabled(
  env: PublicationFeatureEnv,
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

export function publicationFeatureEnabled(
  env: PublicationFeatureEnv,
  userId: string,
  workspaceId: string,
  runId?: string,
): boolean {
  return publicationTenantFeatureEnabled(env, userId, workspaceId) &&
    stagingImageCanaryScopeEnabled(env, userId, workspaceId, runId);
}

export function publicationSourceFeatureEnabled(
  env: PublicationFeatureEnv,
  userId: string,
  workspaceId: string,
  sourceKey: string,
): boolean {
  if (!publicationTenantFeatureEnabled(env, userId, workspaceId)) return false;
  if (!stagingImageCanaryConfigured(env)) return true;
  return stagingImageCanaryBaseEnabled(env, userId, workspaceId) &&
    env.STAGING_IMAGE_CANARY_SOURCE_KEY?.trim() === sourceKey;
}

export type PublicationProjectionTransitionOptions = {
  eventId: string;
  eventType: string;
  eventIdempotencyKey: string;
  eventPayloadHash: string;
  eventCreatedAt: string;
  nextAction?: string | null;
  errorCode?: string | null;
  retryCount?: number;
  allowSameState?: boolean;
};

/**
 * The only mutable projection derivation point. Route handlers and workers
 * provide an intended target plus an event identity; they cannot hand-build a
 * stage/progress/status combination that regresses the App projection.
 */
export function projectPublicationTransition(
  current: PublicationRunRow,
  targetState: PublicationState,
  options: PublicationProjectionTransitionOptions,
): PublicationRunRow {
  const allowed = options.allowSameState && targetState === current.state
    ? true
    : targetState === "retrying"
    ? (current.state === "failed" || current.state === "needs_action")
    : current.state === "retrying"
      ? targetState === current.resume_state || targetState === "cancelled"
      : ALLOWED_PROJECTION_TRANSITIONS[current.state]?.includes(targetState);
  if (!isPublicationState(targetState) || !allowed) {
    throw new PublicationProjectionError("publication_transition_invalid", "publication state transition is not allowed", 409);
  }
  if (current.last_successful_progress_percent < 0 || current.last_successful_progress_percent > 100) {
    throw new PublicationProjectionError("publication_projection_invalid", "publication progress is invalid", 409);
  }
  const revision = current.state_revision + 1;
  const successfulTarget = SUCCESSFUL_STATES.has(targetState);
  const progress = successfulTarget
    ? Math.max(current.last_successful_progress_percent, publicationProgress(targetState))
    : current.last_successful_progress_percent;
  const retrying = targetState === "retrying";
  const exceptional = ["needs_action", "failed", "cancelled"].includes(targetState);
  const runStatus: PublicationRunRow["run_status"] = targetState === "draft_ready"
    ? "ready"
    : retrying
      ? "retrying"
      : exceptional
        ? targetState as "needs_action" | "failed" | "cancelled"
        : "active";
  const lastSuccessfulState = successfulTarget ? targetState : current.last_successful_state;
  const lastSuccessfulProgress = successfulTarget ? progress : current.last_successful_progress_percent;
  const resumeState = retrying ? current.last_successful_state : null;
  const nextAction = exceptional ? (options.nextAction ?? null) : null;
  const errorCode = exceptional ? (options.errorCode ?? null) : null;
  const retryCount = options.retryCount ?? current.retry_count;
  if (lastSuccessfulProgress < current.last_successful_progress_percent) {
    throw new PublicationProjectionError("publication_progress_regression", "publication progress cannot regress", 409);
  }
  return {
    ...current,
    state: targetState,
    run_status: runStatus,
    state_revision: revision,
    progress_percent: progress,
    resume_state: resumeState,
    last_successful_state: lastSuccessfulState,
    last_successful_progress_percent: lastSuccessfulProgress,
    retry_count: retryCount,
    next_action: nextAction,
    error_code: errorCode,
    updated_at: options.eventCreatedAt,
    last_event_id: options.eventId,
    last_event_type: options.eventType,
    last_event_idempotency_key: options.eventIdempotencyKey,
    last_event_payload_hash: options.eventPayloadHash,
    last_event_created_at: options.eventCreatedAt,
  };
}

export type SystemPublicationTransitionInput = {
  runId: string;
  auth: PublicationAuthContext;
  targetState: PublicationState;
  expectedStateRevision?: number;
  options: PublicationProjectionTransitionOptions;
  compatibilityProjection?: {
    recordingId: number;
    wechatDraftId: string;
    verifiedCoverImageUrl?: string;
  };
};

/**
 * Server-owned CAS for durable Workflow/artifact progress. It intentionally
 * has no human-action fields and writes the projection plus matching event in
 * one D1 batch so a stale workflow cannot leave an orphan event.
 */
export async function applySystemPublicationTransition(
  db: D1Database,
  input: SystemPublicationTransitionInput,
): Promise<{ run: PublicationRunRow; replayed: boolean }> {
  const current = await first<PublicationRunRow>(db, `
    SELECT * FROM publication_runs
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1
  `, [input.runId, input.auth.userId, input.auth.workspaceId]);
  if (!current) throw new PublicationProjectionError("publication_run_not_found", "publication run not found", 404);

  const expectedRevision = input.expectedStateRevision ?? current.state_revision;
  if (current.state_revision !== expectedRevision) {
    if (current.last_event_id === input.options.eventId &&
        current.last_event_idempotency_key === input.options.eventIdempotencyKey &&
        current.last_event_payload_hash === input.options.eventPayloadHash) {
      return { run: current, replayed: true };
    }
    throw new PublicationProjectionError("publication_revision_conflict", "publication run revision is stale", 409);
  }
  if (current.last_event_id === input.options.eventId &&
      current.last_event_idempotency_key === input.options.eventIdempotencyKey &&
      current.last_event_payload_hash === input.options.eventPayloadHash) {
    return { run: current, replayed: true };
  }

  const currentEventTime = Date.parse(current.last_event_created_at || current.updated_at || current.created_at);
  const requestedEventTime = Date.parse(input.options.eventCreatedAt);
  const eventCreatedAt = Number.isFinite(currentEventTime) && (!Number.isFinite(requestedEventTime) || requestedEventTime <= currentEventTime)
    ? new Date(currentEventTime + 1).toISOString()
    : input.options.eventCreatedAt;
  const projected = projectPublicationTransition(current, input.targetState, { ...input.options, eventCreatedAt });
  const eventStage = publicationStage(projected.last_successful_state);
  const compatibility = input.compatibilityProjection;
  const compatibilityStatements: D1PreparedStatement[] = [];
  let compatibilityExistsSql = "";
  let compatibilityExistsValues: unknown[] = [];
  if (compatibility) {
    if (input.targetState !== "draft_ready" || current.recording_id !== compatibility.recordingId || !compatibility.wechatDraftId) {
      throw new PublicationProjectionError("publication_compatibility_invalid", "verified draft compatibility projection is invalid", 409);
    }
    const cover = compatibility.verifiedCoverImageUrl;
    const coverSql = cover ? ", cover_image_url = CASE WHEN cover_image_url IS NULL THEN ? ELSE cover_image_url END" : "";
    const coverGuard = cover ? "AND (cover_image_url IS NULL OR cover_image_url = ?)" : "";
    const values: unknown[] = [compatibility.wechatDraftId];
    if (cover) values.push(cover);
    values.push(compatibility.recordingId, input.auth.userId, input.auth.workspaceId, compatibility.wechatDraftId);
    if (cover) values.push(cover);
    // The recording write must see the exact same publication pre-state as the
    // run CAS. Otherwise a stale completion could change the legacy projection
    // while its publication transition loses the race.
    values.push(
      input.runId, input.auth.userId, input.auth.workspaceId, expectedRevision,
      current.state, current.last_event_id, current.last_event_type,
      current.last_event_idempotency_key, current.last_event_payload_hash,
      current.last_event_created_at,
    );
    compatibilityStatements.push(db.prepare(`UPDATE recordings SET
      wechat_draft_id = CASE WHEN wechat_draft_id IS NULL THEN ? ELSE wechat_draft_id END${coverSql}
      WHERE id = ? AND user_id = ? AND workspace_id = ? AND (wechat_draft_id IS NULL OR wechat_draft_id = ?) ${coverGuard}
        AND EXISTS (
          SELECT 1 FROM publication_runs
          WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?
            AND state = ? AND last_event_id = ? AND last_event_type = ?
            AND last_event_idempotency_key = ? AND last_event_payload_hash = ?
            AND last_event_created_at = ?
        )`).bind(...values));
    // Every statement in this batch uses the same verified recording identity.
    // This prevents a cover conflict from committing draft_ready/event alone.
    compatibilityExistsSql = ` AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND user_id = ? AND workspace_id = ? AND wechat_draft_id = ?${cover ? " AND cover_image_url = ?" : ""})`;
    compatibilityExistsValues = [compatibility.recordingId, input.auth.userId, input.auth.workspaceId, compatibility.wechatDraftId, ...(cover ? [cover] : [])];
  }
  let batch: D1Result[];
  try {
    batch = await db.batch([
      ...compatibilityStatements,
      db.prepare(`UPDATE publication_runs
        SET state = ?, run_status = ?, state_revision = ?, progress_percent = ?, resume_state = ?,
            last_successful_state = ?, last_successful_progress_percent = ?, retry_count = ?,
            next_action = ?, error_code = ?, updated_at = ?, last_event_id = ?, last_event_type = ?,
            last_event_idempotency_key = ?, last_event_payload_hash = ?, last_event_created_at = ?
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?
          AND state = ? AND last_event_id = ? AND last_event_type = ?
          AND last_event_idempotency_key = ? AND last_event_payload_hash = ? AND last_event_created_at = ?${compatibilityExistsSql}`)
        .bind(
          projected.state, projected.run_status, projected.state_revision, projected.progress_percent,
          projected.resume_state, projected.last_successful_state, projected.last_successful_progress_percent,
          projected.retry_count, projected.next_action, projected.error_code, projected.updated_at,
          projected.last_event_id, projected.last_event_type, projected.last_event_idempotency_key,
          projected.last_event_payload_hash, projected.last_event_created_at,
          input.runId, input.auth.userId, input.auth.workspaceId, expectedRevision,
          current.state, current.last_event_id, current.last_event_type,
          current.last_event_idempotency_key, current.last_event_payload_hash, current.last_event_created_at,
          ...compatibilityExistsValues,
        ),
      db.prepare(`INSERT INTO publication_run_events
        (event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state,
         publication_stage, progress_percent, retry_count, next_action, error_code,
         idempotency_key, payload_hash, created_at)
        SELECT ?, run_id, user_id, workspace_id, recording_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM publication_runs
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?
          AND state = ? AND last_event_id = ? AND last_event_type = ?
          AND last_event_idempotency_key = ? AND last_event_payload_hash = ? AND last_event_created_at = ?${compatibilityExistsSql}`)
        .bind(
          projected.last_event_id, projected.state_revision, projected.last_event_type, projected.state,
          eventStage, projected.progress_percent, projected.retry_count, projected.next_action,
          projected.error_code, projected.last_event_idempotency_key, projected.last_event_payload_hash,
          projected.last_event_created_at, input.runId, input.auth.userId, input.auth.workspaceId,
          projected.state_revision, projected.state, projected.last_event_id, projected.last_event_type,
          projected.last_event_idempotency_key, projected.last_event_payload_hash, projected.last_event_created_at,
          ...compatibilityExistsValues,
        ),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: publication_run_events/i.test(String((error as { message?: unknown })?.message || error))) {
      throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during transition", 409);
    }
    throw error;
  }
  const runUpdateIndex = compatibilityStatements.length;
  if ((compatibility && Number(batch[0]?.meta?.changes || 0) !== 1) ||
      Number(batch[runUpdateIndex]?.meta?.changes || 0) !== 1 ||
      Number(batch[runUpdateIndex + 1]?.meta?.changes || 0) !== 1) {
    throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during transition", 409);
  }
  const after = await first<PublicationRunRow>(db, `
    SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1
  `, [input.runId, input.auth.userId, input.auth.workspaceId]);
  if (!after) throw new PublicationProjectionError("publication_run_unavailable", "publication run disappeared", 503);
  return { run: after, replayed: false };
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
        AND c.user_id = p.user_id
        AND c.workspace_id = p.workspace_id
        AND c.recording_id = p.recording_id
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
  const agentVersions = parseJson<Record<string, unknown>>(row.agent_versions_json, {});
  const skillPins = parseJson<Record<string, unknown>>(row.skill_pins_json, {});
  const wave1SkillPins = isExactWave1PublicationSkillPins(skillPins);
  const wave2SkillPins = isExactWave2PublicationSkillPins(skillPins);
  if (
    row.schema_version !== CANONICAL_EDITORIAL_SCHEMA_VERSION ||
    row.workflow_version !== CANONICAL_EDITORIAL_WORKFLOW_VERSION ||
    row.policy_version !== CANONICAL_EDITORIAL_POLICY_VERSION ||
    canonicalJson(agentVersions) !== canonicalJson(PUBLICATION_AGENT_VERSIONS) ||
    !wave1SkillPins && !wave2SkillPins
  ) {
    throw new PublicationProjectionError(
      "publication_source_not_v3",
      "canonical editorial run is not an active v3 publication run",
      409,
    );
  }
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
      agent_versions: agentVersions,
      skill_pins: skillPins,
      adapter_pins: skillPins.adapter_pins,
      model_pins: skillPins.model_pins,
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
  const now = canonical.created_at;
  const sourceManifest = parseJson<Record<string, unknown>>(canonical.manifest_json, {});
  const agents = canonicalJson(sourceManifest.agent_versions);
  const skills = canonicalJson(sourceManifest.skill_pins);
  await db.batch([
    db.prepare(`INSERT INTO publication_runs
      (run_id, source_run_id, user_id, workspace_id, article_id, recording_id,
       source_manifest_hash, source_state, source_state_revision, schema_version,
       workflow_version, policy_version, agent_versions_json, skill_pins_json, state,
       run_status, state_revision, progress_percent, last_successful_state,
       last_successful_progress_percent, retry_count, next_action, error_code,
       idempotency_key, payload_hash, created_at, updated_at, last_event_id,
       last_event_type, last_event_idempotency_key, last_event_payload_hash,
       last_event_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'active', 0, 0, 'queued', 0, 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.runId, input.runId, input.userId, input.workspaceId, input.articleId, input.recordingId,
        sourceManifestHash, canonical.state, canonical.state_revision,
        PUBLICATION_SCHEMA_VERSION, PUBLICATION_WORKFLOW_VERSION, PUBLICATION_POLICY_VERSION,
        agents, skills, input.idempotencyKey, input.payloadHash, now, now,
        `${input.runId}:event:0`, "run_queued", `${input.runId}:event:0`, input.payloadHash, now),
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

function isKnownPublicationActionConflict(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error);
  return /UNIQUE constraint failed: publication_run_(actions|events)/i.test(message) ||
    /publication_run_(action|event)_projection_mismatch/i.test(message);
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
  if (publicationRequiresReconciliation(current)) {
    throw new PublicationProjectionError("reconciliation_required", "external side effect requires controlled reconciliation", 409);
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

  if (action === "retry") {
    if (!(current.state === "failed" || current.state === "needs_action")) {
      throw new PublicationProjectionError("publication_retry_not_allowed", "publication run is not retryable", 409);
    }
  } else if (action === "cancel") {
    if (TERMINAL_STATES.has(current.state)) {
      throw new PublicationProjectionError("publication_cancel_not_allowed", "publication run is already terminal", 409);
    }
  } else if (current.state !== "retrying" || !current.resume_state) {
    throw new PublicationProjectionError("publication_resume_not_allowed", "publication run is not resumable", 409);
  }

  const revision = current.state_revision + 1;
  const now = new Date().toISOString();
  const eventId = `${runId}:event:${revision}`;
  const actionId = `${runId}:action:${idempotencyKey}`;
  const targetState = action === "retry"
    ? "retrying"
    : action === "cancel"
      ? "cancelled"
      : current.resume_state as PublicationState;
  const projected = projectPublicationTransition(current, targetState, {
    eventId,
    eventType: `action_${action}`,
    eventIdempotencyKey: idempotencyKey,
    eventPayloadHash: payloadHash,
    eventCreatedAt: now,
    retryCount: action === "retry" ? current.retry_count + 1 : current.retry_count,
    errorCode: null,
  });
  const result = actionResult(projected, action, false);
  const resultJson = JSON.stringify(result);
  let batch: D1Result[];
  try {
    batch = await db.batch([
      db.prepare(`UPDATE publication_runs
      SET state = ?, run_status = ?, state_revision = ?, progress_percent = ?, resume_state = ?,
          last_successful_state = ?, last_successful_progress_percent = ?, retry_count = ?,
          next_action = ?, error_code = ?, updated_at = ?, last_event_id = ?, last_event_type = ?,
          last_event_idempotency_key = ?, last_event_payload_hash = ?, last_event_created_at = ?
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?`)
        .bind(projected.state, projected.run_status, projected.state_revision, projected.progress_percent, projected.resume_state,
        projected.last_successful_state, projected.last_successful_progress_percent, projected.retry_count,
        projected.next_action, projected.error_code, projected.updated_at, projected.last_event_id, projected.last_event_type,
        projected.last_event_idempotency_key, projected.last_event_payload_hash, projected.last_event_created_at,
          runId, auth.userId, auth.workspaceId, current.state_revision),
      db.prepare(`INSERT INTO publication_run_events
      (event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state,
       publication_stage, progress_percent, retry_count, next_action, error_code,
       idempotency_key, payload_hash, created_at)
      SELECT ?, run_id, user_id, workspace_id, recording_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM publication_runs
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?`)
        .bind(eventId, revision, `action_${action}`, projected.state, publicationStage(projected.last_successful_state), projected.progress_percent, projected.retry_count, projected.next_action, projected.error_code, idempotencyKey, payloadHash, now, runId, auth.userId, auth.workspaceId, revision),
      db.prepare(`INSERT INTO publication_run_actions
      (action_id, run_id, user_id, workspace_id, recording_id, action, action_contract_version,
       action_origin, expected_state_revision, idempotency_key, payload_hash, intent_json, result_json, created_at)
      SELECT ?, run_id, user_id, workspace_id, recording_id, ?, ?, 'system', ?, ?, ?, '{}', ?, ?
      FROM publication_runs
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND state_revision = ?`)
        .bind(actionId, action, "publication-system-action.v1", current.state_revision, idempotencyKey, payloadHash, resultJson, now,
          runId, auth.userId, auth.workspaceId, revision),
    ]);
  } catch (error) {
    if (!isKnownPublicationActionConflict(error)) throw error;
    const replay = await existingAction(db, { runId, ...auth, idempotencyKey, payloadHash });
    if (replay) return replay;
    const latest = await first<PublicationRunRow>(db, `SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`, [runId, auth.userId, auth.workspaceId]);
    if (!latest || latest.state_revision !== expectedStateRevision) {
      throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during action", 409);
    }
    throw new PublicationProjectionError("publication_action_conflict", "publication action conflicts with an existing action", 409);
  }
  const changed = Number((batch[0] as { meta?: { changes?: number } })?.meta?.changes || 0);
  if (changed !== 1) {
    const replay = await existingAction(db, { runId, ...auth, idempotencyKey, payloadHash });
    if (replay) return replay;
    const latest = await first<PublicationRunRow>(db, `SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`, [runId, auth.userId, auth.workspaceId]);
    if (!latest || latest.state_revision !== expectedStateRevision) {
      throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during action", 409);
    }
    throw new PublicationProjectionError("publication_action_conflict", "publication action conflicts with an existing action", 409);
  }
  return result;
}

export const HUMAN_ACTION_CONTRACT_VERSION = "publication-human-action.v1";
export const HUMAN_ACTIONS = ["confirm", "abandon", "resume"] as const;
export type HumanActionIntent = (typeof HUMAN_ACTIONS)[number];

export function publicationRequiresReconciliation(current: PublicationRunRow): boolean {
  return current.state === "needs_action" &&
    (current.next_action === "reconcile_external_side_effect" || current.error_code === "external_side_effect_unknown");
}

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
  if (current.state !== "needs_action" || current.run_status !== "needs_action" || current.next_action !== action) {
    throw new PublicationProjectionError("publication_action_not_allowed", "human action is not allowed for the current projection", 409);
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
    expected_state_revision: expectedStateRevision,
    run: publicationResponse(current),
    replayed: false,
  };
  const createdAt = new Date().toISOString();
  let insertResult: { meta?: { changes?: number } };
  try {
    insertResult = await db.prepare(`INSERT INTO publication_run_actions
      (action_id, run_id, user_id, workspace_id, recording_id, action, action_contract_version,
       action_origin, expected_state_revision, idempotency_key, payload_hash, intent_json, result_json, created_at)
      SELECT ?, run_id, user_id, workspace_id, recording_id, ?, ?, 'human', state_revision, ?, ?, ?, ?, ?
      FROM publication_runs
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND recording_id = ?
        AND state_revision = ? AND state = 'needs_action' AND run_status = 'needs_action' AND next_action = ?`)
      .bind(actionId, action, HUMAN_ACTION_CONTRACT_VERSION, expectedStateRevision, idempotencyKey, payloadHash,
        JSON.stringify({ action, action_contract_version: HUMAN_ACTION_CONTRACT_VERSION, expected_state_revision: expectedStateRevision }),
        JSON.stringify(result), createdAt, runId, auth.userId, auth.workspaceId, current.recording_id, expectedStateRevision, action)
      .run();
  } catch (error) {
    if (!/unique|constraint/i.test(String((error as { message?: unknown })?.message || error))) throw error;
    const replay = await existingAction(db, { runId, ...auth, idempotencyKey, payloadHash });
    if (replay) return replay;
    const latest = await first<PublicationRunRow>(db, `SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`, [runId, auth.userId, auth.workspaceId]);
    if (!latest || latest.state_revision !== expectedStateRevision) {
      throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during human action", 409);
    }
    throw new PublicationProjectionError("publication_human_action_conflict", "another human action already owns this revision", 409);
  }
  if (Number(insertResult.meta?.changes || 0) !== 1) {
    const latest = await first<PublicationRunRow>(db, `SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`, [runId, auth.userId, auth.workspaceId]);
    if (!latest || latest.state_revision !== expectedStateRevision) {
      throw new PublicationProjectionError("publication_revision_conflict", "publication run changed during human action", 409);
    }
    throw new PublicationProjectionError("publication_human_action_conflict", "another human action already owns this revision", 409);
  }
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
        AND c.user_id = p.user_id
        AND c.workspace_id = p.workspace_id
        AND c.recording_id = p.recording_id
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
    if (!row) {
      return {
        ...recording,
        run_id: null,
        publication_stage: null,
        state_revision: null,
        progress_percent: null,
        retry_count: 0,
        next_action: null,
        publication_summary: null,
      };
    }
    const publicRun = publicationResponse(row) as Record<string, unknown>;
    const publicationSummary = {
      run_id: publicRun.run_id,
      state: publicRun.state,
      run_status: publicRun.run_status,
      publication_stage: publicRun.publication_stage,
      state_revision: publicRun.state_revision,
      progress_percent: publicRun.progress_percent,
      last_successful_state: publicRun.last_successful_state,
      last_successful_progress_percent: row.last_successful_progress_percent,
      retry_count: publicRun.retry_count,
      next_action: publicRun.next_action,
      error_code: null,
      created_at: publicRun.created_at,
      updated_at: publicRun.updated_at,
    };
    return {
      ...recording,
      run_id: publicRun.run_id,
      publication_stage: publicRun.publication_stage,
      state_revision: publicRun.state_revision,
      progress_percent: publicRun.progress_percent,
      retry_count: publicRun.retry_count,
      next_action: publicRun.next_action,
      publication_summary: publicationSummary,
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

export async function resumePublicationRun(
  db: D1Database,
  auth: PublicationAuthContext,
  runId: string,
  idempotencyKey: string,
  payloadHash: string,
  expectedStateRevision: number,
): Promise<Record<string, unknown>> {
  return applyPublicationAction(db, auth, runId, "resume", idempotencyKey, payloadHash, expectedStateRevision);
}
