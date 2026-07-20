import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
} from "agents/workflows";
import {
  canonicalJson,
  isExactWave2PublicationSkillPins,
  PUBLICATION_AGENT_VERSIONS,
  PUBLICATION_WAVE2_ADAPTER_PINS,
  PUBLICATION_SKILL_PINS,
} from "./editorialContracts";
import {
  EditorialCoordinatorAgent,
  EditorialRuntimeError,
  coordinatorShardName,
  type FiveAgentEnvelopeMetadata,
  type EditorialRuntimeEnv,
  type FiveAgentRunInput,
  type FiveAgentStartStatus,
  type FiveAgentWorkflowStartHold,
  type FiveAgentWorkflowStartResult,
} from "./editorialAgents";
import {
  createPublicationRun,
  publicationFeatureEnabled,
  applySystemPublicationTransition,
  type PublicationState,
  type PublicationRunRow,
} from "./publicationProjection";
import {
  deriveArtifactId,
  artifactKey,
  canonicalJson as artifactCanonicalJson,
  normalizeArtifactEnvelope,
  toArtifactMetadata,
  type ArtifactObject,
  type ArticleBrief,
  type ArticleDraft,
  type ReviewReport,
  type RevisionDispatch,
  type FrozenArticleVersion,
  Wave2ContractError,
} from "./wave2/artifactContracts";
import { ArtifactStoreError, putImmutableArtifact, readImmutableArtifact } from "./wave2/artifactStore";
import { callReviewAgentV3, callWritingAgentV3, InternalServiceError } from "./wave2/serviceClients";

export const FIVE_AGENT_PUBLISHING_WORKFLOW_NAME = "FIVE_AGENT_PUBLISHING_WORKFLOW";
export const FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION = "editorial-workflow.v3";
export const FIVE_AGENT_PUBLISHING_POLICY_VERSION = "editorial-policy.v3";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TRANSCRIPT_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONTENT_FREE_KEYS = new Set([
  "run_id", "article_id", "recording_id", "source_type", "language", "transcript_ref",
  "transcript_hash", "source_hash", "title_hint", "content_goal", "profile_pins", "style_profile_body",
]);

export type FiveAgentStartBody = {
  run_id: string;
  article_id: string;
  recording_id: number;
  source_type: "audio" | "text";
  language: string;
  transcript_ref: string;
  transcript_hash: string;
  source_hash: string;
  title_hint: string | null;
  content_goal: string;
  profile_pins: Record<string, { id: string; version: string }>;
  style_profile_body?: string;
};

export type FiveAgentWorkflowParams = FiveAgentRunInput & {
  transcript_ref: string;
  transcript_hash: string;
  source_hash: string;
  brief_artifact_id: string;
  brief_artifact_key: string;
  brief_payload_hash: string;
};

export type FiveAgentWorkflowResult = {
  run_id: string;
  state: string;
  state_revision: number;
  transcript_ref: string;
  transcript_hash: string;
  artifact_ids: string[];
};

function errorResponse(error: unknown): Response {
  if (error instanceof EditorialRuntimeError) return Response.json({ error: error.code }, { status: error.status });
  return Response.json({ error: "five_agent_publishing_unavailable" }, { status: 503 });
}

function workflowStartHoldResult(result: FiveAgentWorkflowStartResult): FiveAgentWorkflowStartHold | null {
  const hold = result.start_hold;
  if (!hold || typeof hold !== "object") return null;
  if ((hold.code !== "workflow_create_unknown" && hold.code !== "five_agent_workflow_reconciliation_required") ||
      hold.status !== 503 || hold.start_status !== "workflow_create_unknown") {
    throw new EditorialRuntimeError("workflow_start_result_invalid", "workflow start returned an invalid hold result", 502);
  }
  return hold;
}

type BriefArtifactRef = Pick<FiveAgentEnvelopeMetadata, "artifact_id" | "artifact_key" | "payload_hash">;

function redactedBriefRef(metadata: BriefArtifactRef): Record<string, string> {
  return {
    artifact_id: metadata.artifact_id,
    artifact_key: metadata.artifact_key,
    payload_hash: metadata.payload_hash,
  };
}

const PUBLIC_RUN_PROJECTION_KEYS = [
  "run_id", "article_id", "recording_id", "workflow_id", "state", "run_status",
  "state_revision", "progress_percent", "last_successful_state", "last_successful_progress_percent",
  "resume_state", "retry_count", "revision_count", "approval_state", "next_action", "error_code",
  "created_at", "updated_at", "start_status", "start_ledger_status", "start_error_code",
  "start_next_action", "artifact_count", "receipt_count", "call_intent_count",
] as const;

function buildPublicRunProjection(run: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(PUBLIC_RUN_PROJECTION_KEYS.map(key => [key, run[key] ?? null]));
}

function startResultResponse(
  result: FiveAgentWorkflowStartResult,
  current: Record<string, unknown>,
  briefMetadata: BriefArtifactRef,
  status: number,
): Response {
  if (!result.run || typeof result.run !== "object" || Array.isArray(result.run) || !current || Array.isArray(current)) {
    throw new EditorialRuntimeError("workflow_start_result_invalid", "workflow start did not return a run projection", 502);
  }
  return Response.json({
    run: buildPublicRunProjection(current),
    replayed: result.replayed,
    ...(result.workflow_status ? { workflow_status: result.workflow_status } : {}),
    brief: redactedBriefRef(briefMetadata),
  }, { status });
}

function startHoldResponse(current: Record<string, unknown>, briefMetadata: BriefArtifactRef): Response {
  return Response.json({
    run: buildPublicRunProjection(current),
    replayed: true,
    workflow_status: "unknown",
    brief: redactedBriefRef(briefMetadata),
  }, { status: 202 });
}

async function parseRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EditorialRuntimeError("invalid_json", "request body must be valid JSON", 400);
  }
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new EditorialRuntimeError("invalid_opaque_id", `${field} is invalid`, 400);
  return value;
}

function transcriptRef(value: unknown): string {
  if (typeof value !== "string" || !TRANSCRIPT_REF.test(value) || value.includes("..") || value.startsWith("/")) {
    throw new EditorialRuntimeError("transcript_ref_invalid", "transcript reference is invalid", 400);
  }
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new EditorialRuntimeError("hash_invalid", `${field} is invalid`, 400);
  return value;
}

function profilePins(value: unknown): Record<string, { id: string; version: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EditorialRuntimeError("profile_pins_invalid", "profile pins are invalid", 400);
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "formatting" || keys[1] !== "style") {
    throw new EditorialRuntimeError("profile_pins_invalid", "only style and formatting profile pins are accepted", 400);
  }
  const result: Record<string, { id: string; version: string }> = {};
  for (const [key, raw] of Object.entries(value)) {
    id(key, "profile pin id");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EditorialRuntimeError("profile_pins_invalid", "profile pin is invalid", 400);
    const pin = raw as Record<string, unknown>;
    if (JSON.stringify(Object.keys(pin).sort()) !== JSON.stringify(["id", "version"])) {
      throw new EditorialRuntimeError("profile_pins_invalid", "profile pin contains unsupported fields", 400);
    }
    result[key] = { id: id(pin.id, `${key}.id`), version: id(pin.version, `${key}.version`) };
  }
  if (result.formatting.id !== PUBLICATION_SKILL_PINS.formatting.id || result.formatting.version !== PUBLICATION_SKILL_PINS.formatting.version) {
    throw new EditorialRuntimeError("formatting_skill_pin_conflict", "the active formatting skill pin is required", 409);
  }
  return result;
}

export function normalizeFiveAgentStartBody(value: unknown): FiveAgentStartBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EditorialRuntimeError("payload_required", "publishing payload is required", 400);
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!CONTENT_FREE_KEYS.has(key)) throw new EditorialRuntimeError("server_owned_field", `${key} is not accepted by the V3 route`, 400);
  }
  const sourceType = body.source_type;
  if (sourceType !== "audio" && sourceType !== "text") throw new EditorialRuntimeError("source_type_invalid", "source_type is invalid", 400);
  if (!Number.isSafeInteger(body.recording_id) || Number(body.recording_id) < 1) throw new EditorialRuntimeError("recording_id_invalid", "recording_id is invalid", 400);
  const titleHint = body.title_hint === null || body.title_hint === undefined ? null : body.title_hint;
  if (titleHint !== null && (typeof titleHint !== "string" || titleHint.length > 500)) {
    throw new EditorialRuntimeError("title_hint_invalid", "title_hint must be a string of at most 500 characters", 400);
  }
  const pins = profilePins(body.profile_pins);
  const styleBody = body.style_profile_body;
  if (pins.style.id === "style_litianc_default") {
    if (pins.style.version !== "2026-07-05" || styleBody !== undefined) {
      throw new EditorialRuntimeError("style_profile_pin_conflict", "the default style cannot be overridden inline", 409);
    }
  } else if (typeof styleBody !== "string" || styleBody.length === 0 || styleBody.length > 20_000) {
    throw new EditorialRuntimeError("style_profile_body_required", "custom styles require a non-empty inline body", 409);
  }
  return {
    run_id: id(body.run_id, "run_id"),
    article_id: id(body.article_id, "article_id"),
    recording_id: Number(body.recording_id),
    source_type: sourceType,
    language: typeof body.language === "string" && body.language.length <= 32 ? body.language : "zh-CN",
    transcript_ref: transcriptRef(body.transcript_ref),
    transcript_hash: hash(body.transcript_hash, "transcript_hash"),
    source_hash: hash(body.source_hash, "source_hash"),
    title_hint: titleHint,
    content_goal: typeof body.content_goal === "string" && body.content_goal.length <= 4_000 ? body.content_goal : "",
    profile_pins: pins,
    ...(styleBody === undefined ? {} : { style_profile_body: styleBody as string }),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function hashJson(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
}

const V3_DEFAULT_MODEL_VERSION = "glm-5.2";

type FrozenManifest = {
  skill_pins: Record<string, unknown>;
  adapter_pins: Record<string, unknown>;
  model_pins: Record<string, unknown>;
};

function manifestForFrozen(params: FiveAgentWorkflowParams): FrozenManifest {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(params.manifest_json) as Record<string, unknown>;
  } catch {
    throw new EditorialRuntimeError("manifest_invalid", "the run manifest is not valid JSON", 409);
  }
  if (canonicalJson(manifest) !== params.manifest_json ||
      manifest.run_id !== params.run_id || manifest.article_id !== params.article_id ||
      manifest.recording_id !== params.recording_id || manifest.user_id !== params.user_id ||
      manifest.workspace_id !== params.workspace_id || manifest.workflow_version !== FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION ||
      manifest.policy_version !== FIVE_AGENT_PUBLISHING_POLICY_VERSION ||
      canonicalJson(manifest.agent_versions) !== canonicalJson(PUBLICATION_AGENT_VERSIONS)) {
    throw new EditorialRuntimeError("manifest_identity_conflict", "the run manifest identity is not active", 409);
  }
  const skillPins = manifest.skill_pins as Record<string, unknown>;
  const adapterPins = manifest.adapter_pins as Record<string, unknown>;
  const modelPins = manifest.model_pins as Record<string, unknown>;
  if (!isExactWave2PublicationSkillPins(skillPins) ||
      canonicalJson(adapterPins) !== canonicalJson(PUBLICATION_WAVE2_ADAPTER_PINS) ||
      canonicalJson(adapterPins) !== canonicalJson(skillPins.adapter_pins) ||
      canonicalJson(modelPins) !== canonicalJson(skillPins.model_pins)) {
    throw new EditorialRuntimeError("manifest_pin_conflict", "the run manifest pins are not active", 409);
  }
  return { skill_pins: skillPins, adapter_pins: adapterPins, model_pins: modelPins };
}

function assertDraftManifestPins(draft: ArtifactObject, manifest: FrozenManifest): void {
  const payload = draft.payload as ArticleDraft;
  const skillPins = manifest.skill_pins;
  const expectedProfilePins = { style: skillPins.style, formatting: skillPins.formatting };
  if (payload.adapter_version !== manifest.adapter_pins.writing ||
      payload.model_version !== manifest.model_pins.writing ||
      artifactCanonicalJson(payload.profile_pins) !== artifactCanonicalJson(expectedProfilePins)) {
    throw new EditorialRuntimeError("frozen_draft_pin_conflict", "draft pins do not match the run manifest", 409);
  }
  const expectedStyleBodyHash = skillPins.style_profile_body_hash;
  if (expectedStyleBodyHash === undefined
      ? payload.style_profile_body_hash !== undefined
      : payload.style_profile_body_hash !== expectedStyleBodyHash) {
    throw new EditorialRuntimeError("frozen_style_profile_conflict", "draft style body hash does not match the run manifest", 409);
  }
}

function assertDraftResponseManifestPins(
  params: FiveAgentWorkflowParams,
  rawPayload: unknown,
  expectedProfilePins: Record<string, unknown>,
  expectedStyleBodyHash?: string,
): void {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new EditorialRuntimeError("draft_manifest_pin_conflict", "draft response pins are invalid", 409);
  }
  const payload = rawPayload as Record<string, unknown>;
  const manifest = manifestForFrozen(params);
  const expectedAdapter = manifest.adapter_pins.writing;
  const expectedModel = manifest.model_pins.writing;
  const expectedManifestProfile = { style: manifest.skill_pins.style, formatting: manifest.skill_pins.formatting };
  if (payload.adapter_version !== expectedAdapter || payload.model_version !== expectedModel ||
      artifactCanonicalJson(payload.profile_pins) !== artifactCanonicalJson(expectedProfilePins) ||
      artifactCanonicalJson(payload.profile_pins) !== artifactCanonicalJson(expectedManifestProfile) ||
      artifactCanonicalJson(payload.formatting_skill) !== artifactCanonicalJson(manifest.skill_pins.formatting)) {
    throw new EditorialRuntimeError("draft_manifest_pin_conflict", "draft response pins do not match the run manifest", 409);
  }
  const actualStyleBodyHash = payload.style_profile_body_hash;
  if (expectedStyleBodyHash === undefined
      ? actualStyleBodyHash !== undefined
      : actualStyleBodyHash !== expectedStyleBodyHash) {
    throw new EditorialRuntimeError("draft_manifest_pin_conflict", "draft response style body pin does not match the run manifest", 409);
  }
}

function assertDraftBeforePersistence(
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  expectedInputArtifactIds: readonly string[],
  expectedProfilePins: Record<string, unknown>,
  expectedStyleBodyHash?: string,
): void {
  const manifest = manifestForFrozen(params);
  assertDraftManifestPins(draft, manifest);
  if (artifactCanonicalJson(draft.envelope.input_artifact_ids) !== artifactCanonicalJson(expectedInputArtifactIds) ||
      artifactCanonicalJson((draft.payload as ArticleDraft).profile_pins) !== artifactCanonicalJson(expectedProfilePins) ||
      (draft.payload as ArticleDraft).style_profile_body_hash !== expectedStyleBodyHash) {
    throw new EditorialRuntimeError("draft_manifest_pin_conflict", "draft artifact identity is not bound to the run manifest", 409);
  }
}

function assertReviewRoundBeforePersistence(rawPayload: unknown, expectedRound: 1 | 2): void {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload) ||
      (rawPayload as Record<string, unknown>).review_round !== expectedRound) {
    throw new EditorialRuntimeError("review_round_conflict", "review response round does not match the workflow phase", 409);
  }
}

function assertReviewManifestPins(review: ArtifactObject, manifest: FrozenManifest): void {
  const payload = review.payload as ReviewReport;
  if (payload.reviewer_version !== manifest.adapter_pins.editorial_review ||
      artifactCanonicalJson(payload.rules_pins) !== artifactCanonicalJson({
        dbs_ai_check: { id: "dbs-ai-check", version: "1.0.0" },
        humanizer: { id: "humanizer-zh", version: "1.0.0" },
      }) ||
      artifactCanonicalJson(review.envelope.skill_pins) !== artifactCanonicalJson({ review: manifest.skill_pins.review })) {
    throw new EditorialRuntimeError("frozen_review_pin_conflict", "review pins do not match the run manifest", 409);
  }
}

async function manifestFor(input: FiveAgentStartBody & { user_id: string; workspace_id: string; model_version?: string }): Promise<Record<string, unknown>> {
  const skillPins = {
    ...PUBLICATION_SKILL_PINS,
    style: input.profile_pins.style,
    formatting: input.profile_pins.formatting,
    adapter_pins: { ...PUBLICATION_WAVE2_ADAPTER_PINS },
    model_pins: { writing: input.model_version || V3_DEFAULT_MODEL_VERSION, editorial_review: "rules-only" },
    ...(input.style_profile_body === undefined ? {} : {
      style_profile_body_hash: await sha256(new TextEncoder().encode(input.style_profile_body)),
    }),
  };
  return {
    schema_version: "editorial-orchestration.v3",
    run_id: input.run_id,
    article_id: input.article_id,
    recording_id: input.recording_id,
    user_id: input.user_id,
    workspace_id: input.workspace_id,
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    agent_versions: PUBLICATION_AGENT_VERSIONS,
    skill_pins: skillPins,
    adapter_pins: skillPins.adapter_pins,
    model_pins: skillPins.model_pins,
    idempotency_key: `run:${input.run_id}`,
  };
}

function canonicalRunMatches(
  existing: Record<string, unknown>,
  input: FiveAgentStartBody & { user_id: string; workspace_id: string; payload_hash: string },
  manifest: Record<string, unknown>,
): boolean {
  return existing.run_id === input.run_id &&
    existing.user_id === input.user_id &&
    existing.workspace_id === input.workspace_id &&
    existing.article_id === input.article_id &&
    Number(existing.recording_id) === input.recording_id &&
    existing.schema_version === "editorial-orchestration.v3" &&
    existing.workflow_version === FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION &&
    existing.policy_version === FIVE_AGENT_PUBLISHING_POLICY_VERSION &&
    existing.agent_versions_json === canonicalJson(manifest.agent_versions) &&
    existing.skill_pins_json === canonicalJson(manifest.skill_pins) &&
    existing.idempotency_key === `run:${input.run_id}` &&
    existing.payload_hash === input.payload_hash;
}

async function ensureCanonicalRun(
  db: D1Database,
  input: FiveAgentStartBody & { user_id: string; workspace_id: string; payload_hash: string },
  manifest: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  const agentVersions = canonicalJson(manifest.agent_versions);
  const skillPins = canonicalJson(manifest.skill_pins);
  const existing = await db.prepare(`SELECT run_id, user_id, workspace_id, article_id, recording_id,
      schema_version, workflow_version, policy_version, agent_versions_json, skill_pins_json,
      idempotency_key, payload_hash FROM editorial_runs WHERE run_id = ? LIMIT 1`).bind(input.run_id).first<Record<string, unknown>>();
  if (existing) {
    if (!canonicalRunMatches(existing, input, manifest)) throw new EditorialRuntimeError("canonical_run_conflict", "canonical editorial run identity conflicts", 409);
    return;
  }
  try {
    await db.prepare(`INSERT INTO editorial_runs
      (run_id, user_id, workspace_id, article_id, recording_id, schema_version, workflow_version, policy_version,
       agent_versions_json, skill_pins_json, status, idempotency_key, payload_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`)
      .bind(input.run_id, input.user_id, input.workspace_id, input.article_id, input.recording_id,
        "editorial-orchestration.v3", FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION, FIVE_AGENT_PUBLISHING_POLICY_VERSION,
        agentVersions, skillPins, `run:${input.run_id}`, input.payload_hash, createdAt, createdAt).run();
  } catch {
    const raced = await db.prepare(`SELECT run_id, user_id, workspace_id, article_id, recording_id,
        schema_version, workflow_version, policy_version, agent_versions_json, skill_pins_json,
        idempotency_key, payload_hash FROM editorial_runs WHERE run_id = ? LIMIT 1`)
      .bind(input.run_id).first<Record<string, unknown>>();
    if (!raced || !canonicalRunMatches(raced, input, manifest)) throw new EditorialRuntimeError("canonical_run_conflict", "canonical editorial run could not be created", 409);
  }
  void manifest;
}

async function buildBriefObject(input: FiveAgentStartBody & { user_id: string; workspace_id: string; created_at: string }): Promise<ArtifactObject> {
  const idempotencyKey = `brief:${input.run_id}`;
  const artifactId = await deriveArtifactId("article_brief", input.run_id, idempotencyKey);
  const payload: ArticleBrief = {
    article_id: input.article_id,
    run_id: input.run_id,
    recording_id: input.recording_id,
    source_type: input.source_type,
    language: input.language,
    transcript_ref: input.transcript_ref,
    transcript_hash: input.transcript_hash,
    source_hash: input.source_hash,
    title_hint: input.title_hint,
    content_goal: input.content_goal,
    profile_pins: input.profile_pins,
    ...(input.style_profile_body === undefined ? {} : { style_profile_body: input.style_profile_body }),
    ...(input.style_profile_body === undefined ? {} : { style_profile_body_hash: await sha256(new TextEncoder().encode(input.style_profile_body)) }),
    block_strategy: "stable_block_v1",
  };
  return normalizeArtifactEnvelope({
    artifact_id: artifactId,
    kind: "article_brief",
    run_id: input.run_id,
    article_id: input.article_id,
    recording_id: input.recording_id,
    user_id: input.user_id,
    workspace_id: input.workspace_id,
    producer: { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    skill_pins: input.profile_pins,
    input_artifact_ids: [],
    idempotency_key: idempotencyKey,
    created_at: input.created_at,
    payload,
  });
}

async function mirrorArtifactToD1(db: D1Database, object: ArtifactObject): Promise<void> {
  const metadata = toArtifactMetadata(object);
  const mirror = {
    artifact_id: metadata.artifact_id,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: metadata.recording_id,
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    kind: metadata.kind,
    payload_hash: metadata.payload_hash,
    storage_ref: metadata.storage_ref,
    input_artifact_ids_json: JSON.stringify(metadata.input_artifact_ids),
    skill_id: metadata.skill_pins.formatting?.id || null,
    skill_version: metadata.skill_pins.formatting?.version || null,
    producer_role: metadata.producer.role,
    producer_version: metadata.producer.version,
    schema_version: metadata.schema_version,
    workflow_version: metadata.workflow_version,
    policy_version: metadata.policy_version,
  };
  const readExisting = () => db.prepare(`SELECT artifact_id, run_id, article_id, recording_id, user_id, workspace_id,
      kind, payload_hash, storage_ref, input_artifact_ids_json, skill_id, skill_version,
      producer_agent_role, producer_agent_version, schema_version, workflow_version, policy_version
      FROM editorial_artifacts WHERE artifact_id = ? LIMIT 1`).bind(mirror.artifact_id).first<Record<string, unknown>>();
  const matches = (existing: Record<string, unknown> | null): boolean => Boolean(existing &&
    String(existing.artifact_id) === mirror.artifact_id &&
    String(existing.run_id) === mirror.run_id &&
    String(existing.article_id) === mirror.article_id &&
    Number(existing.recording_id) === mirror.recording_id &&
    String(existing.user_id) === mirror.user_id &&
    String(existing.workspace_id) === mirror.workspace_id &&
    String(existing.kind) === mirror.kind &&
    String(existing.payload_hash) === mirror.payload_hash &&
    String(existing.storage_ref) === mirror.storage_ref &&
    String(existing.input_artifact_ids_json) === mirror.input_artifact_ids_json &&
    String(existing.skill_id ?? "") === String(mirror.skill_id ?? "") &&
    String(existing.skill_version ?? "") === String(mirror.skill_version ?? "") &&
    String(existing.producer_agent_role) === mirror.producer_role &&
    String(existing.producer_agent_version) === mirror.producer_version &&
    String(existing.schema_version) === mirror.schema_version &&
    String(existing.workflow_version) === mirror.workflow_version &&
    String(existing.policy_version) === mirror.policy_version);
  let existing = await readExisting();
  if (existing && !matches(existing)) throw new EditorialRuntimeError("artifact_mirror_conflict", "D1 artifact mirror conflicts", 409);
  if (!existing) {
    try {
      await db.prepare(`INSERT INTO editorial_artifacts
      (artifact_id, run_id, user_id, workspace_id, article_id, recording_id, schema_version, kind,
       producer_agent_role, producer_agent_version, skill_id, skill_version, workflow_version,
       policy_version, input_artifact_ids_json, payload_hash, storage_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(mirror.artifact_id, mirror.run_id, mirror.user_id, mirror.workspace_id, mirror.article_id,
          mirror.recording_id, mirror.schema_version, mirror.kind, mirror.producer_role, mirror.producer_version,
          mirror.skill_id, mirror.skill_version, mirror.workflow_version, mirror.policy_version,
          mirror.input_artifact_ids_json, mirror.payload_hash, mirror.storage_ref, metadata.created_at).run();
    } catch {
      existing = await readExisting();
      if (!existing) throw new EditorialRuntimeError("artifact_reconciliation_required", "D1 artifact mirror insert outcome is unknown", 503);
      if (!matches(existing)) throw new EditorialRuntimeError("artifact_mirror_conflict", "D1 artifact mirror insert could not be reconciled", 409);
    }
  }
  const check = await readExisting();
  if (!matches(check)) throw new EditorialRuntimeError("artifact_mirror_unavailable", "D1 artifact mirror could not be verified", 503);
}

async function coordinatorEnvelopeFromMetadata(metadata: ReturnType<typeof toArtifactMetadata>): Promise<FiveAgentEnvelopeMetadata> {
  const base = {
    schema_version: metadata.schema_version,
    artifact_id: metadata.artifact_id,
    artifact_key: metadata.artifact_key,
    kind: metadata.kind,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: metadata.recording_id,
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    producer_role: metadata.producer.role,
    producer_version: metadata.producer.version,
    workflow_version: metadata.workflow_version,
    policy_version: metadata.policy_version,
    input_artifact_ids_json: JSON.stringify(metadata.input_artifact_ids),
    payload_hash: metadata.payload_hash,
    payload_length: metadata.payload_length,
    idempotency_key: metadata.idempotency_key,
    storage_ref: metadata.storage_ref,
    created_at: metadata.created_at,
  };
  const skillPinsHash = await hashJson(metadata.skill_pins);
  const identity = await hashJson({ ...base, skill_pins_hash: skillPinsHash });
  const result: FiveAgentEnvelopeMetadata = { ...base, skill_pins_hash: skillPinsHash, envelope_identity_hash: identity };
  return result;
}

async function coordinatorEnvelope(object: ArtifactObject): Promise<FiveAgentEnvelopeMetadata> {
  return coordinatorEnvelopeFromMetadata(toArtifactMetadata(object));
}

async function prepareArtifactStorage(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  object: ArtifactObject,
): Promise<ReturnType<typeof toArtifactMetadata>> {
  const metadata = toArtifactMetadata(object);
  const redactedEnvelope = await coordinatorEnvelope(object);
  await coordinator.prepareFiveAgentArtifact({
    run_id: params.run_id,
    metadata: redactedEnvelope,
    envelope_json: artifactCanonicalJson(redactedEnvelope),
  });
  try {
    await putImmutableArtifact(env.FILES_BUCKET, object, {
      userId: params.user_id,
      workspaceId: params.workspace_id,
      runId: params.run_id,
    });
    await readImmutableArtifact(env.FILES_BUCKET, object, {
      userId: params.user_id,
      workspaceId: params.workspace_id,
      runId: params.run_id,
    });
  } catch (error) {
    throw error;
  }
  try {
    await mirrorArtifactToD1(env.DB, object);
  } catch (error) {
    if (error instanceof EditorialRuntimeError && error.code === "artifact_mirror_conflict") throw error;
    if (error instanceof EditorialRuntimeError && (error.code === "artifact_mirror_unavailable" || error.code === "artifact_reconciliation_required")) throw error;
    throw new EditorialRuntimeError("artifact_reconciliation_required", "D1 artifact mirror outcome is unknown", 503);
  }
  return metadata;
}

async function readArtifactFromR2(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
  artifactId: string,
  artifactKeyValue: string,
  expectedPayloadHash?: string,
): Promise<ArtifactObject> {
  let stored: R2ObjectBody | null;
  try {
    stored = await env.FILES_BUCKET.get(artifactKeyValue);
  } catch {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "artifact read outcome is unknown", 503);
  }
  if (!stored) throw new EditorialRuntimeError("artifact_not_found", "artifact is unavailable", 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await stored.text());
  } catch {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "artifact bytes cannot be normalized", 503);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new EditorialRuntimeError("artifact_reconciliation_required", "artifact envelope is invalid", 503);
  const record = parsed as Record<string, unknown>;
  if (!record.envelope || typeof record.envelope !== "object" || !Object.prototype.hasOwnProperty.call(record, "payload")) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "artifact envelope is incomplete", 503);
  }
  const rawEnvelope = record.envelope as Record<string, unknown>;
  if (rawEnvelope.run_id !== params.run_id || rawEnvelope.user_id !== params.user_id || rawEnvelope.workspace_id !== params.workspace_id || rawEnvelope.artifact_id !== artifactId) {
    throw new EditorialRuntimeError("artifact_identity_conflict", "artifact owner or run identity does not match", 409);
  }
  let object: ArtifactObject;
  try {
    const envelope = rawEnvelope;
    object = await normalizeArtifactEnvelope({
      artifact_id: envelope.artifact_id,
      kind: envelope.kind,
      run_id: envelope.run_id,
      article_id: envelope.article_id,
      recording_id: envelope.recording_id,
      user_id: envelope.user_id,
      workspace_id: envelope.workspace_id,
      producer: envelope.producer,
      workflow_version: envelope.workflow_version,
      policy_version: envelope.policy_version,
      skill_pins: envelope.skill_pins,
      input_artifact_ids: envelope.input_artifact_ids,
      idempotency_key: envelope.idempotency_key,
      created_at: envelope.created_at,
      payload: record.payload,
    });
  } catch {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "artifact envelope cannot be verified", 503);
  }
  if (object.envelope.artifact_id !== artifactId || object.envelope.artifact_key !== artifactKeyValue ||
      (expectedPayloadHash !== undefined && object.envelope.payload_hash !== expectedPayloadHash) || object.envelope.run_id !== params.run_id ||
      object.envelope.user_id !== params.user_id || object.envelope.workspace_id !== params.workspace_id) {
    throw new EditorialRuntimeError("artifact_identity_conflict", "artifact identity does not match the workflow", 409);
  }
  try {
    await readImmutableArtifact(env.FILES_BUCKET, object, {
      userId: params.user_id,
      workspaceId: params.workspace_id,
      runId: params.run_id,
    });
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.code !== "artifact_reconciliation_required") throw error;
    throw new EditorialRuntimeError("artifact_reconciliation_required", "artifact readback cannot be reconciled", 503);
  }
  return object;
}

function workflowTimestamp(base: string, offsetMs: number): string {
  const parsed = Date.parse(base);
  if (!Number.isFinite(parsed)) throw new EditorialRuntimeError("created_at_invalid", "workflow timestamp is invalid", 400);
  return new Date(parsed + offsetMs).toISOString();
}

async function applySystemState(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  targetState: "transcribing" | "writing" | "reviewing" | "needs_action" | "failed",
  eventType: "transcription_started" | "writing_started" | "review_started" | "needs_action" | "failed",
  doStateRevision: number,
  projectionRevision: number,
  offsetMs: number,
  phase: number,
  transition: {
    errorCode?: string | null;
    nextAction?: string | null;
    revisionCount?: number;
    retryCount?: number;
    projectionTargetState?: PublicationState;
    projectionAllowSameState?: boolean;
  } = {},
): Promise<{ doStateRevision: number; projectionRevision: number }> {
  const createdAt = workflowTimestamp(params.created_at, offsetMs);
  const eventPayloadHash = await hashJson({
    run_payload_hash: params.payload_hash,
    event_type: eventType,
    phase,
    target_state: targetState,
    error_code: transition.errorCode ?? null,
    next_action: transition.nextAction ?? null,
    revision_count: transition.revisionCount ?? null,
    retry_count: transition.retryCount ?? null,
  });
  const projectionTargetState = transition.projectionTargetState || targetState;
  const projection = await applySystemPublicationTransition(env.DB, {
    runId: params.run_id,
    auth: { userId: params.user_id, workspaceId: params.workspace_id },
    targetState: projectionTargetState,
    expectedStateRevision: projectionRevision,
    options: {
      eventId: `${params.run_id}:event:${projectionRevision + 1}`,
      eventType,
      eventIdempotencyKey: `${eventType}:${phase}:${params.run_id}`,
      eventPayloadHash,
      eventCreatedAt: createdAt,
      errorCode: transition.errorCode,
      nextAction: transition.nextAction,
      retryCount: transition.retryCount,
      allowSameState: transition.projectionAllowSameState,
    },
  });
  await coordinator.recordFiveAgentState({
    run_id: params.run_id,
    state: targetState,
    state_revision: doStateRevision + 1,
    event_type: eventType,
    payload_hash: eventPayloadHash,
    created_at: createdAt,
    next_action: transition.nextAction,
    error_code: transition.errorCode,
    revision_count: transition.revisionCount,
    retry_count: transition.retryCount,
  });
  return { doStateRevision: doStateRevision + 1, projectionRevision: projection.run.state_revision };
}

export async function reconcilePreStartHold(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  startStatus: FiveAgentStartStatus = "brief_storage_unknown",
): Promise<{ state: string; state_revision: number; reconciled: boolean }> {
  const current = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  if (current.state !== "queued" || Number(current.state_revision || 0) !== 0 ||
      current.start_ledger_status !== "needs_action" || current.start_status !== startStatus) {
    return { state: String(current.state), state_revision: Number(current.state_revision || 0), reconciled: false };
  }
  const projection = await env.DB.prepare(`SELECT state, state_revision, resume_state, error_code, next_action
    FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<{ state: string; state_revision: number; resume_state: string | null; error_code: string | null; next_action: string | null }>();
  if (!projection || !["needs_action", "retrying", "queued"].includes(projection.state)) {
    throw new EditorialRuntimeError("reconciliation_required", "pre-start projection is not in a resumable hold", 409);
  }
  if (projection.state === "needs_action" && projection.resume_state !== null) {
    throw new EditorialRuntimeError("reconciliation_required", "pre-start projection is not in a resumable hold", 409);
  }
  const reconciledNeedsAction = projection.state === "needs_action" &&
    projection.error_code === "start_side_effect_reconciled" &&
    projection.next_action === "resume_reconciled_start";
  if (projection.state === "retrying" && projection.resume_state !== "queued") {
    throw new EditorialRuntimeError("reconciliation_required", "pre-start retry does not resume queued", 409);
  }
  const reconciliationInput = {
    run_id: params.run_id,
    workflow_id: params.workflow_id,
    start_status: startStatus,
    reconciliation_key: `${startStatus}:${params.workflow_id}`,
    evidence_hash: startStatus === "brief_storage_unknown" ? params.brief_payload_hash : params.manifest_hash,
    created_at: workflowTimestamp(params.created_at, 2_002),
  } as const;
  await coordinator.prepareFiveAgentStartReconciliation(reconciliationInput);
  const retryingHash = await hashJson({
    run_payload_hash: params.payload_hash, event_type: "start_reconciliation_retrying",
    start_status: startStatus, target_state: "retrying",
  });
  const queuedHash = await hashJson({
    run_payload_hash: params.payload_hash, event_type: "start_reconciliation_queued",
    start_status: startStatus, target_state: "queued",
  });
  const reconciledHash = await hashJson({
    run_payload_hash: params.payload_hash, event_type: "start_reconciled",
    start_status: startStatus, target_state: "needs_action",
    error_code: "start_side_effect_reconciled", next_action: "resume_reconciled_start",
  });
  const reconciled = projection.state === "needs_action" && !reconciledNeedsAction
    ? await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: "needs_action",
      expectedStateRevision: projection.state_revision,
      options: {
        eventId: `${params.run_id}:event:${projection.state_revision + 1}`,
        eventType: "start_reconciled",
        eventIdempotencyKey: `start-reconcile:${startStatus}:reconciled:${params.run_id}`,
        eventPayloadHash: reconciledHash,
        eventCreatedAt: workflowTimestamp(params.created_at, 2_000),
        errorCode: "start_side_effect_reconciled",
        nextAction: "resume_reconciled_start",
        allowSameState: true,
      },
    })
    : { run: projection as unknown as PublicationRunRow, replayed: true };
  const retrying = reconciled.run.state === "retrying" || reconciled.run.state === "queued"
    ? reconciled
    : await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: "retrying",
      expectedStateRevision: reconciled.run.state_revision,
      options: {
        eventId: `${params.run_id}:event:${reconciled.run.state_revision + 1}`,
        eventType: "start_reconciliation_retrying",
        eventIdempotencyKey: `start-reconcile:${startStatus}:retrying:${params.run_id}`,
        eventPayloadHash: retryingHash,
        eventCreatedAt: workflowTimestamp(params.created_at, 2_001),
        errorCode: "external_side_effect_unknown",
        nextAction: "reconcile_external_side_effect",
      },
    });
  const queued = retrying.run.state === "queued" ? retrying : await applySystemPublicationTransition(env.DB, {
    runId: params.run_id,
    auth: { userId: params.user_id, workspaceId: params.workspace_id },
    targetState: "queued",
    expectedStateRevision: retrying.run.state_revision,
    options: {
      eventId: `${params.run_id}:event:${retrying.run.state_revision + 1}`,
      eventType: "run_queued",
      eventIdempotencyKey: `start-reconcile:${startStatus}:queued:${params.run_id}`,
      eventPayloadHash: queuedHash,
      eventCreatedAt: workflowTimestamp(params.created_at, 2_002),
    },
  });
  await coordinator.finalizeFiveAgentStartReconciliation(reconciliationInput);
  return {
    state: "queued",
    state_revision: queued.run.state_revision,
    reconciled: true,
  };
}

async function holdPreStartPublication(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
  startStatus: FiveAgentStartStatus,
): Promise<{ state_revision: number; replayed: boolean }> {
  const current = await env.DB.prepare(`SELECT state, state_revision, error_code, next_action, resume_state
    FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<{ state: string; state_revision: number; error_code: string | null; next_action: string | null; resume_state: string | null }>();
  if (!current) throw new EditorialRuntimeError("publication_run_not_found", "publication run not found", 404);
  if (current.state === "needs_action" && current.resume_state === null &&
      current.error_code === "external_side_effect_unknown" && current.next_action === "reconcile_external_side_effect") {
    return { state_revision: current.state_revision, replayed: true };
  }
  if (current.state !== "queued") throw new EditorialRuntimeError("publication_revision_conflict", "pre-start publication is no longer queued", 409);
  const eventCreatedAt = workflowTimestamp(params.created_at, 1_000);
  const eventPayloadHash = await hashJson({
    run_payload_hash: params.payload_hash, event_type: "start_reconciliation_required",
    start_status: startStatus, target_state: "needs_action",
  });
  const held = await applySystemPublicationTransition(env.DB, {
    runId: params.run_id,
    auth: { userId: params.user_id, workspaceId: params.workspace_id },
    targetState: "needs_action",
    expectedStateRevision: current.state_revision,
    options: {
      eventId: `${params.run_id}:event:${current.state_revision + 1}`,
      eventType: "start_reconciliation_required",
      eventIdempotencyKey: `start-required:${startStatus}:${params.run_id}`,
      eventPayloadHash,
      eventCreatedAt,
      errorCode: "external_side_effect_unknown",
      nextAction: "reconcile_external_side_effect",
    },
  });
  return { state_revision: held.run.state_revision, replayed: held.replayed };
}

function isReconciliationHold(error: unknown): boolean {
  return (error instanceof EditorialRuntimeError &&
    (error.code === "external_side_effect_unknown" || error.code === "artifact_reconciliation_required" ||
      error.code === "artifact_mirror_unavailable" || error.code === "artifact_not_found")) ||
    (error instanceof ArtifactStoreError && error.code === "artifact_reconciliation_required");
}

function adapterFailureMetadata(error: unknown, role: "writing" | "review"): { errorCode: string; nextAction: string; retryCount: number } {
  const exhausted = (error instanceof InternalServiceError && wave2bRetryable(error)) ||
    (error instanceof EditorialRuntimeError && error.code === "adapter_retry_exhausted");
  const retryCount = error instanceof EditorialRuntimeError && Number.isSafeInteger(error.retryCount) && error.retryCount > 0
    ? error.retryCount
    : 1;
  return exhausted
    ? { errorCode: `${role}_adapter_retry_exhausted`, nextAction: "retry", retryCount }
    : { errorCode: `${role}_adapter_non_retryable`, nextAction: "retry_after_service_fix", retryCount };
}

function isAdapterFailure(error: unknown): boolean {
  return error instanceof InternalServiceError || error instanceof Wave2ContractError ||
    (error instanceof EditorialRuntimeError && (error.code === "adapter_retry_exhausted" || error.code === "adapter_non_retryable"));
}

export const PRE_PERSISTENCE_INTEGRITY_ERROR_CODES = [
  "draft_manifest_pin_conflict",
  "frozen_draft_pin_conflict",
  "frozen_style_profile_conflict",
  "review_round_conflict",
  "frozen_review_pin_conflict",
] as const;
type PrePersistenceIntegrityErrorCode = typeof PRE_PERSISTENCE_INTEGRITY_ERROR_CODES[number];
type PrePersistenceIntegrityError = EditorialRuntimeError & { readonly code: PrePersistenceIntegrityErrorCode };

export function isPrePersistenceIntegrityError(error: unknown): error is PrePersistenceIntegrityError {
  return error instanceof EditorialRuntimeError &&
    PRE_PERSISTENCE_INTEGRITY_ERROR_CODES.includes(error.code as PrePersistenceIntegrityErrorCode);
}

async function completePrePersistenceIntegrityCallAndThrow(
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  prepared: { call_id: string },
  errorCode: PrePersistenceIntegrityErrorCode,
  role: "writing" | "review",
  recordedAt: string,
): Promise<never> {
  await coordinator.completeFiveAgentCall({
    call_id: prepared.call_id,
    run_id: params.run_id,
    status: "failed",
    error_code: errorCode,
    retryable: false,
    recorded_at: recordedAt,
  });
  throw new EditorialRuntimeError(
    "adapter_non_retryable",
    `${role} pre-persistence contract validation failed`,
    409,
    1,
  );
}

async function failAdapterRun(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  doStateRevision: number,
  projectionRevision: number,
  phase: number,
  transcript: { ref: string; hash: string },
  artifactIds: string[],
  error: unknown,
  role: "writing" | "review",
): Promise<FiveAgentWorkflowResult> {
  const metadata = adapterFailureMetadata(error, role);
  const failed = await applySystemState(
    env,
    coordinator,
    params,
    "failed",
    "failed",
    doStateRevision,
    projectionRevision,
    phase * 1_000,
    phase,
    metadata,
  );
  return {
    run_id: params.run_id,
    state: "failed",
    state_revision: failed.doStateRevision,
    transcript_ref: transcript.ref,
    transcript_hash: transcript.hash,
    artifact_ids: artifactIds,
  };
}

async function holdForReconciliation(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  doStateRevision: number,
  projectionRevision: number,
  phase: number,
  transcript: { ref: string; hash: string },
  artifactIds: string[],
): Promise<FiveAgentWorkflowResult> {
  const held = await applySystemState(
    env,
    coordinator,
    params,
    "needs_action",
    "needs_action",
    doStateRevision,
    projectionRevision,
    phase * 1_000,
    phase,
    { errorCode: "external_side_effect_unknown", nextAction: "reconcile_external_side_effect" },
  );
  return {
    run_id: params.run_id,
    state: "needs_action",
    state_revision: held.doStateRevision,
    transcript_ref: transcript.ref,
    transcript_hash: transcript.hash,
    artifact_ids: artifactIds,
  };
}

async function persistArtifact(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  object: ArtifactObject,
  targetState: "transcript_ready" | "draft_generated" | "reviewing" | "revising" | "reviewed" | "needs_action" | "content_frozen",
  eventType: string,
  doStateRevision: number,
  projectionRevision: number,
  allowSameState = false,
  transition: {
    errorCode?: string | null;
    nextAction?: string | null;
    eventIdempotencyKey?: string;
    revisionCount?: number;
    projectionTargetState?: PublicationState;
    projectionAllowSameState?: boolean;
    expectedArtifactSet?: readonly ArtifactSetIdentity[];
  } = {},
): Promise<StoredArtifactMetadata & { doStateRevision: number; projectionRevision: number }> {
  const metadata = await prepareArtifactStorage(env, coordinator, params, object);
  const priorSet = transition.expectedArtifactSet ? [...transition.expectedArtifactSet] : [];
  const fullSet = [...priorSet, metadata];
  if (new Set(fullSet.map(item => item.artifact_id)).size !== fullSet.length) {
    throw new EditorialRuntimeError("artifact_set_conflict", "Wave2B artifact set contains duplicate identities", 409);
  }

  // The storage call may have completed before the Workflow step result was
  // lost. Reconcile the three durable layers before deciding which operation
  // is still missing. A receipt without its matching event is not a replayable
  // state: it is an integrity hold rather than permission to write again.
  const ledger = await coordinator.getFiveAgentArtifactLedger(params.run_id, params.user_id, params.workspace_id);
  const currentOutbox = ledger.artifacts.some(item => item.artifact_id === metadata.artifact_id);
  const currentReceipt = ledger.receipt_ids.includes(metadata.artifact_id);
  const eventRow = await env.DB.prepare(`SELECT idempotency_key, payload_hash
    FROM publication_run_events WHERE run_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(params.run_id, transition.eventIdempotencyKey || metadata.idempotency_key)
    .first<{ idempotency_key: string; payload_hash: string }>();
  const currentEvent = eventRow !== null;
  if (!currentOutbox) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B current artifact is missing from the durable outbox", 503);
  }

  const receiptIds = currentReceipt ? fullSet.map(item => item.artifact_id) : priorSet.map(item => item.artifact_id);
  const eventIds = currentEvent ? fullSet.map(item => item.artifact_id) : priorSet.map(item => item.artifact_id);
  await verifyExactArtifactSet(env, coordinator, params, fullSet, receiptIds, eventIds);

  const currentDoRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const currentProjection = await env.DB.prepare(`SELECT state, state_revision
    FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<{ state: string; state_revision: number }>();
  if (!currentProjection) throw new EditorialRuntimeError("publication_run_not_found", "publication run is unavailable", 404);

  if (currentReceipt) {
    const expectedProjectionState = transition.projectionTargetState || targetState;
    if (!currentEvent || currentDoRun.state !== targetState || currentProjection.state !== expectedProjectionState) {
      throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B completed artifact layers do not match the target state", 503);
    }
    return {
      ...metadata,
      doStateRevision: Number(currentDoRun.state_revision),
      projectionRevision: Number(currentProjection.state_revision),
    };
  }

  let projectionRevisionForWrite = Number(currentProjection.state_revision);
  let doStateRevisionForWrite = Number(currentDoRun.state_revision);
  let projection = { run: currentProjection as unknown as PublicationRunRow, replayed: false };
  if (!currentEvent) {
    projection = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: transition.projectionTargetState || targetState,
      expectedStateRevision: projectionRevisionForWrite,
      options: {
        eventId: `${params.run_id}:event:${projectionRevisionForWrite + 1}`,
        eventType,
        eventIdempotencyKey: transition.eventIdempotencyKey || metadata.idempotency_key,
        eventPayloadHash: metadata.payload_hash,
        eventCreatedAt: metadata.created_at,
        allowSameState: transition.projectionAllowSameState ?? allowSameState,
        errorCode: transition.errorCode,
        nextAction: transition.nextAction,
      },
    });
  }
  await coordinator.completeFiveAgentArtifact({
    run_id: params.run_id,
    artifact_id: metadata.artifact_id,
    payload_hash: metadata.payload_hash,
    state: targetState,
    state_revision: doStateRevisionForWrite + 1,
    event_type: "artifact_committed",
    created_at: metadata.created_at,
    summary: {
      kind: metadata.kind,
      payload_hash: metadata.payload_hash,
      next_action: transition.nextAction || null,
      error_code: transition.errorCode || null,
    },
    next_action: transition.nextAction,
    error_code: transition.errorCode,
    revision_count: transition.revisionCount,
  });
  await verifyExactArtifactSet(env, coordinator, params, fullSet, fullSet.map(item => item.artifact_id), fullSet.map(item => item.artifact_id));
  return { ...metadata, doStateRevision: doStateRevisionForWrite + 1, projectionRevision: currentEvent ? projectionRevisionForWrite : projection.run.state_revision };
}

async function readTranscript(env: EditorialRuntimeEnv, input: FiveAgentWorkflowParams): Promise<{ ref: string; hash: string; length: number; text: string }> {
  if (!env.FILES_BUCKET) throw new EditorialRuntimeError("transcript_unavailable", "transcript storage is unavailable", 503);
  const object = await env.FILES_BUCKET.get(input.transcript_ref);
  if (!object) throw new EditorialRuntimeError("transcript_not_found", "transcript is unavailable", 404);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await object.arrayBuffer()); } catch { throw new EditorialRuntimeError("transcript_unavailable", "transcript could not be read", 503); }
  const actualHash = await sha256(bytes);
  if (actualHash !== input.transcript_hash) throw new EditorialRuntimeError("transcript_hash_mismatch", "transcript hash does not match", 409);
  const owner = object.customMetadata?.user_id;
  const workspace = object.customMetadata?.workspace_id;
  if (owner !== input.user_id || workspace !== input.workspace_id) throw new EditorialRuntimeError("transcript_owner_conflict", "transcript owner metadata is not exact", 403);
  return { ref: input.transcript_ref, hash: actualHash, length: bytes.byteLength, text: new TextDecoder().decode(bytes) };
}

async function startCoordinator(env: EditorialRuntimeEnv, params: FiveAgentRunInput): Promise<DurableObjectStub<EditorialCoordinatorAgent>> {
  const namespace = env.EDITORIAL_COORDINATOR;
  return namespace.getByName(await coordinatorShardName(params.user_id, params.workspace_id, params.article_id, params.run_id));
}

type StoredArtifactMetadata = ReturnType<typeof toArtifactMetadata> & {
  doStateRevision?: number;
  projectionRevision?: number;
};
type PreparedArtifactMetadata = StoredArtifactMetadata & { call_id: string };
type ArtifactSetIdentity = ReturnType<typeof toArtifactMetadata>;

function sameArtifactIdentity(actual: ArtifactSetIdentity, expected: ArtifactSetIdentity): boolean {
  return actual.schema_version === expected.schema_version && actual.artifact_id === expected.artifact_id &&
    actual.artifact_key === expected.artifact_key && actual.kind === expected.kind && actual.run_id === expected.run_id &&
    actual.article_id === expected.article_id && actual.recording_id === expected.recording_id &&
    actual.user_id === expected.user_id && actual.workspace_id === expected.workspace_id &&
    artifactCanonicalJson(actual.producer) === artifactCanonicalJson(expected.producer) &&
    actual.workflow_version === expected.workflow_version && actual.policy_version === expected.policy_version &&
    artifactCanonicalJson(actual.input_artifact_ids) === artifactCanonicalJson(expected.input_artifact_ids) &&
    actual.payload_hash === expected.payload_hash && actual.payload_length === expected.payload_length &&
    actual.idempotency_key === expected.idempotency_key && actual.storage_ref === expected.storage_ref &&
    actual.created_at === expected.created_at && artifactCanonicalJson(actual.skill_pins) === artifactCanonicalJson(expected.skill_pins);
}

async function verifyExactArtifactSet(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  expected: readonly ArtifactSetIdentity[],
  expectedReceiptIds: readonly string[],
  expectedEventIds: readonly string[] = expected.map(item => item.artifact_id),
): Promise<void> {
  const expectedIds = expected.map(item => item.artifact_id);
  if (new Set(expectedIds).size !== expectedIds.length) throw new EditorialRuntimeError("artifact_set_conflict", "Wave2B expected artifact set contains duplicates", 409);
  const ledger = await coordinator.getFiveAgentArtifactLedger(params.run_id, params.user_id, params.workspace_id);
  if (ledger.artifacts.length !== expected.length || ledger.receipt_ids.length !== expectedReceiptIds.length ||
      artifactCanonicalJson(ledger.receipt_ids.slice().sort()) !== artifactCanonicalJson(expectedReceiptIds.slice().sort())) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B DO artifact set is not exact", 503);
  }
  const expectedById = new Map(expected.map(item => [item.artifact_id, item]));
  const allowedDoEventTypes = new Set([
    "run_queued", "transcription_started", "transcript_ready", "writing_started", "draft_generated",
    "review_started", "reviewed", "revision_requested", "content_frozen", "needs_action", "failed",
    "artifact_committed",
  ]);
  const doEvents = await coordinator.listFiveAgentEvents(params.run_id, params.user_id, params.workspace_id);
  const doRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const doRevision = Number(doRun.state_revision);
  if (doEvents.length !== doRevision + 1 || doEvents.some((event, index) =>
      event.state_revision !== index || !allowedDoEventTypes.has(event.event_type))) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B DO event set is not exact", 503);
  }
  const doArtifactEvents = doEvents.filter(event => event.artifact_id !== null);
  const expectedDoArtifactIds = expectedEventIds.slice().sort();
  const actualDoArtifactIds = doArtifactEvents.map(event => event.artifact_id as string).sort();
  if (artifactCanonicalJson(actualDoArtifactIds) !== artifactCanonicalJson(expectedDoArtifactIds) ||
      doArtifactEvents.some(event => {
        const item = expectedById.get(String(event.artifact_id));
        return !item || event.payload_hash !== item.payload_hash;
      })) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B DO artifact event set is not exact", 503);
  }
  const startEvidence = await coordinator.getFiveAgentStartEvidence(params.run_id, params.workflow_id);
  const startEventTypes = new Set(["start_reconciliation_required", "start_reconciled", "workflow_start_confirmed"]);
  if (startEvidence.events.some(event => !startEventTypes.has(event.event_type)) ||
      new Set(startEvidence.events.map(event => event.idempotency_key)).size !== startEvidence.events.length ||
      new Set(startEvidence.events.map(event => event.evidence_hash)).size !== startEvidence.events.length) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B start event set is not exact", 503);
  }
  for (const artifact of ledger.artifacts) {
    const expectedItem = expectedById.get(artifact.artifact_id);
    if (!expectedItem) {
      throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B DO artifact identity does not reconcile", 503);
    }
    const expectedDoEnvelope = await coordinatorEnvelopeFromMetadata(expectedItem);
    if (artifactCanonicalJson(artifact) !== artifactCanonicalJson(expectedDoEnvelope)) {
      throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B DO artifact identity does not reconcile", 503);
    }
    const stored = await readArtifactFromR2(env, params, artifact.artifact_id, artifact.artifact_key, artifact.payload_hash);
    if (!sameArtifactIdentity(toArtifactMetadata(stored), expectedItem)) {
      throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B R2 artifact identity does not reconcile", 503);
    }
  }
  if (expected.length > 0) {
    const marker = "/artifacts/";
    const markerIndex = expected[0].artifact_key.indexOf(marker);
    if (markerIndex < 0) throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B artifact prefix is invalid", 503);
    const prefix = expected[0].artifact_key.slice(0, markerIndex + marker.length);
    const listedKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.FILES_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
      listedKeys.push(...page.objects.map(item => item.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const expectedKeys = expected.map(item => item.artifact_key).sort();
    if (artifactCanonicalJson(listedKeys.sort()) !== artifactCanonicalJson(expectedKeys)) {
      throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B R2 artifact set is not exact", 503);
    }
  }
  const rows = await env.DB.prepare(`SELECT artifact_id, run_id, article_id, recording_id, user_id, workspace_id,
      schema_version, kind, producer_agent_role, producer_agent_version, workflow_version, policy_version,
      input_artifact_ids_json, payload_hash, storage_ref, created_at, skill_id, skill_version
      FROM editorial_artifacts WHERE run_id = ? AND user_id = ? AND workspace_id = ?`).bind(
    params.run_id, params.user_id, params.workspace_id,
  ).all<Record<string, unknown>>();
  if ((rows.results || []).length !== expected.length) throw new EditorialRuntimeError("artifact_reconciliation_required", "D1 artifact set is not exact", 503);
  for (const row of rows.results || []) {
    const expectedItem = expectedById.get(String(row.artifact_id));
    const formatting = expectedItem?.skill_pins.formatting as { id?: string; version?: string } | undefined;
    if (!expectedItem || String(row.run_id) !== params.run_id || String(row.article_id) !== params.article_id ||
        Number(row.recording_id) !== params.recording_id || String(row.user_id) !== params.user_id ||
        String(row.workspace_id) !== params.workspace_id || String(row.schema_version) !== expectedItem.schema_version ||
        String(row.kind) !== expectedItem.kind || String(row.producer_agent_role) !== expectedItem.producer.role ||
        String(row.producer_agent_version) !== expectedItem.producer.version || String(row.workflow_version) !== expectedItem.workflow_version ||
        String(row.policy_version) !== expectedItem.policy_version || String(row.input_artifact_ids_json) !== artifactCanonicalJson(expectedItem.input_artifact_ids) ||
        String(row.payload_hash) !== expectedItem.payload_hash || String(row.storage_ref) !== expectedItem.storage_ref ||
        String(row.created_at) !== expectedItem.created_at ||
        String(row.skill_id || "") !== String(formatting?.id || "") || String(row.skill_version || "") !== String(formatting?.version || "")) {
      throw new EditorialRuntimeError("artifact_reconciliation_required", "D1 artifact set is not exact", 503);
    }
  }
  const expectedEvents = expected.filter(item => expectedEventIds.includes(item.artifact_id));
  const fullPublicationEvents = await env.DB.prepare(`SELECT event_id, revision, event_type, idempotency_key, payload_hash
      FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? ORDER BY revision ASC`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .all<{ event_id: string; revision: number; event_type: string; idempotency_key: string; payload_hash: string }>();
  const allowedPublicationEventTypes = new Set([
    "run_queued", "transcription_started", "transcript_ready", "writing_started", "draft_generated",
    "review_started", "review_pass", "review_revise", "review_block", "review_2_pass", "review_2_revise",
    "review_2_block", "revision_requested", "content_frozen", "needs_action", "failed", "start_reconciliation_required", "start_reconciled",
    "start_reconciliation_retrying", "start_reconciliation_queued", "workflow_start_confirmed", "action_retry", "action_cancel",
  ]);
  const currentProjection = await env.DB.prepare(`SELECT state_revision FROM publication_runs
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<{ state_revision: number }>();
  if (!currentProjection || fullPublicationEvents.results.length !== Number(currentProjection.state_revision) + 1 ||
      fullPublicationEvents.results.some((row, index) => Number(row.revision) !== index ||
        row.event_id !== `${params.run_id}:event:${row.revision}` || !allowedPublicationEventTypes.has(row.event_type))) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B publication event set is not exact", 503);
  }
  const artifactEvents = fullPublicationEvents.results.filter(row =>
    expectedEvents.some(item => item.idempotency_key === row.idempotency_key));
  const expectedEventKeys = expectedEvents.map(item => item.idempotency_key).sort();
  const actualEventKeys = artifactEvents.map(row => row.idempotency_key).sort();
  if (artifactCanonicalJson(actualEventKeys) !== artifactCanonicalJson(expectedEventKeys) || artifactEvents.some(row => {
    const item = expectedEvents.find(expectedItem => expectedItem.idempotency_key === row.idempotency_key);
    return !item || row.payload_hash !== item.payload_hash;
  })) {
    throw new EditorialRuntimeError("artifact_reconciliation_required", "Wave2B projection event set is not exact", 503);
  }
}

function wave2bRetryable(error: unknown): boolean {
  if (!(error instanceof InternalServiceError)) return false;
  if (error.status === 408 || error.status === 429) return true;
  return (error.status === 502 || error.status === 503 || error.status === 504) &&
    error.retryable &&
    (error.upstreamCode === undefined || error.upstreamCode === "upstream_retryable" || error.upstreamCode === "upstream_timeout" || error.upstreamCode === "service_temporarily_unavailable");
}

function fiveAgentCallId(runId: string, callKind: string, idempotencyKey: string, attempt: number): string {
  return `${runId}:call:${callKind}:${idempotencyKey}:attempt:${attempt}`;
}

async function recoverCompletedCallArtifact(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  callKind: string,
  idempotencyKey: string,
  attempt: number,
  artifactId: string,
  artifactKeyValue: string,
): Promise<StoredArtifactMetadata | null> {
  try {
    const object = await readArtifactFromR2(env, params, artifactId, artifactKeyValue);
    const metadata = toArtifactMetadata(object);
    await coordinator.completeFiveAgentCall({
      call_id: fiveAgentCallId(params.run_id, callKind, idempotencyKey, attempt),
      run_id: params.run_id,
      status: "succeeded",
      response_hash: metadata.payload_hash,
      artifact_id: metadata.artifact_id,
      recorded_at: metadata.created_at,
    });
    return metadata;
  } catch (error) {
    if (error instanceof EditorialRuntimeError && error.code === "artifact_not_found") return null;
    throw error;
  }
}

async function writeDraftThroughService(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  transcriptText: string,
  brief: ArtifactObject,
  createdAt: string,
): Promise<PreparedArtifactMetadata> {
  const briefPayload = brief.payload as ArticleBrief;
  const idempotencyKey = `draft:1:${brief.envelope.artifact_id}`;
  const artifactId = await deriveArtifactId("article_draft", params.run_id, idempotencyKey);
  const artifactKeyValue = artifactKey(params.user_id, params.workspace_id, params.run_id, "article_draft", artifactId);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let prepared: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>>;
    try {
      prepared = await coordinator.prepareFiveAgentCall({
        run_id: params.run_id,
        call_kind: "writing_initial",
        idempotency_key: idempotencyKey,
        attempt,
        created_at: createdAt,
      });
    } catch (error) {
      if (error instanceof EditorialRuntimeError && error.code === "external_side_effect_unknown") {
        const recovered = await recoverCompletedCallArtifact(env, coordinator, params, "writing_initial", idempotencyKey, attempt, artifactId, artifactKeyValue);
        if (recovered) return { ...recovered, call_id: fiveAgentCallId(params.run_id, "writing_initial", idempotencyKey, attempt) };
      }
      throw error;
    }
    if (prepared.status === "needs_action") {
      throw new EditorialRuntimeError(prepared.error_code || "external_side_effect_unknown", "writing adapter call requires reconciliation", 409);
    }
    if (prepared.status === "completed") {
      const recovered = await readArtifactFromR2(env, params, prepared.artifact_id || artifactId, artifactKeyValue, prepared.response_hash);
      return { ...toArtifactMetadata(recovered), call_id: prepared.call_id };
    }
    if (prepared.status === "failed") {
      if (prepared.retryable && attempt < 3) continue;
      throw new EditorialRuntimeError(
        prepared.error_code === "writing_adapter_retry_exhausted" ? "adapter_retry_exhausted" : "adapter_non_retryable",
        "writing adapter did not complete",
        503,
        prepared.attempt || attempt,
      );
    }
    try {
      const response = await callWritingAgentV3(env, {
        protocol_version: "vibepub.editorial.v3",
        job_id: `${params.run_id}:writing:1`,
        idempotency_key: idempotencyKey,
        mode: "initial",
        article_id: params.article_id,
        run_id: params.run_id,
        recording_id: params.recording_id,
        source_text: transcriptText,
        source_hash: params.source_hash,
        formatting_skill_id: briefPayload.profile_pins.formatting?.id,
        formatting_skill_version: briefPayload.profile_pins.formatting?.version,
        style_profile_id: briefPayload.profile_pins.style?.id,
        style_profile_version: briefPayload.profile_pins.style?.version,
        ...(briefPayload.style_profile_body === undefined ? {} : {
          style_profile_body: briefPayload.style_profile_body,
          style_profile_body_hash: briefPayload.style_profile_body_hash,
        }),
      });
      assertDraftResponseManifestPins(
        params,
        response.result,
        briefPayload.profile_pins,
        briefPayload.style_profile_body_hash,
      );
      const object = await normalizeArtifactEnvelope({
        artifact_id: artifactId,
        kind: "article_draft",
        run_id: params.run_id,
        article_id: params.article_id,
        recording_id: params.recording_id,
        user_id: params.user_id,
        workspace_id: params.workspace_id,
        producer: { role: "writing", version: PUBLICATION_AGENT_VERSIONS.writing },
        workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
        policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
        skill_pins: briefPayload.profile_pins,
        input_artifact_ids: [brief.envelope.artifact_id],
        idempotency_key: idempotencyKey,
        created_at: createdAt,
        payload: response.result,
      });
      assertDraftBeforePersistence(
        params,
        object,
        [brief.envelope.artifact_id],
        briefPayload.profile_pins,
        briefPayload.style_profile_body_hash,
      );
      const metadata = await prepareArtifactStorage(env, coordinator, params, object);
      return { ...metadata, call_id: prepared.call_id };
    } catch (error) {
      if (isPrePersistenceIntegrityError(error)) {
        return completePrePersistenceIntegrityCallAndThrow(
          coordinator,
          params,
          prepared,
          error.code,
          "writing",
          createdAt,
        );
      }
      if (isReconciliationHold(error)) {
        await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: createdAt });
        throw new EditorialRuntimeError("external_side_effect_unknown", "writing artifact persistence requires reconciliation", 503);
      }
      const retryable = wave2bRetryable(error);
      const errorCode = error instanceof InternalServiceError ? error.upstreamCode || error.code : error instanceof EditorialRuntimeError ? error.code : "adapter_invalid_response";
      await coordinator.completeFiveAgentCall({
        call_id: prepared.call_id,
        run_id: params.run_id,
        status: "failed",
        error_code: errorCode,
        retryable,
        recorded_at: createdAt,
      });
      if (retryable && attempt < 3) continue;
      if (retryable) throw new EditorialRuntimeError("adapter_retry_exhausted", "writing adapter retry limit exceeded", 503, attempt);
      if (error instanceof InternalServiceError || error instanceof Wave2ContractError) {
        throw new EditorialRuntimeError("adapter_non_retryable", "writing adapter response was not retryable", error instanceof InternalServiceError ? error.status : 502, attempt);
      }
      throw error;
    }
  }
  throw new EditorialRuntimeError("adapter_retry_exhausted", "writing adapter retry limit exceeded", 503, 3);
}

async function reviewThroughService(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  createdAt: string,
  reviewRound: 1 | 2 = 1,
): Promise<PreparedArtifactMetadata> {
  const draftPayload = draft.payload as ArticleDraft;
  const idempotencyKey = `review:${reviewRound}:${draft.envelope.artifact_id}`;
  const artifactId = await deriveArtifactId("review_report", params.run_id, idempotencyKey);
  const artifactKeyValue = artifactKey(params.user_id, params.workspace_id, params.run_id, "review_report", artifactId);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let prepared: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>>;
    try {
      prepared = await coordinator.prepareFiveAgentCall({ run_id: params.run_id, call_kind: `editorial_review_${reviewRound}`, idempotency_key: idempotencyKey, attempt, created_at: createdAt });
    } catch (error) {
      if (error instanceof EditorialRuntimeError && error.code === "external_side_effect_unknown") {
        const recovered = await recoverCompletedCallArtifact(env, coordinator, params, `editorial_review_${reviewRound}`, idempotencyKey, attempt, artifactId, artifactKeyValue);
        if (recovered) return { ...recovered, call_id: fiveAgentCallId(params.run_id, `editorial_review_${reviewRound}`, idempotencyKey, attempt) };
      }
      throw error;
    }
    if (prepared.status === "needs_action") {
      throw new EditorialRuntimeError(prepared.error_code || "external_side_effect_unknown", "review adapter call requires reconciliation", 409);
    }
    if (prepared.status === "completed") {
      const recovered = await readArtifactFromR2(env, params, prepared.artifact_id || artifactId, artifactKeyValue, prepared.response_hash);
      return { ...toArtifactMetadata(recovered), call_id: prepared.call_id };
    }
    if (prepared.status === "failed") {
      if (prepared.retryable && attempt < 3) continue;
      throw new EditorialRuntimeError(
        prepared.error_code === "review_adapter_retry_exhausted" ? "adapter_retry_exhausted" : "adapter_non_retryable",
        "review adapter did not complete",
        503,
        prepared.attempt || attempt,
      );
    }
    try {
      const response = await callReviewAgentV3(env, {
        protocol_version: "vibepub.editorial.review.v1",
        article_id: params.article_id,
        run_id: params.run_id,
        input_artifact_id: draft.envelope.artifact_id,
        input_payload_hash: draft.envelope.payload_hash,
        input_payload: draftPayload,
        recording_id: params.recording_id,
        review_round: reviewRound,
        title: draftPayload.title,
        body: draftPayload.body,
        blocks: draftPayload.blocks,
      });
      assertReviewRoundBeforePersistence(response.result, reviewRound);
      const object = await normalizeArtifactEnvelope({
        artifact_id: artifactId,
        kind: "review_report",
        run_id: params.run_id,
        article_id: params.article_id,
        recording_id: params.recording_id,
        user_id: params.user_id,
        workspace_id: params.workspace_id,
        producer: { role: "editorial_review", version: PUBLICATION_AGENT_VERSIONS.editorial_review },
        workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
        policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
        skill_pins: { review: PUBLICATION_SKILL_PINS.review },
        input_artifact_ids: [draft.envelope.artifact_id],
        idempotency_key: idempotencyKey,
        created_at: createdAt,
        payload: response.result,
      });
      const manifest = manifestForFrozen(params);
      assertReviewManifestPins(object, manifest);
      const metadata = await prepareArtifactStorage(env, coordinator, params, object);
      return { ...metadata, call_id: prepared.call_id };
    } catch (error) {
      if (isPrePersistenceIntegrityError(error)) {
        return completePrePersistenceIntegrityCallAndThrow(
          coordinator,
          params,
          prepared,
          error.code,
          "review",
          createdAt,
        );
      }
      if (isReconciliationHold(error)) {
        await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: createdAt });
        throw new EditorialRuntimeError("external_side_effect_unknown", "review artifact persistence requires reconciliation", 503);
      }
      const retryable = wave2bRetryable(error);
      const errorCode = error instanceof InternalServiceError ? error.upstreamCode || error.code : error instanceof EditorialRuntimeError ? error.code : "review_invalid_response";
      await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "failed", error_code: errorCode, retryable, recorded_at: createdAt });
      if (retryable && attempt < 3) continue;
      if (retryable) throw new EditorialRuntimeError("adapter_retry_exhausted", "review adapter retry limit exceeded", 503, attempt);
      if (error instanceof InternalServiceError || error instanceof Wave2ContractError) {
        throw new EditorialRuntimeError("adapter_non_retryable", "review adapter response was not retryable", error instanceof InternalServiceError ? error.status : 502, attempt);
      }
      throw error;
    }
  }
  throw new EditorialRuntimeError("adapter_retry_exhausted", "review adapter retry limit exceeded", 503, 3);
}

async function buildRevisionDispatch(
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  review: ArtifactObject,
  createdAt: string,
): Promise<ArtifactObject> {
  const draftPayload = draft.payload as ArticleDraft;
  const reviewPayload = review.payload as ReviewReport;
  if (reviewPayload.decision !== "revise") throw new EditorialRuntimeError("revision_dispatch_not_allowed", "only a revise review can create a dispatch", 409);
  const targets = [...new Set(reviewPayload.revision_targets)].sort();
  const targetBlockIds = targets.filter(target => target !== "@title");
  const protectedBlockHashes: Record<string, string> = {};
  for (const block of draftPayload.blocks) if (!targetBlockIds.includes(block.block_id)) protectedBlockHashes[block.block_id] = block.text_hash;
  if (!targets.includes("@title")) protectedBlockHashes["@title"] = await sha256(new TextEncoder().encode(draftPayload.title));
  const payload: RevisionDispatch = {
    article_id: params.article_id,
    run_id: params.run_id,
    recording_id: params.recording_id,
    source_draft_artifact_id: draft.envelope.artifact_id,
    source_draft_payload_hash: draft.envelope.payload_hash,
    source_review_artifact_id: review.envelope.artifact_id,
    source_review_payload_hash: review.envelope.payload_hash,
    target_block_ids: targetBlockIds,
    target: targets,
    issue_codes: reviewPayload.findings.filter(finding => finding.severity === "P1").map(finding => finding.code),
    protected_block_hashes: protectedBlockHashes,
    revision_limit: 1,
    instruction_text: reviewPayload.suggested_actions.join("; ") || "只修改审核标记的目标。",
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    producer_pins: [
      { id: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
      { id: "writing", version: PUBLICATION_AGENT_VERSIONS.writing },
      { id: "editorial_review", version: PUBLICATION_AGENT_VERSIONS.editorial_review },
    ],
  };
  const idempotencyKey = `revision-dispatch:${params.run_id}:${review.envelope.artifact_id}`;
  const artifactId = await deriveArtifactId("revision_dispatch", params.run_id, idempotencyKey);
  return normalizeArtifactEnvelope({
    artifact_id: artifactId,
    kind: "revision_dispatch",
    run_id: params.run_id,
    article_id: params.article_id,
    recording_id: params.recording_id,
    user_id: params.user_id,
    workspace_id: params.workspace_id,
    producer: { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    skill_pins: { writing: PUBLICATION_SKILL_PINS.writing, review: PUBLICATION_SKILL_PINS.review },
    input_artifact_ids: [draft.envelope.artifact_id, review.envelope.artifact_id],
    idempotency_key: idempotencyKey,
    created_at: createdAt,
    payload,
  });
}

function assertFrozenInputIdentity(
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  review: ArtifactObject,
  expectedReviewRound: 1 | 2,
): void {
  const manifest = manifestForFrozen(params);
  const identity = (object: ArtifactObject): boolean =>
    object.envelope.run_id === params.run_id &&
    object.envelope.article_id === params.article_id &&
    object.envelope.recording_id === params.recording_id &&
    object.envelope.user_id === params.user_id &&
    object.envelope.workspace_id === params.workspace_id &&
    object.envelope.workflow_version === FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION &&
    object.envelope.policy_version === FIVE_AGENT_PUBLISHING_POLICY_VERSION;
  if (!identity(draft) || !identity(review)) throw new EditorialRuntimeError("frozen_source_identity_conflict", "accepted artifacts do not match the run identity", 409);
  if (draft.envelope.producer.role !== "writing" || draft.envelope.producer.version !== PUBLICATION_AGENT_VERSIONS.writing ||
      review.envelope.producer.role !== "editorial_review" || review.envelope.producer.version !== PUBLICATION_AGENT_VERSIONS.editorial_review) {
    throw new EditorialRuntimeError("frozen_source_pin_conflict", "accepted producer pins are not active", 409);
  }
  if (draft.envelope.kind !== "article_draft" || review.envelope.kind !== "review_report") throw new EditorialRuntimeError("frozen_source_kind_conflict", "frozen input kinds are invalid", 409);
  const draftPayload = draft.payload as ArticleDraft;
  const reviewPayload = review.payload as ReviewReport;
  assertDraftManifestPins(draft, manifest);
  assertReviewManifestPins(review, manifest);
  if (reviewPayload.review_round !== expectedReviewRound) {
    throw new EditorialRuntimeError("frozen_review_round_conflict", "accepted review round does not match the freeze phase", 409);
  }
  if (expectedReviewRound === 1 && (draft.envelope.input_artifact_ids.length !== 1 || draft.envelope.input_artifact_ids[0] !== params.brief_artifact_id)) {
    throw new EditorialRuntimeError("frozen_brief_parent_conflict", "draft is not bound to the canonical brief", 409);
  }
  if (reviewPayload.decision !== "pass" || reviewPayload.findings.some(finding => finding.severity === "P0" || finding.severity === "P1")) {
    throw new EditorialRuntimeError("frozen_review_not_accepted", "only a clean passing review can freeze content", 409);
  }
  if (reviewPayload.input_artifact_id !== draft.envelope.artifact_id || reviewPayload.input_payload_hash !== draft.envelope.payload_hash ||
      review.envelope.input_artifact_ids.length !== 1 || review.envelope.input_artifact_ids[0] !== draft.envelope.artifact_id) {
    throw new EditorialRuntimeError("frozen_review_input_conflict", "review does not exactly accept the draft", 409);
  }
  if (draftPayload.article_id !== params.article_id || draftPayload.run_id !== params.run_id || draftPayload.recording_id !== params.recording_id ||
      draftPayload.formatting_skill.id !== PUBLICATION_SKILL_PINS.formatting.id || draftPayload.formatting_skill.version !== PUBLICATION_SKILL_PINS.formatting.version ||
      draft.envelope.skill_pins.formatting?.id !== PUBLICATION_SKILL_PINS.formatting.id || draft.envelope.skill_pins.formatting?.version !== PUBLICATION_SKILL_PINS.formatting.version) {
    throw new EditorialRuntimeError("frozen_draft_pin_conflict", "draft pins or identity are not active", 409);
  }
}

function assertFrozenRelatedIdentity(
  params: FiveAgentWorkflowParams,
  object: ArtifactObject,
  kind: ArtifactObject["envelope"]["kind"],
  role: string,
  version: string,
): void {
  const envelope = object.envelope;
  if (envelope.kind !== kind || envelope.producer.role !== role || envelope.producer.version !== version ||
      envelope.run_id !== params.run_id || envelope.article_id !== params.article_id ||
      envelope.recording_id !== params.recording_id || envelope.user_id !== params.user_id ||
      envelope.workspace_id !== params.workspace_id || envelope.workflow_version !== FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION ||
      envelope.policy_version !== FIVE_AGENT_PUBLISHING_POLICY_VERSION) {
    throw new EditorialRuntimeError("frozen_parent_identity_conflict", "frozen parent artifact identity is not exact", 409);
  }
}

function assertFrozenDraftEquality(draft: ArticleDraft, frozen: FrozenArticleVersion): void {
  const fields: Array<keyof ArticleDraft> = [
    "title", "body", "blocks", "title_candidates", "selected_title", "cover_title",
    "claim_ledger", "content_hash", "formatting_skill", "profile_pins",
  ];
  for (const field of fields) {
    if (artifactCanonicalJson(draft[field]) !== artifactCanonicalJson(frozen[field as keyof FrozenArticleVersion])) {
      throw new EditorialRuntimeError("frozen_snapshot_conflict", `frozen field ${String(field)} differs from the accepted draft`, 409);
    }
  }
}

function assertFrozenRevisionChain(
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  parentDraft: ArtifactObject,
  parentReview: ArtifactObject,
  dispatch: ArtifactObject,
  parentArtifactId: string | null,
): void {
  assertFrozenRelatedIdentity(params, parentDraft, "article_draft", "writing", PUBLICATION_AGENT_VERSIONS.writing);
  assertFrozenRelatedIdentity(params, parentReview, "review_report", "editorial_review", PUBLICATION_AGENT_VERSIONS.editorial_review);
  assertFrozenRelatedIdentity(params, dispatch, "revision_dispatch", "editorial_coordinator", PUBLICATION_AGENT_VERSIONS.editorial_coordinator);
  const manifest = manifestForFrozen(params);
  assertDraftManifestPins(parentDraft, manifest);
  assertReviewManifestPins(parentReview, manifest);
  assertDraftManifestPins(draft, manifest);
  const draftPayload = draft.payload as ArticleDraft;
  const parentDraftPayload = parentDraft.payload as ArticleDraft;
  const parentReviewPayload = parentReview.payload as ReviewReport;
  const dispatchPayload = dispatch.payload as RevisionDispatch;
  if (draftPayload.revision !== 2 || parentArtifactId !== parentDraft.envelope.artifact_id ||
      draftPayload.parent_artifact_id !== parentDraft.envelope.artifact_id ||
      draftPayload.parent_review_artifact_id !== parentReview.envelope.artifact_id ||
      draftPayload.parent_dispatch_artifact_id !== dispatch.envelope.artifact_id ||
      artifactCanonicalJson(draft.envelope.input_artifact_ids) !== artifactCanonicalJson([
        parentDraft.envelope.artifact_id, parentReview.envelope.artifact_id, dispatch.envelope.artifact_id,
      ])) throw new EditorialRuntimeError("frozen_parent_chain_conflict", "revision draft parent chain is not exact", 409);
  if (parentDraftPayload.revision !== 1 || parentDraftPayload.parent_artifact_id !== null ||
      parentDraft.envelope.input_artifact_ids.length !== 1 || parentDraft.envelope.input_artifact_ids[0] !== params.brief_artifact_id ||
      parentReviewPayload.review_round !== 1 || parentReviewPayload.decision !== "revise" ||
      parentReviewPayload.findings.some(finding => finding.severity === "P0") ||
      !parentReviewPayload.findings.some(finding => finding.severity === "P1") ||
      parentReviewPayload.input_artifact_id !== parentDraft.envelope.artifact_id ||
      parentReviewPayload.input_payload_hash !== parentDraft.envelope.payload_hash ||
      parentReview.envelope.input_artifact_ids.length !== 1 ||
      parentReview.envelope.input_artifact_ids[0] !== parentDraft.envelope.artifact_id) {
    throw new EditorialRuntimeError("frozen_parent_review_conflict", "revision parent review is not an exact first-round revise", 409);
  }
  if (artifactCanonicalJson((draft.payload as ArticleDraft).profile_pins) !== artifactCanonicalJson(parentDraftPayload.profile_pins) ||
      (draft.payload as ArticleDraft).adapter_version !== parentDraftPayload.adapter_version ||
      (draft.payload as ArticleDraft).model_version !== parentDraftPayload.model_version ||
      (draft.payload as ArticleDraft).style_profile_body_hash !== parentDraftPayload.style_profile_body_hash) {
    throw new EditorialRuntimeError("frozen_revision_pin_conflict", "revision draft pins drifted from the parent draft", 409);
  }
  if (dispatch.envelope.input_artifact_ids.length !== 2 ||
      artifactCanonicalJson(dispatch.envelope.input_artifact_ids) !== artifactCanonicalJson([
        parentDraft.envelope.artifact_id, parentReview.envelope.artifact_id,
      ]) || dispatchPayload.source_draft_artifact_id !== parentDraft.envelope.artifact_id ||
      dispatchPayload.source_draft_payload_hash !== parentDraft.envelope.payload_hash ||
      dispatchPayload.source_review_artifact_id !== parentReview.envelope.artifact_id ||
      dispatchPayload.source_review_payload_hash !== parentReview.envelope.payload_hash || dispatchPayload.revision_limit !== 1 ||
      artifactCanonicalJson(dispatchPayload.producer_pins) !== artifactCanonicalJson([
        { id: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
        { id: "writing", version: PUBLICATION_AGENT_VERSIONS.writing },
        { id: "editorial_review", version: PUBLICATION_AGENT_VERSIONS.editorial_review },
      ])) {
    throw new EditorialRuntimeError("frozen_dispatch_chain_conflict", "revision dispatch is not exactly bound to its parents", 409);
  }
}

async function writeRevisionThroughService(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  review: ArtifactObject,
  dispatch: ArtifactObject,
  createdAt: string,
): Promise<PreparedArtifactMetadata> {
  const draftPayload = draft.payload as ArticleDraft;
  const idempotencyKey = `draft:2:${dispatch.envelope.artifact_id}`;
  const artifactId = await deriveArtifactId("article_draft", params.run_id, idempotencyKey);
  const artifactKeyValue = artifactKey(params.user_id, params.workspace_id, params.run_id, "article_draft", artifactId);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let prepared: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>>;
    try {
      prepared = await coordinator.prepareFiveAgentCall({ run_id: params.run_id, call_kind: "writing_revision", idempotency_key: idempotencyKey, attempt, created_at: createdAt });
    } catch (error) {
      if (error instanceof EditorialRuntimeError && error.code === "external_side_effect_unknown") {
        const recovered = await recoverCompletedCallArtifact(env, coordinator, params, "writing_revision", idempotencyKey, attempt, artifactId, artifactKeyValue);
        if (recovered) return { ...recovered, call_id: fiveAgentCallId(params.run_id, "writing_revision", idempotencyKey, attempt) };
      }
      throw error;
    }
    if (prepared.status === "needs_action") throw new EditorialRuntimeError(prepared.error_code || "external_side_effect_unknown", "writing revision requires reconciliation", 409);
    if (prepared.status === "completed") {
      const recovered = await readArtifactFromR2(env, params, prepared.artifact_id || artifactId, artifactKeyValue, prepared.response_hash);
      return { ...toArtifactMetadata(recovered), call_id: prepared.call_id };
    }
    if (prepared.status === "failed") {
      if (prepared.retryable && attempt < 3) continue;
      throw new EditorialRuntimeError(
        prepared.error_code === "writing_adapter_retry_exhausted" ? "adapter_retry_exhausted" : "adapter_non_retryable",
        "writing revision did not complete",
        503,
        prepared.attempt || attempt,
      );
    }
    try {
      const response = await callWritingAgentV3(env, {
        protocol_version: "vibepub.editorial.v3",
        job_id: `${params.run_id}:writing:2`,
        idempotency_key: idempotencyKey,
        mode: "revision",
        article_id: params.article_id,
        run_id: params.run_id,
        recording_id: params.recording_id,
        source_hash: draftPayload.source_hash,
        current_draft: { artifact_id: draft.envelope.artifact_id, payload_hash: draft.envelope.payload_hash, payload: draftPayload },
        review_report: { artifact_id: review.envelope.artifact_id, payload_hash: review.envelope.payload_hash, payload: review.payload },
        revision_dispatch: { artifact_id: dispatch.envelope.artifact_id, payload_hash: dispatch.envelope.payload_hash, payload: dispatch.payload },
        formatting_skill_id: draftPayload.formatting_skill.id,
        formatting_skill_version: draftPayload.formatting_skill.version,
        style_profile_id: draftPayload.profile_pins.style?.id,
        style_profile_version: draftPayload.profile_pins.style?.version,
      });
      assertDraftResponseManifestPins(
        params,
        response.result,
        draftPayload.profile_pins,
        draftPayload.style_profile_body_hash,
      );
      const object = await normalizeArtifactEnvelope({
        artifact_id: artifactId,
        kind: "article_draft",
        run_id: params.run_id,
        article_id: params.article_id,
        recording_id: params.recording_id,
        user_id: params.user_id,
        workspace_id: params.workspace_id,
        producer: { role: "writing", version: PUBLICATION_AGENT_VERSIONS.writing },
        workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
        policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
        skill_pins: draftPayload.profile_pins,
        input_artifact_ids: [draft.envelope.artifact_id, review.envelope.artifact_id, dispatch.envelope.artifact_id],
        idempotency_key: idempotencyKey,
        created_at: createdAt,
        payload: response.result,
      });
      assertDraftBeforePersistence(
        params,
        object,
        [draft.envelope.artifact_id, review.envelope.artifact_id, dispatch.envelope.artifact_id],
        draftPayload.profile_pins,
        draftPayload.style_profile_body_hash,
      );
      const metadata = await prepareArtifactStorage(env, coordinator, params, object);
      return { ...metadata, call_id: prepared.call_id };
    } catch (error) {
      if (isPrePersistenceIntegrityError(error)) {
        return completePrePersistenceIntegrityCallAndThrow(
          coordinator,
          params,
          prepared,
          error.code,
          "writing",
          createdAt,
        );
      }
      if (isReconciliationHold(error)) {
        await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: createdAt });
        throw new EditorialRuntimeError("external_side_effect_unknown", "revision artifact persistence requires reconciliation", 503);
      }
      const retryable = wave2bRetryable(error);
      const errorCode = error instanceof InternalServiceError ? error.upstreamCode || error.code : error instanceof EditorialRuntimeError ? error.code : "adapter_invalid_response";
      await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "failed", error_code: errorCode, retryable, recorded_at: createdAt });
      if (retryable && attempt < 3) continue;
      if (retryable) throw new EditorialRuntimeError("adapter_retry_exhausted", "writing revision retry limit exceeded", 503, attempt);
      if (error instanceof InternalServiceError || error instanceof Wave2ContractError) {
        throw new EditorialRuntimeError("adapter_non_retryable", "writing revision response was not retryable", error instanceof InternalServiceError ? error.status : 502, attempt);
      }
      throw error;
    }
  }
  throw new EditorialRuntimeError("adapter_retry_exhausted", "writing revision retry limit exceeded", 503, 3);
}

async function buildFrozenFromAccepted(
  params: FiveAgentWorkflowParams,
  draft: ArtifactObject,
  review: ArtifactObject,
  createdAt: string,
  version: 1 | 2 = 1,
  parentArtifactId: string | null = null,
  revisionChain?: { parentDraft: ArtifactObject; parentReview: ArtifactObject; dispatch: ArtifactObject },
): Promise<ArtifactObject> {
  assertFrozenInputIdentity(params, draft, review, version);
  const draftPayload = draft.payload as ArticleDraft;
  if (version === 1) {
    if (draftPayload.revision !== 1 || draftPayload.parent_artifact_id !== null || draftPayload.parent_review_artifact_id !== null || draftPayload.parent_dispatch_artifact_id !== null || draft.envelope.input_artifact_ids.length !== 1) {
      throw new EditorialRuntimeError("frozen_initial_chain_conflict", "initial frozen draft chain is invalid", 409);
    }
  } else {
    if (!revisionChain) throw new EditorialRuntimeError("frozen_parent_chain_conflict", "revision frozen content requires its full parent chain", 409);
    assertFrozenRevisionChain(params, draft, revisionChain.parentDraft, revisionChain.parentReview, revisionChain.dispatch, parentArtifactId);
  }
  const payload: FrozenArticleVersion = {
    article_id: params.article_id,
    run_id: params.run_id,
    recording_id: params.recording_id,
    version,
    parent_artifact_id: parentArtifactId,
    draft_artifact_id: draft.envelope.artifact_id,
    review_artifact_id: review.envelope.artifact_id,
    title: draftPayload.title,
    body: draftPayload.body,
    blocks: draftPayload.blocks,
    title_candidates: draftPayload.title_candidates,
    selected_title: draftPayload.selected_title,
    cover_title: draftPayload.cover_title,
    claim_ledger: draftPayload.claim_ledger,
    content_hash: draftPayload.content_hash,
    formatting_skill: draftPayload.formatting_skill,
    html_hash: null,
    warnings: [],
    immutable: true,
    frozen_at: createdAt,
    accepted_draft_payload_hash: draft.envelope.payload_hash,
    accepted_review_payload_hash: review.envelope.payload_hash,
    profile_pins: draftPayload.profile_pins,
  };
  assertFrozenDraftEquality(draftPayload, payload);
  const idempotencyKey = `frozen:${version}:${draft.envelope.artifact_id}:${review.envelope.artifact_id}`;
  const artifactId = await deriveArtifactId("frozen_article_version", params.run_id, idempotencyKey);
  return normalizeArtifactEnvelope({
    artifact_id: artifactId,
    kind: "frozen_article_version",
    run_id: params.run_id,
    article_id: params.article_id,
    recording_id: params.recording_id,
    user_id: params.user_id,
    workspace_id: params.workspace_id,
    producer: { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    skill_pins: draftPayload.profile_pins,
    input_artifact_ids: [draft.envelope.artifact_id, review.envelope.artifact_id],
    idempotency_key: idempotencyKey,
    created_at: createdAt,
    payload,
  });
}

export class FiveAgentPublishingWorkflow extends AgentWorkflow<EditorialCoordinatorAgent, FiveAgentWorkflowParams, FiveAgentWorkflowResult, EditorialRuntimeEnv> {
  async run(event: AgentWorkflowEvent<FiveAgentWorkflowParams>, step: AgentWorkflowStep): Promise<FiveAgentWorkflowResult> {
    const params = event.payload;
    const retry = { retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const };
    const coordinator = this.agent;
    await step.do("workflow-start-confirmation", retry, async () => {
      const confirmation = await coordinator.getFiveAgentWorkflowStartConfirmation({
        run_id: params.run_id,
        workflow_id: params.workflow_id,
        article_id: params.article_id,
        recording_id: params.recording_id,
        user_id: params.user_id,
        workspace_id: params.workspace_id,
        payload_hash: params.payload_hash,
        manifest_hash: params.manifest_hash,
      });
      if (!confirmation.confirmed) {
        throw new EditorialRuntimeError("workflow_start_unconfirmed", "Wave2B workflow start confirmation is not durable yet", 503);
      }
      return { run_id: params.run_id, workflow_id: params.workflow_id, event_id: confirmation.event_id };
    });
    const transcript = await step.do("transcript-verify", retry, async () => {
      const value = await readTranscript(this.env, params);
      return { ref: value.ref, hash: value.hash, length: value.length };
    });
    const currentDoRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown> | null;
    if (!currentDoRun || currentDoRun.state !== "queued" || Number(currentDoRun.state_revision) < 0) {
      throw new EditorialRuntimeError("workflow_start_state_conflict", "Wave2B workflow must start from the durable queued run", 409);
    }
    const currentProjection = await this.env.DB.prepare(`SELECT state, state_revision, user_id, workspace_id
      FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id)
      .first<{ state: string; state_revision: number; user_id: string; workspace_id: string }>();
    if (!currentProjection || currentProjection.state !== "queued" ||
        currentProjection.user_id !== params.user_id || currentProjection.workspace_id !== params.workspace_id) {
      throw new EditorialRuntimeError("workflow_start_state_conflict", "Wave2B publication must start from the durable queued projection", 409);
    }
    let doStateRevision = Number(currentDoRun.state_revision);
    let projectionRevision = Number(currentProjection.state_revision);
    const transcribing = await step.do("state-transcribing", retry, () => applySystemState(
      this.env, coordinator, params, "transcribing", "transcription_started", doStateRevision, projectionRevision, 1, 1,
    ));
    doStateRevision = transcribing.doStateRevision;
    projectionRevision = transcribing.projectionRevision;
    const briefCommit = await step.do("commit-brief", retry, async () => {
      const brief = await readArtifactFromR2(this.env, params, params.brief_artifact_id, params.brief_artifact_key, params.brief_payload_hash);
      return persistArtifact(this.env, coordinator, params, brief, "transcript_ready", "transcript_ready", doStateRevision, projectionRevision);
    });
    doStateRevision = briefCommit.doStateRevision;
    projectionRevision = briefCommit.projectionRevision;
    const writing = await step.do("state-writing", retry, () => applySystemState(
      this.env, coordinator, params, "writing", "writing_started", doStateRevision, projectionRevision, 2, 1,
    ));
    doStateRevision = writing.doStateRevision;
    projectionRevision = writing.projectionRevision;
    const draftPrepared = await step.do("write-draft-1", retry, async () => {
      try {
        const transcriptValue = await readTranscript(this.env, params);
        const brief = await readArtifactFromR2(this.env, params, briefCommit.artifact_id, briefCommit.artifact_key, briefCommit.payload_hash);
        return await writeDraftThroughService(this.env, coordinator, params, transcriptValue.text, brief, workflowTimestamp(params.created_at, 3_000));
      } catch (error) {
        if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 3, transcript, [briefCommit.artifact_id]);
        if (!isAdapterFailure(error)) throw error;
        return failAdapterRun(this.env, coordinator, params, doStateRevision, projectionRevision, 3, transcript, [briefCommit.artifact_id], error, "writing");
      }
    });
    if ("state" in draftPrepared) return draftPrepared;
    const draft = await step.do("commit-draft", retry, async () => {
      try {
        const draftObject = await readArtifactFromR2(this.env, params, draftPrepared.artifact_id, draftPrepared.artifact_key, draftPrepared.payload_hash);
        const persisted = await persistArtifact(this.env, coordinator, params, draftObject, "draft_generated", "draft_generated", doStateRevision, projectionRevision, false, {
          expectedArtifactSet: [briefCommit],
        });
        await coordinator.completeFiveAgentCall({ call_id: draftPrepared.call_id, run_id: params.run_id, status: "succeeded", response_hash: persisted.payload_hash, artifact_id: persisted.artifact_id, recorded_at: workflowTimestamp(params.created_at, 3_000) });
        return { ...draftPrepared, ...persisted };
      } catch (error) {
        if (isReconciliationHold(error)) {
          await coordinator.completeFiveAgentCall({ call_id: draftPrepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: workflowTimestamp(params.created_at, 3_000) });
          return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 3, transcript, [briefCommit.artifact_id]);
        }
        throw error;
      }
    });
    if ("state" in draft) return draft;
    doStateRevision = draft.doStateRevision;
    projectionRevision = draft.projectionRevision;
    const reviewing = await step.do("state-reviewing", retry, () => applySystemState(
      this.env, coordinator, params, "reviewing", "review_started", doStateRevision, projectionRevision, 4, 1,
    ));
    doStateRevision = reviewing.doStateRevision;
    projectionRevision = reviewing.projectionRevision;
    const reviewPrepared = await step.do("review-1", retry, async () => {
      try {
        const draftObject = await readArtifactFromR2(this.env, params, draft.artifact_id, draft.artifact_key, draft.payload_hash);
        return await reviewThroughService(this.env, coordinator, params, draftObject, workflowTimestamp(params.created_at, 5_000));
      } catch (error) {
        if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 5, transcript, [briefCommit.artifact_id, draft.artifact_id]);
        if (!isAdapterFailure(error)) throw error;
        return failAdapterRun(this.env, coordinator, params, doStateRevision, projectionRevision, 5, transcript, [briefCommit.artifact_id, draft.artifact_id], error, "review");
      }
    });
    if ("state" in reviewPrepared) return reviewPrepared;
    const review = await step.do("commit-review", retry, async () => {
      try {
        const reviewObject = await readArtifactFromR2(this.env, params, reviewPrepared.artifact_id, reviewPrepared.artifact_key, reviewPrepared.payload_hash);
        const reviewPayload = reviewObject.payload as ReviewReport;
        const targetState = reviewPayload.decision === "pass" ? "reviewed" : reviewPayload.decision === "revise" ? "revising" : "needs_action";
        const persisted = await persistArtifact(this.env, coordinator, params, reviewObject, targetState, `review_${reviewPayload.decision}`, doStateRevision, projectionRevision, false, {
          ...(targetState === "needs_action" ? {
            errorCode: "review_round_1_blocked",
            nextAction: "review_round_1_human_review",
          } : {}),
          expectedArtifactSet: [briefCommit, draft],
        });
        await coordinator.completeFiveAgentCall({ call_id: reviewPrepared.call_id, run_id: params.run_id, status: "succeeded", response_hash: persisted.payload_hash, artifact_id: persisted.artifact_id, recorded_at: workflowTimestamp(params.created_at, 5_000) });
        return { ...reviewPrepared, ...persisted, decision: reviewPayload.decision, p0: reviewPayload.findings.filter(finding => finding.severity === "P0").length, p1: reviewPayload.findings.filter(finding => finding.severity === "P1").length };
      } catch (error) {
        if (isReconciliationHold(error)) {
          await coordinator.completeFiveAgentCall({ call_id: reviewPrepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: workflowTimestamp(params.created_at, 5_000) });
          return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 5, transcript, [briefCommit.artifact_id, draft.artifact_id]);
        }
        throw error;
      }
    });
    if ("state" in review) return review;
    doStateRevision = review.doStateRevision;
    projectionRevision = review.projectionRevision;
    const reviewDecision = { decision: review.decision, p0: review.p0, p1: review.p1 };
    if (reviewDecision.decision === "block") {
      return { run_id: params.run_id, state: "needs_action", state_revision: review.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [briefCommit.artifact_id, draft.artifact_id, review.artifact_id] };
    }
    if (reviewDecision.decision === "revise") {
      const dispatch = await step.do("commit-revision-dispatch", retry, async () => {
        try {
          const draftObject = await readArtifactFromR2(this.env, params, draft.artifact_id, draft.artifact_key, draft.payload_hash);
          const reviewObject = await readArtifactFromR2(this.env, params, review.artifact_id, review.artifact_key, review.payload_hash);
          const object = await buildRevisionDispatch(params, draftObject, reviewObject, workflowTimestamp(params.created_at, 6_000));
          return await persistArtifact(this.env, coordinator, params, object, "revising", "revision_requested", doStateRevision, projectionRevision, true, {
            expectedArtifactSet: [briefCommit, draft, review],
          });
        } catch (error) {
          if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 6, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id]);
          throw error;
        }
      });
      if ("state" in dispatch) return dispatch;
      doStateRevision = dispatch.doStateRevision;
      projectionRevision = dispatch.projectionRevision;
      const writing2 = await step.do("state-writing-2", retry, () => applySystemState(
        this.env, coordinator, params, "writing", "writing_started", doStateRevision, projectionRevision, 6_500, 2,
        { revisionCount: 1, projectionTargetState: "revising", projectionAllowSameState: true },
      ));
      doStateRevision = writing2.doStateRevision;
      projectionRevision = writing2.projectionRevision;
      const draft2Prepared = await step.do("write-draft-2", retry, async () => {
        try {
          const draftObject = await readArtifactFromR2(this.env, params, draft.artifact_id, draft.artifact_key, draft.payload_hash);
          const reviewObject = await readArtifactFromR2(this.env, params, review.artifact_id, review.artifact_key, review.payload_hash);
          const dispatchObject = await readArtifactFromR2(this.env, params, dispatch.artifact_id, dispatch.artifact_key, dispatch.payload_hash);
          return await writeRevisionThroughService(this.env, coordinator, params, draftObject, reviewObject, dispatchObject, workflowTimestamp(params.created_at, 7_000));
        } catch (error) {
          if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 7, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id]);
          if (!isAdapterFailure(error)) throw error;
          return failAdapterRun(this.env, coordinator, params, doStateRevision, projectionRevision, 7, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id], error, "writing");
        }
      });
      if ("state" in draft2Prepared) return draft2Prepared;
      const draft2 = await step.do("commit-draft-2", retry, async () => {
        try {
          const draftObject = await readArtifactFromR2(this.env, params, draft2Prepared.artifact_id, draft2Prepared.artifact_key, draft2Prepared.payload_hash);
          const persisted = await persistArtifact(this.env, coordinator, params, draftObject, "draft_generated", "draft_generated", doStateRevision, projectionRevision, false, {
            revisionCount: 1,
            projectionTargetState: "revising",
            projectionAllowSameState: true,
            expectedArtifactSet: [briefCommit, draft, review, dispatch],
          });
          await coordinator.completeFiveAgentCall({ call_id: draft2Prepared.call_id, run_id: params.run_id, status: "succeeded", response_hash: persisted.payload_hash, artifact_id: persisted.artifact_id, recorded_at: workflowTimestamp(params.created_at, 7_000) });
          return { ...draft2Prepared, ...persisted };
        } catch (error) {
          if (isReconciliationHold(error)) {
            await coordinator.completeFiveAgentCall({ call_id: draft2Prepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: workflowTimestamp(params.created_at, 7_000) });
            return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 7, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id]);
          }
          throw error;
        }
      });
      if ("state" in draft2) return draft2;
      doStateRevision = draft2.doStateRevision;
      projectionRevision = draft2.projectionRevision;
      const reviewing2 = await step.do("state-reviewing-2", retry, () => applySystemState(
        this.env, coordinator, params, "reviewing", "review_started", doStateRevision, projectionRevision, 8_500, 2,
      ));
      doStateRevision = reviewing2.doStateRevision;
      projectionRevision = reviewing2.projectionRevision;
      const review2Prepared = await step.do("review-2", retry, async () => {
        try {
          const draftObject = await readArtifactFromR2(this.env, params, draft2.artifact_id, draft2.artifact_key, draft2.payload_hash);
          return await reviewThroughService(this.env, coordinator, params, draftObject, workflowTimestamp(params.created_at, 9_000), 2);
        } catch (error) {
          if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 9, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id]);
          if (!isAdapterFailure(error)) throw error;
          return failAdapterRun(this.env, coordinator, params, doStateRevision, projectionRevision, 9, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id], error, "review");
        }
      });
      if ("state" in review2Prepared) return review2Prepared;
      const review2 = await step.do("commit-review-2", retry, async () => {
        try {
          const reviewObject = await readArtifactFromR2(this.env, params, review2Prepared.artifact_id, review2Prepared.artifact_key, review2Prepared.payload_hash);
          const payload = reviewObject.payload as ReviewReport;
          const targetState = payload.decision === "pass" ? "reviewed" : "needs_action";
          const persisted = await persistArtifact(this.env, coordinator, params, reviewObject, targetState, `review_2_${payload.decision}`, doStateRevision, projectionRevision, false, {
            ...(targetState === "needs_action" ? {
              errorCode: "review_round_2_blocked",
              nextAction: "review_round_2_human_review",
            } : {}),
            expectedArtifactSet: [briefCommit, draft, review, dispatch, draft2],
          });
          await coordinator.completeFiveAgentCall({ call_id: review2Prepared.call_id, run_id: params.run_id, status: "succeeded", response_hash: persisted.payload_hash, artifact_id: persisted.artifact_id, recorded_at: workflowTimestamp(params.created_at, 9_000) });
          return { ...review2Prepared, ...persisted, decision: payload.decision, p0: payload.findings.filter(finding => finding.severity === "P0").length, p1: payload.findings.filter(finding => finding.severity === "P1").length };
        } catch (error) {
          if (isReconciliationHold(error)) {
            await coordinator.completeFiveAgentCall({ call_id: review2Prepared.call_id, run_id: params.run_id, status: "needs_action", error_code: "external_side_effect_unknown", retryable: false, recorded_at: workflowTimestamp(params.created_at, 9_000) });
            return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 9, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id]);
          }
          throw error;
        }
      });
      if ("state" in review2) return review2;
      if (review2.decision !== "pass") return { run_id: params.run_id, state: "needs_action", state_revision: review2.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id, review2.artifact_id] };
      doStateRevision = review2.doStateRevision;
      projectionRevision = review2.projectionRevision;
      const frozen2 = await step.do("freeze-content-2", retry, async () => {
        try {
          const draftObject = await readArtifactFromR2(this.env, params, draft2.artifact_id, draft2.artifact_key, draft2.payload_hash);
          const reviewObject = await readArtifactFromR2(this.env, params, review2.artifact_id, review2.artifact_key, review2.payload_hash);
          const parentDraft = await readArtifactFromR2(this.env, params, draft.artifact_id, draft.artifact_key, draft.payload_hash);
          const parentReview = await readArtifactFromR2(this.env, params, review.artifact_id, review.artifact_key, review.payload_hash);
          const dispatchObject = await readArtifactFromR2(this.env, params, dispatch.artifact_id, dispatch.artifact_key, dispatch.payload_hash);
          const object = await buildFrozenFromAccepted(
            params,
            draftObject,
            reviewObject,
            workflowTimestamp(params.created_at, 10_000),
            2,
            draft.artifact_id,
            { parentDraft, parentReview, dispatch: dispatchObject },
          );
          return await persistArtifact(this.env, coordinator, params, object, "content_frozen", "content_frozen", doStateRevision, projectionRevision, false, {
            expectedArtifactSet: [briefCommit, draft, review, dispatch, draft2, review2],
          });
        } catch (error) {
          if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 10, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id, review2.artifact_id]);
          throw error;
        }
      });
      if ("state" in frozen2) return frozen2;
      return { run_id: params.run_id, state: "content_frozen", state_revision: frozen2.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id, review2.artifact_id, frozen2.artifact_id] };
    }
    const frozen = await step.do("freeze-content", retry, async () => {
      try {
        const draftObject = await readArtifactFromR2(this.env, params, draft.artifact_id, draft.artifact_key, draft.payload_hash);
        const reviewObject = await readArtifactFromR2(this.env, params, review.artifact_id, review.artifact_key, review.payload_hash);
        const object = await buildFrozenFromAccepted(params, draftObject, reviewObject, workflowTimestamp(params.created_at, 6_000));
        return await persistArtifact(this.env, coordinator, params, object, "content_frozen", "content_frozen", doStateRevision, projectionRevision, false, {
          expectedArtifactSet: [briefCommit, draft, review],
        });
      } catch (error) {
        if (isReconciliationHold(error)) return holdForReconciliation(this.env, coordinator, params, doStateRevision, projectionRevision, 6, transcript, [briefCommit.artifact_id, draft.artifact_id, review.artifact_id]);
        throw error;
      }
    });
    if ("state" in frozen) return frozen;
    return {
      run_id: params.run_id,
      state: "content_frozen",
      state_revision: frozen.doStateRevision,
      transcript_ref: transcript.ref,
      transcript_hash: transcript.hash,
      artifact_ids: [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, frozen.artifact_id],
    };
  }
}

export async function handleFiveAgentPublishingInternalRoute(
  request: Request,
  env: EditorialRuntimeEnv,
  url: URL,
): Promise<Response> {
  let userId = "";
  let workspaceId = "";
  try {
    userId = id(request.headers.get("x-vibepub-user-id") || "", "x-vibepub-user-id");
    workspaceId = id(request.headers.get("x-vibepub-workspace-id") || "", "x-vibepub-workspace-id");
  } catch (error) { return errorResponse(error); }
  if (!publicationFeatureEnabled(env, userId, workspaceId)) return Response.json({ error: "editorial_workflow_disabled" }, { status: 404 });

  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (request.method === "POST" && parts.length === 5 && parts[4] === "runs") {
      const body = normalizeFiveAgentStartBody(await parseRequestJson(request));
      const existingCanonical = await env.DB.prepare(`SELECT user_id, workspace_id, article_id, recording_id, created_at
        FROM editorial_runs WHERE run_id = ? LIMIT 1`).bind(body.run_id).first<{
          user_id: string; workspace_id: string; article_id: string; recording_id: number; created_at: string;
        }>();
      const createdAt = existingCanonical && existingCanonical.user_id === userId &&
        existingCanonical.workspace_id === workspaceId && existingCanonical.article_id === body.article_id &&
        Number(existingCanonical.recording_id) === body.recording_id
        ? existingCanonical.created_at
        : new Date().toISOString();
      const manifest = await manifestFor({ ...body, user_id: userId, workspace_id: workspaceId, model_version: env.GLM_MODEL });
      const payloadHash = await hashJson({ ...body, user_id: userId, workspace_id: workspaceId });
      const manifestJson = canonicalJson(manifest);
      const manifestHash = await sha256(new TextEncoder().encode(manifestJson));
      const runInput: FiveAgentRunInput = {
        run_id: body.run_id,
        article_id: body.article_id,
        recording_id: body.recording_id,
        user_id: userId,
        workspace_id: workspaceId,
        payload_hash: payloadHash,
        manifest_hash: manifestHash,
        manifest_json: manifestJson,
        workflow_id: `five-agent-${body.run_id}`,
        created_at: createdAt,
      };
      // Transcript ownership and bytes are verified before any canonical run,
      // DO, D1, or R2 write. Building the brief is pure normalization only.
      const briefObject = await buildBriefObject({ ...body, user_id: userId, workspace_id: workspaceId, created_at: createdAt });
      const briefMetadata = toArtifactMetadata(briefObject);
      const workflowParams: FiveAgentWorkflowParams = {
        ...runInput,
        transcript_ref: body.transcript_ref,
        transcript_hash: body.transcript_hash,
        source_hash: body.source_hash,
        brief_artifact_id: briefMetadata.artifact_id,
        brief_artifact_key: briefMetadata.artifact_key,
        brief_payload_hash: briefMetadata.payload_hash,
      };
      await readTranscript(env, workflowParams);
      await ensureCanonicalRun(env.DB, { ...body, user_id: userId, workspace_id: workspaceId, payload_hash: payloadHash }, manifest, createdAt);
      await createPublicationRun(env.DB, {
        runId: body.run_id, articleId: body.article_id, recordingId: body.recording_id,
        userId, workspaceId, idempotencyKey: `five-agent:${body.run_id}`, payloadHash,
      });
      const coordinator = await startCoordinator(env, runInput);
      await coordinator.startFiveAgentRun(runInput, false);
      let current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
      let briefStorageReconciled = false;
      if (current.start_ledger_status === "needs_action" && current.start_status === "brief_storage_unknown") {
        // A repeated start must never blindly write the same brief again. Read-only
        // reconciliation is enough to distinguish a committed object, a missing
        // object, and an unknown R2 outcome; only the first case may resume.
        const existingBrief = (await coordinator.listFiveAgentArtifacts(body.run_id, userId, workspaceId))
          .find(item => item.artifact_id === briefMetadata.artifact_id);
        if (!existingBrief) return startHoldResponse(current, briefMetadata);
        try {
          await readArtifactFromR2(env, workflowParams, existingBrief.artifact_id, existingBrief.artifact_key, existingBrief.payload_hash);
        } catch (error) {
          if (isReconciliationHold(error)) return startHoldResponse(current, briefMetadata);
          throw error;
        }
        const resumed = await reconcilePreStartHold(env, coordinator, workflowParams, "brief_storage_unknown");
        if (!resumed.reconciled) return startHoldResponse(current, briefMetadata);
        briefStorageReconciled = true;
        current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
      }
      if (current.start_ledger_status === "needs_action" && current.start_status === "workflow_create_unknown") {
        const workflowStatus = await coordinator.getFiveAgentWorkflowStatus(body.run_id, runInput.workflow_id);
        if (workflowStatus === "unknown") return startHoldResponse(current, briefMetadata);
        const reconciled = await reconcilePreStartHold(env, coordinator, workflowParams, "workflow_create_unknown");
        if (!reconciled.reconciled) return startHoldResponse(current, briefMetadata);
        current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
        if (workflowStatus === "exists") {
          // Reconcile the D1 hold first, then pass through the coordinator's
          // existing-workflow branch so the immutable confirmation event and
          // started ledger are written exactly once before returning.
          const confirmed = await coordinator.startFiveAgentWorkflow(workflowParams);
          const hold = workflowStartHoldResult(confirmed);
          if (hold) {
            await coordinator.recordFiveAgentStartHold({
              run_id: body.run_id, workflow_id: runInput.workflow_id,
              start_status: hold.start_status, created_at: createdAt,
            });
            await holdPreStartPublication(env, workflowParams, hold.start_status);
            current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
            return startHoldResponse(current, briefMetadata);
          }
          current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
          return startResultResponse(confirmed, current, briefMetadata, 200);
        }
      }
      if (!briefStorageReconciled) {
        try {
          await prepareArtifactStorage(env, coordinator, workflowParams, briefObject);
        } catch (error) {
          if (!isReconciliationHold(error)) throw error;
          await coordinator.recordFiveAgentStartHold({
            run_id: body.run_id, workflow_id: runInput.workflow_id,
            start_status: "brief_storage_unknown", created_at: createdAt,
          });
          await holdPreStartPublication(env, workflowParams, "brief_storage_unknown");
          current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
          if (current.start_ledger_status === "needs_action") {
            return startHoldResponse(current, briefMetadata);
          }
        }
        current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
        if (current.start_ledger_status === "needs_action" && current.start_status === "brief_storage_unknown") {
          const resumed = await reconcilePreStartHold(env, coordinator, workflowParams, "brief_storage_unknown");
          if (!resumed.reconciled) return startHoldResponse(current, briefMetadata);
          current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
        }
      }
      const result = await coordinator.startFiveAgentWorkflow(workflowParams) as FiveAgentWorkflowStartResult;
      const hold = workflowStartHoldResult(result);
      if (hold) {
        await coordinator.recordFiveAgentStartHold({
          run_id: body.run_id, workflow_id: runInput.workflow_id,
          start_status: hold.start_status, created_at: createdAt,
        });
        await holdPreStartPublication(env, workflowParams, hold.start_status);
        current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
        return startHoldResponse(current, briefMetadata);
      }
      current = await coordinator.getFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown>;
      return startResultResponse(result, current, briefMetadata, result.replayed ? 200 : 202);
    }
    if (request.method === "GET" && parts.length === 6 && parts[4] === "runs") {
      const runId = id(parts[5], "run_id");
      const articleId = id(url.searchParams.get("article_id") || "", "article_id");
      const coordinator = env.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
      const current = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
      return Response.json({ run: buildPublicRunProjection(current) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}
