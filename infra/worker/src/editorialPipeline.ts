import type { Env } from "./index";
import {
  EditorialContractError,
  canonicalJson,
  normalizeReviewInput,
  normalizeVersionInput,
  normalizeVisualPlanInput,
  assertPipelineStageTransition,
  type PipelineStage,
  type TrustedProducerContext,
  type ArticleBlock,
} from "./editorialContracts";

type EditorialAuth = {
  userId: string;
  workspaceId: string;
  emailVerified: boolean;
};

type VersionRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  article_id: string;
  recording_id: number;
  version_no: number;
  parent_version_id: string | null;
  source: string;
  source_job_id: string | null;
  source_hash: string | null;
  title: string;
  body: string;
  cover_json: string;
  blocks_json: string;
  title_candidates_json: string;
  selected_title: string;
  cover_title_json: string;
  claim_ledger_json: string;
  visual_plan_json: string;
  formatting_skill_id: string | null;
  formatting_skill_version: string | null;
  content_html_hash: string | null;
  html_warnings_json: string;
  generation_status: string;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
};

type VersionStateRow = {
  version_id: string;
  user_id: string;
  workspace_id: string;
  article_id: string;
  recording_id: number;
  state: PipelineStage;
  state_revision: number;
};

const TRUSTED_PRODUCERS = {
  writing: { role: "writing", version: "writing.worker.v1" },
  review: { role: "editorial_review", version: "editorial-review.worker.v1" },
  coordinator: { role: "editorial_coordinator", version: "editorial-coordinator.worker.v1" },
} as const satisfies Record<string, TrustedProducerContext>;
const PIPELINE_STAGE_VALUES = new Set<string>([
  "queued", "asr", "draft_generated", "review_pending", "reviewed", "revision_pending",
  "content_frozen", "visuals_generating", "rendering", "visual_qa", "draft_sync", "completed", "failed",
]);

export async function handleEditorialRoute(
  request: Request,
  env: Env,
  url: URL,
  auth: EditorialAuth,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodePathPart);
  if (parts[0] !== "api" || parts[1] !== "editorial") return editorialJson({ error: "not_found" }, 404);

  try {
    if (request.method === "POST" && parts.length === 3 && parts[2] === "versions") {
      return editorialJson({ error: "writing_agent_only" }, 403);
    }
    if (request.method === "GET" && parts.length === 5 && parts[2] === "articles" && parts[4] === "versions") {
      return await listVersions(env, auth, parts[3]);
    }
    if (parts.length >= 4 && parts[2] === "versions") {
      const versionId = parts[3];
      if (request.method === "GET" && parts.length === 4) return getVersion(env, auth, versionId);
      if (request.method === "POST" && parts.length === 5 && parts[4] === "reviews") {
        return editorialJson({ error: "editorial_review_agent_only" }, 403);
      }
      if (request.method === "POST" && parts.length === 5 && parts[4] === "visual-plan") {
        return await createVisualPlan(request, env, auth, versionId);
      }
      if (request.method === "GET" && parts.length === 5 && parts[4] === "reviews") {
        return listReviews(env, auth, versionId);
      }
    }
    return editorialJson({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof EditorialContractError) {
      return editorialJson({ error: error.code, message: error.message }, error.status);
    }
    console.error("Editorial pipeline request failed:", safeErrorMessage(error));
    return editorialJson({ error: "editorial_database_error" }, 500);
  }
}

export async function handleEditorialInternalRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).map(decodePathPart);
  if (parts[0] !== "api" || parts[1] !== "internal" || parts[2] !== "editorial") {
    return editorialJson({ error: "not_found" }, 404);
  }
  const userId = request.headers.get("X-VibePub-User-Id")?.trim();
  const workspaceId = request.headers.get("X-VibePub-Workspace-Id")?.trim();
  if (!userId || !workspaceId) return editorialJson({ error: "producer_scope_required" }, 400);
  const auth: EditorialAuth = { userId, workspaceId, emailVerified: true };

  try {
    if (request.method === "POST" && parts.length === 4 && parts[3] === "versions") {
      return await createVersion(request, env, auth, TRUSTED_PRODUCERS.writing);
    }
    if (request.method === "POST" && parts.length === 6 && parts[3] === "versions" && parts[5] === "reviews") {
      const version = await queryOne<VersionRow>(env, "SELECT * FROM article_versions WHERE id = ? LIMIT 1", [parts[4]]);
      if (!version) return editorialJson({ error: "version_not_found" }, 404);
      if (version.user_id !== userId || version.workspace_id !== workspaceId) {
        return editorialJson({ error: "version_not_found" }, 404);
      }
      return await createReview(request, env, auth, version.id, TRUSTED_PRODUCERS.review);
    }
    if (request.method === "POST" && parts.length === 6 && parts[3] === "versions" && parts[5] === "transition") {
      const version = await queryOne<VersionRow>(env, "SELECT * FROM article_versions WHERE id = ? LIMIT 1", [parts[4]]);
      if (!version) return editorialJson({ error: "version_not_found" }, 404);
      if (version.user_id !== userId || version.workspace_id !== workspaceId) {
        return editorialJson({ error: "version_not_found" }, 404);
      }
      return await transitionVersionState(request, env, auth, version, TRUSTED_PRODUCERS.coordinator);
    }
    return editorialJson({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof EditorialContractError) {
      return editorialJson({ error: error.code, message: error.message }, error.status);
    }
    console.error("Editorial internal request failed:", safeErrorMessage(error));
    return editorialJson({ error: "editorial_database_error" }, 500);
  }
}

async function createVersion(
  request: Request,
  env: Env,
  auth: EditorialAuth,
  producer: TrustedProducerContext,
): Promise<Response> {
  if (producer.role !== TRUSTED_PRODUCERS.writing.role) return editorialJson({ error: "writing_agent_only" }, 403);
  const input = normalizeVersionInput(await parseJsonWithIdempotency(request));
  if (input.source !== "initial" && input.source !== "revision") {
    return editorialJson({ error: "writing_source_not_allowed" }, 403);
  }
  const payloadHash = await sha256Hex(canonicalJson(input));
  const existing = await queryOne<VersionRow>(env,
    `SELECT * FROM article_versions
     WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1`,
    [auth.userId, auth.workspaceId, input.article_id, input.idempotency_key]);
  if (existing) return idempotentVersionResponse(existing, payloadHash);

  const recording = await queryOne<{ recording_id: number }>(env,
    `SELECT recording_id FROM editorial_recording_scopes
     WHERE recording_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
    [input.recording_id, auth.userId, auth.workspaceId]);
  if (!recording) return editorialJson({ error: "recording_not_found" }, 404);

  const parent = input.parent_version_id
    ? await queryOne<VersionRow>(env,
      `SELECT * FROM article_versions
       WHERE id = ? AND user_id = ? AND workspace_id = ? AND article_id = ? AND recording_id = ? LIMIT 1`,
      [input.parent_version_id, auth.userId, auth.workspaceId, input.article_id, input.recording_id])
    : null;
  if (input.parent_version_id && !parent) return editorialJson({ error: "parent_version_not_found" }, 404);

  const maxRow = await queryOne<{ max_version_no: number | null }>(env,
    `SELECT MAX(version_no) AS max_version_no FROM article_versions
     WHERE user_id = ? AND workspace_id = ? AND article_id = ?`,
    [auth.userId, auth.workspaceId, input.article_id]);
  const nextVersionNo = Number(maxRow?.max_version_no || 0) + 1;
  if (input.source === "initial" && nextVersionNo !== 1) {
    return editorialJson({ error: "initial_version_already_exists" }, 409);
  }
  if (input.source === "revision" && parent && parent.version_no !== nextVersionNo - 1) {
    return editorialJson({ error: "parent_version_not_latest" }, 409);
  }

  const versionId = `av_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    const versionStatement = env.DB.prepare(
      `INSERT INTO article_versions
       (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id,
        source, source_job_id, source_hash, title, body, cover_json, blocks_json,
        title_candidates_json, selected_title, cover_title_json, claim_ledger_json,
        visual_plan_json, formatting_skill_id, formatting_skill_version, content_html_hash,
        html_warnings_json, generation_status, idempotency_key, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const stateStatement = env.DB.prepare(
      `INSERT INTO editorial_version_states
       (version_id, user_id, workspace_id, article_id, recording_id, state, state_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(versionId, auth.userId, auth.workspaceId, input.article_id, input.recording_id, "draft_generated", now, now);
    await env.DB.batch([versionStatement.bind(
      versionId,
      auth.userId,
      auth.workspaceId,
      input.article_id,
      input.recording_id,
      nextVersionNo,
      input.parent_version_id,
      input.source,
      input.source_job_id,
      input.source_hash,
      input.title,
      input.body,
      canonicalJson(input.cover),
      canonicalJson(input.blocks),
      canonicalJson(input.title_candidates),
      input.selected_title,
      canonicalJson(input.cover_title),
      canonicalJson(input.claim_ledger),
      canonicalJson(input.visual_plan),
      input.formatting_skill_id,
      input.formatting_skill_version,
      input.content_html_hash,
      canonicalJson(input.html_warnings),
      "generated",
      input.idempotency_key,
      payloadHash,
      now,
    ), stateStatement]);
  } catch (error) {
    const raced = await queryOne<VersionRow>(env,
      `SELECT * FROM article_versions
       WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1`,
      [auth.userId, auth.workspaceId, input.article_id, input.idempotency_key]);
    if (raced) return idempotentVersionResponse(raced, payloadHash);
    return editorialJson({ error: "version_conflict", message: "version allocation conflicted; retry with the same idempotency key" }, 409);
  }

  const row = await queryOne<VersionRow>(env, `SELECT * FROM article_versions WHERE id = ? LIMIT 1`, [versionId]);
  return editorialJson({ version: publicVersion(row!), replayed: false }, 201);
}

async function createReview(
  request: Request,
  env: Env,
  auth: EditorialAuth,
  versionId: string,
  producer: TrustedProducerContext,
): Promise<Response> {
  if (producer.role !== TRUSTED_PRODUCERS.review.role) return editorialJson({ error: "editorial_review_agent_only" }, 403);
  const version = await ownedVersion(env, auth, versionId);
  if (!version) return editorialJson({ error: "version_not_found" }, 404);
  const input = normalizeReviewInput(await parseJsonWithIdempotency(request));
  const payloadHash = await sha256Hex(canonicalJson(input));
  const existing = await queryOne<any>(env,
    `SELECT * FROM editorial_reviews
     WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1`,
    [auth.userId, auth.workspaceId, version.article_id, input.idempotency_key]);
  if (existing) return idempotentReviewResponse(existing, payloadHash);

  const reviewId = `rev_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO editorial_reviews
       (id, user_id, workspace_id, article_id, recording_id, input_version_id,
        findings_json, decision, producer_role, producer_version, idempotency_key, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      reviewId,
      auth.userId,
      auth.workspaceId,
      version.article_id,
      version.recording_id,
      version.id,
      canonicalJson(input.findings),
      input.decision,
      producer.role,
      producer.version,
      input.idempotency_key,
      payloadHash,
      now,
    ).run();
  } catch (error) {
    const raced = await queryOne<any>(env,
      `SELECT * FROM editorial_reviews
       WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1`,
      [auth.userId, auth.workspaceId, version.article_id, input.idempotency_key]);
    if (raced) return idempotentReviewResponse(raced, payloadHash);
    return editorialJson({ error: "review_conflict" }, 409);
  }
  const row = await queryOne<any>(env, `SELECT * FROM editorial_reviews WHERE id = ? LIMIT 1`, [reviewId]);
  return editorialJson({ review: publicReview(row!), replayed: false }, 201);
}

async function transitionVersionState(
  request: Request,
  env: Env,
  auth: EditorialAuth,
  version: VersionRow,
  producer: TrustedProducerContext,
): Promise<Response> {
  if (producer.role !== TRUSTED_PRODUCERS.coordinator.role) return editorialJson({ error: "coordinator_only" }, 403);
  const body = await parseJsonWithIdempotency(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EditorialContractError("transition_payload_required", "transition payload must be an object");
  }
  const record = body as Record<string, unknown>;
  const toState = record.to_state ?? record.to;
  const expectedRevision = Number(record.expected_revision ?? record.expectedRevision);
  const idempotencyKey = typeof record.idempotency_key === "string"
    ? record.idempotency_key
    : typeof record.idempotencyKey === "string" ? record.idempotencyKey : "";
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new EditorialContractError("expected_revision_invalid", "expected_revision must be a non-negative integer");
  }
  if (!idempotencyKey.trim()) throw new EditorialContractError("idempotency_key_required", "idempotency_key is required");
  if (typeof toState !== "string" || !PIPELINE_STAGE_VALUES.has(toState)) {
    throw new EditorialContractError("to_state_invalid", "to_state is invalid");
  }
  const normalizedToState = toState as PipelineStage;
  const payload = { expected_revision: expectedRevision, idempotency_key: idempotencyKey.trim(), to_state: normalizedToState };
  const payloadHash = await sha256Hex(canonicalJson(payload));
  const existing = await queryOne<any>(env,
    `SELECT * FROM editorial_state_transition_requests WHERE version_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1`,
    [version.id, auth.userId, auth.workspaceId, payload.idempotency_key]);
  if (existing) {
    if (existing.payload_hash !== payloadHash) return editorialJson({ error: "idempotency_conflict" }, 409);
    return editorialJson({ state: { version_id: version.id, current_state: existing.to_state, state_revision: existing.result_revision }, replayed: true });
  }

  const current = await queryOne<VersionStateRow>(env,
    `SELECT * FROM editorial_version_states
     WHERE version_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
    [version.id, auth.userId, auth.workspaceId]);
  if (!current) return editorialJson({ error: "version_state_not_found" }, 409);
  assertPipelineStageTransition(current.state, normalizedToState);
  if (current.state_revision !== expectedRevision) return editorialJson({ error: "state_revision_conflict" }, 409);
  const requestId = `tr_${crypto.randomUUID()}`;
  const resultRevision = expectedRevision + 1;
  const now = new Date().toISOString();
  try {
    const update = env.DB.prepare(
      `UPDATE editorial_version_states
       SET state = ?, state_revision = state_revision + 1, updated_at = ?
       WHERE version_id = ? AND user_id = ? AND workspace_id = ? AND state = ? AND state_revision = ?`,
    ).bind(normalizedToState, now, version.id, auth.userId, auth.workspaceId, current.state, expectedRevision);
    const insert = env.DB.prepare(
      `INSERT INTO editorial_state_transition_requests
       (id, version_id, user_id, workspace_id, article_id, recording_id, from_state, to_state,
        expected_revision, result_revision, idempotency_key, payload_hash, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM editorial_version_states
         WHERE version_id = ? AND user_id = ? AND workspace_id = ? AND state = ? AND state_revision = ?)`,
    ).bind(
      requestId, version.id, auth.userId, auth.workspaceId, version.article_id, version.recording_id,
      current.state, normalizedToState, expectedRevision, resultRevision, payload.idempotency_key, payloadHash, now,
      version.id, auth.userId, auth.workspaceId, normalizedToState, resultRevision,
    );
    const results = await env.DB.batch([update, insert]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      return editorialJson({ error: "state_revision_conflict" }, 409);
    }
  } catch (error) {
    const raced = await queryOne<any>(env,
      `SELECT * FROM editorial_state_transition_requests WHERE version_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1`,
      [version.id, auth.userId, auth.workspaceId, payload.idempotency_key]);
    if (raced) {
      if (raced.payload_hash !== payloadHash) return editorialJson({ error: "idempotency_conflict" }, 409);
      return editorialJson({ state: { version_id: version.id, current_state: raced.to_state, state_revision: raced.result_revision }, replayed: true });
    }
    if (error instanceof EditorialContractError) throw error;
    return editorialJson({ error: "state_transition_conflict" }, 409);
  }
  return editorialJson({ state: { version_id: version.id, current_state: normalizedToState, state_revision: resultRevision }, replayed: false }, 201);
}

async function createVisualPlan(request: Request, env: Env, auth: EditorialAuth, versionId: string): Promise<Response> {
  const version = await ownedVersion(env, auth, versionId);
  if (!version) return editorialJson({ error: "version_not_found" }, 404);
  const blocks = parseColumn<ArticleBlock[]>(version.blocks_json, []);
  const input = normalizeVisualPlanInput(await parseJsonWithIdempotency(request), blocks);
  const payloadHash = await sha256Hex(canonicalJson(input));
  const existing = await queryOne<any>(env,
    `SELECT * FROM visual_plans
     WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1`,
    [auth.userId, auth.workspaceId, version.article_id, input.idempotency_key]);
  if (existing) return idempotentVisualResponse(existing, payloadHash);

  const planId = `vp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO visual_plans
       (id, user_id, workspace_id, article_id, recording_id, version_id, items_json, idempotency_key, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      planId,
      auth.userId,
      auth.workspaceId,
      version.article_id,
      version.recording_id,
      version.id,
      canonicalJson(input.items),
      input.idempotency_key,
      payloadHash,
      now,
    ).run();
  } catch (error) {
    const raced = await queryOne<any>(env,
      `SELECT * FROM visual_plans
       WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND idempotency_key = ? LIMIT 1`,
      [auth.userId, auth.workspaceId, version.article_id, input.idempotency_key]);
    if (raced) return idempotentVisualResponse(raced, payloadHash);
    return editorialJson({ error: "visual_plan_conflict" }, 409);
  }
  const row = await queryOne<any>(env, `SELECT * FROM visual_plans WHERE id = ? LIMIT 1`, [planId]);
  return editorialJson({ visual_plan: publicVisualPlan(row!), replayed: false }, 201);
}

async function getVersion(env: Env, auth: EditorialAuth, versionId: string): Promise<Response> {
  const row = await ownedVersion(env, auth, versionId);
  if (!row) return editorialJson({ error: "version_not_found" }, 404);
  const state = await queryOne<VersionStateRow>(env,
    `SELECT * FROM editorial_version_states WHERE version_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
    [row.id, auth.userId, auth.workspaceId]);
  return editorialJson({ version: publicVersion(row), state: state ? publicState(state) : null });
}

async function listVersions(env: Env, auth: EditorialAuth, articleId: string): Promise<Response> {
  const rows = await queryAll<VersionRow>(env,
    `SELECT * FROM article_versions
     WHERE user_id = ? AND workspace_id = ? AND article_id = ?
     ORDER BY version_no ASC`,
    [auth.userId, auth.workspaceId, articleId]);
  return editorialJson({ versions: rows.map(publicVersion) });
}

async function listReviews(env: Env, auth: EditorialAuth, versionId: string): Promise<Response> {
  const version = await ownedVersion(env, auth, versionId);
  if (!version) return editorialJson({ error: "version_not_found" }, 404);
  const rows = await queryAll<any>(env,
    `SELECT * FROM editorial_reviews
     WHERE user_id = ? AND workspace_id = ? AND article_id = ? AND input_version_id = ?
     ORDER BY created_at ASC`,
    [auth.userId, auth.workspaceId, version.article_id, version.id]);
  return editorialJson({ reviews: rows.map(publicReview) });
}

async function ownedVersion(env: Env, auth: EditorialAuth, versionId: string): Promise<VersionRow | null> {
  return queryOne<VersionRow>(env,
    `SELECT * FROM article_versions
     WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`,
    [versionId, auth.userId, auth.workspaceId]);
}

function idempotentVersionResponse(row: VersionRow, payloadHash: string): Response {
  if (row.payload_hash !== payloadHash) {
    return editorialJson({ error: "idempotency_conflict" }, 409);
  }
  return editorialJson({ version: publicVersion(row), replayed: true });
}

function idempotentReviewResponse(row: any, payloadHash: string): Response {
  if (row.payload_hash !== payloadHash) return editorialJson({ error: "idempotency_conflict" }, 409);
  return editorialJson({ review: publicReview(row), replayed: true });
}

function idempotentVisualResponse(row: any, payloadHash: string): Response {
  if (row.payload_hash !== payloadHash) return editorialJson({ error: "idempotency_conflict" }, 409);
  return editorialJson({ visual_plan: publicVisualPlan(row), replayed: true });
}

function publicVersion(row: VersionRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    article_id: row.article_id,
    recording_id: row.recording_id,
    version_no: row.version_no,
    parent_version_id: row.parent_version_id,
    source: row.source,
    source_job_id: row.source_job_id,
    source_hash: row.source_hash,
    title: row.title,
    body: row.body,
    cover: parseColumn(row.cover_json, {}),
    blocks: parseColumn(row.blocks_json, []),
    title_candidates: parseColumn(row.title_candidates_json, []),
    selected_title: row.selected_title,
    cover_title: parseColumn(row.cover_title_json, []),
    claim_ledger: parseColumn(row.claim_ledger_json, []),
    visual_plan: parseColumn(row.visual_plan_json, []),
    formatting_skill_id: row.formatting_skill_id,
    formatting_skill_version: row.formatting_skill_version,
    content_html_hash: row.content_html_hash,
    html_warnings: parseColumn(row.html_warnings_json, []),
    generation_status: row.generation_status,
    created_at: row.created_at,
  };
}

function publicReview(row: any): Record<string, unknown> {
  return {
    id: row.id,
    review_id: row.id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    article_id: row.article_id,
    recording_id: row.recording_id,
    input_version_id: row.input_version_id,
    findings: parseColumn(row.findings_json, []),
    decision: row.decision,
    producer_role: row.producer_role,
    producer_version: row.producer_version,
    reviewer_version: row.producer_version,
    created_at: row.created_at,
  };
}

function publicState(row: VersionStateRow): Record<string, unknown> {
  return {
    version_id: row.version_id,
    current_state: row.state,
    state_revision: row.state_revision,
  };
}

function publicVisualPlan(row: any): Record<string, unknown> {
  return {
    id: row.id,
    visual_plan_id: row.id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    article_id: row.article_id,
    recording_id: row.recording_id,
    version_id: row.version_id,
    items: parseColumn(row.items_json, []),
    created_at: row.created_at,
  };
}

function parseColumn<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EditorialContractError("invalid_json", "request body must be valid JSON");
  }
}

async function parseJsonWithIdempotency(request: Request): Promise<unknown> {
  const body = await parseJson(request);
  const headerKey = request.headers.get("Idempotency-Key")?.trim();
  if (!headerKey || typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.idempotency_key || record.idempotencyKey) return body;
  return { ...record, idempotency_key: headerKey };
}

async function queryOne<T>(env: Env, sql: string, values: unknown[]): Promise<T | null> {
  const { results } = await env.DB.prepare(sql).bind(...values).all<T>();
  return results?.[0] || null;
}

async function queryAll<T>(env: Env, sql: string, values: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...values).all<T>();
  return results || [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function editorialJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
