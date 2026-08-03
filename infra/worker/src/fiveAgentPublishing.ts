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
  publicationTenantFeatureEnabled,
  stagingImageCanaryScopeEnabled,
  v3TenantAllowed,
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
import {
  ACTIVE_VISUAL_PINS,
  VISUAL_PIN_SNAPSHOT_ID,
  buildVisualPlan,
  decodeVisualPinSnapshot,
  encodeVisualPinSnapshot,
  assertVisualAssetMatchesPlanSlot,
  deriveVisualImageOperationKey,
  makeVisualArtifactObject,
  normalizeVisualArtifact,
  toVisualArtifactMetadata,
  visualBinaryKey,
  type VisualArtifactMetadata,
  type VisualArtifactObject,
  type VisualAssetPayload,
  type VisualPlanPayload,
  type VisualQAReportPayload,
  VisualContractError,
} from "./wave2/visualContracts";
import { putImmutableVisualArtifact, readImmutableVisualArtifact, VisualArtifactStoreError } from "./wave2/visualArtifactStore";
import { BinaryImageStoreError, ImageTransformationServiceError, MAX_PROVIDER_BASE64_CHARS, MAX_PROVIDER_PNG_BYTES, describeImmutableBinaryImage, normalizePngWithImagesBinding, putImmutableBinaryImage, readExistingImmutableBinaryImage, readImmutableBinaryImage, verifyPngOpaqueCoverageWithImagesBinding, verifyPngWhiteBackgroundWithImagesBinding } from "./wave2/binaryImageStore";
import { callVisualImageService, callVisualPlanService, reconcileVisualImageService, reconcileVisualPlanService } from "./wave2/visualServiceClients";
import {
  WAVE2D_SCHEMA_VERSION,
  WECHAT_ACTIVE_PINS,
  activeWechatPinSnapshot,
  normalizeWechatHtml,
  validateWechatHtml,
  deriveWechatArtifactId,
  deriveWechatDraftIdentity,
  finalizeWechatPackage,
  makeWechatArtifact,
  normalizeWechatArtifact,
  renderWechatPackage,
  toWechatArtifactMetadata,
  wechatScopeHash,
  canonicalWechatHtml,
  type WechatArtifactMetadata,
  type WechatArtifactObject,
  type WechatOwner,
  type WechatRenderTemplatePayload,
  type WechatImageUploadReceiptPayload,
  type RenderedArticlePackagePayload,
  type WechatDraftReceiptPayload,
  type WechatDraftReadbackQAPayload,
  type WechatPrepublishQAReportPayload,
  type WechatRenderQAReportPayload,
  WechatContractError,
} from "./wave2/wechatContracts";
import { putImmutableWechatArtifact, readExactWechatArtifact, WechatArtifactStoreError } from "./wave2/wechatArtifactStore";
import { callWechatPublishingAdapter, isWechatAccountAllowed, isWechatMediaUrlAllowed, wechatDraftFeatureEnabled, wechatOperationId, WechatPublishingServiceError } from "./wave2/wechatServiceClients";

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

export function visualProductionFeatureEnabled(env: EditorialRuntimeEnv, userId: string, workspaceId: string, runId?: string): boolean {
  if (env.VISUAL_PRODUCTION_V3 !== "true") return false;
  return v3TenantAllowed(env, env.VISUAL_PRODUCTION_V3_ALLOWLIST, userId, workspaceId) &&
    stagingImageCanaryScopeEnabled(env, userId, workspaceId, runId);
}

function errorResponse(error: unknown): Response {
  if (error instanceof EditorialRuntimeError) return Response.json({ error: error.code }, { status: error.status });
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const bounded = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n]+/g, " ").slice(0, 240) : null;
  let stringValue: string | null = null;
  try { stringValue = bounded(String(error)); } catch { /* diagnostic only */ }
  console.warn("five_agent_publishing_internal_error", JSON.stringify({
    value_type: typeof error,
    own_keys: record ? Object.getOwnPropertyNames(error).sort().slice(0, 16) : [],
    name: bounded(record?.name),
    message: bounded(record?.message),
    string_value: stringValue,
  }));
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

async function manifestFor(input: FiveAgentStartBody & { user_id: string; workspace_id: string; payload_hash: string; model_version?: string }): Promise<Record<string, unknown>> {
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
    payload_hash: input.payload_hash,
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

export async function buildFiveAgentBriefObject(input: FiveAgentStartBody & { user_id: string; workspace_id: string; created_at: string }): Promise<ArtifactObject> {
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

function projectionEventCreatedAt(run: { last_event_created_at?: string }): string {
  if (typeof run.last_event_created_at !== "string" || !Number.isFinite(Date.parse(run.last_event_created_at))) {
    throw new EditorialRuntimeError("publication_event_identity_invalid", "publication event time is unavailable", 503);
  }
  return run.last_event_created_at;
}

function projectionEventIdentity(run: PublicationRunRow): { eventType: string; payloadHash: string; createdAt: string } {
  if (typeof run.last_event_type !== "string" || typeof run.last_event_payload_hash !== "string") {
    throw new EditorialRuntimeError("publication_event_identity_invalid", "publication event identity is unavailable", 503);
  }
  return {
    eventType: run.last_event_type,
    payloadHash: run.last_event_payload_hash,
    createdAt: projectionEventCreatedAt(run),
  };
}

async function applySystemState(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  targetState: "transcribing" | "writing" | "reviewing" | "visual_planning" | "visual_generating" | "visual_ready" | "formatting" | "visual_qa" | "draft_syncing" | "needs_action" | "failed",
  eventType: "transcription_started" | "writing_started" | "review_started" | "visual_planning" | "visual_generating" | "visual_ready" | "formatting" | "visual_qa" | "draft_syncing" | "needs_action" | "failed",
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
    eventIdempotencyKey?: string;
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
      eventIdempotencyKey: transition.eventIdempotencyKey || `${eventType}:${phase}:${params.run_id}`,
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
    created_at: projectionEventCreatedAt(projection.run),
    next_action: transition.nextAction,
    error_code: transition.errorCode,
    revision_count: transition.revisionCount,
    retry_count: transition.retryCount,
  });
  return { doStateRevision: doStateRevision + 1, projectionRevision: projection.run.state_revision };
}

const WECHAT_DRAFT_SYNCING_PHASE = 220;

async function wechatDraftSyncingPayloadHash(params: FiveAgentWorkflowParams): Promise<string> {
  return hashJson({
    run_payload_hash: params.payload_hash,
    event_type: "draft_syncing",
    phase: WECHAT_DRAFT_SYNCING_PHASE,
    target_state: "draft_syncing",
    error_code: null,
    next_action: null,
    revision_count: null,
    retry_count: null,
  });
}

type WechatDraftSyncingCheckpoint = {
  doStateRevision: number;
  projectionRevision: number;
  createdAt: string;
};

/**
 * Upload is the first external WeChat side effect. Keep its local checkpoint
 * recoverable when D1 commits before the Coordinator RPC response arrives.
 */
async function ensureWechatDraftSyncingCheckpoint(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  executionScope: string,
): Promise<WechatDraftSyncingCheckpoint> {
  const key = `wave2d:draft-syncing:${executionScope.slice(7, 39)}:${params.run_id}`;
  const payloadHash = await hashJson({
    run_payload_hash: params.payload_hash,
    event_type: "draft_syncing",
    execution_scope: executionScope,
    phase: 220,
    target_state: "draft_syncing",
    error_code: null,
    next_action: null,
    revision_count: null,
    retry_count: null,
  });
  const projection = await env.DB.prepare(`SELECT state, state_revision, last_event_id, last_event_type,
      last_event_idempotency_key, last_event_payload_hash, last_event_created_at
    FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<Pick<PublicationRunRow, "state" | "state_revision" | "last_event_id" | "last_event_type" | "last_event_idempotency_key" | "last_event_payload_hash" | "last_event_created_at">>();
  if (!projection) throw new EditorialRuntimeError("publication_run_not_found", "publication run is unavailable", 404);

  const existingEvent = await env.DB.prepare(`SELECT event_id, revision, event_type, state, idempotency_key, payload_hash, created_at
    FROM publication_run_events WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id, key)
    .first<{ event_id: string; revision: number; event_type: string; state: string; idempotency_key: string; payload_hash: string; created_at: string }>();

  let projected: { state_revision: number; created_at: string };
  if (projection.state === "draft_syncing") {
    if (existingEvent) {
      if (existingEvent.event_id !== `${params.run_id}:event:${existingEvent.revision}` ||
          existingEvent.event_type !== "draft_syncing" || existingEvent.state !== "draft_syncing" ||
          existingEvent.idempotency_key !== key || existingEvent.payload_hash !== payloadHash ||
          existingEvent.revision > projection.state_revision) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft syncing checkpoint identity is not exact", 503);
      }
      projected = { state_revision: existingEvent.revision, created_at: existingEvent.created_at };
    } else {
      const applied = await applySystemPublicationTransition(env.DB, {
        runId: params.run_id,
        auth: { userId: params.user_id, workspaceId: params.workspace_id },
        targetState: "draft_syncing",
        expectedStateRevision: projection.state_revision,
        options: {
          eventId: `${params.run_id}:event:${projection.state_revision + 1}`,
          eventType: "draft_syncing",
          eventIdempotencyKey: key,
          eventPayloadHash: payloadHash,
          eventCreatedAt: workflowTimestamp(params.created_at, 22_250),
          allowSameState: true,
        },
      });
      projected = { state_revision: applied.run.state_revision, created_at: projectionEventCreatedAt(applied.run) };
    }
  } else {
    if (projection.state !== "visual_qa" || existingEvent) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft syncing checkpoint is not resumable", 503);
    }
    const applied = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: "draft_syncing",
      expectedStateRevision: projection.state_revision,
      options: {
        eventId: `${params.run_id}:event:${projection.state_revision + 1}`,
        eventType: "draft_syncing",
        eventIdempotencyKey: key,
        eventPayloadHash: payloadHash,
        eventCreatedAt: workflowTimestamp(params.created_at, 22_250),
      },
    });
    projected = { state_revision: applied.run.state_revision, created_at: projectionEventCreatedAt(applied.run) };
  }

  const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  let doRevision = Number(currentDo.state_revision);
  if (currentDo.state === "draft_syncing") {
    const events = await coordinator.listFiveAgentEvents(params.run_id, params.user_id, params.workspace_id);
    const event = events.find(item => item.event_type === "draft_syncing" && item.payload_hash === payloadHash && item.created_at === projected.created_at);
    if (event) {
      doRevision = Number(event.state_revision);
    } else {
      const expectedRevision = doRevision + 1;
      try {
        await coordinator.recordFiveAgentState({
          run_id: params.run_id,
          state: "draft_syncing",
          state_revision: expectedRevision,
          event_type: "draft_syncing",
          payload_hash: payloadHash,
          created_at: projected.created_at,
        });
      } catch {
        const settled = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
        const settledEvents = await coordinator.listFiveAgentEvents(params.run_id, params.user_id, params.workspace_id);
        const settledEvent = settledEvents.find(item => Number(item.state_revision) === expectedRevision);
        if (settled.state !== "draft_syncing" || Number(settled.state_revision) !== expectedRevision ||
            !settledEvent || settledEvent.event_type !== "draft_syncing" || settledEvent.payload_hash !== payloadHash || settledEvent.created_at !== projected.created_at) {
          throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "Coordinator draft syncing checkpoint is unresolved", 503);
        }
      }
      doRevision = expectedRevision;
    }
  } else if (currentDo.state === "visual_qa") {
    const expectedRevision = doRevision + 1;
    try {
      await coordinator.recordFiveAgentState({
        run_id: params.run_id,
        state: "draft_syncing",
        state_revision: expectedRevision,
        event_type: "draft_syncing",
        payload_hash: payloadHash,
        created_at: projected.created_at,
      });
    } catch {
      const reconciled = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
      const events = await coordinator.listFiveAgentEvents(params.run_id, params.user_id, params.workspace_id);
      const event = events.find(item => Number(item.state_revision) === expectedRevision);
      if (reconciled.state === "visual_qa" && Number(reconciled.state_revision) === doRevision && !event) {
        // D1 is already authoritative. A lost DO request has no external
        // side effect and can safely replay the same state CAS once.
        try {
          await coordinator.recordFiveAgentState({
            run_id: params.run_id,
            state: "draft_syncing",
            state_revision: expectedRevision,
            event_type: "draft_syncing",
            payload_hash: payloadHash,
            created_at: projected.created_at,
          });
        } catch {
          // The final exact read below distinguishes a committed response-loss
          // from an unresolved Coordinator operation.
        }
      }
      const settled = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
      const settledEvents = await coordinator.listFiveAgentEvents(params.run_id, params.user_id, params.workspace_id);
      const settledEvent = settledEvents.find(item => Number(item.state_revision) === expectedRevision);
      if (settled.state !== "draft_syncing" || Number(settled.state_revision) !== expectedRevision ||
          !settledEvent || settledEvent.event_type !== "draft_syncing" || settledEvent.payload_hash !== payloadHash || settledEvent.created_at !== projected.created_at) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "Coordinator draft syncing checkpoint is unresolved", 503);
      }
    }
    doRevision = expectedRevision;
  } else {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "Coordinator draft syncing checkpoint is not resumable", 503);
  }

  return { doStateRevision: doRevision, projectionRevision: projected.state_revision, createdAt: projected.created_at };
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
      eventType: "start_reconciliation_queued",
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

function isVisualReconciliationHold(error: unknown): boolean {
  return isReconciliationHold(error) ||
    (error instanceof EditorialRuntimeError && error.code === "visual_artifact_reconciliation_required") ||
    (error instanceof VisualArtifactStoreError && error.code === "visual_artifact_reconciliation_required") ||
    (error instanceof BinaryImageStoreError && error.code === "binary_reconciliation_required");
}

class VisualCancelledError extends Error {
  constructor() {
    super("visual production was cancelled");
    this.name = "VisualCancelledError";
  }
}

async function isPublicationCancelled(env: EditorialRuntimeEnv, params: FiveAgentWorkflowParams): Promise<boolean> {
  let row: { state: string } | null;
  try {
    row = await env.DB.prepare(`SELECT state FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id)
      .first<{ state: string }>();
  } catch {
    throw new EditorialRuntimeError("external_side_effect_unknown", "visual cancellation state is unavailable", 503);
  }
  if (!row) throw new EditorialRuntimeError("external_side_effect_unknown", "visual cancellation state is unavailable", 503);
  return row?.state === "cancelled";
}

function isKnownVisualPersistenceConflict(error: unknown): boolean {
  return error instanceof EditorialRuntimeError && [
    "visual_artifact_identity_conflict",
    "visual_artifact_mirror_conflict",
    "visual_artifact_metadata_invalid",
    "visual_artifact_conflict",
    "visual_state_invalid",
    "publication_run_not_found",
    "publication_revision_conflict",
    "publication_transition_invalid",
    "stale_workflow_step",
    "idempotency_conflict",
  ].includes(error.code);
}

function visualPersistenceUnknown(error: unknown): never {
  if (isVisualReconciliationHold(error) || isKnownVisualPersistenceConflict(error)) throw error;
  throw new EditorialRuntimeError("external_side_effect_unknown", "visual persistence outcome is unknown", 503);
}

function visualIntegrityError(error: unknown): boolean {
  return (error instanceof VisualArtifactStoreError && error.code !== "visual_artifact_reconciliation_required") ||
    (error instanceof BinaryImageStoreError && error.code !== "binary_reconciliation_required") ||
    (error instanceof EditorialRuntimeError && (error.code === "visual_artifact_identity_conflict" || error.code === "visual_artifact_mirror_conflict" || error.code === "visual_artifact_metadata_invalid"));
}

function isInsufficientVisualPlanError(error: unknown): boolean {
  if (error instanceof VisualContractError && error.code === "visual_plan_insufficient_unique_blocks") return true;
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  if (record?.code === "visual_plan_insufficient_unique_blocks") return true;
  const message = String(record?.message || error || "");
  return message.includes("visual_plan_insufficient_unique_blocks") ||
    message.includes("visual planning requires enough unique non-blank blocks");
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
  const currentProjection = await env.DB.prepare(`SELECT state, state_revision, last_event_created_at
    FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<{ state: string; state_revision: number; last_event_created_at: string }>();
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
    created_at: currentEvent ? projectionEventCreatedAt(currentProjection) : projectionEventCreatedAt(projection.run),
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

type VisualPersistedMetadata = VisualArtifactMetadata & { doStateRevision: number; projectionRevision: number };

async function mirrorVisualArtifactToD1(db: D1Database, object: VisualArtifactObject): Promise<void> {
  const metadata = toVisualArtifactMetadata(object);
  const inputIds = artifactCanonicalJson(metadata.input_artifact_ids);
  const mirror = {
    artifact_id: metadata.artifact_id,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: metadata.recording_id,
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    schema_version: metadata.schema_version,
    kind: metadata.kind,
    producer_agent_role: metadata.producer.role,
    producer_agent_version: metadata.producer.version,
    skill_id: VISUAL_PIN_SNAPSHOT_ID,
    skill_version: encodeVisualPinSnapshot(),
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
    policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    input_artifact_ids_json: inputIds,
    payload_hash: metadata.payload_hash,
    storage_ref: metadata.storage_ref,
    created_at: metadata.created_at,
  };
  const readExisting = () => db.prepare(`SELECT artifact_id, run_id, article_id, recording_id, user_id, workspace_id,
      schema_version, kind, producer_agent_role, producer_agent_version, skill_id, skill_version,
      workflow_version, policy_version, input_artifact_ids_json, payload_hash, storage_ref
      FROM editorial_artifacts WHERE artifact_id = ? LIMIT 1`).bind(mirror.artifact_id).first<Record<string, unknown>>();
  const matches = (existing: Record<string, unknown> | null): boolean => Boolean(existing &&
    String(existing.artifact_id) === mirror.artifact_id && String(existing.run_id) === mirror.run_id &&
    String(existing.article_id) === mirror.article_id && Number(existing.recording_id) === mirror.recording_id &&
    String(existing.user_id) === mirror.user_id && String(existing.workspace_id) === mirror.workspace_id &&
    String(existing.schema_version) === mirror.schema_version && String(existing.kind) === mirror.kind &&
    String(existing.producer_agent_role) === mirror.producer_agent_role && String(existing.producer_agent_version) === mirror.producer_agent_version &&
    String(existing.skill_id || "") === mirror.skill_id && String(existing.skill_version || "") === mirror.skill_version &&
    String(existing.workflow_version) === mirror.workflow_version && String(existing.policy_version) === mirror.policy_version &&
    String(existing.input_artifact_ids_json) === mirror.input_artifact_ids_json && String(existing.payload_hash) === mirror.payload_hash &&
    String(existing.storage_ref) === mirror.storage_ref);
  let existing = await readExisting();
  if (existing && !matches(existing)) throw new EditorialRuntimeError("visual_artifact_mirror_conflict", "visual D1 artifact mirror conflicts", 409);
  if (!existing) {
    try {
      await db.prepare(`INSERT INTO editorial_artifacts
        (artifact_id, run_id, user_id, workspace_id, article_id, recording_id, schema_version, kind,
         producer_agent_role, producer_agent_version, skill_id, skill_version, workflow_version,
         policy_version, input_artifact_ids_json, payload_hash, storage_ref, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(mirror.artifact_id, mirror.run_id, mirror.user_id, mirror.workspace_id, mirror.article_id, mirror.recording_id,
          mirror.schema_version, mirror.kind, mirror.producer_agent_role, mirror.producer_agent_version, mirror.skill_id,
          mirror.skill_version, mirror.workflow_version, mirror.policy_version, mirror.input_artifact_ids_json,
          mirror.payload_hash, mirror.storage_ref, mirror.created_at).run();
    } catch {
      existing = await readExisting();
      if (!existing) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 mirror outcome is unknown", 503);
      if (!matches(existing)) throw new EditorialRuntimeError("visual_artifact_mirror_conflict", "visual D1 mirror insert conflicts", 409);
    }
  }
  if (!matches(await readExisting())) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 mirror could not be verified", 503);
}

async function readVisualArtifactFromR2(env: EditorialRuntimeEnv, metadata: VisualArtifactMetadata): Promise<VisualArtifactObject> {
  let body: R2ObjectBody | null;
  try { body = await env.FILES_BUCKET.get(metadata.artifact_key); } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact read is unknown", 503); }
  if (!body) throw new EditorialRuntimeError("visual_artifact_not_found", "visual artifact is unavailable", 404);
  let parsed: unknown;
  try { parsed = JSON.parse(await body.text()); } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact JSON cannot be read", 503); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact envelope is invalid", 503);
  const raw = parsed as Record<string, unknown>;
  const envelope = raw.envelope as Record<string, unknown>;
  let object: VisualArtifactObject;
  try {
    object = await normalizeVisualArtifact({
      schema_version: envelope.schema_version,
      artifact_id: envelope.artifact_id,
      artifact_key: envelope.artifact_key,
      kind: envelope.kind,
      run_id: envelope.run_id,
      article_id: envelope.article_id,
      recording_id: envelope.recording_id,
      user_id: envelope.user_id,
      workspace_id: envelope.workspace_id,
      input_artifact_ids: envelope.input_artifact_ids,
      idempotency_key: envelope.idempotency_key,
      created_at: envelope.created_at,
      storage_ref: envelope.storage_ref,
      binary_storage_ref: envelope.binary_storage_ref,
      producer: envelope.producer,
      payload_hash: envelope.payload_hash,
      payload_length: envelope.payload_length,
      payload: raw.payload,
    });
  } catch (error) {
    if (error instanceof VisualContractError) throw new EditorialRuntimeError("visual_artifact_identity_conflict", "visual artifact contract does not match its reference", 409);
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact contract cannot be verified", 503);
  }
  if (artifactCanonicalJson(object.envelope) !== artifactCanonicalJson({
    schema_version: metadata.schema_version,
    artifact_id: metadata.artifact_id,
    artifact_key: metadata.artifact_key,
    kind: metadata.kind,
    producer: metadata.producer,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: metadata.recording_id,
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    input_artifact_ids: metadata.input_artifact_ids,
    idempotency_key: metadata.idempotency_key,
    payload_hash: metadata.payload_hash,
    payload_length: metadata.payload_length,
    created_at: metadata.created_at,
    storage_ref: metadata.storage_ref,
    binary_storage_ref: metadata.binary_storage_ref,
  })) throw new EditorialRuntimeError("visual_artifact_identity_conflict", "visual artifact identity does not match", 409);
  try { await readImmutableVisualArtifact(env.FILES_BUCKET, object); } catch (error) {
    if (error instanceof VisualArtifactStoreError && error.code !== "visual_artifact_reconciliation_required") throw error;
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact readback is unknown", 503);
  }
  return object;
}

async function persistVisualArtifact(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  object: VisualArtifactObject,
  targetState: "visual_planning" | "visual_generating" | "visual_ready",
  eventType: "visual_plan_committed" | "visual_asset_committed" | "visual_qa_committed",
  eventIdempotencyKey: string,
  preparedMetadata?: VisualArtifactMetadata,
): Promise<VisualPersistedMetadata> {
  const metadata = toVisualArtifactMetadata(object);
  if (preparedMetadata) {
    if (artifactCanonicalJson(preparedMetadata) !== artifactCanonicalJson(metadata)) throw new EditorialRuntimeError("visual_artifact_identity_conflict", "prepared visual artifact identity changed", 409);
  } else {
    await prepareVisualArtifactIntent(coordinator, params, metadata);
  }
  try {
    await putImmutableVisualArtifact(env.FILES_BUCKET, object);
    await readImmutableVisualArtifact(env.FILES_BUCKET, object);
    await mirrorVisualArtifactToD1(env.DB, object);
  } catch (error) {
    if (error instanceof VisualArtifactStoreError && error.code !== "visual_artifact_reconciliation_required") throw error;
    if (error instanceof EditorialRuntimeError && error.code === "visual_artifact_mirror_conflict") throw error;
    if (error instanceof EditorialRuntimeError && error.code === "visual_artifact_reconciliation_required") throw error;
    if (error instanceof BinaryImageStoreError && error.code !== "binary_reconciliation_required") throw error;
    throw new EditorialRuntimeError("external_side_effect_unknown", "visual artifact persistence outcome is unknown", 503);
  }
  try {
    const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
    const currentProjection = await env.DB.prepare(`SELECT state, state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: PublicationState; state_revision: number }>();
    if (!currentProjection) throw new EditorialRuntimeError("publication_run_not_found", "publication run is unavailable", 404);
    const projection = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState,
      expectedStateRevision: Number(currentProjection.state_revision),
      options: {
        eventId: `${params.run_id}:visual:event:${eventIdempotencyKey}`,
        eventType,
        eventIdempotencyKey,
        eventPayloadHash: metadata.payload_hash,
        eventCreatedAt: metadata.created_at,
        allowSameState: currentProjection.state === targetState,
      },
    });
    const targetDoRevision = String(currentDo.state) === targetState ? Number(currentDo.state_revision) : Number(currentDo.state_revision) + 1;
    await coordinator.completeFiveAgentVisualArtifact({
      artifact_id: metadata.artifact_id,
      run_id: params.run_id,
      payload_hash: metadata.payload_hash,
      state: targetState,
      state_revision: targetDoRevision,
      event_type: eventType,
      event_idempotency_key: eventIdempotencyKey,
      created_at: projectionEventCreatedAt(projection.run),
    });
    return { ...metadata, doStateRevision: targetDoRevision, projectionRevision: projection.run.state_revision };
  } catch (error) {
    visualPersistenceUnknown(error);
  }
}

async function prepareVisualArtifactIntent(
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  metadata: VisualArtifactMetadata,
): Promise<void> {
  try {
    await coordinator.prepareFiveAgentVisualArtifact({ run_id: params.run_id, metadata, envelope_json: artifactCanonicalJson(metadata) });
    return;
  } catch (error) {
    if (isKnownVisualPersistenceConflict(error)) throw error;
    let ledger: Awaited<ReturnType<EditorialCoordinatorAgent["getFiveAgentVisualLedger"]>>;
    try { ledger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id); }
    catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact intent outcome is unknown", 503); }
    const existing = ledger.artifacts.find(item => item.artifact_id === metadata.artifact_id);
    if (existing && artifactCanonicalJson(existing) === artifactCanonicalJson(metadata)) return;
    if (existing) throw new EditorialRuntimeError("visual_artifact_identity_conflict", "visual artifact intent identity conflicts", 409);
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact intent outcome is unknown", 503);
  }
}

async function verifyExactVisualArtifactSet(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  expected: readonly VisualArtifactMetadata[],
  scope?: { frozenPayloadHash: string; planArtifactId: string; planPayloadHash: string },
): Promise<void> {
  const expectedIds = expected.map(item => item.artifact_id);
  if (expected.length === 0 || new Set(expectedIds).size !== expectedIds.length) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact set is not exact", 503);
  const expectedById = new Map(expected.map(item => [item.artifact_id, item]));
  const ledger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
  const currentFrozenHash = scope?.frozenPayloadHash || expected[0].payload_summary.frozen_payload_hash;
  const currentPlanArtifactId = scope?.planArtifactId || expected.find(item => item.kind === "visual_plan")?.artifact_id;
  const currentPlanPayloadHash = scope?.planPayloadHash || expected.find(item => item.kind === "visual_plan")?.payload_hash;
  if (!currentFrozenHash || !currentPlanArtifactId || !currentPlanPayloadHash) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual execution scope is incomplete", 503);
  const isCurrentScope = (item: VisualArtifactMetadata): boolean => item.payload_summary.frozen_payload_hash === currentFrozenHash &&
    (item.kind === "visual_plan"
      ? item.artifact_id === currentPlanArtifactId && item.payload_hash === currentPlanPayloadHash
      : item.payload_summary.plan_artifact_id === currentPlanArtifactId && item.payload_summary.plan_payload_hash === currentPlanPayloadHash);
  const currentArtifacts = ledger.artifacts.filter(isCurrentScope);
  const currentArtifactIds = currentArtifacts.map(item => item.artifact_id);
  const currentReceiptIds = ledger.receipt_ids.filter(id => currentArtifactIds.includes(id));
  const currentEventArtifacts = ledger.event_artifacts.filter(item => currentArtifactIds.includes(item.artifact_id));
  if (currentArtifacts.length !== expected.length ||
      artifactCanonicalJson(currentArtifactIds.sort()) !== artifactCanonicalJson([...expectedIds].sort()) ||
      artifactCanonicalJson(currentReceiptIds.sort()) !== artifactCanonicalJson([...expectedIds].sort()) ||
      artifactCanonicalJson(currentEventArtifacts.map(item => item.artifact_id).sort()) !== artifactCanonicalJson([...expectedIds].sort())) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO artifact set is not exact", 503);
  }
  const expectedDoEvents = expected.map(item => ({
    event_id: `${params.run_id}:visual:${item.idempotency_key}`,
    event_type: item.kind === "visual_plan" ? "visual_plan_committed" : item.kind === "visual_asset" ? "visual_asset_committed" : "visual_qa_committed",
    artifact_id: item.artifact_id,
    payload_hash: item.payload_hash,
    idempotency_key: item.idempotency_key,
  })).sort((left, right) => left.event_id.localeCompare(right.event_id));
  const currentDoEvents = ledger.visual_events
    .filter(event => {
      const artifact = ledger.artifacts.find(item => item.artifact_id === event.artifact_id);
      return Boolean(artifact && isCurrentScope(artifact));
    })
    .map(event => ({ event_id: event.event_id, event_type: event.event_type, artifact_id: event.artifact_id, payload_hash: event.payload_hash, idempotency_key: event.idempotency_key }))
    .sort((left, right) => left.event_id.localeCompare(right.event_id));
  for (const event of ledger.visual_events) {
    const artifact = ledger.artifacts.find(item => item.artifact_id === event.artifact_id);
    if ((!artifact && event.idempotency_key.startsWith("visual")) || (artifact && artifact.payload_summary.frozen_payload_hash === currentFrozenHash && !isCurrentScope(artifact))) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO contains an event outside the current execution scope", 503);
    }
  }
  if (artifactCanonicalJson(currentDoEvents) !== artifactCanonicalJson(expectedDoEvents)) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO event set is not exact", 503);
  }
  for (const item of ledger.artifacts) {
    if (item.payload_summary.frozen_payload_hash === currentFrozenHash && !isCurrentScope(item)) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO contains an extra artifact in the current execution scope", 503);
    }
  }
  for (const event of ledger.event_artifacts) {
    const artifact = ledger.artifacts.find(item => item.artifact_id === event.artifact_id);
    if (artifact?.payload_summary.frozen_payload_hash === currentFrozenHash && !isCurrentScope(artifact)) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO contains an extra artifact event in the current execution scope", 503);
    }
  }
  for (const item of currentArtifacts) {
    const expectedItem = expectedById.get(item.artifact_id);
    if (!expectedItem) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO metadata does not reconcile", 503);
    const { doStateRevision: _doStateRevision, projectionRevision: _projectionRevision, ...expectedMetadata } = expectedItem as VisualPersistedMetadata;
    if (artifactCanonicalJson(item) !== artifactCanonicalJson(expectedMetadata)) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual DO metadata does not reconcile", 503);
  }
  const visualPrefixMarker = "/visual/";
  const visualPrefixIndex = expected[0].artifact_key.indexOf(visualPrefixMarker);
  if (visualPrefixIndex < 0) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact key is not canonical", 503);
  const visualPrefix = expected[0].artifact_key.slice(0, visualPrefixIndex + visualPrefixMarker.length);
  const visualKeys: string[] = [];
  let cursor: string | undefined;
  do {
    let page: R2Objects;
    try { page = await env.FILES_BUCKET.list({ prefix: visualPrefix, ...(cursor ? { cursor } : {}) }); }
    catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON scope listing is unknown", 503); }
    visualKeys.push(...page.objects.map(item => item.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const currentVisualKeys: string[] = [];
  for (const key of visualKeys) {
    let body: R2ObjectBody | null;
    try { body = await env.FILES_BUCKET.get(key); } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON scope read is unknown", 503); }
    if (!body) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON scope object is unavailable", 503);
    let raw: unknown;
    try { raw = JSON.parse(await body.text()); } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON scope object is invalid", 503); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON scope object is invalid", 503);
    const envelope = (raw as Record<string, unknown>).envelope;
    const payload = (raw as Record<string, unknown>).payload;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON scope object is invalid", 503);
    const envelopeRecord = envelope as Record<string, unknown>;
    const payloadRecord = payload as Record<string, unknown>;
    if (envelopeRecord.run_id !== params.run_id || envelopeRecord.user_id !== params.user_id || envelopeRecord.workspace_id !== params.workspace_id) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON object crosses tenant scope", 503);
    const isCurrentObject = payloadRecord.frozen_payload_hash === currentFrozenHash &&
      (envelopeRecord.artifact_id === currentPlanArtifactId
        ? envelopeRecord.artifact_id === currentPlanArtifactId && envelopeRecord.payload_hash === currentPlanPayloadHash
        : payloadRecord.plan_artifact_id === currentPlanArtifactId && payloadRecord.plan_payload_hash === currentPlanPayloadHash);
    if (payloadRecord.frozen_payload_hash === currentFrozenHash && !isCurrentObject) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON object is outside the current plan scope", 503);
    }
    if (isCurrentObject) currentVisualKeys.push(key);
  }
  if (artifactCanonicalJson(currentVisualKeys.sort()) !== artifactCanonicalJson(expected.map(item => item.artifact_key).sort())) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual JSON object set is not exact", 503);
  const binaryExpected = expected.filter(item => item.kind === "visual_asset").map(item => item.binary_storage_ref).filter((value): value is string => Boolean(value)).map(value => value.slice(5));
  if (binaryExpected.length !== expected.filter(item => item.kind === "visual_asset").length) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual binary refs are incomplete", 503);
  const binaryMarker = "/visual-binary/";
  const binaryIndex = binaryExpected[0]?.indexOf(binaryMarker) ?? -1;
  if (binaryIndex < 0) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual binary key is not canonical", 503);
  const binaryPrefix = `${binaryExpected[0].slice(0, binaryIndex + binaryMarker.length)}${currentFrozenHash.slice(7, 23)}/`;
  const binaryKeys: string[] = [];
  cursor = undefined;
  do {
    let page: R2Objects;
    try { page = await env.FILES_BUCKET.list({ prefix: binaryPrefix, ...(cursor ? { cursor } : {}) }); }
    catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual binary scope listing is unknown", 503); }
    binaryKeys.push(...page.objects.map(item => item.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (artifactCanonicalJson(binaryKeys.sort()) !== artifactCanonicalJson(binaryExpected.sort())) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual binary object set is not exact", 503);
  const rows = await env.DB.prepare(`SELECT artifact_id, run_id, article_id, recording_id, user_id, workspace_id,
      schema_version, kind, producer_agent_role, producer_agent_version, skill_id, skill_version,
      workflow_version, policy_version, input_artifact_ids_json, payload_hash, storage_ref
      FROM editorial_artifacts WHERE run_id = ? AND user_id = ? AND workspace_id = ?
      AND kind IN ('visual_plan', 'visual_asset', 'visual_qa_report')`).bind(params.run_id, params.user_id, params.workspace_id).all<Record<string, unknown>>();
  const historicalPayloadHashes = new Set<string>();
  const currentD1Artifacts: VisualArtifactMetadata[] = [];
  const readD1VisualMetadata = async (row: Record<string, unknown>): Promise<VisualArtifactMetadata> => {
    const storageRef = String(row.storage_ref || "");
    if (!storageRef.startsWith("r2://")) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 storage ref is invalid", 503);
    let stored: R2ObjectBody | null;
    try { stored = await env.FILES_BUCKET.get(storageRef.slice(5)); } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact read is unknown", 503); }
    if (!stored) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact is unavailable", 503);
    let parsed: unknown;
    try { parsed = JSON.parse(await stored.text()); } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact is invalid", 503); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact is invalid", 503);
    const record = parsed as Record<string, unknown>;
    const envelope = record.envelope;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !Object.prototype.hasOwnProperty.call(record, "payload")) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact envelope is incomplete", 503);
    const rawEnvelope = envelope as Record<string, unknown>;
    let object: VisualArtifactObject;
    try {
      object = await normalizeVisualArtifact({
        schema_version: rawEnvelope.schema_version,
        artifact_id: rawEnvelope.artifact_id,
        artifact_key: rawEnvelope.artifact_key,
        kind: rawEnvelope.kind,
        run_id: rawEnvelope.run_id,
        article_id: rawEnvelope.article_id,
        recording_id: rawEnvelope.recording_id,
        user_id: rawEnvelope.user_id,
        workspace_id: rawEnvelope.workspace_id,
        producer: rawEnvelope.producer,
        input_artifact_ids: rawEnvelope.input_artifact_ids,
        idempotency_key: rawEnvelope.idempotency_key,
        created_at: rawEnvelope.created_at,
        storage_ref: rawEnvelope.storage_ref,
        binary_storage_ref: rawEnvelope.binary_storage_ref,
        payload_hash: rawEnvelope.payload_hash,
        payload_length: rawEnvelope.payload_length,
        payload: record.payload,
      });
    } catch { throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact identity cannot be verified", 503); }
    const metadata = toVisualArtifactMetadata(object);
    if (String(row.artifact_id) !== metadata.artifact_id || String(row.run_id) !== metadata.run_id || String(row.article_id) !== metadata.article_id || Number(row.recording_id) !== metadata.recording_id ||
        String(row.user_id) !== metadata.user_id || String(row.workspace_id) !== metadata.workspace_id || String(row.schema_version) !== metadata.schema_version ||
        String(row.kind) !== metadata.kind || String(row.producer_agent_role) !== metadata.producer.role || String(row.producer_agent_version) !== metadata.producer.version ||
        String(row.skill_id) !== VISUAL_PIN_SNAPSHOT_ID ||
        String(row.workflow_version) !== FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION || String(row.policy_version) !== FIVE_AGENT_PUBLISHING_POLICY_VERSION ||
        String(row.input_artifact_ids_json) !== artifactCanonicalJson(metadata.input_artifact_ids) || String(row.payload_hash) !== metadata.payload_hash || String(row.storage_ref) !== metadata.storage_ref) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact identity does not reconcile", 503);
    }
    try { decodeVisualPinSnapshot(row.skill_version); } catch {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 pin snapshot does not reconcile", 503);
    }
    return metadata;
  };
  for (const row of rows.results || []) {
    const metadata = await readD1VisualMetadata(row);
    if (isCurrentScope(metadata)) {
      currentD1Artifacts.push(metadata);
      continue;
    }
    if (metadata.payload_summary.frozen_payload_hash === currentFrozenHash) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact is outside the current plan scope", 503);
    }
    historicalPayloadHashes.add(metadata.payload_hash);
  }
  if (artifactCanonicalJson(currentD1Artifacts.map(item => item.artifact_id).sort()) !== artifactCanonicalJson([...expectedIds].sort())) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual D1 artifact set is not exact", 503);
  }
  const eventRows = await env.DB.prepare(`SELECT event_type, idempotency_key, payload_hash FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ?
      ORDER BY revision ASC`).bind(params.run_id, params.user_id, params.workspace_id).all<{ event_type: string; idempotency_key: string; payload_hash: string }>();
  const expectedArtifactEvents = expected.map(item => ({ idempotency_key: item.idempotency_key, payload_hash: item.payload_hash }));
  const expectedStateEvents = [
    { idempotency_key: `visual_planning:11:${params.run_id}`, payload_hash: await hashJson({ run_payload_hash: params.payload_hash, event_type: "visual_planning", phase: 11, target_state: "visual_planning", error_code: null, next_action: null, revision_count: null, retry_count: null }) },
    { idempotency_key: `visual_generating:13:${params.run_id}`, payload_hash: await hashJson({ run_payload_hash: params.payload_hash, event_type: "visual_generating", phase: 13, target_state: "visual_generating", error_code: null, next_action: null, revision_count: null, retry_count: null }) },
  ];
  const currentProjection = await env.DB.prepare(`SELECT state FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: string }>();
  if (currentProjection?.state === "visual_ready") {
    expectedStateEvents.push({ idempotency_key: `visual_ready:21:${params.run_id}`, payload_hash: await hashJson({ run_payload_hash: params.payload_hash, event_type: "visual_ready", phase: 21, target_state: "visual_ready", error_code: null, next_action: null, revision_count: null, retry_count: null }) });
  }
  const currentPayloadHashes = new Set(expectedArtifactEvents.map(item => item.payload_hash));
  const visualEventTypes = new Set(["visual_planning", "visual_generating", "visual_ready", "visual_plan_committed", "visual_asset_committed", "visual_qa_committed"]);
  const visualRows = (eventRows.results || []).filter(row => visualEventTypes.has(row.event_type) || row.idempotency_key.startsWith("visual"));
  if (visualRows.some(row => !visualEventTypes.has(row.event_type))) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "publication contains an unknown visual event", 503);
  }
  const currentArtifactEvents = visualRows
    .filter(row => ["visual_plan_committed", "visual_asset_committed", "visual_qa_committed"].includes(row.event_type) && currentPayloadHashes.has(row.payload_hash))
    .map(row => ({ idempotency_key: row.idempotency_key, payload_hash: row.payload_hash }));
  for (const row of visualRows) {
    if (["visual_plan_committed", "visual_asset_committed", "visual_qa_committed"].includes(row.event_type) &&
        !currentPayloadHashes.has(row.payload_hash) && !historicalPayloadHashes.has(row.payload_hash)) {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual publication event is outside the known artifact scope", 503);
    }
  }
  const actualStateEvents = visualRows
    .filter(row => ["visual_planning", "visual_generating", "visual_ready"].includes(row.event_type))
    .map(row => ({ idempotency_key: row.idempotency_key, payload_hash: row.payload_hash }));
  const actualEvents = [...currentArtifactEvents, ...actualStateEvents].sort((left, right) => left.idempotency_key.localeCompare(right.idempotency_key));
  const expectedEvents = [...expectedArtifactEvents, ...expectedStateEvents].sort((left, right) => left.idempotency_key.localeCompare(right.idempotency_key));
  if (artifactCanonicalJson(actualEvents) !== artifactCanonicalJson(expectedEvents)) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual publication event set is not exact", 503);
  }
}

async function verifyVisualAssetReadback(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
  frozen: FrozenArticleVersion,
  plan: VisualPlanPayload,
  planMeta: VisualArtifactMetadata,
  slot: VisualPlanPayload["slots"][number],
  metadata: VisualArtifactMetadata,
): Promise<{ byte_hash: string; white_background: boolean }> {
  const object = await readVisualArtifactFromR2(env, metadata);
  const asset = object.payload as VisualAssetPayload;
  await assertVisualAssetMatchesPlanSlot(asset, slot, planMeta.payload_hash, object.envelope.idempotency_key);
  if (asset.frozen_artifact_id !== plan.frozen_artifact_id || asset.plan_artifact_id !== planMeta.artifact_id ||
      asset.plan_payload_hash !== planMeta.payload_hash ||
      (asset.purpose === "cover" && artifactCanonicalJson(asset.visible_text) !== artifactCanonicalJson(frozen.cover_title)) ||
      (asset.purpose === "body" && asset.visible_text.length !== 0)) {
    throw new VisualContractError("visual_asset_contract_invalid", "visual asset provenance or visible text evidence is invalid", 409);
  }
  const key = visualBinaryKey(params.user_id, params.workspace_id, params.run_id, plan.frozen_payload_hash, slot.slot_id);
  const bytes = await readImmutableBinaryImage(env.FILES_BUCKET, key, {
    storage_ref: asset.binary_storage_ref,
    byte_hash: asset.byte_hash,
    byte_length: asset.byte_length,
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    user_id: params.user_id,
    workspace_id: params.workspace_id,
    run_id: params.run_id,
    frozen_payload_hash: plan.frozen_payload_hash,
    slot_id: slot.slot_id,
  });
  const whiteBackground = slot.purpose === "cover"
    ? await verifyPngOpaqueCoverageWithImagesBinding(env.IMAGES, bytes, slot.width, slot.height)
    : await verifyPngWhiteBackgroundWithImagesBinding(env.IMAGES, bytes, slot.width, slot.height);
  if (asset.white_background_verified !== whiteBackground) throw new VisualContractError("visual_asset_contract_invalid", "visual asset QA claim does not match deterministic verification", 409);
  return { byte_hash: asset.byte_hash, white_background: whiteBackground };
}

async function verifyCompletedVisualExecution(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  frozen: StoredArtifactMetadata,
  currentArtifacts: readonly VisualArtifactMetadata[],
): Promise<void> {
  const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
  const frozenPayload = frozenObject.payload as FrozenArticleVersion;
  const planMeta = currentArtifacts.find(item => item.kind === "visual_plan");
  if (!planMeta) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual plan is unavailable", 503);
  const planObject = await readVisualArtifactFromR2(env, planMeta);
  const plan = planObject.payload as VisualPlanPayload;
  if (plan.frozen_artifact_id !== frozen.artifact_id || plan.frozen_payload_hash !== frozen.payload_hash) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual plan parent is not exact", 503);
  }
  const recomputedPlan = await buildVisualPlan({
    frozen: frozenPayload,
    user_id: params.user_id,
    workspace_id: params.workspace_id,
    frozen_artifact_id: frozen.artifact_id,
    frozen_payload_hash: frozen.payload_hash,
    created_at: plan.created_at,
  });
  if (artifactCanonicalJson(recomputedPlan) !== artifactCanonicalJson(plan)) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual plan does not match deterministic planning", 503);
  }
  const assetMetadata = plan.slots.map(slot => {
    const asset = currentArtifacts.find(item => item.kind === "visual_asset" && item.payload_summary.slot_id === slot.slot_id);
    if (!asset) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual asset slot is missing", 503);
    return asset;
  });
  const verifiedAssets = [] as Array<{ byte_hash: string; white_background: boolean }>;
  for (const [index, slot] of plan.slots.entries()) {
    verifiedAssets.push(await verifyVisualAssetReadback(env, params, frozenPayload, plan, planMeta, slot, assetMetadata[index]));
  }
  const verifiedCover = verifiedAssets[0];
  const verifiedBody = verifiedAssets.slice(1);
  const qaMeta = currentArtifacts.find(item => item.kind === "visual_qa_report");
  if (!qaMeta) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual QA report is unavailable", 503);
  const qaObject = await readVisualArtifactFromR2(env, qaMeta);
  const qa = qaObject.payload as VisualQAReportPayload;
  const expectedAssetIds = assetMetadata.map(item => item.artifact_id);
  const expectedByteHashes = verifiedAssets.map(item => item.byte_hash);
  if (qa.frozen_artifact_id !== frozen.artifact_id || qa.frozen_payload_hash !== frozen.payload_hash ||
      qa.plan_artifact_id !== planMeta.artifact_id || qa.plan_payload_hash !== planMeta.payload_hash ||
      artifactCanonicalJson(qa.asset_artifact_ids) !== artifactCanonicalJson(expectedAssetIds) ||
      artifactCanonicalJson(qa.asset_byte_hashes) !== artifactCanonicalJson(expectedByteHashes) ||
      qa.passed !== true || qa.checks.ordered_slots !== true || qa.checks.png_signature !== true ||
      qa.checks.dimensions !== true || qa.checks.metadata !== true || qa.checks.white_background !== "verified" ||
      qa.checks.visible_text_pin !== "evidence_only" || artifactCanonicalJson(qa.pins) !== artifactCanonicalJson(ACTIVE_VISUAL_PINS) ||
      verifiedCover?.white_background !== true || verifiedBody.length === 0 || verifiedBody.some(item => item.white_background !== true)) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual QA report is not exact", 503);
  }
  await verifyExactVisualArtifactSet(env, coordinator, params, [planMeta, ...assetMetadata, qaMeta], {
    frozenPayloadHash: frozen.payload_hash,
    planArtifactId: planMeta.artifact_id,
    planPayloadHash: planMeta.payload_hash,
  });
}

async function verifyVisualExecutionReadyForQa(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  frozen: StoredArtifactMetadata,
  ledger: Awaited<ReturnType<EditorialCoordinatorAgent["getFiveAgentVisualLedger"]>>,
  planMeta: VisualArtifactMetadata,
): Promise<void> {
  const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
  const frozenPayload = frozenObject.payload as FrozenArticleVersion;
  const planObject = await readVisualArtifactFromR2(env, planMeta);
  const plan = planObject.payload as VisualPlanPayload;
  const recomputedPlan = await buildVisualPlan({
    frozen: frozenPayload,
    user_id: params.user_id,
    workspace_id: params.workspace_id,
    frozen_artifact_id: frozen.artifact_id,
    frozen_payload_hash: frozen.payload_hash,
    created_at: plan.created_at,
  });
  if (artifactCanonicalJson(recomputedPlan) !== artifactCanonicalJson(plan)) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual plan cannot be reconciled before QA", 503);
  }
  const assets = plan.slots.map(slot => {
    const metadata = ledger.artifacts.find(item => item.kind === "visual_asset" &&
      item.payload_summary.plan_artifact_id === planMeta.artifact_id &&
      item.payload_summary.plan_payload_hash === planMeta.payload_hash &&
      item.payload_summary.slot_id === slot.slot_id && visualArtifactHasReceipt(ledger, item));
    if (!metadata) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual asset evidence is incomplete before QA", 503);
    return metadata;
  });
  for (const [index, slot] of plan.slots.entries()) {
    await verifyVisualAssetReadback(env, params, frozenPayload, plan, planMeta, slot, assets[index]);
  }
  const qa = ledger.artifacts.find(item => item.kind === "visual_qa_report" &&
    item.payload_summary.plan_artifact_id === planMeta.artifact_id &&
    item.payload_summary.plan_payload_hash === planMeta.payload_hash && visualArtifactHasReceipt(ledger, item));
  if (qa) {
    await verifyCompletedVisualExecution(env, coordinator, params, frozen, [planMeta, ...assets, qa]);
    return;
  }
  await verifyExactVisualArtifactSet(env, coordinator, params, [planMeta, ...assets], {
    frozenPayloadHash: frozen.payload_hash,
    planArtifactId: planMeta.artifact_id,
    planPayloadHash: planMeta.payload_hash,
  });
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROVIDER_BASE64_CHARS) throw new EditorialRuntimeError("visual_asset_contract_invalid", "image adapter did not return bounded PNG bytes", 502);
  const constructor = Uint8Array as typeof Uint8Array & { fromBase64?: (encoded: string) => Uint8Array };
  let bytes: Uint8Array;
  try {
    if (typeof constructor.fromBase64 === "function") bytes = constructor.fromBase64(value);
    else {
      const binary = atob(value);
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    }
  } catch { throw new EditorialRuntimeError("visual_asset_contract_invalid", "image adapter returned invalid bytes", 502); }
  if (bytes.byteLength > MAX_PROVIDER_PNG_BYTES) throw new EditorialRuntimeError("visual_asset_contract_invalid", "image adapter returned oversized PNG bytes", 502);
  return bytes;
}

async function visualFailure(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  transcript: { ref: string; hash: string },
  artifactIds: string[],
  errorCode: string,
  nextAction: string,
  phase: number,
  retryCount = 1,
  replayCommittedVisualReady = true,
): Promise<FiveAgentWorkflowResult> {
  const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const currentProjection = await env.DB.prepare(`SELECT state, state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: string; state_revision: number }>();
  // A concurrent Workflow may already have committed the same visual
  // execution. A stale losing closure must replay that terminal result rather
  // than turn it into a failure after the fact.
  if (replayCommittedVisualReady && currentDo.state === "visual_ready" && currentProjection?.state === "visual_ready") {
    return { run_id: params.run_id, state: "visual_ready", state_revision: Number(currentDo.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
  }
  const failed = await applySystemState(env, coordinator, params, "failed", "failed", Number(currentDo.state_revision), Number(currentProjection?.state_revision || 0), phase * 1_000, phase, { errorCode, nextAction, retryCount });
  return { run_id: params.run_id, state: "failed", state_revision: failed.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
}

async function visualHold(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  transcript: { ref: string; hash: string },
  artifactIds: string[],
  phase: number,
  retryCount = 1,
): Promise<FiveAgentWorkflowResult> {
  return visualHoldWithCode(env, coordinator, params, transcript, artifactIds, "external_side_effect_unknown", "reconcile_external_side_effect", phase, retryCount);
}

async function visualHoldWithCode(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  transcript: { ref: string; hash: string },
  artifactIds: string[],
  errorCode: string,
  nextAction: string,
  phase: number,
  retryCount = 1,
  replayCommittedVisualReady = true,
): Promise<FiveAgentWorkflowResult> {
  const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const currentProjection = await env.DB.prepare(`SELECT state, state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: string; state_revision: number }>();
  if (replayCommittedVisualReady && currentDo.state === "visual_ready" && currentProjection?.state === "visual_ready") {
    return { run_id: params.run_id, state: "visual_ready", state_revision: Number(currentDo.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
  }
  const held = await applySystemState(
    env,
    coordinator,
    params,
    "needs_action",
    "needs_action",
    Number(currentDo.state_revision),
    Number(currentProjection?.state_revision || 0),
    phase * 1_000,
    phase,
    {
      errorCode,
      nextAction,
      retryCount,
      // A repaired checkpoint can later hold again for a different local
      // evidence gap. The event must not collide with the original hold.
      eventIdempotencyKey: `wave2d:needs-action:${phase}:${errorCode}:${Number(currentProjection?.state_revision || 0)}:${params.run_id}`,
    },
  );
  return { run_id: params.run_id, state: "needs_action", state_revision: held.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
}

type VisualAdapterCallResult = {
  callId: string;
  response: Record<string, unknown> | null;
  replayed: boolean;
  durable: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>>;
};

async function reconcileExistingVisualAdapterCall(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  operation: "plan" | "image",
  callKind: string,
  idempotencyKey: string,
  payload: unknown,
  recordedAt: string,
): Promise<VisualAdapterCallResult | null> {
  const attempts = (await coordinator.listFiveAgentCallAttempts(params.run_id, params.user_id, params.workspace_id))
    .filter(item => item.call_kind === callKind && item.idempotency_key === idempotencyKey)
    .sort((left, right) => left.attempt - right.attempt);
  const latest = attempts.at(-1);
  if (!latest) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual reconciliation has no durable adapter call intent", 503);
  }
  if (latest.status === "succeeded") {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "completed visual call is missing its committed artifact evidence", 503);
  }
  if (latest.status === "failed") return null;
  if (latest.status !== null && latest.status !== "needs_action") {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual adapter call is not reconcilable", 503);
  }
  if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
  const requestPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), attempt: latest.attempt }
    : payload;
  try {
    const response = operation === "plan"
      ? await reconcileVisualPlanService(env, requestPayload)
      : await reconcileVisualImageService(env, requestPayload);
    return {
      callId: latest.call_id,
      response: response.result,
      replayed: false,
      durable: {
        status: "needs_action",
        call_id: latest.call_id,
        error_code: latest.error_code || "external_side_effect_unknown",
        retryable: false,
        attempt: latest.attempt,
      },
    };
  } catch (error) {
    if (error instanceof InternalServiceError && error.upstreamCode === "external_side_effect_unknown") {
      throw new EditorialRuntimeError("external_side_effect_unknown", "visual adapter result still requires reconciliation", 503, latest.attempt);
    }
    if (!(error instanceof InternalServiceError)) throw error;
    const retryable = wave2bRetryable(error);
    await coordinator.completeFiveAgentCall({
      call_id: latest.call_id,
      run_id: params.run_id,
      status: "failed",
      error_code: retryable ? "upstream_retryable" : "visual_generation_non_retryable",
      retryable,
      recorded_at: recordedAt,
    });
    return null;
  }
}

async function runVisualAdapterCall(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  operation: "plan" | "image",
  callKind: string,
  idempotencyKey: string,
  payload: unknown,
  createdAt: string,
  reconciledCalls?: Map<string, { callId: string; response: Record<string, unknown> | null; replayed: boolean; durable: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>> }>,
): Promise<VisualAdapterCallResult> {
  const reconciled = reconciledCalls?.get(idempotencyKey);
  if (reconciled) {
    reconciledCalls!.delete(idempotencyKey);
    return reconciled;
  }
  const completeReconciledFailure = async (
    error: unknown,
    prepared: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>>,
  ): Promise<boolean> => {
    if (error instanceof InternalServiceError && error.upstreamCode === "external_side_effect_unknown") {
      throw new EditorialRuntimeError("external_side_effect_unknown", "visual adapter result requires reconciliation", 503, prepared.attempt || 1);
    }
    const retryable = wave2bRetryable(error);
    const durableAttempt = prepared.attempt || 1;
    await coordinator.completeFiveAgentCall({
      call_id: prepared.call_id,
      run_id: params.run_id,
      status: "failed",
      error_code: retryable ? "upstream_retryable" : "visual_generation_non_retryable",
      retryable,
      recorded_at: createdAt,
    });
    if (retryable && durableAttempt < 3) {
      return true;
    }
    throw new EditorialRuntimeError(
      retryable ? "visual_generation_retry_exhausted" : "visual_generation_non_retryable",
      "visual adapter call failed",
      retryable ? 503 : 409,
      durableAttempt,
    );
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
    const prepared = await coordinator.prepareFiveAgentCall({ run_id: params.run_id, call_kind: callKind, idempotency_key: idempotencyKey, attempt, created_at: createdAt });
    if (prepared.status === "needs_action") {
      if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
      const requestPayload = payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), attempt: prepared.attempt || attempt }
        : payload;
      try {
        const reconciled = operation === "plan"
          ? await reconcileVisualPlanService(env, requestPayload)
          : await reconcileVisualImageService(env, requestPayload);
        return { callId: prepared.call_id, response: reconciled.result, replayed: false, durable: prepared };
      } catch (error) {
        if (await completeReconciledFailure(error, prepared)) {
          attempt = prepared.attempt || attempt;
          continue;
        }
      }
    }
    if (prepared.status === "failed") {
      const durableAttempt = prepared.attempt || attempt;
      if (prepared.retryable === true) {
        if (durableAttempt >= 3) throw new EditorialRuntimeError("visual_generation_retry_exhausted", "visual adapter retry limit exceeded", 503, durableAttempt);
        attempt = durableAttempt;
        continue;
      }
      throw new EditorialRuntimeError(prepared.error_code || "visual_generation_non_retryable", "visual adapter call failed", 409, durableAttempt);
    }
    if (prepared.status === "completed") {
      return { callId: prepared.call_id, response: null, replayed: true, durable: prepared };
    }
    try {
      if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
      const requestPayload = payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), attempt }
        : payload;
      const response = operation === "plan" ? await callVisualPlanService(env, requestPayload) : await callVisualImageService(env, requestPayload);
      return { callId: prepared.call_id, response: response.result, replayed: false, durable: prepared };
    } catch (error) {
      if (error instanceof VisualCancelledError) throw error;
      if (error instanceof InternalServiceError && error.upstreamCode === "external_side_effect_unknown") {
        throw new EditorialRuntimeError("external_side_effect_unknown", "visual adapter result requires reconciliation", 503, attempt);
      }
      const retryable = error instanceof InternalServiceError && error.retryable;
      await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "failed", error_code: retryable ? "upstream_retryable" : "visual_generation_non_retryable", retryable, recorded_at: createdAt });
      if (retryable && attempt < 3) continue;
      throw new EditorialRuntimeError(retryable ? "visual_generation_retry_exhausted" : "visual_generation_non_retryable", "visual adapter call failed", retryable ? 503 : 409, attempt);
    }
  }
  throw new EditorialRuntimeError("visual_generation_retry_exhausted", "visual adapter retry limit exceeded", 503, 3);
}

function visualArtifactHasReceipt(
  ledger: Awaited<ReturnType<EditorialCoordinatorAgent["getFiveAgentVisualLedger"]>>,
  metadata: VisualArtifactMetadata,
): boolean {
  return ledger.receipt_ids.includes(metadata.artifact_id) && ledger.visual_events.some(event =>
    event.artifact_id === metadata.artifact_id && event.payload_hash === metadata.payload_hash &&
    event.idempotency_key === metadata.idempotency_key,
  );
}

async function resumeVisualReconciliationHold(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
): Promise<"visual_planning" | "visual_generating"> {
  let doRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  let projection = await env.DB.prepare(`SELECT state, state_revision, resume_state, last_successful_state, error_code, next_action,
      last_event_type, last_event_payload_hash, last_event_created_at
      FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id)
    .first<PublicationRunRow>();
  if (!projection) throw new EditorialRuntimeError("publication_run_not_found", "visual publication projection is unavailable", 404);
  const target = String(doRun.last_successful_state || projection.last_successful_state);
  if (target !== "visual_planning" && target !== "visual_generating") {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual reconciliation has no resumable successful state", 503);
  }
  if (String(doRun.state) === "needs_action" &&
      (doRun.error_code !== "external_side_effect_unknown" || doRun.next_action !== "reconcile_external_side_effect")) {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual hold is not eligible for automatic reconciliation", 503);
  }
  if (projection.state === "needs_action") {
    if (projection.error_code !== "external_side_effect_unknown" || projection.next_action !== "reconcile_external_side_effect") {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "publication hold is not eligible for automatic reconciliation", 503);
    }
    const reconciledAt = workflowTimestamp(params.created_at, 22_000);
    const reconciledHash = await hashJson({ run_payload_hash: params.payload_hash, event_type: "visual_side_effect_reconciled", target_state: "needs_action", resume_state: target });
    const marked = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: "needs_action",
      expectedStateRevision: projection.state_revision,
      options: {
        eventId: `${params.run_id}:event:${projection.state_revision + 1}`,
        eventType: "visual_side_effect_reconciled",
        eventIdempotencyKey: `wave2c-reconciled:${target}:${params.run_id}`,
        eventPayloadHash: reconciledHash,
        eventCreatedAt: reconciledAt,
        errorCode: "visual_side_effect_reconciled",
        nextAction: "resume_reconciled_visual",
        allowSameState: true,
      },
    });
    projection = marked.run;
  }
  if (projection.state === "needs_action") {
    if (projection.error_code !== "visual_side_effect_reconciled" || projection.next_action !== "resume_reconciled_visual") {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual reconciliation evidence is incomplete", 503);
    }
    const createdAt = workflowTimestamp(params.created_at, 22_500);
    const payloadHash = await hashJson({ run_payload_hash: params.payload_hash, event_type: "visual_reconciliation_retrying", target_state: "retrying", resume_state: target });
    const retried = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: "retrying",
      expectedStateRevision: projection.state_revision,
      options: {
        eventId: `${params.run_id}:event:${projection.state_revision + 1}`,
        eventType: "visual_reconciliation_retrying",
        eventIdempotencyKey: `wave2c-retrying:${target}:${params.run_id}`,
        eventPayloadHash: payloadHash,
        eventCreatedAt: createdAt,
      },
    });
    projection = retried.run;
  }
  if (projection.state === "retrying") {
    if (projection.resume_state !== target) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual retry target is not exact", 503);
    const createdAt = workflowTimestamp(params.created_at, 23_000);
    const payloadHash = await hashJson({ run_payload_hash: params.payload_hash, event_type: "visual_reconciliation_resumed", target_state: target });
    const resumed = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: target,
      expectedStateRevision: projection.state_revision,
      options: {
        eventId: `${params.run_id}:event:${projection.state_revision + 1}`,
        eventType: "visual_reconciliation_resumed",
        eventIdempotencyKey: `wave2c-resumed:${target}:${params.run_id}`,
        eventPayloadHash: payloadHash,
        eventCreatedAt: createdAt,
      },
    });
    projection = resumed.run;
  }
  if (projection.state !== target) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual publication reconciliation did not converge", 503);
  if (String(doRun.state) === "needs_action") {
    const resumedEvent = projectionEventIdentity(projection);
    if (resumedEvent.eventType !== "visual_reconciliation_resumed") {
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual reconciliation event identity is incomplete", 503);
    }
    await coordinator.recordFiveAgentState({
      run_id: params.run_id,
      state: target,
      state_revision: Number(doRun.state_revision) + 1,
      event_type: target,
      payload_hash: resumedEvent.payloadHash,
      created_at: resumedEvent.createdAt,
      retry_count: Number(doRun.retry_count || 0),
    });
    doRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  }
  if (String(doRun.state) !== target) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual coordinator reconciliation did not converge", 503);
  return target;
}

export async function runVisualProductionPhase(input: {
  env: EditorialRuntimeEnv;
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>;
  params: FiveAgentWorkflowParams;
  frozen: StoredArtifactMetadata;
  priorArtifactIds: string[];
  transcript: { ref: string; hash: string };
  step: AgentWorkflowStep;
}): Promise<FiveAgentWorkflowResult> {
  const { env, coordinator, params, frozen, priorArtifactIds, transcript, step } = input;
  if (!visualProductionFeatureEnabled(env, params.user_id, params.workspace_id, params.run_id)) {
    return { run_id: params.run_id, state: "content_frozen", state_revision: Number(frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: priorArtifactIds };
  }
  if (await isPublicationCancelled(env, params)) {
    return { run_id: params.run_id, state: "cancelled", state_revision: Number(frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: priorArtifactIds };
  }
  const reconciledCalls = new Map<string, { callId: string; response: Record<string, unknown> | null; replayed: boolean; durable: Awaited<ReturnType<EditorialCoordinatorAgent["prepareFiveAgentCall"]>> }>();
  let existingRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  if (existingRun.state === "needs_action" && existingRun.error_code === "external_side_effect_unknown" && existingRun.next_action === "reconcile_external_side_effect") {
    const target = String(existingRun.last_successful_state);
    try {
      if (target === "visual_planning") {
        const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
        const planPayload = await buildVisualPlan({
          frozen: frozenObject.payload as FrozenArticleVersion,
          user_id: params.user_id,
          workspace_id: params.workspace_id,
          frozen_artifact_id: frozen.artifact_id,
          frozen_payload_hash: frozen.payload_hash,
          created_at: workflowTimestamp(params.created_at, 12_000),
        });
        const key = `visual-plan:${params.run_id}:${frozen.payload_hash}`;
        const reconciled = await reconcileExistingVisualAdapterCall(env, coordinator, params, "plan", "visual_plan", key, { operation_id: key, plan: planPayload }, workflowTimestamp(params.created_at, 12_100));
        if (reconciled) reconciledCalls.set(key, reconciled);
      } else if (target === "visual_generating") {
        const ledger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
        const planMeta = ledger.artifacts.find(item => item.kind === "visual_plan" && item.payload_summary.frozen_payload_hash === frozen.payload_hash && visualArtifactHasReceipt(ledger, item));
        if (!planMeta) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual reconciliation cannot find the committed plan", 503);
        const planObject = await readVisualArtifactFromR2(env, planMeta);
        const planPayload = planObject.payload as VisualPlanPayload;
        const pendingSlot = planPayload.slots.find(slot => !ledger.artifacts.some(item => item.kind === "visual_asset" &&
          item.payload_summary.plan_artifact_id === planMeta.artifact_id && item.payload_summary.plan_payload_hash === planMeta.payload_hash &&
          item.payload_summary.slot_id === slot.slot_id && visualArtifactHasReceipt(ledger, item)));
        if (pendingSlot) {
          const key = await deriveVisualImageOperationKey(params.run_id, planPayload.frozen_payload_hash, planMeta.payload_hash, pendingSlot.slot_id, pendingSlot.prompt_hash);
          const reconciled = await reconcileExistingVisualAdapterCall(env, coordinator, params, "image", "visual_image", key, {
            operation_id: key,
            run_id: params.run_id,
            user_id: params.user_id,
            workspace_id: params.workspace_id,
            prompt: pendingSlot.prompt,
            size: `${pendingSlot.width}x${pendingSlot.height}`,
            model: "gpt-image-2",
          }, workflowTimestamp(params.created_at, 14_000 + pendingSlot.order));
          if (reconciled) reconciledCalls.set(key, reconciled);
        } else {
          await verifyVisualExecutionReadyForQa(env, coordinator, params, frozen, ledger, planMeta);
        }
      } else {
        throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual hold has no resumable state", 503);
      }
    } catch (error) {
      if (isVisualReconciliationHold(error)) {
        const ledger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
        const completedIds = ledger.artifacts.filter(item => visualArtifactHasReceipt(ledger, item)).map(item => item.artifact_id);
        return { run_id: params.run_id, state: "needs_action", state_revision: Number(existingRun.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...new Set([...priorArtifactIds, ...completedIds])] };
      }
      throw error;
    }
    await resumeVisualReconciliationHold(env, coordinator, params);
    existingRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  }
  if (existingRun.state === "visual_ready") {
    const visualLedger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
    const currentPlan = visualLedger.artifacts.find(item => item.kind === "visual_plan" && item.payload_summary.frozen_payload_hash === frozen.payload_hash);
    if (!currentPlan) throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "the current frozen visual plan is unavailable", 503);
    const currentArtifacts = visualLedger.artifacts.filter(item =>
      item.payload_summary.frozen_payload_hash === frozen.payload_hash &&
      (item.kind === "visual_plan"
        ? item.artifact_id === currentPlan.artifact_id
        : item.payload_summary.plan_artifact_id === currentPlan.artifact_id && item.payload_summary.plan_payload_hash === currentPlan.payload_hash));
    await verifyCompletedVisualExecution(env, coordinator, params, frozen, currentArtifacts);
    return { run_id: params.run_id, state: "visual_ready", state_revision: Number(existingRun.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...new Set([...priorArtifactIds, ...currentArtifacts.map(item => item.artifact_id)])] };
  }
  let qaMetadata: VisualPersistedMetadata | null = null;
  if (existingRun.state === "content_frozen") try {
    if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
    const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
    const currentProjection = await env.DB.prepare(`SELECT state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state_revision: number }>();
    await applySystemState(env, coordinator, params, "visual_planning", "visual_planning", Number(currentDo.state_revision), Number(currentProjection?.state_revision || 0), 11_000, 11);
  } catch (error) {
    if (error instanceof VisualCancelledError) {
      return { run_id: params.run_id, state: "cancelled", state_revision: Number(frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: priorArtifactIds };
    }
    return visualFailure(env, coordinator, params, transcript, priorArtifactIds, "visual_generation_non_retryable", "retry_after_service_fix", 11);
  } else if (existingRun.state !== "visual_planning" && existingRun.state !== "visual_generating") {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual workflow state is not resumable", 503);
  }

  let planMeta: VisualPersistedMetadata;
  const entryLedger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
  const committedPlan = entryLedger.artifacts.find(item => item.kind === "visual_plan" && item.payload_summary.frozen_payload_hash === frozen.payload_hash && visualArtifactHasReceipt(entryLedger, item));
  if (committedPlan) {
    planMeta = committedPlan as VisualPersistedMetadata;
  } else try {
    planMeta = await step.do("visual-plan", { retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const }, async () => {
      const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
      const payload = await buildVisualPlan({ frozen: frozenObject.payload as FrozenArticleVersion, user_id: params.user_id, workspace_id: params.workspace_id, frozen_artifact_id: frozen.artifact_id, frozen_payload_hash: frozen.payload_hash, created_at: workflowTimestamp(params.created_at, 12_000) });
      const call = await runVisualAdapterCall(env, coordinator, params, "plan", "visual_plan", `visual-plan:${params.run_id}:${frozen.payload_hash}`, { operation_id: `visual-plan:${params.run_id}:${frozen.payload_hash}`, plan: payload }, workflowTimestamp(params.created_at, 12_100), reconciledCalls);
      if (call.response && call.response.prompt_hash && call.response.prompt_hash !== await hashJson(payload.slots.map(slot => slot.prompt_hash))) throw new EditorialRuntimeError("visual_generation_non_retryable", "visual plan adapter response is not deterministic", 409);
      const object = await makeVisualArtifactObject({ kind: "visual_plan", payload, user_id: params.user_id, workspace_id: params.workspace_id, input_artifact_ids: [frozen.artifact_id], idempotency_key: `visual-plan:${params.run_id}:${frozen.payload_hash}`, created_at: payload.created_at });
      const persisted = await persistVisualArtifact(env, coordinator, params, object, "visual_planning", "visual_plan_committed", object.envelope.idempotency_key);
      if (!call.replayed) await coordinator.completeFiveAgentCall({ call_id: call.callId, run_id: params.run_id, status: "succeeded", response_hash: persisted.payload_hash, artifact_id: persisted.artifact_id, recorded_at: payload.created_at });
      return persisted;
    });
  } catch (error) {
    if (error instanceof VisualCancelledError) return { run_id: params.run_id, state: "cancelled", state_revision: Number(frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: priorArtifactIds };
    if (isInsufficientVisualPlanError(error)) return visualHoldWithCode(env, coordinator, params, transcript, priorArtifactIds, "visual_plan_insufficient_unique_blocks", "revise_content_before_visuals", 12, 0);
    if (isVisualReconciliationHold(error)) return visualHold(env, coordinator, params, transcript, priorArtifactIds, 12, error instanceof EditorialRuntimeError ? error.retryCount : 1);
    if (visualIntegrityError(error)) return visualFailure(env, coordinator, params, transcript, priorArtifactIds, "visual_asset_contract_invalid", "retry_after_service_fix", 12);
    return visualFailure(env, coordinator, params, transcript, priorArtifactIds, error instanceof EditorialRuntimeError ? error.code : "visual_generation_non_retryable", "retry_after_service_fix", 12, error instanceof EditorialRuntimeError ? error.retryCount : 1);
  }

  const stateAfterPlan = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  if (stateAfterPlan.state === "visual_planning") try {
    const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
    const currentProjection = await env.DB.prepare(`SELECT state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state_revision: number }>();
    await applySystemState(env, coordinator, params, "visual_generating", "visual_generating", Number(currentDo.state_revision), Number(currentProjection?.state_revision || 0), 13_000, 13);
  } catch (error) {
    if (error instanceof VisualCancelledError) return { run_id: params.run_id, state: "cancelled", state_revision: Number(planMeta.doStateRevision || frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...priorArtifactIds, planMeta.artifact_id] };
    if (isVisualReconciliationHold(error)) return visualHold(env, coordinator, params, transcript, [...priorArtifactIds, planMeta.artifact_id], 13, error instanceof EditorialRuntimeError ? error.retryCount : 1);
    return visualFailure(env, coordinator, params, transcript, [...priorArtifactIds, planMeta.artifact_id], "visual_generation_non_retryable", "retry_after_service_fix", 13);
  } else if (stateAfterPlan.state !== "visual_generating") {
    throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual generation state is not resumable", 503);
  }

  const assetMetadata: VisualPersistedMetadata[] = [];
  let planObject: VisualArtifactObject;
  try { planObject = await readVisualArtifactFromR2(env, planMeta); } catch (error) {
    if (isVisualReconciliationHold(error)) return visualHold(env, coordinator, params, transcript, [...priorArtifactIds, planMeta.artifact_id], 14, error instanceof EditorialRuntimeError ? error.retryCount : 1);
    if (visualIntegrityError(error)) return visualFailure(env, coordinator, params, transcript, [...priorArtifactIds, planMeta.artifact_id], "visual_asset_contract_invalid", "retry_after_service_fix", 14);
    return visualFailure(env, coordinator, params, transcript, [...priorArtifactIds, planMeta.artifact_id], "visual_generation_non_retryable", "retry_after_service_fix", 14, error instanceof EditorialRuntimeError ? error.retryCount : 1);
  }
  const planPayload = planObject.payload as VisualPlanPayload;
  const ledgerAfterPlan = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
  for (const slot of planPayload.slots) {
    const committedAsset = ledgerAfterPlan.artifacts.find(item => item.kind === "visual_asset" &&
      item.payload_summary.plan_artifact_id === planMeta.artifact_id && item.payload_summary.plan_payload_hash === planMeta.payload_hash &&
      item.payload_summary.slot_id === slot.slot_id && visualArtifactHasReceipt(ledgerAfterPlan, item));
    if (committedAsset) {
      assetMetadata.push(committedAsset as VisualPersistedMetadata);
      continue;
    }
    try {
      const assetMeta = await step.do(`visual-asset-${slot.slot_id}`, { retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const }, async () => {
        const imageOperationId = await deriveVisualImageOperationKey(params.run_id, planPayload.frozen_payload_hash, planMeta.payload_hash, slot.slot_id, slot.prompt_hash);
        const call = await runVisualAdapterCall(env, coordinator, params, "image", "visual_image", imageOperationId, { operation_id: imageOperationId, run_id: params.run_id, user_id: params.user_id, workspace_id: params.workspace_id, prompt: slot.prompt, size: `${slot.width}x${slot.height}`, model: "gpt-image-2" }, workflowTimestamp(params.created_at, 14_000 + slot.order), reconciledCalls);
        if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
        const binaryKey = visualBinaryKey(params.user_id, params.workspace_id, params.run_id, planPayload.frozen_payload_hash, slot.slot_id);
        const existingBinary = call.response ? null : await readExistingImmutableBinaryImage(env.FILES_BUCKET, binaryKey, {
          user_id: params.user_id,
          workspace_id: params.workspace_id,
          run_id: params.run_id,
          frozen_payload_hash: planPayload.frozen_payload_hash,
          slot_id: slot.slot_id,
        });
        if (!call.response && !existingBinary) throw new EditorialRuntimeError("external_side_effect_unknown", "visual image result requires binary reconciliation", 503);
        const result = call.response as Record<string, unknown> | null;
        const imageBytes = result
          ? await normalizePngWithImagesBinding(env.IMAGES, decodeBase64(result.bytes_base64 ?? result.b64_json), slot.width, slot.height, slot.purpose === "cover"
            ? { backgroundRgb: [0xde, 0xd9, 0xcf], padding: "solid" }
            : { backgroundRgb: [255, 255, 255], padding: "solid" })
          : existingBinary!.bytes;
        const expectedBinary = existingBinary?.metadata ?? await describeImmutableBinaryImage(binaryKey, imageBytes, {
          mime: "image/png", width: slot.width, height: slot.height, user_id: params.user_id, workspace_id: params.workspace_id,
          run_id: params.run_id, frozen_payload_hash: planPayload.frozen_payload_hash, slot_id: slot.slot_id,
        });
        const whiteBackgroundVerified = slot.purpose === "cover"
          ? await verifyPngOpaqueCoverageWithImagesBinding(env.IMAGES, imageBytes, slot.width, slot.height)
          : await verifyPngWhiteBackgroundWithImagesBinding(env.IMAGES, imageBytes, slot.width, slot.height);
        const payload: VisualAssetPayload = {
          protocol_version: "visual_asset.v2", article_id: params.article_id, run_id: params.run_id, recording_id: params.recording_id,
          frozen_artifact_id: planPayload.frozen_artifact_id, frozen_payload_hash: planPayload.frozen_payload_hash,
          plan_artifact_id: planMeta.artifact_id, plan_payload_hash: planMeta.payload_hash, slot_id: slot.slot_id, order: slot.order,
          purpose: slot.purpose, aspect_ratio: slot.aspect_ratio, block_id: slot.block_id, block_text_hash: slot.block_text_hash, binary_storage_ref: expectedBinary.storage_ref,
          byte_hash: expectedBinary.byte_hash, byte_length: expectedBinary.byte_length, mime: "image/png", width: slot.width, height: slot.height,
          prompt_hash: slot.prompt_hash, model_version: "gpt-image-2", adapter_version: "visual-generation.adapter.1.0.0", pins: ACTIVE_VISUAL_PINS,
          visible_text: slot.purpose === "cover" ? (await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash).then(value => (value.payload as FrozenArticleVersion).cover_title)) : [],
          visible_text_evidence: "prompt_contract",
          white_background_verified: whiteBackgroundVerified, created_at: workflowTimestamp(params.created_at, 15_000 + slot.order),
        };
        const object = await makeVisualArtifactObject({ kind: "visual_asset", payload, user_id: params.user_id, workspace_id: params.workspace_id, input_artifact_ids: [planPayload.frozen_artifact_id, planMeta.artifact_id], idempotency_key: imageOperationId, created_at: payload.created_at, binary_storage_ref: expectedBinary.storage_ref });
        const preparedMetadata = toVisualArtifactMetadata(object);
        await prepareVisualArtifactIntent(coordinator, params, preparedMetadata);
        if (!existingBinary) {
          const binary = await putImmutableBinaryImage(env.FILES_BUCKET, binaryKey, imageBytes, {
            mime: "image/png", width: slot.width, height: slot.height, user_id: params.user_id, workspace_id: params.workspace_id,
            run_id: params.run_id, frozen_payload_hash: planPayload.frozen_payload_hash, slot_id: slot.slot_id,
          });
          if (artifactCanonicalJson(binary.metadata) !== artifactCanonicalJson(expectedBinary)) throw new EditorialRuntimeError("visual_artifact_identity_conflict", "visual binary identity changed after artifact intent", 409);
        }
        const persisted = await persistVisualArtifact(env, coordinator, params, object, "visual_generating", "visual_asset_committed", imageOperationId, preparedMetadata);
        if (!call.replayed) await coordinator.completeFiveAgentCall({ call_id: call.callId, run_id: params.run_id, status: "succeeded", response_hash: persisted.payload_hash, artifact_id: persisted.artifact_id, recorded_at: payload.created_at });
        return persisted;
      });
      assetMetadata.push(assetMeta);
    } catch (error) {
      const ids = [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id)];
      if (error instanceof VisualCancelledError) return { run_id: params.run_id, state: "cancelled", state_revision: Number(planMeta.doStateRevision || frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: ids };
      if (isVisualReconciliationHold(error)) return visualHold(env, coordinator, params, transcript, ids, 15 + slot.order, error instanceof EditorialRuntimeError ? error.retryCount : 1);
      if (error instanceof ImageTransformationServiceError) return visualFailure(env, coordinator, params, transcript, ids, error.code, error.retryable ? "retry" : "retry_after_service_fix", 15 + slot.order);
      if (visualIntegrityError(error)) return visualFailure(env, coordinator, params, transcript, ids, "visual_asset_contract_invalid", "retry_after_service_fix", 15 + slot.order);
      return visualFailure(env, coordinator, params, transcript, ids, error instanceof EditorialRuntimeError ? error.code : "visual_generation_non_retryable", error instanceof EditorialRuntimeError && error.code === "visual_generation_retry_exhausted" ? "retry" : "retry_after_service_fix", 15 + slot.order, error instanceof EditorialRuntimeError ? error.retryCount : 1);
    }
  }

  try {
    if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
    const qaLedger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
    const committedQa = qaLedger.artifacts.find(item => item.kind === "visual_qa_report" &&
      item.payload_summary.plan_artifact_id === planMeta.artifact_id &&
      item.payload_summary.plan_payload_hash === planMeta.payload_hash && visualArtifactHasReceipt(qaLedger, item));
    if (committedQa) {
      qaMetadata = committedQa as VisualPersistedMetadata;
      await verifyCompletedVisualExecution(env, coordinator, params, frozen, [planMeta, ...assetMetadata, committedQa]);
      if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
      const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
      const currentProjection = await env.DB.prepare(`SELECT state, state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: string; state_revision: number }>();
      if (currentDo.state === "visual_ready" && currentProjection?.state === "visual_ready") {
        return { run_id: params.run_id, state: "visual_ready", state_revision: Number(currentDo.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id), committedQa.artifact_id] };
      }
      const ready = await applySystemState(env, coordinator, params, "visual_ready", "visual_ready", Number(currentDo.state_revision), Number(currentProjection?.state_revision || 0), 21_000, 21);
      return { run_id: params.run_id, state: "visual_ready", state_revision: ready.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id), committedQa.artifact_id] };
    }
    const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
    const frozenPayload = frozenObject.payload as FrozenArticleVersion;
    const verifiedAssets = [] as Array<{ byte_hash: string; white_background: boolean }>;
    for (const slot of planPayload.slots) {
      const metadata = assetMetadata.find(item => item.payload_summary.slot_id === slot.slot_id);
      if (!metadata) throw new VisualContractError("visual_slot_conflict", "visual asset slot is missing", 409);
      verifiedAssets.push(await verifyVisualAssetReadback(env, params, frozenPayload, planPayload, planMeta, slot, metadata));
    }
    const coverAsset = verifiedAssets[0];
    const bodyAssets = verifiedAssets.slice(1);
    const whiteBackgroundPassed = coverAsset?.white_background === true && bodyAssets.length > 0 && bodyAssets.every(item => item.white_background);
    const qaPayload: VisualQAReportPayload = {
      protocol_version: "visual_qa_report.v2", article_id: params.article_id, run_id: params.run_id, recording_id: params.recording_id,
      frozen_artifact_id: planPayload.frozen_artifact_id, frozen_payload_hash: planPayload.frozen_payload_hash, plan_artifact_id: planMeta.artifact_id,
      plan_payload_hash: planMeta.payload_hash, asset_artifact_ids: assetMetadata.map(asset => asset.artifact_id),
      asset_byte_hashes: verifiedAssets.map(item => item.byte_hash),
      checks: { ordered_slots: true, png_signature: true, dimensions: true, metadata: true, white_background: whiteBackgroundPassed ? "verified" : "failed", visible_text_pin: "evidence_only" },
      visible_text_evidence: "prompt_contract", passed: whiteBackgroundPassed, pins: ACTIVE_VISUAL_PINS, created_at: workflowTimestamp(params.created_at, 20_000),
    };
    const qaObject = await makeVisualArtifactObject({ kind: "visual_qa_report", payload: qaPayload, user_id: params.user_id, workspace_id: params.workspace_id, input_artifact_ids: [planPayload.frozen_artifact_id, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id)], idempotency_key: `visual-qa:${params.run_id}:${planMeta.payload_hash}`, created_at: qaPayload.created_at });
    // Keep the QA artifact in the last successful visual state until the
    // complete JSON/binary/D1/event set has been reconciled. Only then may the
    // system transition the run to the terminal Wave2C state.
    const qa = await persistVisualArtifact(env, coordinator, params, qaObject, "visual_generating", "visual_qa_committed", qaObject.envelope.idempotency_key);
    qaMetadata = qa;
    if (await isPublicationCancelled(env, params)) throw new VisualCancelledError();
    await verifyExactVisualArtifactSet(env, coordinator, params, [planMeta, ...assetMetadata, qa]);
    if (!whiteBackgroundPassed) return visualHoldWithCode(env, coordinator, params, transcript, [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id), qa.artifact_id], "visual_qa_failed", "review_visual_assets", 20);
    const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
    const currentProjection = await env.DB.prepare(`SELECT state, state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: string; state_revision: number }>();
    if (currentDo.state === "visual_ready" && currentProjection?.state === "visual_ready") {
      return { run_id: params.run_id, state: "visual_ready", state_revision: Number(currentDo.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id), qa.artifact_id] };
    }
    const ready = await applySystemState(env, coordinator, params, "visual_ready", "visual_ready", Number(currentDo.state_revision), Number(currentProjection?.state_revision || 0), 21_000, 21);
    return { run_id: params.run_id, state: "visual_ready", state_revision: ready.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id), qa.artifact_id] };
  } catch (error) {
    const ids = [...priorArtifactIds, planMeta.artifact_id, ...assetMetadata.map(asset => asset.artifact_id), ...(qaMetadata ? [qaMetadata.artifact_id] : [])];
    if (error instanceof VisualCancelledError) return { run_id: params.run_id, state: "cancelled", state_revision: Number(planMeta.doStateRevision || frozen.doStateRevision || 0), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: ids };
    if (isVisualReconciliationHold(error)) return visualHold(env, coordinator, params, transcript, ids, 20, error instanceof EditorialRuntimeError ? error.retryCount : 1);
    if (error instanceof ImageTransformationServiceError) return visualFailure(env, coordinator, params, transcript, ids, error.code, error.retryable ? "retry" : "retry_after_service_fix", 20);
    if (visualIntegrityError(error)) return visualFailure(env, coordinator, params, transcript, ids, "visual_asset_contract_invalid", "retry_after_service_fix", 20);
    return visualFailure(env, coordinator, params, transcript, ids, "visual_qa_failed", "review_visual_assets", 20);
  }
}

type WechatPersistedMetadata = WechatArtifactMetadata & { doStateRevision: number; projectionRevision: number };

async function readWechatArtifactFromR2(env: EditorialRuntimeEnv, metadata: WechatArtifactMetadata): Promise<WechatArtifactObject> {
  let body: R2ObjectBody | null;
  try { body = await env.FILES_BUCKET.get(metadata.artifact_key); } catch { throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact read is unknown", 503); }
  if (!body) throw new EditorialRuntimeError("wechat_artifact_not_found", "wechat artifact is unavailable", 404);
  let raw: unknown;
  try { raw = JSON.parse(await body.text()); } catch { throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact is unreadable", 503); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact is invalid", 503);
  const record = raw as Record<string, unknown>;
  const envelope = record.envelope && typeof record.envelope === "object" ? record.envelope as Record<string, unknown> : {};
  let object: WechatArtifactObject;
  try { object = await normalizeWechatArtifact({ ...envelope, payload: record.payload }); }
  catch (error) {
    if (error instanceof WechatContractError) throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat artifact contract conflicts", 409);
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact cannot be normalized", 503);
  }
  const expectedMetadata = { ...metadata } as Record<string, unknown>;
  delete expectedMetadata.doStateRevision;
  delete expectedMetadata.projectionRevision;
  if (artifactCanonicalJson(toWechatArtifactMetadata(object)) !== artifactCanonicalJson(expectedMetadata)) throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat artifact metadata conflicts", 409);
  try { await readExactWechatArtifact(env.FILES_BUCKET, object); }
  catch (error) {
    if (error instanceof WechatArtifactStoreError && error.code === "wechat_artifact_conflict") throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat artifact bytes conflict", 409);
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact readback is unknown", 503);
  }
  return object;
}

async function mirrorWechatArtifactToD1(db: D1Database, object: WechatArtifactObject): Promise<void> {
  const metadata = toWechatArtifactMetadata(object);
  const mirror = {
    artifact_id: metadata.artifact_id, run_id: metadata.run_id, user_id: metadata.user_id, workspace_id: metadata.workspace_id,
    article_id: metadata.article_id, recording_id: metadata.recording_id, schema_version: metadata.schema_version, kind: metadata.kind,
    producer_agent_role: metadata.producer.role, producer_agent_version: metadata.producer.version,
    skill_id: "wechat-pin-snapshot",
    // Existing D1 columns are sufficient for a decodable, redacted per-epoch
    // snapshot. The account receipt remains a hash in the R2 payload only.
    skill_version: artifactCanonicalJson({
      pins: WECHAT_ACTIVE_PINS,
      execution_scope: (object.payload as { execution_scope: string }).execution_scope,
      recovery_cycle: (object.payload as { recovery_cycle: string | null }).recovery_cycle,
    }),
    workflow_version: FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION, policy_version: FIVE_AGENT_PUBLISHING_POLICY_VERSION,
    input_artifact_ids_json: artifactCanonicalJson(metadata.input_artifact_ids), payload_hash: metadata.payload_hash,
    storage_ref: metadata.storage_ref, created_at: metadata.created_at,
  };
  const get = () => db.prepare(`SELECT artifact_id, run_id, user_id, workspace_id, article_id, recording_id, schema_version, kind,
    producer_agent_role, producer_agent_version, skill_id, skill_version, workflow_version, policy_version,
    input_artifact_ids_json, payload_hash, storage_ref, created_at FROM editorial_artifacts WHERE artifact_id = ? LIMIT 1`).bind(mirror.artifact_id).first<Record<string, unknown>>();
  const matches = (row: Record<string, unknown> | null): boolean => Boolean(row && Object.entries(mirror).every(([key, value]) => String(row[key] ?? "") === String(value)));
  let existing = await get();
  if (existing && !matches(existing)) throw new EditorialRuntimeError("wechat_artifact_mirror_conflict", "wechat D1 artifact mirror conflicts", 409);
  if (!existing) {
    try {
      await db.prepare(`INSERT INTO editorial_artifacts (artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
        schema_version, kind, producer_agent_role, producer_agent_version, skill_id, skill_version, workflow_version,
        policy_version, input_artifact_ids_json, payload_hash, storage_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(mirror.artifact_id, mirror.run_id, mirror.user_id, mirror.workspace_id, mirror.article_id, mirror.recording_id,
          mirror.schema_version, mirror.kind, mirror.producer_agent_role, mirror.producer_agent_version, mirror.skill_id,
          mirror.skill_version, mirror.workflow_version, mirror.policy_version, mirror.input_artifact_ids_json,
          mirror.payload_hash, mirror.storage_ref, mirror.created_at).run();
    } catch {
      existing = await get();
      if (!existing) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat D1 mirror outcome is unknown", 503);
      if (!matches(existing)) throw new EditorialRuntimeError("wechat_artifact_mirror_conflict", "wechat D1 mirror conflicts", 409);
    }
  }
  if (!matches(await get())) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat D1 mirror cannot be verified", 503);
}

async function persistWechatArtifact(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  object: WechatArtifactObject,
  state: "formatting" | "visual_qa" | "draft_syncing" | "draft_verifying" | "draft_ready" | "needs_action" | "failed",
  eventType: "wechat_artifact_committed" | "wechat_needs_action" | "wechat_failed",
  compatibilityProjection?: { recordingId: number; wechatDraftId: string; verifiedCoverImageUrl?: string },
): Promise<WechatPersistedMetadata> {
  const metadata = toWechatArtifactMetadata(object);
  await coordinator.prepareFiveAgentWechatArtifact({ run_id: params.run_id, metadata, envelope_json: artifactCanonicalJson(metadata) });
  try {
    await putImmutableWechatArtifact(env.FILES_BUCKET, object);
    await readExactWechatArtifact(env.FILES_BUCKET, object);
    await mirrorWechatArtifactToD1(env.DB, object);
  } catch (error) {
    if (error instanceof WechatArtifactStoreError && error.code === "wechat_artifact_conflict") throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat artifact persistence conflicts", 409);
    if (error instanceof EditorialRuntimeError && error.status === 409) throw error;
    throw new EditorialRuntimeError("external_side_effect_unknown", "wechat artifact persistence outcome is unknown", 503);
  }
  const ledger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
  const completedEvent = ledger.wechat_events.find(event =>
    event.idempotency_key === metadata.idempotency_key &&
    event.artifact_id === metadata.artifact_id &&
    event.payload_hash === metadata.payload_hash &&
    event.state === state && event.event_type === eventType,
  );
  const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const projection = await env.DB.prepare(`SELECT state, state_revision, last_event_idempotency_key, last_event_payload_hash FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id).first<{ state: PublicationState; state_revision: number; last_event_idempotency_key: string | null; last_event_payload_hash: string | null }>();
  if (!projection) throw new EditorialRuntimeError("publication_run_not_found", "publication run is unavailable", 404);
  const projectedReceipt = await env.DB.prepare(`SELECT revision, state, event_type, created_at FROM publication_run_events
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? AND payload_hash = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id, metadata.idempotency_key, metadata.payload_hash)
    .first<{ revision: number; state: string; event_type: string; created_at: string }>();
  const projectedReceiptIdentity = await env.DB.prepare(`SELECT payload_hash, state, event_type FROM publication_run_events
    WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id, metadata.idempotency_key)
    .first<{ payload_hash: string; state: string; event_type: string }>();
  if (projectedReceiptIdentity && (!projectedReceipt ||
      projectedReceiptIdentity.state !== state || projectedReceiptIdentity.event_type !== eventType)) {
    throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat artifact event identity conflicts", 409);
  }
  if (completedEvent) {
    const mirroredEvent = await env.DB.prepare(`SELECT revision FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? AND payload_hash = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id, metadata.idempotency_key, metadata.payload_hash)
      .first<{ revision: number }>();
    // Publication and Coordinator revisions are deliberately independent:
    // recovery can add local reconciliation events to either ledger. The
    // stable artifact idempotency key and payload hash are the cross-ledger
    // receipt identity, not a coincident revision number.
    if (!mirroredEvent) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact DO receipt is ahead of projection", 503);
    }
    return { ...metadata, doStateRevision: completedEvent.state_revision, projectionRevision: projection.state_revision };
  }
  if (projectedReceipt) {
    if (projectedReceipt.state !== state || projectedReceipt.event_type !== eventType) {
      throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat D1 receipt conflicts with the artifact completion", 409);
    }
    const doRevision = Number(currentDo.state_revision) + 1;
    try {
      const completion = await coordinator.completeFiveAgentWechatArtifact({
        artifact_id: metadata.artifact_id,
        run_id: params.run_id,
        payload_hash: metadata.payload_hash,
        state,
        state_revision: doRevision,
        event_type: eventType,
        event_idempotency_key: metadata.idempotency_key,
        created_at: projectedReceipt.created_at,
      });
      return { ...metadata, doStateRevision: completion.state_revision, projectionRevision: projection.state_revision };
    } catch {
      const reconciledLedger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
      const reconciledEvent = reconciledLedger.wechat_events.find(event =>
        event.idempotency_key === metadata.idempotency_key &&
        event.artifact_id === metadata.artifact_id &&
        event.payload_hash === metadata.payload_hash &&
        event.state === state && event.event_type === eventType,
      );
      if (reconciledEvent) {
        return { ...metadata, doStateRevision: reconciledEvent.state_revision, projectionRevision: projection.state_revision };
      }
      // The D1 event is already durable. A prior local recovery event can
      // advance only the DO revision between the first RPC read and its CAS;
      // re-read and retry the same receipt identity once, never the provider.
      const refreshedDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
      try {
        const completion = await coordinator.completeFiveAgentWechatArtifact({
          artifact_id: metadata.artifact_id,
          run_id: params.run_id,
          payload_hash: metadata.payload_hash,
          state,
          state_revision: Number(refreshedDo.state_revision) + 1,
          event_type: eventType,
          event_idempotency_key: metadata.idempotency_key,
          created_at: projectedReceipt.created_at,
        });
        return { ...metadata, doStateRevision: completion.state_revision, projectionRevision: projection.state_revision };
      } catch {
        const settledLedger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
        const settledEvent = settledLedger.wechat_events.find(event =>
          event.idempotency_key === metadata.idempotency_key &&
          event.artifact_id === metadata.artifact_id &&
          event.payload_hash === metadata.payload_hash &&
          event.state === state && event.event_type === eventType,
        );
        if (settledEvent) return { ...metadata, doStateRevision: settledEvent.state_revision, projectionRevision: projection.state_revision };
      }
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat D1 receipt is awaiting Durable Object completion", 503);
    }
  }
  const applied = await applySystemPublicationTransition(env.DB, {
    runId: params.run_id,
    auth: { userId: params.user_id, workspaceId: params.workspace_id },
    targetState: state,
    expectedStateRevision: projection.state_revision,
    ...(compatibilityProjection ? { compatibilityProjection } : {}),
    options: {
      eventId: `${params.run_id}:wechat:event:${metadata.idempotency_key}`,
      eventType,
      eventIdempotencyKey: metadata.idempotency_key,
      eventPayloadHash: metadata.payload_hash,
      eventCreatedAt: metadata.created_at,
      allowSameState: projection.state === state,
    },
  });
  const doRevision = Number(currentDo.state_revision) + 1;
  try {
    const completion = await coordinator.completeFiveAgentWechatArtifact({ artifact_id: metadata.artifact_id, run_id: params.run_id, payload_hash: metadata.payload_hash, state, state_revision: doRevision, event_type: eventType, event_idempotency_key: metadata.idempotency_key, created_at: projectionEventCreatedAt(applied.run) });
    return { ...metadata, doStateRevision: completion.state_revision, projectionRevision: applied.run.state_revision };
  } catch {
    // The Coordinator transaction can commit before an RPC response is lost.
    // Only a complete matching DO receipt plus its D1 projection event proves
    // that this is a replay; any other outcome remains a reconciliation hold.
    const reconciledLedger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
    const reconciledEvent = reconciledLedger.wechat_events.find(event =>
      event.idempotency_key === metadata.idempotency_key &&
      event.artifact_id === metadata.artifact_id &&
      event.payload_hash === metadata.payload_hash &&
      event.state === state && event.event_type === eventType,
    );
    const reconciledProjectionEvent = reconciledEvent
      ? await env.DB.prepare(`SELECT revision FROM publication_run_events
          WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? AND payload_hash = ? LIMIT 1`)
        .bind(params.run_id, params.user_id, params.workspace_id, metadata.idempotency_key, metadata.payload_hash)
        .first<{ revision: number }>()
      : null;
    if (reconciledEvent && reconciledProjectionEvent) {
      return { ...metadata, doStateRevision: reconciledEvent.state_revision, projectionRevision: applied.run.state_revision };
    }
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact completion outcome is unknown", 503);
  }
}

// This preserves the production Coordinator -> R2 -> D1 -> projection -> DO
// order for adversarial runtime fixtures without adding a second write path.
export async function persistWechatArtifactForVerification(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  object: WechatArtifactObject,
  state: "formatting" | "visual_qa" | "draft_syncing" | "draft_verifying" | "draft_ready" | "needs_action" | "failed",
  eventType: "wechat_artifact_committed" | "wechat_needs_action" | "wechat_failed",
): Promise<WechatPersistedMetadata> {
  return persistWechatArtifact(env, coordinator, params, object, state, eventType);
}

type WechatScopeTopology = {
  scope: string;
  recoveryCycle: string | null;
  artifacts: WechatArtifactObject[];
  template: WechatArtifactObject;
  templatePayload: WechatRenderTemplatePayload;
  slots: string[];
  uploads: WechatArtifactObject[];
  readbacks: WechatArtifactObject[];
};

type WechatRecoveryGroup = {
  target: string;
  holdRevision: number;
  reconciledRevision: number;
  retryingRevision: number;
  resumedRevision: number;
};

type WechatRecoveryProjectionEvent = {
  revision: number;
  event_id: string;
  event_type: string;
  state: string;
  error_code: string | null;
  next_action: string | null;
  retry_count: number;
};

function wechatTopologyFailure(message: string): never {
  throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", message, 503);
}

// A recovery group is written synchronously by the Coordinator-owned D1
// state machine. No other Wave2D event is permitted between the source hold
// and its three server-owned recovery steps.
function validateWechatRecoveryRevisionOrder(group: WechatRecoveryGroup): void {
  if (group.reconciledRevision !== group.holdRevision + 1 ||
      group.retryingRevision !== group.reconciledRevision + 1 ||
      group.resumedRevision !== group.retryingRevision + 1) {
    wechatTopologyFailure("wechat recovery group revisions are not contiguous");
  }
}

function validateWechatHoldRevision(stateRevision: number, holdRevision: number): void {
  if (stateRevision + 1 !== holdRevision) {
    wechatTopologyFailure("wechat hold revision does not match its embedded predecessor");
  }
}

function validateWechatRecoveryProjectionFields(input: {
  runId: string;
  target: string;
  checkpointState: string;
  hold: Pick<WechatRecoveryProjectionEvent, "revision" | "retry_count">;
  reconciled: WechatRecoveryProjectionEvent;
  retrying: WechatRecoveryProjectionEvent;
  resumed: WechatRecoveryProjectionEvent;
}): void {
  if (!WECHAT_RESUMABLE_STATES.has(input.checkpointState) || input.target !== input.checkpointState) {
    wechatTopologyFailure("wechat recovery target does not match the held checkpoint");
  }
  validateWechatRecoveryRevisionOrder({
    target: input.target,
    holdRevision: input.hold.revision,
    reconciledRevision: input.reconciled.revision,
    retryingRevision: input.retrying.revision,
    resumedRevision: input.resumed.revision,
  });
  for (const event of [input.reconciled, input.retrying, input.resumed]) {
    if (event.event_id !== `${input.runId}:event:${event.revision}`) {
      wechatTopologyFailure("wechat recovery event id is not canonical");
    }
  }
  if (input.reconciled.event_type !== "wechat_side_effect_reconciled" || input.reconciled.state !== "needs_action" ||
      input.reconciled.error_code !== "wechat_side_effect_reconciled" || input.reconciled.next_action !== "resume_reconciled_wechat" ||
      input.retrying.event_type !== "wechat_reconciliation_retrying" || input.retrying.state !== "retrying" ||
      input.retrying.error_code !== null || input.retrying.next_action !== null ||
      input.resumed.event_type !== "wechat_reconciliation_resumed" || input.resumed.state !== input.target ||
      input.resumed.error_code !== null || input.resumed.next_action !== null ||
      input.reconciled.retry_count !== input.hold.retry_count ||
      input.retrying.retry_count !== input.hold.retry_count || input.resumed.retry_count !== input.hold.retry_count) {
    wechatTopologyFailure("wechat recovery projection fields are not exact");
  }
}

function wechatPayloadScope(object: WechatArtifactObject): { scope: string; cycle: string | null } {
  const payload = object.payload as { execution_scope?: unknown; recovery_cycle?: unknown };
  if (typeof payload.execution_scope !== "string" || !/^sha256:[a-f0-9]{64}$/.test(payload.execution_scope) ||
      (payload.recovery_cycle !== null && (typeof payload.recovery_cycle !== "string" || !/^[a-f0-9]{32}$/.test(payload.recovery_cycle)))) {
    wechatTopologyFailure("wechat artifact epoch evidence is invalid");
  }
  return { scope: payload.execution_scope, cycle: payload.recovery_cycle };
}

/**
 * Validates every retained Wave2D epoch, not just the active terminal graph.
 * The envelopes already duplicate the typed inputs; this resolver additionally
 * proves each typed parent is a real object in the same immutable epoch.
 */
function validateWechatScopeTopologies(objects: Map<string, WechatArtifactObject>): Map<string, WechatScopeTopology> {
  const grouped = new Map<string, WechatArtifactObject[]>();
  const cycles = new Map<string, string | null>();
  for (const object of objects.values()) {
    const { scope, cycle } = wechatPayloadScope(object);
    const previous = cycles.get(scope);
    if (previous !== undefined && previous !== cycle) wechatTopologyFailure("wechat execution scope has conflicting recovery evidence");
    cycles.set(scope, cycle);
    const group = grouped.get(scope) || [];
    group.push(object);
    grouped.set(scope, group);
  }
  // Account resolution can fail before the first Wave2D artifact exists. Its
  // repaired execution is then the first persisted epoch and is deliberately
  // recovery-bound rather than an invented initial scope. What remains
  // forbidden is more than one unbound initial epoch.
  if ([...cycles.values()].filter(value => value === null).length > 1) {
    wechatTopologyFailure("wechat initial execution scope is not unique");
  }

  const topologies = new Map<string, WechatScopeTopology>();
  for (const [scope, artifacts] of grouped) {
    const byKind = new Map<string, WechatArtifactObject[]>();
    for (const object of artifacts) {
      const values = byKind.get(object.envelope.kind) || [];
      values.push(object);
      byKind.set(object.envelope.kind, values);
    }
    const one = <T extends WechatArtifactObject>(kind: string): T | undefined => {
      const values = byKind.get(kind) || [];
      if (values.length > 1) wechatTopologyFailure(`wechat execution scope duplicates ${kind}`);
      return values[0] as T | undefined;
    };
    const template = one<WechatArtifactObject>("wechat_render_template");
    if (!template) wechatTopologyFailure("wechat execution scope is missing its template root");
    const templatePayload = template.payload as WechatRenderTemplatePayload;
    const slots = [templatePayload.cover_slot_id, ...templatePayload.body_slots.map(slot => slot.slot_id)];
    if (new Set(slots).size !== slots.length || slots[0] !== "cover_01") {
      wechatTopologyFailure("wechat template slot topology is invalid");
    }
    const renderQa = one<WechatArtifactObject>("wechat_render_qa_report");
    const packageObject = one<WechatArtifactObject>("rendered_article_package");
    const preQa = one<WechatArtifactObject>("wechat_prepublish_qa_report");
    const draftReceipt = one<WechatArtifactObject>("wechat_draft_receipt");
    const readback = one<WechatArtifactObject>("wechat_draft_readback_qa");
    const uploads = byKind.get("wechat_image_upload_receipt") || [];
    const requireEarlier = (condition: boolean, message: string) => { if (!condition) wechatTopologyFailure(message); };
    requireEarlier(!renderQa || renderQa.envelope.input_artifact_ids.length === 1, "wechat render QA has invalid parent topology");
    if (renderQa) {
      const payload = renderQa.payload as WechatRenderQAReportPayload;
      requireEarlier(payload.template_artifact_id === template.envelope.artifact_id && payload.template_payload_hash === template.envelope.payload_hash &&
        renderQa.envelope.input_artifact_ids[0] === template.envelope.artifact_id, "wechat render QA parent conflicts");
    }
    const renderPassed = renderQa && (renderQa.payload as WechatRenderQAReportPayload).decision === "pass";
    if (!renderQa && (uploads.length || packageObject || preQa || draftReceipt || readback)) wechatTopologyFailure("wechat scope has a topology hole before render QA");
    if (renderQa && !renderPassed && (uploads.length || packageObject || preQa || draftReceipt || readback)) wechatTopologyFailure("wechat failed render QA has descendants");

    const bySlot = new Map<string, WechatArtifactObject>();
    for (const upload of uploads) {
      const payload = upload.payload as WechatImageUploadReceiptPayload;
      const slotIndex = slots.indexOf(payload.slot_id);
      if (slotIndex < 0 || bySlot.has(payload.slot_id) || payload.order !== slotIndex ||
          payload.purpose !== (slotIndex === 0 ? "cover" : "body") ||
          payload.media_kind !== (slotIndex === 0 ? "thumb" : "body") ||
          payload.frozen_artifact_id !== templatePayload.frozen_artifact_id || payload.frozen_payload_hash !== templatePayload.frozen_payload_hash ||
          payload.visual_plan_artifact_id !== templatePayload.visual_plan_artifact_id || payload.visual_plan_payload_hash !== templatePayload.visual_plan_payload_hash ||
          payload.visual_qa_artifact_id !== templatePayload.visual_qa_artifact_id || payload.visual_qa_payload_hash !== templatePayload.visual_qa_payload_hash ||
          payload.visual_asset_artifact_id !== templatePayload.asset_artifact_ids[slotIndex] ||
          payload.account_binding_id !== templatePayload.account_binding_id) {
        wechatTopologyFailure("wechat upload receipt slot topology conflicts");
      }
      bySlot.set(payload.slot_id, upload);
    }
    const orderedUploads = slots.map(slot => bySlot.get(slot)).filter((value): value is WechatArtifactObject => Boolean(value));
    const completeUploads = orderedUploads.length === slots.length;
    if ((packageObject || preQa || draftReceipt || readback) && (!renderPassed || !completeUploads)) {
      wechatTopologyFailure("wechat scope has a topology hole before package");
    }
    if (!packageObject && (preQa || draftReceipt || readback)) wechatTopologyFailure("wechat scope has a topology hole before prepublish QA");
    if (!preQa && (draftReceipt || readback)) wechatTopologyFailure("wechat scope has a topology hole before draft receipt");
    if (!draftReceipt && readback) wechatTopologyFailure("wechat scope has a topology hole before readback");

    const sameParent = (id: string, hash: string, expected: WechatArtifactObject | undefined, kind: string): boolean =>
      Boolean(expected && expected.envelope.kind === kind && expected.envelope.artifact_id === id && expected.envelope.payload_hash === hash &&
        wechatPayloadScope(expected).scope === scope);
    if (packageObject) {
      const payload = packageObject.payload as RenderedArticlePackagePayload;
      requireEarlier(sameParent(payload.template_artifact_id, payload.template_payload_hash, template, "wechat_render_template") &&
        sameParent(payload.render_qa_artifact_id, payload.render_qa_payload_hash, renderQa, "wechat_render_qa_report") &&
        artifactCanonicalJson(payload.upload_receipt_ids) === artifactCanonicalJson(orderedUploads.map(object => object.envelope.artifact_id)) &&
        artifactCanonicalJson(packageObject.envelope.input_artifact_ids) === artifactCanonicalJson([template.envelope.artifact_id, renderQa!.envelope.artifact_id, ...orderedUploads.map(object => object.envelope.artifact_id)]),
      "wechat package parents conflict across execution scopes");
    }
    if (preQa) {
      const payload = preQa.payload as WechatPrepublishQAReportPayload;
      requireEarlier(sameParent(payload.package_artifact_id, payload.package_payload_hash, packageObject, "rendered_article_package") &&
        artifactCanonicalJson(payload.ordered_upload_receipt_ids) === artifactCanonicalJson(orderedUploads.map(object => object.envelope.artifact_id)) &&
        artifactCanonicalJson(preQa.envelope.input_artifact_ids) === artifactCanonicalJson([packageObject!.envelope.artifact_id, ...orderedUploads.map(object => object.envelope.artifact_id)]),
      "wechat prepublish QA parents conflict across execution scopes");
    }
    if (draftReceipt) {
      const payload = draftReceipt.payload as WechatDraftReceiptPayload;
      requireEarlier(sameParent(payload.package_artifact_id, payload.package_payload_hash, packageObject, "rendered_article_package") &&
        sameParent(payload.prepublish_qa_artifact_id, payload.prepublish_qa_payload_hash, preQa, "wechat_prepublish_qa_report") &&
        artifactCanonicalJson(payload.upload_receipt_ids) === artifactCanonicalJson(orderedUploads.map(object => object.envelope.artifact_id)) &&
        artifactCanonicalJson(draftReceipt.envelope.input_artifact_ids) === artifactCanonicalJson([packageObject!.envelope.artifact_id, preQa!.envelope.artifact_id, ...orderedUploads.map(object => object.envelope.artifact_id)]),
      "wechat draft receipt parents conflict across execution scopes");
    }
    if (readback) {
      const payload = readback.payload as WechatDraftReadbackQAPayload;
      requireEarlier(sameParent(payload.package_artifact_id, payload.package_payload_hash, packageObject, "rendered_article_package") &&
        sameParent(payload.prepublish_qa_artifact_id, payload.prepublish_qa_payload_hash, preQa, "wechat_prepublish_qa_report") &&
        sameParent(payload.draft_receipt_artifact_id, payload.draft_receipt_payload_hash, draftReceipt, "wechat_draft_receipt") &&
        artifactCanonicalJson(payload.upload_receipt_ids) === artifactCanonicalJson(orderedUploads.map(object => object.envelope.artifact_id)) &&
        artifactCanonicalJson(readback.envelope.input_artifact_ids) === artifactCanonicalJson([packageObject!.envelope.artifact_id, preQa!.envelope.artifact_id, draftReceipt!.envelope.artifact_id, ...orderedUploads.map(object => object.envelope.artifact_id)]),
      "wechat readback parents conflict across execution scopes");
    }
    topologies.set(scope, { scope, recoveryCycle: cycles.get(scope) || null, artifacts, template, templatePayload, slots, uploads: orderedUploads, readbacks: readback ? [readback] : [] });
  }
  return topologies;
}

function validateWechatScopeRecoveryBindings(
  topologies: Map<string, WechatScopeTopology>,
  selectedScope: string,
  artifactRevisions: Map<string, number[]>,
  recoveryGroups: Map<string, WechatRecoveryGroup>,
): void {
  for (const recovery of recoveryGroups.values()) validateWechatRecoveryRevisionOrder(recovery);
  const scopeByRecoveryCycle = new Map<string, string>();
  for (const topology of topologies.values()) {
    if (topology.recoveryCycle === null) continue;
    const existingScope = scopeByRecoveryCycle.get(topology.recoveryCycle);
    if (existingScope !== undefined && existingScope !== topology.scope) {
      wechatTopologyFailure("wechat recovery cycle is bound to multiple execution scopes");
    }
    scopeByRecoveryCycle.set(topology.recoveryCycle, topology.scope);
  }
  for (const topology of topologies.values()) {
    const revisions = artifactRevisions.get(topology.scope) || [];
    if (revisions.length === 0) wechatTopologyFailure("wechat execution scope has no projection evidence");
    const first = Math.min(...revisions);
    const last = Math.max(...revisions);
    if (topology.recoveryCycle !== null) {
      const recovery = recoveryGroups.get(topology.recoveryCycle);
      if (!recovery || recovery.resumedRevision >= first) {
        wechatTopologyFailure("wechat recovered execution scope is not ordered after its recovery evidence");
      }
    }
    if (topology.scope === selectedScope) continue;
    // A retained historical prefix or failed graph is valid only when the
    // next complete recovery cycle is anchored by a canonical hold after its
    // final artifact receipt. A draft-syncing checkpoint alone cannot make a
    // stale epoch eligible for terminal replay.
    if (![...recoveryGroups.values()].some(group => group.holdRevision > last)) {
      wechatTopologyFailure("wechat historical execution scope lacks a following hold/recovery");
    }
  }
}

// Kept as a narrow testable boundary: completed replay calls the same
// resolver below, while contract fixtures can prove hash-self-consistent
// malicious graphs reach topology validation instead of a storage mismatch.
export function assertWechatScopeTopologyForVerification(objects: Map<string, WechatArtifactObject>): void {
  validateWechatScopeTopologies(objects);
}

function uniquePassingWechatExecutionScope(objects: Iterable<WechatArtifactObject>): string {
  const passing = [...objects].filter(object => object.envelope.kind === "wechat_draft_readback_qa" &&
    (object.payload as WechatDraftReadbackQAPayload).decision === "pass");
  if (passing.length !== 1) wechatTopologyFailure("wechat terminal execution scope is ambiguous");
  return wechatPayloadScope(passing[0]).scope;
}

export function assertUniquePassingWechatExecutionScopeForVerification(objects: Map<string, WechatArtifactObject>): void {
  uniquePassingWechatExecutionScope(objects.values());
}

// Narrow read-only fixture boundary for recovery-event topology. Production
// exact-set verification calls the same resolver below.
export function assertWechatScopeRecoveryBindingsForVerification(input: {
  objects: Map<string, WechatArtifactObject>;
  selectedScope: string;
  artifactRevisions: Record<string, number[]>;
  recoveryGroups: Record<string, WechatRecoveryGroup>;
}): void {
  validateWechatScopeRecoveryBindings(
    validateWechatScopeTopologies(input.objects),
    input.selectedScope,
    new Map(Object.entries(input.artifactRevisions)),
    new Map(Object.entries(input.recoveryGroups)),
  );
}

// Narrow read-only fixture boundary. Production exact-set verification invokes
// this same field validator after it derives the source hold from D1.
export function assertWechatRecoveryProjectionFieldsForVerification(input: {
  runId: string;
  target: string;
  checkpointState: string;
  hold: Pick<WechatRecoveryProjectionEvent, "revision" | "retry_count">;
  reconciled: WechatRecoveryProjectionEvent;
  retrying: WechatRecoveryProjectionEvent;
  resumed: WechatRecoveryProjectionEvent;
}): void {
  validateWechatRecoveryProjectionFields(input);
}

export function assertWechatHoldRevisionForVerification(stateRevision: number, holdRevision: number): void {
  validateWechatHoldRevision(stateRevision, holdRevision);
}

function uniquePassingWechatReadback(
  artifacts: WechatArtifactMetadata[],
  receiptIds: readonly string[],
): WechatArtifactMetadata | undefined {
  const values = artifacts.filter(item => item.kind === "wechat_draft_readback_qa" &&
    item.payload_summary.decision === "pass" && receiptIds.includes(item.artifact_id));
  if (values.length > 1) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat terminal readback evidence is ambiguous", 503);
  }
  return values[0];
}

async function verifyExactWechatArtifactSet(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  expectedSlots: readonly string[],
  executionScope?: string,
): Promise<void> {
  const ledger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
  const allCommitted = ledger.artifacts.filter(item => ledger.receipt_ids.includes(item.artifact_id));
  // The coordinator ledger remains globally exact: a historical epoch can be
  // retained for audit, but it must still have a matching receipt and event.
  if (allCommitted.length !== ledger.artifacts.length ||
      new Set(allCommitted.map(item => item.artifact_id)).size !== allCommitted.length ||
      artifactCanonicalJson([...ledger.receipt_ids].sort()) !== artifactCanonicalJson(allCommitted.map(item => item.artifact_id).sort()) ||
      artifactCanonicalJson([...ledger.event_artifacts].sort()) !== artifactCanonicalJson(allCommitted.map(item => item.artifact_id).sort())) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact receipt/event set is not globally exact", 503);
  }
  const rawScopes = allCommitted.map(item => item.payload_summary.execution_scope);
  if (rawScopes.some(scope => typeof scope !== "string" || !/^sha256:[a-f0-9]{64}$/.test(scope))) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact execution scope is invalid", 503);
  }
  const scopes = new Set(rawScopes as string[]);
  // A completed run is defined by exactly one immutable passing readback.
  // Callers may supply the expected scope only as an assertion, never as a
  // selector that could hide a second terminal epoch.
  const passing = allCommitted.filter(item => item.kind === "wechat_draft_readback_qa" && item.payload_summary.decision === "pass");
  const selectedScope = passing.length === 1 ? passing[0].payload_summary.execution_scope : null;
  if (typeof selectedScope !== "string" || !scopes.has(selectedScope) || (executionScope !== undefined && executionScope !== selectedScope)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat active execution scope is unavailable", 503);
  }
  const committed = allCommitted.filter(item => item.payload_summary.execution_scope === selectedScope);
  const expectedCount = expectedSlots.length + 6;
  if (committed.length !== expectedCount ||
      new Set(committed.map(item => item.artifact_id)).size !== expectedCount ||
      new Set(committed.map(item => item.kind === "wechat_image_upload_receipt" ? `${item.payload_summary.slot_id}:${item.payload_summary.operation_id}` : item.kind)).size !== expectedCount) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact receipt/event set is not exact", 503);
  }
  const byKind = (kind: WechatArtifactMetadata["kind"]) => committed.filter(item => item.kind === kind);
  if (byKind("wechat_render_template").length !== 1 || byKind("wechat_render_qa_report").length !== 1 ||
      byKind("wechat_image_upload_receipt").length !== expectedSlots.length || byKind("rendered_article_package").length !== 1 ||
      byKind("wechat_prepublish_qa_report").length !== 1 || byKind("wechat_draft_receipt").length !== 1 ||
      byKind("wechat_draft_readback_qa").length !== 1) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact kinds are not exact", 503);
  }
  const uploads = byKind("wechat_image_upload_receipt");
  if (artifactCanonicalJson(uploads.map(item => item.payload_summary.slot_id)) !== artifactCanonicalJson(expectedSlots) ||
      new Set(uploads.map(item => item.payload_summary.operation_id)).size !== uploads.length) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat upload slots are not exact", 503);
  }
  const expectedById = new Map(allCommitted.map(item => [item.artifact_id, item]));
  const objects = new Map<string, WechatArtifactObject>();
  for (const metadata of allCommitted) {
    const object = await readWechatArtifactFromR2(env, metadata);
    if (artifactCanonicalJson(toWechatArtifactMetadata(object)) !== artifactCanonicalJson(metadata)) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact metadata does not exactly read back", 503);
    }
    objects.set(metadata.artifact_id, object);
  }
  if (uniquePassingWechatExecutionScope(objects.values()) !== selectedScope) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat terminal readback identity conflicts", 503);
  }
  const topologies = validateWechatScopeTopologies(objects);
  const selectedTopology = topologies.get(selectedScope);
  if (!selectedTopology || selectedTopology.readbacks.length !== 1 ||
      (selectedTopology.readbacks[0].payload as WechatDraftReadbackQAPayload).decision !== "pass") {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat active execution topology is unavailable", 503);
  }
  // Every retained epoch renders the same accepted frozen/visual execution
  // input. Account receipt rotation may create a new epoch, but it may not
  // splice in a different frozen/visual parent graph.
  for (const topology of topologies.values()) {
    const value = topology.templatePayload;
    const active = selectedTopology.templatePayload;
    if (value.frozen_artifact_id !== active.frozen_artifact_id || value.frozen_payload_hash !== active.frozen_payload_hash ||
        value.visual_plan_artifact_id !== active.visual_plan_artifact_id || value.visual_plan_payload_hash !== active.visual_plan_payload_hash ||
        value.visual_qa_artifact_id !== active.visual_qa_artifact_id || value.visual_qa_payload_hash !== active.visual_qa_payload_hash ||
        artifactCanonicalJson(value.asset_artifact_ids) !== artifactCanonicalJson(active.asset_artifact_ids)) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat execution scope splices visual parents", 503);
    }
    if (topology.scope !== selectedScope && topology.readbacks.some(object =>
      (object.payload as WechatDraftReadbackQAPayload).decision === "pass")) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat historical execution scope passes readback", 503);
    }
  }
  const scopeRecoveryCycles = new Map<string, string | null>([...topologies.values()].map(topology => [topology.scope, topology.recoveryCycle]));
  const only = (kind: WechatArtifactMetadata["kind"]): WechatArtifactObject => {
    const values = [...objects.values()].filter(object => object.envelope.kind === kind &&
      (object.payload as { execution_scope?: string }).execution_scope === selectedScope);
    if (values.length !== 1) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact kind is not unique", 503);
    return values[0];
  };
  const sameIds = (actual: readonly string[], expected: readonly string[]): boolean =>
    artifactCanonicalJson(actual) === artifactCanonicalJson(expected);
  const template = only("wechat_render_template");
  const templatePayload = template.payload as WechatRenderTemplatePayload;
  const coreArtifacts = await coordinator.listFiveAgentArtifacts(params.run_id, params.user_id, params.workspace_id);
  const frozen = coreArtifacts.find(item => item.kind === "frozen_article_version" && item.artifact_id === templatePayload.frozen_artifact_id) as StoredArtifactMetadata | undefined;
  if (!frozen || frozen.payload_hash !== templatePayload.frozen_payload_hash) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat template is not bound to the accepted frozen artifact", 503);
  }
  const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
  const frozenPayload = frozenObject.payload as FrozenArticleVersion;
  const frozenSlotCount = Array.from(frozenPayload.body).length >= 5000 ? 6 : 3;
  const frozenSlots = ["cover_01", ...Array.from({ length: frozenSlotCount - 1 }, (_, index) => `body_${String(index + 1).padStart(2, "0")}`)];
  if (!sameIds(expectedSlots, frozenSlots) || templatePayload.asset_artifact_ids.length !== frozenSlotCount ||
      templatePayload.body_slots.length !== frozenSlotCount - 1) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat slot set is not independently bound to frozen content", 503);
  }
  const renderQa = only("wechat_render_qa_report");
  const renderQaPayload = renderQa.payload as WechatRenderQAReportPayload;
  const packageObject = only("rendered_article_package");
  const packagePayload = packageObject.payload as RenderedArticlePackagePayload;
  const preQa = only("wechat_prepublish_qa_report");
  const preQaPayload = preQa.payload as WechatPrepublishQAReportPayload;
  const draftReceipt = only("wechat_draft_receipt");
  const draftReceiptPayload = draftReceipt.payload as WechatDraftReceiptPayload;
  const readback = only("wechat_draft_readback_qa");
  const readbackPayload = readback.payload as WechatDraftReadbackQAPayload;
  const orderedUploads = uploads.sort((left, right) => Number(left.payload_summary.order || 0) - Number(right.payload_summary.order || 0));
  const orderedUploadIds = orderedUploads.map(item => item.artifact_id);
  const uploadPayloads = orderedUploads.map(item => objects.get(item.artifact_id)?.payload as WechatImageUploadReceiptPayload | undefined);
  let packageBodyUrls: string[] = [];
  try {
    packageBodyUrls = validateWechatHtml(packagePayload.canonical_html, uploadPayloads.slice(1).map(payload => payload?.media_url || "")).body_urls;
    if (packageBodyUrls.some(url => !isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, url))) throw new Error("media host");
  } catch {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat package HTML does not bind upload receipts", 503);
  }
  const visualLedger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
  const visualAssets = new Map(visualLedger.artifacts.filter(item => item.kind === "visual_asset" && visualLedger.receipt_ids.includes(item.artifact_id)).map(item => [item.artifact_id, item]));
  const uploadEvidenceValid = await Promise.all(uploadPayloads.map(async (payload, index) => {
    const providerEvidencePrefix = payload ? `wechat-adapter/v1/result/${payload.operation_id}/` : "";
    if (!payload || typeof payload.provider_result_ref !== "string" ||
        !payload.provider_result_ref.startsWith(providerEvidencePrefix) ||
        !/^[1-3]\.json$/.test(payload.provider_result_ref.slice(providerEvidencePrefix.length)) ||
        !/^sha256:[a-f0-9]{64}$/.test(payload.provider_result_hash) ||
        !isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, payload.media_url)) return false;
    const visual = visualAssets.get(payload.visual_asset_artifact_id);
    if (!visual || visual.payload_hash !== payload.visual_asset_payload_hash) return false;
    const visualObject = await readVisualArtifactFromR2(env, visual);
    const visualPayload = visualObject.payload as VisualAssetPayload;
    if (visualPayload.byte_hash !== payload.asset_byte_hash || visualPayload.slot_id !== payload.slot_id) return false;
    if (index === 0) return payload.purpose === "cover" && payload.media_kind === "thumb" && typeof payload.cover_media_id === "string" && OPAQUE_ID.test(payload.cover_media_id);
    return payload.purpose === "body" && payload.media_kind === "body" && payload.cover_media_id === null;
  }));
  const graphValid =
    sameIds(template.envelope.input_artifact_ids, [templatePayload.frozen_artifact_id, templatePayload.visual_plan_artifact_id, ...templatePayload.asset_artifact_ids, templatePayload.visual_qa_artifact_id]) &&
    templatePayload.asset_artifact_ids.length === expectedSlots.length &&
    renderQaPayload.template_artifact_id === template.envelope.artifact_id && renderQaPayload.template_payload_hash === template.envelope.payload_hash &&
    sameIds(renderQa.envelope.input_artifact_ids, [template.envelope.artifact_id]) &&
    sameIds(templatePayload.asset_artifact_ids, uploadPayloads.map(payload => payload?.visual_asset_artifact_id || "")) &&
    uploadPayloads.every((payload, index) => Boolean(payload) && uploadEvidenceValid[index] &&
      payload!.frozen_artifact_id === templatePayload.frozen_artifact_id && payload!.frozen_payload_hash === templatePayload.frozen_payload_hash &&
      payload!.visual_plan_artifact_id === templatePayload.visual_plan_artifact_id && payload!.visual_plan_payload_hash === templatePayload.visual_plan_payload_hash &&
      payload!.visual_qa_artifact_id === templatePayload.visual_qa_artifact_id && payload!.visual_qa_payload_hash === templatePayload.visual_qa_payload_hash &&
      payload!.slot_id === expectedSlots[index] && payload!.order === index &&
      sameIds(orderedUploads[index].artifact_id ? objects.get(orderedUploads[index].artifact_id)!.envelope.input_artifact_ids : [],
        [payload!.frozen_artifact_id, payload!.visual_plan_artifact_id, payload!.visual_asset_artifact_id, payload!.visual_qa_artifact_id])) &&
    packagePayload.template_artifact_id === template.envelope.artifact_id && packagePayload.template_payload_hash === template.envelope.payload_hash &&
    packagePayload.render_qa_artifact_id === renderQa.envelope.artifact_id && packagePayload.render_qa_payload_hash === renderQa.envelope.payload_hash &&
    sameIds(packagePayload.upload_receipt_ids, orderedUploadIds) &&
    sameIds(packagePayload.body_image_slots, uploadPayloads.slice(1).map(payload => payload?.slot_id || "")) &&
    packagePayload.thumb_slot_id === uploadPayloads[0]?.slot_id &&
    sameIds(packageBodyUrls, uploadPayloads.slice(1).map(payload => payload?.media_url || "")) &&
    sameIds(packageObject.envelope.input_artifact_ids, [template.envelope.artifact_id, renderQa.envelope.artifact_id, ...orderedUploadIds]) &&
    preQaPayload.package_artifact_id === packageObject.envelope.artifact_id && preQaPayload.package_payload_hash === packageObject.envelope.payload_hash &&
    sameIds(preQaPayload.ordered_upload_receipt_ids, orderedUploadIds) && sameIds(preQa.envelope.input_artifact_ids, [packageObject.envelope.artifact_id, ...orderedUploadIds]) &&
    draftReceiptPayload.package_artifact_id === packageObject.envelope.artifact_id && draftReceiptPayload.package_payload_hash === packageObject.envelope.payload_hash &&
    draftReceiptPayload.prepublish_qa_artifact_id === preQa.envelope.artifact_id && draftReceiptPayload.prepublish_qa_payload_hash === preQa.envelope.payload_hash &&
    sameIds(draftReceiptPayload.upload_receipt_ids, orderedUploadIds) && sameIds(draftReceipt.envelope.input_artifact_ids, [packageObject.envelope.artifact_id, preQa.envelope.artifact_id, ...orderedUploadIds]) &&
    readbackPayload.draft_receipt_artifact_id === draftReceipt.envelope.artifact_id && readbackPayload.draft_receipt_payload_hash === draftReceipt.envelope.payload_hash &&
    readbackPayload.package_artifact_id === packageObject.envelope.artifact_id && readbackPayload.package_payload_hash === packageObject.envelope.payload_hash &&
    readbackPayload.prepublish_qa_artifact_id === preQa.envelope.artifact_id && readbackPayload.prepublish_qa_payload_hash === preQa.envelope.payload_hash &&
    renderQaPayload.decision === "pass" && preQaPayload.decision === "pass" &&
    readbackPayload.decision === "pass" && readbackPayload.checks.media && readbackPayload.checks.title &&
    readbackPayload.checks.html && readbackPayload.checks.urls && readbackPayload.checks.thumb &&
    readbackPayload.checks.article_index === 0 &&
    draftReceiptPayload.verified_thumb_media_id === uploadPayloads[0]?.cover_media_id &&
    draftReceiptPayload.verified_cover_image_url === uploadPayloads[0]?.media_url &&
    readbackPayload.verified_draft_media_id === draftReceiptPayload.verified_draft_media_id &&
    readbackPayload.verified_thumb_media_id === draftReceiptPayload.verified_thumb_media_id &&
    readbackPayload.verified_cover_image_url === draftReceiptPayload.verified_cover_image_url &&
    sameIds(readbackPayload.upload_receipt_ids, orderedUploadIds) && sameIds(readback.envelope.input_artifact_ids, [packageObject.envelope.artifact_id, preQa.envelope.artifact_id, draftReceipt.envelope.artifact_id, ...orderedUploadIds]);
  if (!graphValid) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact graph is not exact", 503);
  }
  const firstKey = allCommitted[0]?.artifact_key;
  const marker = "/wechat/";
  const markerIndex = firstKey?.indexOf(marker) ?? -1;
  if (markerIndex < 0) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact prefix is invalid", 503);
  const prefix = firstKey!.slice(0, markerIndex + marker.length);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map(item => item.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (artifactCanonicalJson(keys.sort()) !== artifactCanonicalJson(allCommitted.map(item => item.artifact_key).sort())) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat R2 artifact set is not exact", 503);
  }
  const mirrored = await env.DB.prepare(`SELECT artifact_id, run_id, article_id, recording_id, user_id, workspace_id,
      schema_version, kind, producer_agent_role, producer_agent_version, skill_id, skill_version, workflow_version,
      policy_version, input_artifact_ids_json, payload_hash, storage_ref, created_at
      FROM editorial_artifacts WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND schema_version = ?`)
    .bind(params.run_id, params.user_id, params.workspace_id, WAVE2D_SCHEMA_VERSION).all<Record<string, unknown>>();
  if ((mirrored.results || []).length !== allCommitted.length) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat D1 artifact set is not exact", 503);
  for (const row of mirrored.results || []) {
    const metadata = expectedById.get(String(row.artifact_id));
    if (!metadata || String(row.run_id) !== metadata.run_id || String(row.article_id) !== metadata.article_id ||
        Number(row.recording_id) !== metadata.recording_id || String(row.user_id) !== metadata.user_id ||
        String(row.workspace_id) !== metadata.workspace_id || String(row.schema_version) !== metadata.schema_version ||
        String(row.kind) !== metadata.kind || String(row.producer_agent_role) !== metadata.producer.role ||
        String(row.producer_agent_version) !== metadata.producer.version || String(row.workflow_version) !== "editorial-workflow.v3" ||
        String(row.policy_version) !== "editorial-policy.v3" || String(row.input_artifact_ids_json) !== artifactCanonicalJson(metadata.input_artifact_ids) ||
        String(row.payload_hash) !== metadata.payload_hash || String(row.storage_ref) !== metadata.storage_ref ||
        String(row.created_at) !== metadata.created_at || String(row.skill_id) !== "wechat-pin-snapshot" ||
        String(row.skill_version) !== artifactCanonicalJson({
          pins: WECHAT_ACTIVE_PINS,
          execution_scope: metadata.payload_summary.execution_scope,
          recovery_cycle: metadata.payload_summary.recovery_cycle,
        })) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat D1 artifact identity is not exact", 503);
    }
  }
  const projection = await env.DB.prepare(`SELECT state FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id).first<{ state: PublicationState }>();
  if (!projection) throw new EditorialRuntimeError("publication_run_not_found", "publication run is unavailable", 404);
  const expectedEvents = allCommitted.map(item => ({ idempotency_key: item.idempotency_key, payload_hash: item.payload_hash }));
  // Uploads are gated by this separately persisted local state checkpoint; it
  // is part of the terminal evidence even though it has no artifact receipt.
  for (const scope of scopes) {
    const hasUploads = allCommitted.some(item => item.payload_summary.execution_scope === scope && item.kind === "wechat_image_upload_receipt");
    const recoveryCycle = scopeRecoveryCycles.get(scope);
    if (recoveryCycle === undefined) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat execution scope is missing epoch evidence", 503);
    }
    // A historical recovery epoch must be tied to the unique, complete
    // recovery triplet for its source hold. The detailed triplet validation
    // below verifies the event hash and hold identity; this early lookup binds
    // an artifact graph to that exact cycle before accepting it as a prefix.
    if (recoveryCycle !== null) {
      const resumedRows = await env.DB.prepare(`SELECT idempotency_key FROM publication_run_events
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND event_type = 'wechat_reconciliation_resumed'`)
        .bind(params.run_id, params.user_id, params.workspace_id)
        .all<{ idempotency_key: string }>();
      const resumed = (resumedRows.results || []).some(row =>
        /^wave2d:resumed:[a-f0-9]{32}:[^:]+:[A-Za-z0-9._:-]+$/.test(row.idempotency_key) &&
        row.idempotency_key.startsWith(`wave2d:resumed:${recoveryCycle}:`) &&
        row.idempotency_key.endsWith(`:${params.run_id}`),
      );
      if (!resumed) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery epoch has no matching resume evidence", 503);
      }
    }
    const scopePrefix = `wave2d:draft-syncing:${scope.slice(7, 39)}:${params.run_id}`;
    const checkpoint = (await env.DB.prepare(`SELECT idempotency_key, payload_hash, event_type, state FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id, scopePrefix).first<{ idempotency_key: string; payload_hash: string; event_type: string; state: string }>()) || null;
    if (!checkpoint) {
      // A corrected readback may create a complete, immutable audit epoch at
      // draft_verifying without reissuing already-confirmed upload writes.
      // Its trusted recovery triplet is the equivalent side-effect boundary.
      const passReadback = allCommitted.some(item => item.payload_summary.execution_scope === scope &&
        item.kind === "wechat_draft_readback_qa" && item.payload_summary.decision === "pass");
      const recoveredDraftVerifying = recoveryCycle === null ? null : await env.DB.prepare(`SELECT 1 FROM publication_run_events
        WHERE run_id = ? AND user_id = ? AND workspace_id = ?
          AND idempotency_key = ? AND event_type = 'wechat_reconciliation_resumed' AND state = 'draft_verifying'
        LIMIT 1`).bind(params.run_id, params.user_id, params.workspace_id,
          `wave2d:resumed:${recoveryCycle}:draft_verifying:${params.run_id}`).first<{ 1: number }>();
      if (passReadback && recoveredDraftVerifying) continue;
      // A failed prefix may legitimately stop before an upload. It remains
      // auditable only if a later hold/recovery event proves why this scope
      // was abandoned; that ordering check runs after all recovery triplets
      // are parsed below.
      if (!hasUploads) {
        continue;
      }
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat draft-syncing checkpoint is not exact", 503);
    }
    if (checkpoint.event_type !== "draft_syncing" || checkpoint.state !== "draft_syncing" || checkpoint.payload_hash !== await hashJson({
      run_payload_hash: params.payload_hash, event_type: "draft_syncing", execution_scope: scope,
      phase: 220, target_state: "draft_syncing", error_code: null, next_action: null,
      revision_count: null, retry_count: null,
    })) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat draft-syncing checkpoint is not exact", 503);
    }
    expectedEvents.push({ idempotency_key: checkpoint.idempotency_key, payload_hash: checkpoint.payload_hash });
  }
  if (projection.state === "draft_ready") {
    const readyHash = await hashJson({
      event: "draft_ready",
      readback_artifact_id: readback.envelope.artifact_id,
      readback_payload_hash: readback.envelope.payload_hash,
    });
    expectedEvents.push({
      idempotency_key: `wave2d:draft-ready:${readback.envelope.artifact_id}:${readback.envelope.payload_hash}`,
      payload_hash: readyHash,
    });
  }
  const publicationEvents = await env.DB.prepare(`SELECT revision, event_id, idempotency_key, payload_hash, event_type, state, error_code, next_action, retry_count, created_at
    FROM publication_run_events WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key LIKE 'wave2d:%'`)
    .bind(params.run_id, params.user_id, params.workspace_id).all<{ revision: number; event_id: string; idempotency_key: string; payload_hash: string; event_type: string; state: string; error_code: string | null; next_action: string | null; retry_count: number; created_at: string }>();
  const rows = publicationEvents.results || [];
  const wave2dHolds = rows.filter(event => event.idempotency_key.startsWith("wave2d:needs-action:"));
  const holdStateRevisions = new Map<string, number>();
  for (const hold of wave2dHolds) {
    const prefix = "wave2d:needs-action:";
    const suffix = `:${params.run_id}`;
    const parts = hold.idempotency_key.startsWith(prefix) && hold.idempotency_key.endsWith(suffix)
      ? hold.idempotency_key.slice(prefix.length, -suffix.length).split(":")
      : [];
    const phase = Number(parts[0]);
    const stateRevision = Number(parts.at(-1));
    const errorCode = parts.slice(1, -1).join(":");
    const expectedAction = errorCode === "draft_readback_mismatch" || errorCode === "draft_readback_unavailable" ? "reconcile_draft" :
      errorCode === "draft_identity_unresolved" ? "reconcile_draft_identity" :
      errorCode === "wechat_publishing_account_not_allowed" ? "request_account_enablement" :
      errorCode === "wechat_publishing_account_unavailable" || errorCode === "wechat_publishing_account_rejected" || errorCode === "wechat_access_token_rejected"
        ? "repair_publishing_account"
        : "reconcile_external_side_effect";
    if (!Number.isInteger(phase) || phase < 0 || !Number.isInteger(stateRevision) || stateRevision < 0 ||
        !WECHAT_RESUMABLE_HOLDS.has(errorCode) || hold.state !== "needs_action" || hold.event_type !== "needs_action" ||
        hold.error_code !== errorCode || hold.next_action !== expectedAction || hold.retry_count < 1 ||
        hold.payload_hash !== await hashJson({
          run_payload_hash: params.payload_hash,
          event_type: "needs_action",
          phase,
          target_state: "needs_action",
          error_code: errorCode,
          next_action: expectedAction,
          revision_count: null,
          retry_count: hold.retry_count,
        })) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat hold event is not exact", 503);
    }
    validateWechatHoldRevision(stateRevision, hold.revision);
    holdStateRevisions.set(hold.idempotency_key, stateRevision);
    expectedEvents.push({ idempotency_key: hold.idempotency_key, payload_hash: hold.payload_hash });
  }
  const recoveryRows = rows.filter(event => /^(wave2d:reconciled:|wave2d:retrying:|wave2d:resumed:)/.test(event.idempotency_key));
  const recoveryGroups = new Map<string, WechatRecoveryGroup>();
  if (recoveryRows.length > 0) {
    type RecoveryRow = typeof recoveryRows[number];
    const cycles = new Map<string, Partial<Record<"reconciled" | "retrying" | "resumed", RecoveryRow>> & { target?: string }>();
    const suffix = `:${params.run_id}`;
    for (const event of recoveryRows) {
      const match = /^wave2d:(reconciled|retrying|resumed):([a-f0-9]{32}):([^:]+):/.exec(event.idempotency_key);
      if (!match || !event.idempotency_key.endsWith(suffix)) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery event key is invalid", 503);
      }
      const [, phase, cycle, target] = match;
      const expectedKey = `wave2d:${phase}:${cycle}:${target}:${params.run_id}`;
      if (event.idempotency_key !== expectedKey || !WECHAT_RESUMABLE_STATES.has(target)) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery event key is not canonical", 503);
      }
      const group = cycles.get(cycle) || { target };
      if (group.target !== target || group[phase as "reconciled" | "retrying" | "resumed"]) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cycle is duplicated", 503);
      }
      group[phase as "reconciled" | "retrying" | "resumed"] = event;
      cycles.set(cycle, group);
    }
    for (const [cycle, group] of cycles) {
      const target = group.target;
      const reconciled = group.reconciled;
      const retrying = group.retrying;
      const resumed = group.resumed;
      if (!target || !reconciled || !retrying || !resumed ||
          reconciled.event_type !== "wechat_side_effect_reconciled" || reconciled.state !== "needs_action" ||
          retrying.event_type !== "wechat_reconciliation_retrying" || retrying.state !== "retrying" ||
          resumed.event_type !== "wechat_reconciliation_resumed" || resumed.state !== target ||
          retrying.revision !== reconciled.revision + 1 || resumed.revision !== retrying.revision + 1) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cycle is incomplete", 503);
      }
      let matchedHold: typeof wave2dHolds[number] | undefined;
      for (const hold of wave2dHolds) {
        const candidate = (await hashJson({
          run_id: params.run_id,
          target,
          hold_revision: hold.revision,
          hold_idempotency_key: hold.idempotency_key,
          hold_payload_hash: hold.payload_hash,
        })).slice(7, 39);
        if (candidate === cycle) {
          if (matchedHold) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cycle has ambiguous hold evidence", 503);
          matchedHold = hold;
        }
      }
      if (!matchedHold) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cycle has no hold evidence", 503);
      const checkpointRevision = holdStateRevisions.get(matchedHold.idempotency_key);
      if (checkpointRevision === undefined) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery hold revision is unavailable", 503);
      }
      const checkpoint = await env.DB.prepare(`SELECT state FROM publication_run_events
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND revision = ? LIMIT 1`)
        .bind(params.run_id, params.user_id, params.workspace_id, checkpointRevision).first<{ state: string }>();
      if (!checkpoint) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat held checkpoint is unavailable", 503);
      const expectedHash = (event: string) => hashJson({
        run_payload_hash: params.payload_hash,
        event,
        target,
        recovery_cycle: cycle,
        recovered_hold: { revision: matchedHold!.revision, idempotency_key: matchedHold!.idempotency_key, payload_hash: matchedHold!.payload_hash },
      });
      const reconciledHash = await expectedHash("wechat_side_effect_reconciled");
      const retryHash = await expectedHash("wechat_reconciliation_retrying");
      const resumeHash = await expectedHash("wechat_reconciliation_resumed");
      if (reconciled.payload_hash !== reconciledHash || retrying.payload_hash !== retryHash || resumed.payload_hash !== resumeHash) {
        throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery payload identity is not exact", 503);
      }
      validateWechatRecoveryProjectionFields({
        runId: params.run_id,
        target,
        checkpointState: checkpoint.state,
        hold: matchedHold,
        reconciled,
        retrying,
        resumed,
      });
      const recoveryGroup = {
        target,
        holdRevision: matchedHold.revision,
        reconciledRevision: reconciled.revision,
        retryingRevision: retrying.revision,
        resumedRevision: resumed.revision,
      };
      validateWechatRecoveryRevisionOrder(recoveryGroup);
      recoveryGroups.set(cycle, recoveryGroup);
      expectedEvents.push(
        { idempotency_key: reconciled.idempotency_key, payload_hash: reconciledHash },
        { idempotency_key: retrying.idempotency_key, payload_hash: retryHash },
        { idempotency_key: resumed.idempotency_key, payload_hash: resumeHash },
      );
    }
  }
  // Bind retained epoch graphs to the recovery cycle that precedes them. The
  // initial epoch is unique and may only be historical when a later verified
  // hold/recovery sequence follows its own artifact receipts; recovered
  // epochs must begin after their exact resumed event.
  const artifactRevisions = new Map<string, number[]>();
  for (const topology of topologies.values()) {
    const identities = new Set(topology.artifacts.map(object => `${object.envelope.idempotency_key}:${object.envelope.payload_hash}`));
    const revisions = rows.filter(event => identities.has(`${event.idempotency_key}:${event.payload_hash}`)).map(event => event.revision);
    if (revisions.length !== topology.artifacts.length) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat execution scope artifacts lack projection evidence", 503);
    }
    artifactRevisions.set(topology.scope, revisions);
  }
  try {
    validateWechatScopeRecoveryBindings(topologies, selectedScope, artifactRevisions, recoveryGroups);
  } catch (error) {
    if (error instanceof EditorialRuntimeError) throw error;
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat execution scope recovery evidence is invalid", 503);
  }
  if (artifactCanonicalJson((publicationEvents.results || []).map(event => ({ idempotency_key: event.idempotency_key, payload_hash: event.payload_hash })).sort((left, right) => left.idempotency_key.localeCompare(right.idempotency_key))) !==
      artifactCanonicalJson(expectedEvents.sort((left, right) => left.idempotency_key.localeCompare(right.idempotency_key)))) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat publication event set is not exact", 503);
  }
}

async function finalizeWechatDraft(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  readback: WechatArtifactMetadata,
  draftId: string,
  verifiedCoverImageUrl: string | undefined,
): Promise<{ doStateRevision: number; projectionRevision: number }> {
  const readbackObject = await readWechatArtifactFromR2(env, readback);
  if (readbackObject.envelope.kind !== "wechat_draft_readback_qa") {
    throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "draft-ready evidence is not a readback QA artifact", 409);
  }
  const readbackPayload = readbackObject.payload as WechatDraftReadbackQAPayload;
  if (readbackPayload.decision !== "pass" || !readbackPayload.checks.media || !readbackPayload.checks.title ||
      !readbackPayload.checks.html || !readbackPayload.checks.urls || !readbackPayload.checks.thumb ||
      readbackPayload.checks.article_index !== 0 ||
      readbackPayload.verified_draft_media_id !== draftId ||
      !OPAQUE_ID.test(readbackPayload.verified_thumb_media_id) ||
      readbackPayload.verified_cover_image_url !== (verifiedCoverImageUrl || null)) {
    throw new EditorialRuntimeError("draft_readback_mismatch", "draft-ready evidence is not a verified readback", 409);
  }
  const coreArtifacts = await coordinator.listFiveAgentArtifacts(params.run_id, params.user_id, params.workspace_id);
  const frozen = coreArtifacts.find(item => item.kind === "frozen_article_version") as StoredArtifactMetadata | undefined;
  if (!frozen) throw new EditorialRuntimeError("frozen_artifact_not_found", "draft-ready evidence cannot find frozen input", 503);
  const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
  const expectedSlots = Array.from((frozenObject.payload as FrozenArticleVersion).body).length >= 5000 ? 6 : 3;
  if (readbackPayload.upload_receipt_ids.length !== expectedSlots || new Set(readbackPayload.upload_receipt_ids).size !== expectedSlots) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready receipt slot count is not bound to frozen input", 503);
  }
  const currentDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const projection = await env.DB.prepare(`SELECT state, state_revision FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id).first<{ state: PublicationState; state_revision: number }>();
  if (!projection) throw new EditorialRuntimeError("publication_run_not_found", "publication run is unavailable", 404);
  if (projection.state === "draft_ready") {
    const recording = await env.DB.prepare(`SELECT wechat_draft_id, cover_image_url FROM recordings
      WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(params.recording_id, params.user_id, params.workspace_id)
      .first<{ wechat_draft_id: string | null; cover_image_url: string | null }>();
    if (!recording || recording.wechat_draft_id !== draftId ||
        (verifiedCoverImageUrl !== undefined && recording.cover_image_url !== verifiedCoverImageUrl)) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready replay recording evidence conflicts", 503);
    }
  }
  const idempotencyKey = `wave2d:draft-ready:${readback.artifact_id}:${readback.payload_hash}`;
  // The projection trigger requires every event to carry distinct canonical
  // evidence. A draft-ready event is not the readback-artifact receipt, even
  // though it is derived from that receipt.
  const finalEventPayloadHash = await hashJson({
    event: "draft_ready",
    readback_artifact_id: readback.artifact_id,
    readback_payload_hash: readback.payload_hash,
  });
  const applied = await applySystemPublicationTransition(env.DB, {
    runId: params.run_id,
    auth: { userId: params.user_id, workspaceId: params.workspace_id },
    targetState: "draft_ready",
    expectedStateRevision: projection.state_revision,
    compatibilityProjection: { recordingId: params.recording_id, wechatDraftId: draftId, ...(verifiedCoverImageUrl ? { verifiedCoverImageUrl } : {}) },
    options: {
      eventId: `${params.run_id}:wechat:ready:${readback.artifact_id}`,
      eventType: "draft_ready",
      eventIdempotencyKey: idempotencyKey,
      eventPayloadHash: finalEventPayloadHash,
      eventCreatedAt: readback.created_at,
    },
  });
  const doRevision = Number(currentDo.state_revision) + 1;
  await coordinator.recordFiveAgentState({
    run_id: params.run_id,
    state: "draft_ready",
    state_revision: doRevision,
    event_type: "draft_ready",
    payload_hash: finalEventPayloadHash,
    created_at: projectionEventCreatedAt(applied.run),
  });
  return { doStateRevision: doRevision, projectionRevision: applied.run.state_revision };
}

async function assertVerifiedWechatDraftReadyEvidence(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  readback: WechatArtifactMetadata,
): Promise<{ draftId: string; coverUrl?: string }> {
  const object = await readWechatArtifactFromR2(env, readback);
  if (object.envelope.kind !== "wechat_draft_readback_qa") throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "draft-ready evidence is not readback QA", 409);
  const payload = object.payload as WechatDraftReadbackQAPayload;
  if (payload.decision !== "pass" || !payload.checks.media || !payload.checks.title || !payload.checks.html ||
      !payload.checks.urls || !payload.checks.thumb || payload.checks.article_index !== 0) {
    throw new EditorialRuntimeError("draft_readback_mismatch", "draft-ready readback does not pass", 409);
  }
  const frozen = (await coordinator.listFiveAgentArtifacts(params.run_id, params.user_id, params.workspace_id))
    .find(item => item.kind === "frozen_article_version") as StoredArtifactMetadata | undefined;
  if (!frozen) throw new EditorialRuntimeError("frozen_artifact_not_found", "draft-ready evidence cannot find frozen input", 503);
  const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
  const expectedSlotCount = Array.from((frozenObject.payload as FrozenArticleVersion).body).length >= 5000 ? 6 : 3;
  if (payload.upload_receipt_ids.length !== expectedSlotCount || new Set(payload.upload_receipt_ids).size !== expectedSlotCount) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready evidence has the wrong slot set", 503);
  }
  const visualLedger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
  const visualSlots = visualLedger.artifacts
    .filter(item => item.kind === "visual_asset" && visualLedger.receipt_ids.includes(item.artifact_id))
    .sort((left, right) => Number(left.payload_summary.order || 0) - Number(right.payload_summary.order || 0))
    .map(item => String(item.payload_summary.slot_id));
  const expectedSlots = ["cover_01", ...Array.from({ length: expectedSlotCount - 1 }, (_, index) => `body_${String(index + 1).padStart(2, "0")}`)];
  if (artifactCanonicalJson(visualSlots) !== artifactCanonicalJson(expectedSlots)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready visual slot provenance is not exact", 503);
  }
  return { draftId: payload.verified_draft_media_id, ...(payload.verified_cover_image_url ? { coverUrl: payload.verified_cover_image_url } : {}) };
}

async function requireWechatAccount(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
  createdAt: string,
): Promise<{ account_binding_id: string; account_receipt_hash: string; config_hash: string }> {
  const operationId = await wechatOperationId("resolve_account", { run_id: params.run_id, user_id: params.user_id, workspace_id: params.workspace_id, article_id: params.article_id });
  const response = await callWechatPublishingAdapter(env, "resolve_account", {
    operation_id: operationId, attempt: 1, user_id: params.user_id, workspace_id: params.workspace_id, article_id: params.article_id, payload: { created_at: createdAt },
  });
  const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : null;
  if (!result || result.version !== "wechat-account-resolution.v1" ||
      typeof result.account_binding_id !== "string" || typeof result.config_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(result.config_hash) || typeof result.receipt_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(result.receipt_hash)) {
    throw new EditorialRuntimeError("wechat_account_receipt_invalid", "wechat account receipt is invalid", 502);
  }
  if (!isWechatAccountAllowed(env.WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST, result.account_binding_id, env)) throw new EditorialRuntimeError("wechat_publishing_account_not_allowed", "wechat account is not allowlisted", 409);
  const expectedReceiptHash = await hashJson({
    version: "wechat-account-resolution.v1",
    user_id: params.user_id,
    workspace_id: params.workspace_id,
    article_id: params.article_id,
    account_binding_id: result.account_binding_id,
    config_hash: result.config_hash,
  });
  if (result.receipt_hash !== expectedReceiptHash) {
    throw new EditorialRuntimeError("wechat_account_receipt_invalid", "wechat account receipt does not bind its configuration", 502);
  }
  return { account_binding_id: result.account_binding_id, account_receipt_hash: result.receipt_hash, config_hash: result.config_hash };
}

function base64(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof native.toBase64 === "function") return native.toBase64();
  let value = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    value += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk)));
  }
  return btoa(value);
}

// Envelope idempotency keys must remain opaque identifiers. Preserve the
// complete canonical operation identity in the digest instead of truncating
// a raw tuple that can include several SHA-256 values.
async function wechatArtifactIdempotencyKey(kind: string, identity: Record<string, unknown>): Promise<string> {
  return `wave2d:${kind}:${await hashJson(identity)}`;
}

async function existingWechatDraftClue(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT wechat_draft_id FROM recordings
    WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.recording_id, params.user_id, params.workspace_id)
    .first<{ wechat_draft_id: string | null }>();
  if (!row || row.wechat_draft_id === null || row.wechat_draft_id === "") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(row.wechat_draft_id)) {
    throw new EditorialRuntimeError("draft_identity_unresolved", "stored WeChat draft identity is invalid", 409);
  }
  return row.wechat_draft_id;
}

async function isValidWechatDraftReadback(env: EditorialRuntimeEnv, value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  if (typeof draft.media_id !== "string" || !OPAQUE_ID.test(draft.media_id) ||
      typeof draft.title !== "string" || draft.title.length === 0 || typeof draft.thumb_media_id !== "string" || !OPAQUE_ID.test(draft.thumb_media_id) ||
      Number(draft.article_index) !== 0 || typeof draft.canonical_html !== "string" || typeof draft.html_hash !== "string") return false;
  try {
    const canonical = normalizeWechatHtml(draft.canonical_html);
    const urls = Array.isArray(draft.body_urls) && draft.body_urls.every(url => typeof url === "string")
      ? draft.body_urls as string[]
      : [];
    const validation = validateWechatHtml(canonical, urls);
    if (validation.body_urls.some(url => !isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, url))) return false;
    return validation.canonical_html === canonical && draft.html_hash === await sha256(new TextEncoder().encode(canonical));
  } catch {
    return false;
  }
}

async function isExactWechatDraftReadback(
  env: EditorialRuntimeEnv,
  value: unknown,
  fingerprint: {
    title: string;
    canonical_html: string;
    html_hash: string;
    thumb_media_id: string;
  },
): Promise<boolean> {
  if (!await isValidWechatDraftReadback(env, value)) return false;
  const draft = value as Record<string, unknown>;
  try {
    const canonical = normalizeWechatHtml(String(draft.canonical_html));
    if (canonical !== fingerprint.canonical_html || draft.html_hash !== fingerprint.html_hash ||
        draft.title !== fingerprint.title || draft.thumb_media_id !== fingerprint.thumb_media_id ||
        draft.html_hash !== await sha256(new TextEncoder().encode(canonical))) return false;
    const urls = Array.isArray(draft.body_urls) && draft.body_urls.every(url => typeof url === "string")
      ? draft.body_urls as string[]
      : [];
    const expectedUrls = [...fingerprint.canonical_html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    return artifactCanonicalJson(urls) === artifactCanonicalJson(expectedUrls);
  } catch {
    return false;
  }
}

async function completeWechatReadOnlyCall(
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  call: { call_id: string; response: Record<string, unknown> },
  createdAt: string,
): Promise<void> {
  await coordinator.completeFiveAgentCall({
    call_id: call.call_id,
    run_id: params.run_id,
    status: "succeeded",
    response_hash: await hashJson(call.response.result || {}),
    recorded_at: createdAt,
  });
}

async function callWechatOperation(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
  operation: "upload_image" | "write_draft" | "get_draft" | "find_draft",
  request: Record<string, unknown>,
  createdAt: string,
): Promise<{ call_id: string; response: Record<string, unknown> }> {
  if (!wechatDraftFeatureEnabled(env, params.user_id, params.workspace_id)) {
    throw new EditorialRuntimeError("wechat_publishing_disabled", "WeChat draft sync is not enabled for this owner", 404);
  }
  if (typeof request.account_binding_id !== "string" ||
      typeof request.account_receipt_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(request.account_receipt_hash) ||
      !isWechatAccountAllowed(env.WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST, request.account_binding_id, env)) {
    throw new EditorialRuntimeError("wechat_publishing_account_not_allowed", "WeChat account binding is not allowlisted", 409);
  }
  const requestPayload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
    ? request.payload as Record<string, unknown>
    : {};
  const suppliedOperationId = requestPayload.operation_id;
  const operationId = typeof suppliedOperationId === "string"
    ? suppliedOperationId
    : await wechatOperationId(operation, request);
  let attemptNumber = 1;
  while (attemptNumber <= 3) {
    const prepared = await coordinator.prepareFiveAgentCall({ run_id: params.run_id, call_kind: `wechat_${operation}`, idempotency_key: operationId, attempt: attemptNumber, created_at: createdAt });
    const durableAttempt = Number(prepared.attempt || attemptNumber);
    if (prepared.status === "failed") {
      if (!prepared.retryable) throw new EditorialRuntimeError(prepared.error_code || "wechat_operation_non_retryable", "wechat operation has a durable failure", 409);
      if (durableAttempt >= 3) throw new EditorialRuntimeError("wechat_operation_retry_exhausted", "wechat operation retry limit reached", 503);
      attemptNumber = durableAttempt + 1;
      continue;
    }
    const reconcileOnly = prepared.status === "needs_action" || prepared.status === "completed";
    try {
      const response = await callWechatPublishingAdapter(env, operation, {
        operation_id: operationId,
        attempt: durableAttempt,
        user_id: params.user_id,
        workspace_id: params.workspace_id,
        article_id: params.article_id,
        account_binding_id: request.account_binding_id,
        account_receipt_hash: request.account_receipt_hash,
        payload: requestPayload,
      }, { reconcileOnly });
      if (response.account_binding_id !== request.account_binding_id ||
          response.account_receipt_hash !== request.account_receipt_hash) {
        throw new EditorialRuntimeError("wechat_account_receipt_invalid", "wechat operation account receipt conflicts", 502);
      }
      const expectedResultRef = `wechat-adapter/v1/result/${operationId}/${durableAttempt}.json`;
      if (typeof response.result_ref !== "string" || response.result_ref !== expectedResultRef ||
          typeof response.result_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(response.result_hash)) {
        throw new EditorialRuntimeError("wechat_adapter_protocol_invalid", "wechat operation evidence is invalid", 502);
      }
      return { call_id: prepared.call_id, response };
    } catch (error) {
      if (!(error instanceof WechatPublishingServiceError)) throw error;
      if (error.code === "external_side_effect_unknown") {
        // No result is recorded here. The existing intent is the durable proof
        // that a subsequent run may only query the adapter for this attempt.
        const held = new EditorialRuntimeError("external_side_effect_unknown", "wechat operation has unknown side effect", 503) as EditorialRuntimeError & {
          call_id?: string;
          operation_id?: string;
          attempt?: number;
        };
        held.call_id = prepared.call_id;
        held.operation_id = operationId;
        held.attempt = durableAttempt;
        throw held;
      }
      await coordinator.completeFiveAgentCall({ call_id: prepared.call_id, run_id: params.run_id, status: "failed", error_code: error.code, retryable: error.retryable, recorded_at: createdAt });
      if (error.retryable && durableAttempt < 3) {
        attemptNumber = durableAttempt + 1;
        continue;
      }
      throw new EditorialRuntimeError(error.retryable ? "wechat_operation_retry_exhausted" : error.code, "wechat operation failed", error.status);
    }
  }
  throw new EditorialRuntimeError("wechat_operation_retry_exhausted", "wechat operation retry limit reached", 503);
}

function wechatAccountHold(error: unknown): { errorCode: string; nextAction: string } | null {
  const code = error instanceof WechatPublishingServiceError || error instanceof EditorialRuntimeError ? error.code : "";
  if (code === "wechat_publishing_account_not_allowed") return { errorCode: code, nextAction: "request_account_enablement" };
  if (code === "wechat_publishing_account_unavailable" || code === "wechat_account_receipt_invalid" || code === "service_unconfigured") {
    return { errorCode: "wechat_publishing_account_unavailable", nextAction: "repair_publishing_account" };
  }
  if (code === "external_side_effect_unknown") return { errorCode: code, nextAction: "reconcile_external_side_effect" };
  return null;
}

const WECHAT_RESUMABLE_STATES = new Set(["visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying"]);
const WECHAT_RESUMABLE_HOLDS = new Set([
  "wechat_publishing_account_unavailable",
  "wechat_publishing_account_not_allowed",
  "wechat_publishing_account_rejected",
  "wechat_access_token_rejected",
  "external_side_effect_unknown",
  "wechat_artifact_reconciliation_required",
  "draft_identity_unresolved",
  "draft_readback_mismatch",
  "draft_readback_unavailable",
]);
const WECHAT_RESUME_EVENT_TYPE: Record<string, "visual_ready" | "formatting" | "visual_qa" | "draft_syncing" | "draft_verifying"> = {
  visual_ready: "visual_ready",
  formatting: "formatting",
  visual_qa: "visual_qa",
  draft_syncing: "draft_syncing",
  draft_verifying: "draft_verifying",
};

type WechatRecoveryTransition = {
  targetState: PublicationState;
  eventType: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: string;
  errorCode?: string;
  nextAction?: string;
  allowSameState?: boolean;
};

type WechatRecoveryEvent = {
  revision: number;
  event_id: string;
  event_type: string;
  state: string;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
};

async function readExactWechatRecoveryTransition(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
  transition: WechatRecoveryTransition,
  requireCurrentLastEvent: boolean,
): Promise<PublicationRunRow | null> {
  const [run, event] = await Promise.all([
    env.DB.prepare(`SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id).first<PublicationRunRow>(),
    env.DB.prepare(`SELECT revision, event_id, event_type, state, idempotency_key, payload_hash, created_at
      FROM publication_run_events WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id, transition.idempotencyKey).first<WechatRecoveryEvent>(),
  ]);
  if (!event) return null;
  if (!run || event.event_id !== `${params.run_id}:event:${event.revision}` ||
      event.event_type !== transition.eventType || event.state !== transition.targetState ||
      event.idempotency_key !== transition.idempotencyKey || event.payload_hash !== transition.payloadHash ||
      !Number.isFinite(Date.parse(event.created_at))) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery event identity conflicts", 503);
  }
  if (requireCurrentLastEvent &&
      (run.state !== transition.targetState || run.state_revision !== event.revision ||
       run.last_event_id !== event.event_id || run.last_event_type !== event.event_type ||
       run.last_event_idempotency_key !== event.idempotency_key ||
       run.last_event_payload_hash !== event.payload_hash ||
       run.last_event_created_at !== event.created_at)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery projection is not exact", 503);
  }
  return run;
}

async function applyOrReconcileWechatRecoveryTransition(
  env: EditorialRuntimeEnv,
  params: FiveAgentWorkflowParams,
  current: PublicationRunRow,
  transition: WechatRecoveryTransition,
): Promise<PublicationRunRow> {
  try {
    const applied = await applySystemPublicationTransition(env.DB, {
      runId: params.run_id,
      auth: { userId: params.user_id, workspaceId: params.workspace_id },
      targetState: transition.targetState,
      expectedStateRevision: current.state_revision,
      options: {
        eventId: `${params.run_id}:event:${current.state_revision + 1}`,
        eventType: transition.eventType,
        eventIdempotencyKey: transition.idempotencyKey,
        eventPayloadHash: transition.payloadHash,
        eventCreatedAt: transition.createdAt,
        errorCode: transition.errorCode,
        nextAction: transition.nextAction,
        allowSameState: transition.allowSameState,
      },
    });
    return applied.run;
  } catch (error) {
    const reconciled = await readExactWechatRecoveryTransition(env, params, transition, true);
    if (reconciled) return reconciled;
    throw error;
  }
}

async function reconcileProjectedWechatArtifactReceipts(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
): Promise<void> {
  const ledger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
  const pending = ledger.artifacts.filter(metadata => !ledger.receipt_ids.includes(metadata.artifact_id));
  if (!pending.length) return;
  const candidates = await Promise.all(pending.map(async metadata => {
    const event = await env.DB.prepare(`SELECT revision, state, event_type, created_at
      FROM publication_run_events
      WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND idempotency_key = ? AND payload_hash = ? LIMIT 1`)
      .bind(params.run_id, params.user_id, params.workspace_id, metadata.idempotency_key, metadata.payload_hash)
      .first<{ revision: number; state: string; event_type: string; created_at: string }>();
    if (!event) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "prepared WeChat artifact has no D1 projection evidence", 503);
    }
    if (event.event_type !== "wechat_artifact_committed" || !["formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready"].includes(event.state)) {
      throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "prepared WeChat artifact projection identity conflicts", 409);
    }
    return { metadata, event };
  }));
  candidates.sort((left, right) => left.event.revision - right.event.revision);
  for (const { metadata, event } of candidates) {
    const current = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
    try {
      await coordinator.completeFiveAgentWechatArtifact({
        artifact_id: metadata.artifact_id,
        run_id: params.run_id,
        payload_hash: metadata.payload_hash,
        state: event.state,
        state_revision: Number(current.state_revision) + 1,
        event_type: "wechat_artifact_committed",
        event_idempotency_key: metadata.idempotency_key,
        created_at: event.created_at,
      });
    } catch {
      const settled = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
      const receipt = settled.wechat_events.find(item =>
        item.artifact_id === metadata.artifact_id &&
        item.payload_hash === metadata.payload_hash &&
        item.idempotency_key === metadata.idempotency_key &&
        item.state === event.state && item.event_type === "wechat_artifact_committed",
      );
      if (!receipt) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "WeChat artifact receipt cannot be reconciled", 503);
    }
  }
}

async function resumeWechatNeedsAction(
  env: EditorialRuntimeEnv,
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>,
  params: FiveAgentWorkflowParams,
): Promise<{ target: string; recoveryCycle: string; freshExecutionEpoch: boolean }> {
  let doRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const projection = await env.DB.prepare(`SELECT * FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id).first<PublicationRunRow>();
  const originalError = String(doRun.error_code);
  const originalAction = String(doRun.next_action);
  if (!projection || doRun.state !== "needs_action" || !WECHAT_RESUMABLE_HOLDS.has(originalError)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat hold is not eligible for trusted recovery", 503);
  }
  // A D1-first artifact event is durable evidence, not an unknown provider
  // effect. Reconstruct its missing Coordinator receipt before resolving the
  // hold, so the recovery triplet never strands a valid artifact checkpoint.
  await reconcileProjectedWechatArtifactReceipts(env, coordinator, params);
  doRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  // The D1 projection owns the externally visible transition. It can be one
  // checkpoint ahead of the Coordinator when its response was lost, so a
  // stale DO last-successful state must not manufacture a second upload.
  const target = String(projection.last_successful_state || doRun.last_successful_state);
  if (!WECHAT_RESUMABLE_STATES.has(target) ||
      !["needs_action", "retrying", target].includes(projection.state)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat hold has no valid local checkpoint", 503);
  }
  const holds = await env.DB.prepare(`SELECT revision, idempotency_key, payload_hash, event_type, state, error_code, next_action
    FROM publication_run_events WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND event_type = 'needs_action'
    ORDER BY revision DESC`).bind(params.run_id, params.user_id, params.workspace_id)
    .all<{ revision: number; idempotency_key: string; payload_hash: string; event_type: string; state: string; error_code: string | null; next_action: string | null }>();
  const hold = (holds.results || []).find(event =>
    event.state === "needs_action" && event.error_code === originalError &&
    event.next_action === originalAction && WECHAT_RESUMABLE_HOLDS.has(String(event.error_code))
  );
  if (!hold) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat hold event is unavailable", 503);
  const cycle = (await hashJson({
    run_id: params.run_id,
    target,
    hold_revision: hold.revision,
    hold_idempotency_key: hold.idempotency_key,
    hold_payload_hash: hold.payload_hash,
  })).slice(7, 39);
  const key = (phase: "reconciled" | "retrying" | "resumed") => `wave2d:${phase}:${cycle}:${target}:${params.run_id}`;
  const eventHash = (event: string) => hashJson({
    run_payload_hash: params.payload_hash,
    event,
    target,
    recovery_cycle: cycle,
    recovered_hold: { revision: hold.revision, idempotency_key: hold.idempotency_key, payload_hash: hold.payload_hash },
  });
  const reconciledHash = await eventHash("wechat_side_effect_reconciled");
  const retryHash = await eventHash("wechat_reconciliation_retrying");
  const resumeHash = await eventHash("wechat_reconciliation_resumed");

  const reconciledTransition: WechatRecoveryTransition = {
    targetState: "needs_action", eventType: "wechat_side_effect_reconciled", idempotencyKey: key("reconciled"),
    payloadHash: reconciledHash, createdAt: workflowTimestamp(params.created_at, 24_000),
    errorCode: "wechat_side_effect_reconciled", nextAction: "resume_reconciled_wechat", allowSameState: true,
  };
  const retryTransition: WechatRecoveryTransition = {
    targetState: "retrying", eventType: "wechat_reconciliation_retrying", idempotencyKey: key("retrying"),
    payloadHash: retryHash, createdAt: workflowTimestamp(params.created_at, 24_001),
  };
  const resumedTransition: WechatRecoveryTransition = {
    targetState: target as PublicationState, eventType: "wechat_reconciliation_resumed", idempotencyKey: key("resumed"),
    payloadHash: resumeHash, createdAt: workflowTimestamp(params.created_at, 24_002),
  };
  let current = projection;
  if (current.state === "needs_action" && current.error_code === originalError && current.next_action === originalAction) {
    current = await applyOrReconcileWechatRecoveryTransition(env, params, current, reconciledTransition);
  } else if (!await readExactWechatRecoveryTransition(env, params, reconciledTransition, false)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cannot prove its reconciled checkpoint", 503);
  }

  if (current.state === "needs_action" && current.error_code === "wechat_side_effect_reconciled" && current.next_action === "resume_reconciled_wechat") {
    current = await applyOrReconcileWechatRecoveryTransition(env, params, current, retryTransition);
  } else if (!await readExactWechatRecoveryTransition(env, params, retryTransition, false)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cannot prove its retrying checkpoint", 503);
  }

  if (current.state === "retrying") {
    current = await applyOrReconcileWechatRecoveryTransition(env, params, current, resumedTransition);
  } else if (current.state !== target || !await readExactWechatRecoveryTransition(env, params, resumedTransition, false)) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat recovery cannot prove its resumed checkpoint", 503);
  }

  const latestDo = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  if (latestDo.state === "needs_action") {
    const stateRevision = Number(latestDo.state_revision) + 1;
    const eventType = WECHAT_RESUME_EVENT_TYPE[target];
    const identity = projectionEventIdentity(current);
    try {
      await coordinator.recordFiveAgentState({
        run_id: params.run_id,
        state: target,
        state_revision: stateRevision,
        event_type: eventType,
        payload_hash: identity.payloadHash,
        created_at: identity.createdAt,
      });
    } catch (error) {
      const settled = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
      const events = await coordinator.listFiveAgentEvents(params.run_id, params.user_id, params.workspace_id);
      const event = events.find(item => Number(item.state_revision) === stateRevision);
      if (settled.state !== target || Number(settled.state_revision) !== stateRevision ||
          !event || event.event_type !== eventType || event.payload_hash !== identity.payloadHash || event.created_at !== identity.createdAt) {
        throw error;
      }
    }
  } else if (latestDo.state !== target) {
    throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "Coordinator recovery checkpoint conflicts", 503);
  }
  // A local receipt/projection response loss must replay the original scope.
  // Failed reads and repaired account credentials need a fresh immutable
  // execution epoch so their old evidence remains append-only audit history.
  const requiresFreshEpoch = [
    "draft_readback_mismatch",
    "draft_readback_unavailable",
    "wechat_publishing_account_unavailable",
    "wechat_publishing_account_not_allowed",
    "wechat_publishing_account_rejected",
    "wechat_access_token_rejected",
  ].includes(originalError);
  // Every reconciled hold gets a distinct read-only reconciliation identity.
  // Only repairable read/account failures receive a new artifact epoch; an
  // unresolved write remains in its original scope until its exact intent is
  // proven by a fresh bounded lookup.
  return { target, recoveryCycle: cycle, freshExecutionEpoch: requiresFreshEpoch };
}

async function runWechatDraftPhaseInner(input: {
  env: EditorialRuntimeEnv;
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>;
  params: FiveAgentWorkflowParams;
  frozen: StoredArtifactMetadata;
  visual: FiveAgentWorkflowResult;
  transcript: { ref: string; hash: string };
  account?: { account_binding_id: string; account_receipt_hash: string; config_hash: string };
  recovery_cycle?: string;
  reconciliation_cycle?: string;
}): Promise<FiveAgentWorkflowResult> {
  const { env, coordinator, params, frozen, visual, transcript } = input;
  if (!WECHAT_RESUMABLE_STATES.has(String(visual.state)) || !wechatDraftFeatureEnabled(env, params.user_id, params.workspace_id)) return visual;
  const currentWechatRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  // A readback artifact can be durably mirrored to D1 while the coordinator
  // response is lost. At draft_verifying, resume only that local receipt and
  // final compatibility projection. Replaying template/upload work here would
  // manufacture a second route through draft_syncing and can never be safe.
  if (currentWechatRun.state === "draft_verifying") {
    const existingWechatLedger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
    const readbackMetadata = uniquePassingWechatReadback(existingWechatLedger.artifacts, existingWechatLedger.receipt_ids);
    if (readbackMetadata) {
      const readbackObject = await readWechatArtifactFromR2(env, readbackMetadata);
      const readbackPayload = readbackObject.payload as WechatDraftReadbackQAPayload;
      // A failed readback QA is immutable audit evidence for its original
      // execution epoch. It cannot be completed in place after an operator
      // repairs the draft; that repair gets a fresh read-only epoch below.
      if (readbackPayload.decision !== "pass" || !readbackPayload.checks.media || !readbackPayload.checks.title ||
          !readbackPayload.checks.html || !readbackPayload.checks.urls || !readbackPayload.checks.thumb ||
          readbackPayload.checks.article_index !== 0) {
        // Continue through the normal graph with a recovery-scoped identity.
      } else {
      const restoredReadback = await persistWechatArtifact(
        env,
        coordinator,
        params,
        readbackObject,
        "draft_verifying",
        "wechat_artifact_committed",
      );
      const orderedSlots = existingWechatLedger.artifacts
        .filter(item => item.kind === "wechat_image_upload_receipt" && readbackPayload.upload_receipt_ids.includes(item.artifact_id))
        .sort((left, right) => Number(left.payload_summary.order || 0) - Number(right.payload_summary.order || 0))
        .map(item => String(item.payload_summary.slot_id));
      await verifyExactWechatArtifactSet(env, coordinator, params, orderedSlots, readbackPayload.execution_scope);
      const finalized = await finalizeWechatDraft(
        env,
        coordinator,
        params,
        restoredReadback,
        readbackPayload.verified_draft_media_id,
        readbackPayload.verified_cover_image_url || undefined,
      );
      return {
        run_id: params.run_id,
        state: "draft_ready",
        state_revision: finalized.doStateRevision,
        transcript_ref: transcript.ref,
        transcript_hash: transcript.hash,
        artifact_ids: [...visual.artifact_ids, ...existingWechatLedger.receipt_ids, restoredReadback.artifact_id],
      };
      }
    }
  }
  // A repaired epoch never regresses either ledger. Inputs that belong before
  // the durable checkpoint are mirrored with same-state receipts; later
  // stages still advance through the ordinary publishing sequence.
  const recoveryState = Boolean(input.recovery_cycle) && ["formatting", "visual_qa", "draft_syncing", "draft_verifying"].includes(String(currentWechatRun.state))
    ? String(currentWechatRun.state) as "formatting" | "visual_qa" | "draft_syncing" | "draft_verifying"
    : null;
  const stateRank: Record<"formatting" | "visual_qa" | "draft_syncing" | "draft_verifying", number> = {
    formatting: 84,
    visual_qa: 90,
    draft_syncing: 96,
    draft_verifying: 98,
  };
  const artifactState = <T extends "formatting" | "visual_qa" | "draft_syncing" | "draft_verifying">(state: T): T | "formatting" | "visual_qa" | "draft_syncing" | "draft_verifying" =>
    recoveryState && stateRank[recoveryState] > stateRank[state] ? recoveryState : state;
  const ledger = await coordinator.getFiveAgentVisualLedger(params.run_id, params.user_id, params.workspace_id);
  const planMeta = ledger.artifacts.find(item => item.kind === "visual_plan" && ledger.receipt_ids.includes(item.artifact_id));
  const qaMeta = ledger.artifacts.find(item => item.kind === "visual_qa_report" && ledger.receipt_ids.includes(item.artifact_id));
  const assets = ledger.artifacts.filter(item => item.kind === "visual_asset" && ledger.receipt_ids.includes(item.artifact_id)).sort((left, right) => Number(left.payload_summary.order || 0) - Number(right.payload_summary.order || 0));
  if (!planMeta || !qaMeta || new Set(assets.map(asset => asset.payload_summary.slot_id)).size !== assets.length) throw new EditorialRuntimeError("wechat_visual_input_invalid", "wechat publishing inputs are incomplete", 409);
  const plan = await readVisualArtifactFromR2(env, planMeta);
  const planPayload = plan.payload as VisualPlanPayload;
  const expectedSlots = planPayload.slots.map(slot => slot.slot_id);
  if (artifactCanonicalJson(expectedSlots) !== artifactCanonicalJson(assets.map(asset => asset.payload_summary.slot_id))) throw new EditorialRuntimeError("wechat_visual_input_invalid", "wechat visual input slots are not exact", 409);
  const frozenObject = await readArtifactFromR2(env, params, frozen.artifact_id, frozen.artifact_key, frozen.payload_hash);
  const frozenPayload = frozenObject.payload as FrozenArticleVersion;
  const expectedSlotCount = Array.from(frozenPayload.body).length >= 5000 ? 6 : 3;
  if (assets.length !== expectedSlotCount || expectedSlots.length !== expectedSlotCount || expectedSlots[0] !== "cover_01" ||
      artifactCanonicalJson(expectedSlots) !== artifactCanonicalJson(["cover_01", ...Array.from({ length: expectedSlotCount - 1 }, (_, index) => `body_${String(index + 1).padStart(2, "0")}`)])) {
    throw new EditorialRuntimeError("wechat_visual_input_invalid", "wechat visual slot set is not exact", 409);
  }
  let account: { account_binding_id: string; account_receipt_hash: string; config_hash: string };
  try {
    account = input.account || await requireWechatAccount(env, params, workflowTimestamp(params.created_at, 22_000));
  } catch (error) {
    const hold = wechatAccountHold(error);
    if (hold) return visualHoldWithCode(env, coordinator, params, transcript, [...visual.artifact_ids], hold.errorCode, hold.nextAction, 22, 1, false);
    throw error;
  }
  const owner: WechatOwner = { run_id: params.run_id, article_id: params.article_id, recording_id: params.recording_id, user_id: params.user_id, workspace_id: params.workspace_id };
  const scopeHash = await wechatScopeHash({ owner, frozen: { id: frozen.artifact_id, hash: frozen.payload_hash }, plan: { id: planMeta.artifact_id, hash: planMeta.payload_hash }, assets: assets.map(asset => ({ id: asset.artifact_id, hash: asset.payload_hash, slot: String(asset.payload_summary.slot_id) })), visualQA: { id: qaMeta.artifact_id, hash: qaMeta.payload_hash }, pin_snapshot_id: "wechat-pin-snapshot.v1", account_binding_id: account.account_binding_id });
  const executionScope = await hashJson({
    version: "wave2d-execution.v1",
    input_scope_hash: scopeHash,
    account_binding_id: account.account_binding_id,
    account_config_hash: account.config_hash,
    account_receipt_hash: account.account_receipt_hash,
    recovery_cycle: input.recovery_cycle || "initial",
  });
  const templateKey = `wave2d:template:${executionScope}`;
  const templatePayload: WechatRenderTemplatePayload = {
    protocol_version: "wechat_render_template.v1", execution_scope: executionScope, recovery_cycle: input.recovery_cycle || null, run_id: params.run_id, article_id: params.article_id, recording_id: params.recording_id,
    frozen_artifact_id: frozen.artifact_id, frozen_payload_hash: frozen.payload_hash, visual_plan_artifact_id: planMeta.artifact_id, visual_plan_payload_hash: planMeta.payload_hash,
    visual_qa_artifact_id: qaMeta.artifact_id, visual_qa_payload_hash: qaMeta.payload_hash, asset_artifact_ids: assets.map(asset => asset.artifact_id),
    account_binding_id: account.account_binding_id, account_receipt_hash: account.account_receipt_hash, pin_snapshot: activeWechatPinSnapshot(),
    title: frozenPayload.title, cover_slot_id: "cover_01", body_slots: planPayload.slots.filter(slot => slot.purpose === "body").map(slot => ({ slot_id: slot.slot_id, order: slot.order, block_id: slot.block_id || "", alt: slot.alt, caption: slot.caption })),
    html_template: canonicalWechatHtml(frozenPayload.title, frozenPayload.blocks, planPayload.slots.filter(slot => slot.purpose === "body").map(slot => ({ slot_id: slot.slot_id, block_id: slot.block_id || "", alt: slot.alt, caption: slot.caption }))),
    created_at: workflowTimestamp(params.created_at, 22_100),
  };
  let template = await makeWechatArtifact({ owner, kind: "wechat_render_template", payload: templatePayload, input_artifact_ids: [frozen.artifact_id, planMeta.artifact_id, ...assets.map(asset => asset.artifact_id), qaMeta.artifact_id], idempotency_key: templateKey, created_at: templatePayload.created_at });
  const templateMeta = await persistWechatArtifact(env, coordinator, params, template, artifactState("formatting"), "wechat_artifact_committed");
  const templatePlaceholderUrls = templatePayload.body_slots.map(slot => `https://wechat-placeholder.invalid/${slot.slot_id}`);
  const renderedTemplateForQa = templatePayload.body_slots.reduce(
    (html, slot) => html.replace(`{{wechat_image:${slot.slot_id}}}`, `https://wechat-placeholder.invalid/${slot.slot_id}`),
    templatePayload.html_template,
  );
  const renderValidation = validateWechatHtml(renderedTemplateForQa, templatePlaceholderUrls);
  const renderChecks = {
    safe_html: renderValidation.safe_html,
    placeholders: templatePlaceholderUrls.length === templatePayload.body_slots.length,
    list_continuity: renderValidation.list_continuity,
    preview_widths: renderValidation.preview_widths,
  };
  const renderQaPayload: WechatRenderQAReportPayload = {
    protocol_version: "wechat_render_qa_report.v1", execution_scope: executionScope, recovery_cycle: input.recovery_cycle || null, template_artifact_id: templateMeta.artifact_id, template_payload_hash: templateMeta.payload_hash,
    decision: renderChecks.safe_html && renderChecks.placeholders && renderChecks.list_continuity ? "pass" : "failed",
    checks: renderChecks,
    created_at: workflowTimestamp(params.created_at, 22_200),
  };
  const renderQa = await makeWechatArtifact({ owner, kind: "wechat_render_qa_report", payload: renderQaPayload, input_artifact_ids: [templateMeta.artifact_id], idempotency_key: `wave2d:render-qa:${templateMeta.payload_hash}`, created_at: renderQaPayload.created_at });
  const renderQaMeta = await persistWechatArtifact(env, coordinator, params, renderQa, artifactState("visual_qa"), "wechat_artifact_committed");
  if (renderQaPayload.decision !== "pass") {
    // The failed report is audit evidence, but rendering never proceeds to an
    // upload or draft side effect when deterministic HTML QA rejects it.
    throw new EditorialRuntimeError("wechat_html_contract_invalid", "rendered HTML failed deterministic QA", 422);
  }
  // No upload is allowed to cross the service boundary until both durable
  // projections have recorded this exact local checkpoint. It recognizes a
  // D1-first response-loss window and completes only the missing DO event.
  if (artifactState("draft_syncing") === "draft_syncing") await ensureWechatDraftSyncingCheckpoint(env, coordinator, params, executionScope);
  const uploads: Array<{ metadata: WechatPersistedMetadata; url: string; media_id?: string }> = [];
  for (const [index, assetMeta] of assets.entries()) {
    // A concurrent cancellation or a prior response-loss recovery must never
    // leave a later slot executing while either ledger is outside draft_syncing.
    if (artifactState("draft_syncing") === "draft_syncing") await ensureWechatDraftSyncingCheckpoint(env, coordinator, params, executionScope);
    const asset = await readVisualArtifactFromR2(env, assetMeta);
    const payload = asset.payload as VisualAssetPayload;
    const slot = planPayload.slots[index];
    if (!slot || payload.slot_id !== slot.slot_id) throw new EditorialRuntimeError("wechat_visual_input_invalid", "visual asset order is invalid", 409);
    const binaryKey = payload.binary_storage_ref.slice(5);
    const binary = await readImmutableBinaryImage(env.FILES_BUCKET, binaryKey, {
      storage_ref: payload.binary_storage_ref,
      byte_hash: payload.byte_hash,
      byte_length: payload.byte_length,
      mime: payload.mime,
      width: payload.width,
      height: payload.height,
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      run_id: params.run_id,
      frozen_payload_hash: planPayload.frozen_payload_hash,
      slot_id: slot.slot_id,
    });
    const operationId = await wechatOperationId("upload_image", { execution_scope: executionScope, slot_id: slot.slot_id, purpose: slot.purpose, asset_byte_hash: payload.byte_hash, plan_payload_hash: planMeta.payload_hash });
    const operation = await callWechatOperation(env, coordinator, params, "upload_image", { account_binding_id: account.account_binding_id, account_receipt_hash: account.account_receipt_hash, payload: { operation_id: operationId, byte_hash: payload.byte_hash, byte_length: payload.byte_length, mime: payload.mime, slot_id: slot.slot_id, purpose: slot.purpose, image_base64: base64(binary) } }, workflowTimestamp(params.created_at, 22_300 + index));
    const result = operation.response.result && typeof operation.response.result === "object" ? operation.response.result as Record<string, unknown> : {};
    if (!isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, result.media_url)) {
      throw new EditorialRuntimeError("wechat_html_contract_invalid", "wechat image URL violates the HTML contract", 422);
    }
    if (slot.purpose === "cover" && typeof result.media_id !== "string") {
      throw new EditorialRuntimeError("wechat_image_upload_non_retryable", "wechat image upload response is invalid", 502);
    }
    const uploadPayload: WechatImageUploadReceiptPayload = {
      protocol_version: "wechat_image_upload_receipt.v1",
      execution_scope: executionScope,
      recovery_cycle: input.recovery_cycle || null,
      frozen_artifact_id: frozen.artifact_id,
      frozen_payload_hash: frozen.payload_hash,
      visual_plan_artifact_id: planMeta.artifact_id,
      visual_plan_payload_hash: planMeta.payload_hash,
      visual_asset_artifact_id: assetMeta.artifact_id,
      visual_asset_payload_hash: assetMeta.payload_hash,
      visual_qa_artifact_id: qaMeta.artifact_id,
      visual_qa_payload_hash: qaMeta.payload_hash,
      account_binding_id: account.account_binding_id,
      slot_id: slot.slot_id,
      purpose: slot.purpose,
      order: slot.order,
      asset_byte_hash: payload.byte_hash,
      operation_id: operationId,
      provider_result_ref: String(operation.response.result_ref),
      provider_result_hash: String(operation.response.result_hash),
      media_url: String(result.media_url),
      cover_media_id: slot.purpose === "cover" ? String(result.media_id) : null,
      media_kind: slot.purpose === "cover" ? "thumb" : "body",
      created_at: workflowTimestamp(params.created_at, 22_400 + index),
    };
    const uploadKey = await wechatArtifactIdempotencyKey("upload", { execution_scope: executionScope, slot_id: slot.slot_id, purpose: slot.purpose, asset_byte_hash: payload.byte_hash });
    const upload = await makeWechatArtifact({ owner, kind: "wechat_image_upload_receipt", payload: uploadPayload, input_artifact_ids: [frozen.artifact_id, planMeta.artifact_id, assetMeta.artifact_id, qaMeta.artifact_id], idempotency_key: uploadKey, created_at: uploadPayload.created_at });
    const uploadMeta = await persistWechatArtifact(env, coordinator, params, upload, artifactState("draft_syncing"), "wechat_artifact_committed");
    await coordinator.completeFiveAgentCall({ call_id: operation.call_id, run_id: params.run_id, status: "succeeded", response_hash: uploadMeta.payload_hash, artifact_id: uploadMeta.artifact_id, recorded_at: uploadPayload.created_at });
    uploads.push({ metadata: uploadMeta, url: result.media_url, ...(typeof result.media_id === "string" ? { media_id: result.media_id } : {}) });
  }
  const packageBase = renderWechatPackage(templatePayload, uploads.filter(upload => upload.metadata.payload_summary.purpose === "body").map(upload => ({ slot_id: String(upload.metadata.payload_summary.slot_id), url: upload.url })), workflowTimestamp(params.created_at, 22_600));
  const packagePayload = await finalizeWechatPackage({ ...packageBase, template_artifact_id: templateMeta.artifact_id, template_payload_hash: templateMeta.payload_hash, render_qa_artifact_id: renderQaMeta.artifact_id, render_qa_payload_hash: renderQaMeta.payload_hash, upload_receipt_ids: uploads.map(upload => upload.metadata.artifact_id) });
  const expectedBodyUrls = uploads.filter(upload => upload.metadata.payload_summary.purpose === "body").map(upload => upload.url);
  const packageValidation = validateWechatHtml(packagePayload.canonical_html, expectedBodyUrls);
  if (packageValidation.body_urls.some(url => !isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, url)) ||
      !isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, uploads[0]?.url)) {
    throw new EditorialRuntimeError("wechat_html_contract_invalid", "WeChat media URL is not allowlisted", 422);
  }
  if (packagePayload.html_hash !== await sha256(new TextEncoder().encode(packageValidation.canonical_html))) throw new EditorialRuntimeError("wechat_html_contract_invalid", "rendered HTML hash is invalid", 422);
  const packageKey = await wechatArtifactIdempotencyKey("package", { template_payload_hash: templateMeta.payload_hash, ordered_upload_payload_hashes: uploads.map(upload => upload.metadata.payload_hash) });
  const articlePackage = await makeWechatArtifact({ owner, kind: "rendered_article_package", payload: packagePayload, input_artifact_ids: [templateMeta.artifact_id, renderQaMeta.artifact_id, ...uploads.map(upload => upload.metadata.artifact_id)], idempotency_key: packageKey, created_at: packagePayload.created_at });
  const packageMeta = await persistWechatArtifact(env, coordinator, params, articlePackage, artifactState("draft_syncing"), "wechat_artifact_committed");
  const prepublishChecks = {
    title: packagePayload.title === frozenPayload.title,
    html_hash: packagePayload.html_hash === await sha256(new TextEncoder().encode(packageValidation.canonical_html)),
    image_order: artifactCanonicalJson(packageValidation.body_urls) === artifactCanonicalJson(expectedBodyUrls),
    safe_urls: packageValidation.safe_html,
    preview_widths: packageValidation.preview_widths,
  };
  const preQaPayload: WechatPrepublishQAReportPayload = {
    protocol_version: "wechat_prepublish_qa_report.v1", execution_scope: executionScope, recovery_cycle: input.recovery_cycle || null, package_artifact_id: packageMeta.artifact_id, package_payload_hash: packageMeta.payload_hash,
    ordered_upload_receipt_ids: uploads.map(upload => upload.metadata.artifact_id),
    decision: prepublishChecks.title && prepublishChecks.html_hash && prepublishChecks.image_order && prepublishChecks.safe_urls ? "pass" : "failed",
    checks: prepublishChecks,
    created_at: workflowTimestamp(params.created_at, 22_700),
  };
  const preQa = await makeWechatArtifact({ owner, kind: "wechat_prepublish_qa_report", payload: preQaPayload, input_artifact_ids: [packageMeta.artifact_id, ...uploads.map(upload => upload.metadata.artifact_id)], idempotency_key: `wave2d:prepublish-qa:${packageMeta.payload_hash}`, created_at: preQaPayload.created_at });
  const preQaMeta = await persistWechatArtifact(env, coordinator, params, preQa, artifactState("draft_syncing"), "wechat_artifact_committed");
  if (preQaPayload.decision !== "pass") {
    // Preserve the complete deterministic prepublish report before refusing a
    // provider write. This is a local HTML contract failure, not an unknown
    // external side effect.
    throw new EditorialRuntimeError("wechat_html_contract_invalid", "rendered package failed deterministic QA", 422);
  }
  if (!uploads[0]?.media_id) throw new EditorialRuntimeError("wechat_image_upload_non_retryable", "cover upload did not return a media id", 502);
  const draftIdentity = await deriveWechatDraftIdentity(account.account_binding_id, owner);
  const fingerprint = {
    draft_identity_hash: draftIdentity,
    title: packagePayload.title,
    canonical_html: packagePayload.canonical_html,
    html_hash: packagePayload.html_hash,
    thumb_media_id: uploads[0].media_id,
  };
  let verifiedDraft: Record<string, unknown> | null = null;
  let recoveredDraftCallId: string | null = null;
  const legacyDraftId = await existingWechatDraftClue(env, params);
  if (!legacyDraftId) {
    const mappingOperationId = await wechatOperationId("get_draft", { phase: "verified-mapping", execution_scope: executionScope, draft_identity_hash: draftIdentity, package_payload_hash: packageMeta.payload_hash });
    const mappingLookup = await callWechatOperation(env, coordinator, params, "get_draft", {
      account_binding_id: account.account_binding_id,
      account_receipt_hash: account.account_receipt_hash,
      payload: { operation_id: mappingOperationId, ...fingerprint },
    }, workflowTimestamp(params.created_at, 22_750));
    const mappingResult = mappingLookup.response.result && typeof mappingLookup.response.result === "object" && !Array.isArray(mappingLookup.response.result)
      ? mappingLookup.response.result as Record<string, unknown> : {};
    await completeWechatReadOnlyCall(coordinator, params, mappingLookup, workflowTimestamp(params.created_at, 22_750));
    // A mapping proves a stable draft identity. Its content may differ from
    // this package, in which case the safe mutation is update, never add.
    if (await isValidWechatDraftReadback(env, mappingResult)) verifiedDraft = mappingResult;
  }
  if (!verifiedDraft && legacyDraftId) {
    const operationId = await wechatOperationId("get_draft", { phase: "legacy-identity", execution_scope: executionScope, draft_identity: draftIdentity, legacy_draft_id: legacyDraftId, package_payload_hash: packageMeta.payload_hash });
    const lookup = await callWechatOperation(env, coordinator, params, "get_draft", {
      account_binding_id: account.account_binding_id,
      account_receipt_hash: account.account_receipt_hash,
      payload: { operation_id: operationId, media_id: legacyDraftId, ...fingerprint },
    }, workflowTimestamp(params.created_at, 22_760));
    const result = lookup.response.result && typeof lookup.response.result === "object" && !Array.isArray(lookup.response.result)
      ? lookup.response.result as Record<string, unknown> : null;
    if (!result || result.media_id !== legacyDraftId || !await isValidWechatDraftReadback(env, result)) {
      throw new EditorialRuntimeError("draft_identity_unresolved", "stored WeChat draft identity could not be verified", 409);
    }
    await completeWechatReadOnlyCall(coordinator, params, lookup, workflowTimestamp(params.created_at, 22_760));
    verifiedDraft = result;
  }
  // A new recovery epoch may not manufacture a second add while an earlier
  // write intent is unresolved. It may only use an independently durable,
  // read-only exact fingerprint lookup to prove what the original add did.
  if (!verifiedDraft) {
    const priorUnknownWrite = (await coordinator.listFiveAgentCallAttempts(params.run_id, params.user_id, params.workspace_id))
      .filter(item => item.call_kind === "wechat_write_draft" && (item.status === null || item.status === "needs_action"))
      .sort((left, right) => right.attempt - left.attempt)[0];
    if (priorUnknownWrite) {
      const findOperationId = await wechatOperationId("find_draft", {
        execution_scope: executionScope,
        reconciliation_cycle: input.reconciliation_cycle || "initial",
        recovery_of_call_id: priorUnknownWrite.call_id,
        draft_identity_hash: draftIdentity,
        title: packagePayload.title,
        canonical_html: packagePayload.canonical_html,
        html_hash: packagePayload.html_hash,
        thumb_media_id: uploads[0].media_id,
      });
      const found = await callWechatOperation(env, coordinator, params, "find_draft", {
        account_binding_id: account.account_binding_id,
        account_receipt_hash: account.account_receipt_hash,
        payload: { operation_id: findOperationId, ...fingerprint },
      }, workflowTimestamp(params.created_at, 22_790));
      const foundResult = found.response.result && typeof found.response.result === "object" && !Array.isArray(found.response.result)
        ? found.response.result as Record<string, unknown> : null;
      if (!await isExactWechatDraftReadback(env, foundResult, fingerprint)) {
        throw new EditorialRuntimeError("draft_identity_unresolved", "unresolved draft write cannot be safely resumed", 409);
      }
      await completeWechatReadOnlyCall(coordinator, params, found, workflowTimestamp(params.created_at, 22_790));
      recoveredDraftCallId = priorUnknownWrite.call_id;
      verifiedDraft = foundResult;
    }
  }
  // A uniquely recovered unresolved add is evidence for the original add
  // operation. It is not a newly discovered mapping that authorizes an
  // update, and it must never cause a second draft mutation.
  const recoveredUnknownAdd = recoveredDraftCallId !== null;
  const expectedMutation = recoveredUnknownAdd ? "add" : verifiedDraft ? "update" : "add";
  const sameContent = verifiedDraft !== null &&
    verifiedDraft.title === packagePayload.title && verifiedDraft.canonical_html === packagePayload.canonical_html &&
    verifiedDraft.html_hash === packagePayload.html_hash && verifiedDraft.thumb_media_id === uploads[0].media_id &&
    artifactCanonicalJson(verifiedDraft.body_urls || []) === artifactCanonicalJson(expectedBodyUrls);
  const draftOperationId = await wechatOperationId("write_draft", {
    execution_scope: executionScope, draft_identity: draftIdentity, package_hash: packageMeta.payload_hash, preqa_hash: preQaMeta.payload_hash,
    mutation: recoveredUnknownAdd ? "add" : sameContent ? "noop" : expectedMutation,
  });
  let draft: { call_id: string; response: Record<string, unknown> } | null = null;
  let draftResult: Record<string, unknown>;
  if (sameContent && verifiedDraft) {
    draftResult = { ...verifiedDraft, mutation: recoveredUnknownAdd ? "add" : "noop" };
  } else {
    try {
      draft = await callWechatOperation(env, coordinator, params, "write_draft", {
        account_binding_id: account.account_binding_id,
        account_receipt_hash: account.account_receipt_hash,
        payload: {
          operation_id: draftOperationId,
          draft_identity_hash: draftIdentity,
          mutation: expectedMutation,
          ...(verifiedDraft ? { media_id: verifiedDraft.media_id } : {}),
          title: packagePayload.title,
          canonical_html: packagePayload.canonical_html,
          html_hash: packagePayload.html_hash,
          thumb_media_id: uploads[0].media_id,
        },
      }, workflowTimestamp(params.created_at, 22_800));
      draftResult = draft.response.result && typeof draft.response.result === "object" && !Array.isArray(draft.response.result)
        ? draft.response.result as Record<string, unknown>
        : {};
    } catch (error) {
      const unknown = error instanceof EditorialRuntimeError && error.code === "external_side_effect_unknown"
        ? error as EditorialRuntimeError & { call_id?: string }
        : null;
      if (!unknown?.call_id || expectedMutation !== "add") throw error;
      // A failed identity lookup is immutable evidence for that particular
      // hold. A later operator-triggered reconciliation must use a fresh,
      // read-only lookup identity; it may never manufacture a second add.
      const reconciliationRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
      const findOperationId = await wechatOperationId("find_draft", {
        draft_identity_hash: draftIdentity,
        title: packagePayload.title,
        canonical_html: packagePayload.canonical_html,
        html_hash: packagePayload.html_hash,
        thumb_media_id: uploads[0].media_id,
        reconciliation_state_revision: Number(reconciliationRun.state_revision),
      });
      const found = await callWechatOperation(env, coordinator, params, "find_draft", {
        account_binding_id: account.account_binding_id,
        account_receipt_hash: account.account_receipt_hash,
        payload: { operation_id: findOperationId, ...fingerprint },
      }, workflowTimestamp(params.created_at, 22_810));
      const foundResult = found.response.result && typeof found.response.result === "object" && !Array.isArray(found.response.result)
        ? found.response.result as Record<string, unknown> : null;
      if (!await isExactWechatDraftReadback(env, foundResult, fingerprint)) {
        throw new EditorialRuntimeError("draft_identity_unresolved", "unknown draft add could not be uniquely reconciled", 409);
      }
      await completeWechatReadOnlyCall(coordinator, params, found, workflowTimestamp(params.created_at, 22_810));
      recoveredDraftCallId = unknown.call_id;
      draftResult = { ...foundResult, mutation: "add" };
    }
  }
  if (typeof draftResult.media_id !== "string") throw new EditorialRuntimeError("wechat_draft_write_non_retryable", "wechat draft receipt is invalid", 502);
  const mutation = recoveredUnknownAdd ? "add" : sameContent ? "noop" : expectedMutation;
  if (!sameContent && draftResult.mutation !== mutation) throw new EditorialRuntimeError("wechat_draft_write_non_retryable", "wechat draft mutation receipt is invalid", 502);
  const verifiedCoverImageUrl = uploads[0]?.url;
  const receiptPayload: WechatDraftReceiptPayload = { protocol_version: "wechat_draft_receipt.v1", execution_scope: executionScope, recovery_cycle: input.recovery_cycle || null, draft_identity_hash: draftIdentity, package_artifact_id: packageMeta.artifact_id, package_payload_hash: packageMeta.payload_hash, prepublish_qa_artifact_id: preQaMeta.artifact_id, prepublish_qa_payload_hash: preQaMeta.payload_hash, upload_receipt_ids: uploads.map(upload => upload.metadata.artifact_id), account_binding_id: account.account_binding_id, operation_id: draftOperationId, mutation, verified_draft_media_id: String(draftResult.media_id), verified_thumb_media_id: String(uploads[0]?.media_id || ""), verified_cover_image_url: uploads[0]?.url || null, created_at: workflowTimestamp(params.created_at, 22_900) };
  const draftKey = await wechatArtifactIdempotencyKey("draft-mutation", { draft_identity_hash: draftIdentity, package_payload_hash: packageMeta.payload_hash, prepublish_qa_payload_hash: preQaMeta.payload_hash });
  const draftReceipt = await makeWechatArtifact({ owner, kind: "wechat_draft_receipt", payload: receiptPayload, input_artifact_ids: [packageMeta.artifact_id, preQaMeta.artifact_id, ...uploads.map(upload => upload.metadata.artifact_id)], idempotency_key: draftKey, created_at: receiptPayload.created_at });
  const receiptMeta = await persistWechatArtifact(env, coordinator, params, draftReceipt, artifactState("draft_verifying"), "wechat_artifact_committed");
  if (draft || recoveredDraftCallId) await coordinator.completeFiveAgentCall({ call_id: draft?.call_id || recoveredDraftCallId!, run_id: params.run_id, status: "succeeded", response_hash: receiptMeta.payload_hash, artifact_id: receiptMeta.artifact_id, recorded_at: receiptPayload.created_at });
  const readOperationId = await wechatOperationId("get_draft", { execution_scope: executionScope, draft_identity: draftIdentity, receipt_hash: receiptMeta.payload_hash, ...(sameContent ? { validation: "pre-read" } : {}) });
  const read = sameContent ? null : await callWechatOperation(env, coordinator, params, "get_draft", {
    account_binding_id: account.account_binding_id,
    account_receipt_hash: account.account_receipt_hash,
    payload: { operation_id: readOperationId, media_id: draftResult.media_id, ...fingerprint },
  }, workflowTimestamp(params.created_at, 23_000));
  const readResult = read?.response.result && typeof read.response.result === "object" ? read.response.result as Record<string, unknown> : draftResult;
  let readbackHtml: string | null = null;
  let readbackUrls: string[] = [];
  let readbackHtmlHash: string | null = null;
  try {
    readbackHtml = normalizeWechatHtml(String(readResult.canonical_html || ""));
    const validation = validateWechatHtml(readbackHtml, expectedBodyUrls);
    if (validation.body_urls.some(url => !isWechatMediaUrlAllowed(env.WECHAT_MEDIA_URL_HOST_ALLOWLIST, url))) throw new Error("media host");
    readbackHtml = validation.canonical_html;
    readbackUrls = validation.body_urls;
    readbackHtmlHash = await sha256(new TextEncoder().encode(readbackHtml));
  } catch {
    readbackHtml = null;
  }
  const matches = readResult.media_id === draftResult.media_id && readResult.title === packagePayload.title &&
    readbackHtml === packagePayload.canonical_html && readbackHtmlHash === packagePayload.html_hash &&
    readResult.thumb_media_id === uploads[0].media_id && Number(readResult.article_index) === 0 &&
    artifactCanonicalJson(readbackUrls) === artifactCanonicalJson(expectedBodyUrls);
  const readbackPayload: WechatDraftReadbackQAPayload = { protocol_version: "wechat_draft_readback_qa.v1", execution_scope: executionScope, recovery_cycle: input.recovery_cycle || null, draft_receipt_artifact_id: receiptMeta.artifact_id, draft_receipt_payload_hash: receiptMeta.payload_hash, package_artifact_id: packageMeta.artifact_id, package_payload_hash: packageMeta.payload_hash, prepublish_qa_artifact_id: preQaMeta.artifact_id, prepublish_qa_payload_hash: preQaMeta.payload_hash, upload_receipt_ids: uploads.map(upload => upload.metadata.artifact_id), decision: matches ? "pass" : "failed", checks: { media: readResult.media_id === draftResult.media_id, title: readResult.title === packagePayload.title, html: readbackHtml === packagePayload.canonical_html && readbackHtmlHash === packagePayload.html_hash, urls: artifactCanonicalJson(readbackUrls) === artifactCanonicalJson(expectedBodyUrls), thumb: readResult.thumb_media_id === uploads[0].media_id, article_index: 0 }, verified_draft_media_id: String(readResult.media_id || draftResult.media_id), verified_thumb_media_id: String(readResult.thumb_media_id || uploads[0]?.media_id || ""), verified_cover_image_url: verifiedCoverImageUrl || null, created_at: workflowTimestamp(params.created_at, 23_100) };
  const readbackKey = await wechatArtifactIdempotencyKey("readback-qa", { draft_receipt_payload_hash: receiptMeta.payload_hash, package_payload_hash: packageMeta.payload_hash });
  const readback = await makeWechatArtifact({ owner, kind: "wechat_draft_readback_qa", payload: readbackPayload, input_artifact_ids: [packageMeta.artifact_id, preQaMeta.artifact_id, receiptMeta.artifact_id, ...uploads.map(upload => upload.metadata.artifact_id)], idempotency_key: readbackKey, created_at: readbackPayload.created_at });
  const readbackMeta = await persistWechatArtifact(env, coordinator, params, readback, artifactState("draft_verifying"), "wechat_artifact_committed");
  if (read) await coordinator.completeFiveAgentCall({ call_id: read.call_id, run_id: params.run_id, status: "succeeded", response_hash: readbackMeta.payload_hash, artifact_id: readbackMeta.artifact_id, recorded_at: readbackPayload.created_at });
  if (!matches) throw new EditorialRuntimeError("draft_readback_mismatch", "wechat draft readback does not match", 409);
  await verifyExactWechatArtifactSet(env, coordinator, params, expectedSlots, executionScope);
  const finalized = await finalizeWechatDraft(env, coordinator, params, readbackMeta, String(draftResult.media_id), verifiedCoverImageUrl);
  return { run_id: params.run_id, state: "draft_ready", state_revision: finalized.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: [...visual.artifact_ids, templateMeta.artifact_id, renderQaMeta.artifact_id, ...uploads.map(upload => upload.metadata.artifact_id), packageMeta.artifact_id, preQaMeta.artifact_id, receiptMeta.artifact_id, readbackMeta.artifact_id] };
}

export async function runWechatDraftPhase(input: {
  env: EditorialRuntimeEnv;
  coordinator: DurableObjectStub<EditorialCoordinatorAgent>;
  params: FiveAgentWorkflowParams;
  frozen: StoredArtifactMetadata;
  visual: FiveAgentWorkflowResult;
  transcript: { ref: string; hash: string };
}): Promise<FiveAgentWorkflowResult> {
  const { env, coordinator, params, visual, transcript } = input;
  if (!wechatDraftFeatureEnabled(env, params.user_id, params.workspace_id)) return visual;
  const current = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown>;
  const wechatLedger = await coordinator.getFiveAgentWechatLedger(params.run_id, params.user_id, params.workspace_id);
  const artifactIds = [...visual.artifact_ids, ...wechatLedger.receipt_ids];
  const projection = await env.DB.prepare(`SELECT state FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
    .bind(params.run_id, params.user_id, params.workspace_id).first<{ state: PublicationState }>();
  if (current.state === "draft_ready") {
    const readback = uniquePassingWechatReadback(wechatLedger.artifacts, wechatLedger.receipt_ids);
    if (!readback) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready receipt is missing", 503);
    const activeSlots = wechatLedger.artifacts
      .filter(item => item.kind === "wechat_image_upload_receipt" && item.payload_summary.execution_scope === readback.payload_summary.execution_scope && wechatLedger.receipt_ids.includes(item.artifact_id))
      .sort((left, right) => Number(left.payload_summary.order || 0) - Number(right.payload_summary.order || 0))
      .map(item => String(item.payload_summary.slot_id));
    await verifyExactWechatArtifactSet(env, coordinator, params, activeSlots, readback.payload_summary.execution_scope);
    const evidence = await assertVerifiedWechatDraftReadyEvidence(env, coordinator, params, readback);
    const recording = await env.DB.prepare(`SELECT wechat_draft_id, cover_image_url FROM recordings WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(params.recording_id, params.user_id, params.workspace_id).first<{ wechat_draft_id: string | null; cover_image_url: string | null }>();
    if (projection?.state !== "draft_ready" || recording?.wechat_draft_id !== evidence.draftId ||
        (evidence.coverUrl !== undefined && recording?.cover_image_url !== evidence.coverUrl)) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready evidence is incomplete", 503);
    }
    return { run_id: params.run_id, state: "draft_ready", state_revision: Number(current.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
  }
  if (projection?.state === "draft_ready") {
    const readback = uniquePassingWechatReadback(wechatLedger.artifacts, wechatLedger.receipt_ids);
    const recording = await env.DB.prepare(`SELECT wechat_draft_id, cover_image_url FROM recordings WHERE id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
      .bind(params.recording_id, params.user_id, params.workspace_id).first<{ wechat_draft_id: string | null; cover_image_url: string | null }>();
    if (!readback || !recording?.wechat_draft_id) throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready receipt is missing", 503);
    const evidence = await assertVerifiedWechatDraftReadyEvidence(env, coordinator, params, readback);
    if (recording.wechat_draft_id !== evidence.draftId || (evidence.coverUrl !== undefined && recording.cover_image_url !== evidence.coverUrl)) {
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "draft-ready recording evidence conflicts", 503);
    }
    const activeSlots = wechatLedger.artifacts
      .filter(item => item.kind === "wechat_image_upload_receipt" && item.payload_summary.execution_scope === readback.payload_summary.execution_scope && wechatLedger.receipt_ids.includes(item.artifact_id))
      .sort((left, right) => Number(left.payload_summary.order || 0) - Number(right.payload_summary.order || 0))
      .map(item => String(item.payload_summary.slot_id));
    await verifyExactWechatArtifactSet(env, coordinator, params, activeSlots, readback.payload_summary.execution_scope);
    const finalized = await finalizeWechatDraft(env, coordinator, params, readback, evidence.draftId, evidence.coverUrl);
    return { run_id: params.run_id, state: "draft_ready", state_revision: finalized.doStateRevision, transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
  }
  try {
    if (current.state === "needs_action") {
      // Account repair is the only prerequisite for leaving a local Wave2D
      // hold. Resolution is read-only; a failed repair preserves the existing
      // hold and cannot manufacture publishing progress.
      let account: { account_binding_id: string; account_receipt_hash: string; config_hash: string };
      try {
        account = await requireWechatAccount(env, params, workflowTimestamp(params.created_at, 23_900));
      } catch {
        return { run_id: params.run_id, state: "needs_action", state_revision: Number(current.state_revision), transcript_ref: transcript.ref, transcript_hash: transcript.hash, artifact_ids: artifactIds };
      }
      const recovery = await resumeWechatNeedsAction(env, coordinator, params);
      return await runWechatDraftPhaseInner({
        ...input,
        account,
        ...(recovery.freshExecutionEpoch ? { recovery_cycle: recovery.recoveryCycle } : {}),
        reconciliation_cycle: recovery.recoveryCycle,
        visual: { ...visual, state: recovery.target as FiveAgentWorkflowResult["state"] },
      });
    }
    return await runWechatDraftPhaseInner(input);
  } catch (error) {
    // Scope, pin, identity, and parent-chain conflicts are caller-independent
    // integrity errors. They must not be hidden as a provider failure.
    if ((error instanceof WechatContractError && error.code !== "wechat_html_contract_invalid") ||
        (error instanceof EditorialRuntimeError && ["wechat_visual_input_invalid", "wechat_artifact_identity_conflict", "wechat_artifact_mirror_conflict", "wechat_artifact_not_found"].includes(error.code))) {
      throw error;
    }
    const code = error instanceof EditorialRuntimeError || error instanceof WechatPublishingServiceError || error instanceof WechatContractError
      ? error.code
      : "external_side_effect_unknown";
    if (["external_side_effect_unknown", "wechat_artifact_reconciliation_required", "draft_readback_mismatch", "draft_readback_unavailable", "wechat_publishing_account_unavailable", "wechat_publishing_account_not_allowed", "wechat_publishing_account_rejected", "wechat_access_token_rejected", "draft_identity_unresolved"].includes(code)) {
      const nextAction = code === "draft_readback_mismatch" || code === "draft_readback_unavailable" ? "reconcile_draft" :
        code === "draft_identity_unresolved" ? "reconcile_draft_identity" :
        code === "wechat_publishing_account_not_allowed" ? "request_account_enablement" :
        code === "wechat_publishing_account_unavailable" || code === "wechat_publishing_account_rejected" || code === "wechat_access_token_rejected" ? "repair_publishing_account" :
        "reconcile_external_side_effect";
      return visualHoldWithCode(env, coordinator, params, transcript, artifactIds, code, nextAction, 25, 1, false);
    }
    const failedCode = code === "wechat_html_contract_invalid" ? code :
      code === "wechat_operation_retry_exhausted" ? code :
      code.startsWith("wechat_image_") ? "wechat_image_upload_non_retryable" :
      code.startsWith("wechat_draft_") ? "wechat_draft_write_non_retryable" :
      "wechat_draft_write_non_retryable";
    const nextAction = failedCode === "wechat_html_contract_invalid" ? "retry_after_service_fix" :
      failedCode === "wechat_operation_retry_exhausted" ? "retry" :
      failedCode === "wechat_image_upload_non_retryable" ? "repair_publishing_account" : "repair_draft_payload";
    return visualFailure(env, coordinator, params, transcript, artifactIds, failedCode, nextAction, 25, 1, false);
  }
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
  return ([502, 503, 504, 521, 522, 523].includes(error.status)) &&
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
        source_text_hash: params.transcript_hash,
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
    const confirmedCurrentRun = await coordinator.getFiveAgentRun(params.run_id, params.user_id, params.workspace_id) as Record<string, unknown> | null;
    const visualResumeState = confirmedCurrentRun?.state === "content_frozen" || confirmedCurrentRun?.state === "visual_planning" ||
      confirmedCurrentRun?.state === "visual_generating" || confirmedCurrentRun?.state === "visual_ready" ||
      (confirmedCurrentRun?.state === "needs_action" && confirmedCurrentRun?.error_code === "external_side_effect_unknown" &&
        confirmedCurrentRun?.next_action === "reconcile_external_side_effect" &&
        (confirmedCurrentRun?.last_successful_state === "visual_planning" || confirmedCurrentRun?.last_successful_state === "visual_generating"));
    if (visualResumeState && visualProductionFeatureEnabled(this.env, params.user_id, params.workspace_id, params.run_id)) {
      const frozen = (await coordinator.listFiveAgentArtifacts(params.run_id, params.user_id, params.workspace_id)).find(item => item.kind === "frozen_article_version") as StoredArtifactMetadata | undefined;
      if (!frozen) throw new EditorialRuntimeError("frozen_artifact_not_found", "visual replay cannot find the frozen artifact", 503);
      const visual = await runVisualProductionPhase({
        env: this.env,
        coordinator,
        params,
        frozen,
        priorArtifactIds: (await coordinator.listFiveAgentArtifacts(params.run_id, params.user_id, params.workspace_id)).map(item => item.artifact_id),
        transcript: { ref: params.transcript_ref, hash: params.transcript_hash },
        step,
      });
      return runWechatDraftPhase({ env: this.env, coordinator, params, frozen, visual, transcript: { ref: params.transcript_ref, hash: params.transcript_hash } });
    }
    // Wave2D resume is intentionally separate from the visual resume path.
    // The visual phase has already made its immutable inputs; replaying it here
    // would risk invoking image work while only a local WeChat receipt is
    // incomplete. Each downstream WeChat artifact is itself idempotent.
    const wechatResumeState = ["visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready", "needs_action"].includes(String(confirmedCurrentRun?.state));
    if (wechatResumeState && wechatDraftFeatureEnabled(this.env, params.user_id, params.workspace_id)) {
      const artifacts = await coordinator.listFiveAgentArtifacts(params.run_id, params.user_id, params.workspace_id);
      const frozen = artifacts.find(item => item.kind === "frozen_article_version") as StoredArtifactMetadata | undefined;
      if (!frozen) throw new EditorialRuntimeError("frozen_artifact_not_found", "wechat replay cannot find the frozen artifact", 503);
      return runWechatDraftPhase({
        env: this.env,
        coordinator,
        params,
        frozen,
        visual: {
          run_id: params.run_id,
          state: "visual_ready",
          state_revision: Number(confirmedCurrentRun?.state_revision || 0),
          transcript_ref: params.transcript_ref,
          transcript_hash: params.transcript_hash,
          artifact_ids: artifacts.map(item => item.artifact_id),
        },
        transcript: { ref: params.transcript_ref, hash: params.transcript_hash },
      });
    }
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
      const visual = await runVisualProductionPhase({ env: this.env, coordinator, params, frozen: frozen2, priorArtifactIds: [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, dispatch.artifact_id, draft2.artifact_id, review2.artifact_id, frozen2.artifact_id], transcript, step });
      return runWechatDraftPhase({ env: this.env, coordinator, params, frozen: frozen2, visual, transcript });
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
    const visual = await runVisualProductionPhase({ env: this.env, coordinator, params, frozen, priorArtifactIds: [briefCommit.artifact_id, draft.artifact_id, review.artifact_id, frozen.artifact_id], transcript, step });
    return runWechatDraftPhase({ env: this.env, coordinator, params, frozen, visual, transcript });
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
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (request.method === "POST" && parts.length === 5 && parts[4] === "runs") {
      if (!publicationTenantFeatureEnabled(env, userId, workspaceId)) {
        return Response.json({ error: "editorial_workflow_disabled" }, { status: 404 });
      }
      const body = normalizeFiveAgentStartBody(await parseRequestJson(request));
      if (!publicationFeatureEnabled(env, userId, workspaceId, body.run_id)) {
        return Response.json({ error: "editorial_workflow_disabled" }, { status: 404 });
      }
      const existingCanonical = await env.DB.prepare(`SELECT user_id, workspace_id, article_id, recording_id, created_at
        FROM editorial_runs WHERE run_id = ? LIMIT 1`).bind(body.run_id).first<{
          user_id: string; workspace_id: string; article_id: string; recording_id: number; created_at: string;
        }>();
      const createdAt = existingCanonical && existingCanonical.user_id === userId &&
        existingCanonical.workspace_id === workspaceId && existingCanonical.article_id === body.article_id &&
        Number(existingCanonical.recording_id) === body.recording_id
        ? existingCanonical.created_at
        : new Date().toISOString();
      const payloadHash = await hashJson({ ...body, user_id: userId, workspace_id: workspaceId });
      const manifest = await manifestFor({
        ...body, user_id: userId, workspace_id: workspaceId,
        payload_hash: payloadHash, model_version: env.GLM_MODEL,
      });
      const manifestJson = canonicalJson(manifest);
      const manifestHash = await sha256(new TextEncoder().encode(manifestJson));
      const legacyManifest = { ...manifest };
      delete legacyManifest.payload_hash;
      const legacyManifestJson = canonicalJson(legacyManifest);
      const legacyManifestHash = await sha256(new TextEncoder().encode(legacyManifestJson));
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
      const briefObject = await buildFiveAgentBriefObject({ ...body, user_id: userId, workspace_id: workspaceId, created_at: createdAt });
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
      const existingDoRun = await coordinator.findFiveAgentRun(body.run_id, userId, workspaceId) as Record<string, unknown> | null;
      if (existingDoRun && (existingDoRun.manifest_hash !== manifestHash || existingDoRun.manifest_json !== manifestJson) &&
          existingDoRun.manifest_hash === legacyManifestHash && existingDoRun.manifest_json === legacyManifestJson) {
        const workflowStatus = await coordinator.getFiveAgentWorkflowStatus(body.run_id, runInput.workflow_id);
        if (workflowStatus !== "not_found") return startHoldResponse(existingDoRun, briefMetadata);
        await coordinator.upgradeLegacyFiveAgentRunManifest({
          ...runInput,
          legacy_manifest_hash: legacyManifestHash,
          legacy_manifest_json: legacyManifestJson,
        });
      }
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
      if (!publicationTenantFeatureEnabled(env, userId, workspaceId)) {
        return Response.json({ error: "editorial_workflow_disabled" }, { status: 404 });
      }
      const runId = id(parts[5], "run_id");
      if (!publicationFeatureEnabled(env, userId, workspaceId, runId)) {
        return Response.json({ error: "editorial_workflow_disabled" }, { status: 404 });
      }
      const articleId = id(url.searchParams.get("article_id") || "", "article_id");
      const coordinator = env.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(userId, workspaceId, articleId, runId));
      const current = await coordinator.getFiveAgentRun(runId, userId, workspaceId) as Record<string, unknown>;
      return Response.json({ run: buildPublicRunProjection(current) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}
