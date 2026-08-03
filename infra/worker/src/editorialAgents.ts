import { Agent } from "agents";
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
} from "agents/workflows";
import {
  EDITORIAL_AGENT_IDS,
  PUBLICATION_AGENT_IDS,
  PUBLICATION_AGENT_VERSIONS as CONTRACT_PUBLICATION_AGENT_VERSIONS,
  isExactWave2PublicationSkillPins,
  PUBLICATION_WAVE2_ADAPTER_PINS,
  PUBLICATION_SKILL_PINS,
  canonicalJson,
} from "./editorialContracts";
import type { EditorialAgentId } from "./editorialContracts";
import { artifactKey, WAVE2_ARTIFACT_KINDS, WAVE2_SCHEMA_VERSION, validateArtifactKey } from "./wave2/artifactContracts";
import { visualArtifactKey } from "./wave2/visualContracts";
import type { VisualArtifactMetadata } from "./wave2/visualContracts";
import { wechatArtifactKey } from "./wave2/wechatContracts";
import type { WechatArtifactMetadata } from "./wave2/wechatContracts";

export const EDITORIAL_WORKFLOW_VERSION = "editorial-workflow.v2";
export const EDITORIAL_POLICY_VERSION = "editorial-policy.v2";
export const EDITORIAL_SCHEMA_VERSION = "editorial-orchestration.v2";
const WAVE2B_OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WAVE2B_STATES = ["queued", "transcribing", "transcript_ready", "writing", "draft_generated", "reviewing", "revising", "reviewed", "content_frozen", "visual_planning", "visual_generating", "visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready", "needs_action", "failed"] as const;
const WAVE2B_EVENT_TYPES = ["run_queued", "transcription_started", "transcript_ready", "writing_started", "draft_generated", "review_started", "reviewed", "revision_requested", "content_frozen", "visual_planning", "visual_generating", "visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready", "visual_plan_committed", "visual_asset_committed", "visual_qa_committed", "wechat_artifact_committed", "needs_action", "failed", "artifact_committed"] as const;
const WAVE2B_PROGRESS: Record<string, number> = {
  queued: 0,
  transcribing: 10,
  transcript_ready: 20,
  writing: 28,
  draft_generated: 38,
  reviewing: 45,
  revising: 50,
  reviewed: 55,
  content_frozen: 62,
  visual_planning: 68,
  visual_generating: 74,
  visual_ready: 80,
  formatting: 84,
  visual_qa: 90,
  draft_syncing: 96,
  draft_verifying: 98,
  draft_ready: 100,
};

function deriveWave2BProjection(current: Record<string, unknown>, state: string, nextAction?: string | null, errorCode?: string | null): {
  runStatus: "active" | "needs_action" | "failed";
  progress: number;
  resumeState: string | null;
  lastSuccessfulState: string;
  lastSuccessfulProgress: number;
} {
  const oldLastSuccessfulState = String(current.last_successful_state || "queued");
  const oldLastSuccessfulProgress = Number(current.last_successful_progress_percent || 0);
  const exceptional = state === "needs_action" || state === "failed";
  const progress = exceptional
    ? oldLastSuccessfulProgress
    : Math.max(oldLastSuccessfulProgress, WAVE2B_PROGRESS[state] ?? 0);
  return {
    runStatus: state === "needs_action" ? "needs_action" : state === "failed" ? "failed" : "active",
    progress,
    resumeState: null,
    lastSuccessfulState: exceptional ? oldLastSuccessfulState : state,
    lastSuccessfulProgress: progress,
  };
}
const WAVE2B_TRANSITIONS: Record<string, readonly string[]> = {
  queued: ["transcribing", "needs_action", "failed"],
  transcribing: ["transcript_ready", "failed"],
  transcript_ready: ["writing", "failed"],
  writing: ["draft_generated", "needs_action", "failed"],
  draft_generated: ["reviewing", "failed"],
  reviewing: ["revising", "reviewed", "needs_action", "failed"],
  revising: ["writing", "needs_action", "failed"],
  reviewed: ["content_frozen", "needs_action"],
  content_frozen: ["visual_planning", "needs_action", "failed"],
  visual_planning: ["visual_generating", "needs_action", "failed"],
  visual_generating: ["visual_ready", "needs_action", "failed"],
  visual_ready: ["formatting", "needs_action", "failed"],
  formatting: ["visual_qa", "needs_action", "failed"],
  visual_qa: ["draft_syncing", "needs_action", "failed"],
  draft_syncing: ["draft_verifying", "needs_action", "failed"],
  draft_verifying: ["draft_ready", "needs_action", "failed"],
  draft_ready: [],
  // D1 resumes through retrying; Coordinator is the trusted counterpart that
  // can return a repaired Wave2C/D checkpoint to its recorded local state.
  needs_action: ["writing", "reviewing", "visual_planning", "visual_generating", "visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying", "failed"],
  failed: [],
};

export const EDITORIAL_AGENT_VERSIONS: Record<EditorialAgentId, string> = {
  editorial_coordinator: "editorial-coordinator.agent.v2",
  writing: "writing.agent.v2",
  editorial_review: "editorial-review.agent.v2",
  illustration: "illustration.agent.v2",
  cover: "cover.agent.v2",
};

export const PUBLICATION_AGENT_VERSIONS = { ...CONTRACT_PUBLICATION_AGENT_VERSIONS };
export const PUBLICATION_ROLES = PUBLICATION_AGENT_IDS;

export const EDITORIAL_ROLES = EDITORIAL_AGENT_IDS;
export const EDITORIAL_SCENARIOS = ["happy", "p0", "p1_once", "p1_second_failure"] as const;
export type EditorialScenario = (typeof EDITORIAL_SCENARIOS)[number];
export const EDITORIAL_ARTIFACT_KINDS = [
  "article_brief",
  "article_draft",
  "review_report",
  "frozen_article_version",
  "illustration_plan",
  "cover_plan",
] as const;
export type EditorialArtifactKind = (typeof EDITORIAL_ARTIFACT_KINDS)[number];

export type EditorialWorkflowParams = {
  run_id: string;
  article_id: string;
  recording_id: number;
  user_id: string;
  workspace_id: string;
  scenario: EditorialScenario;
  payload_hash: string;
};

export type EditorialAgentState = {
  schema_version: string;
  run_id?: string;
  state: string;
  state_revision: number;
  approval_state: "not_required" | "awaiting" | "approved" | "rejected" | "timed_out" | "human_action_required";
  revision_count: number;
  workflow_id?: string;
  artifact_count: number;
};

export type EditorialRuntimeEnv = Cloudflare.Env & {
  DB: D1Database;
  FILES_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  EDITORIAL_COORDINATOR: DurableObjectNamespace<EditorialCoordinatorAgent>;
  V3_TENANT_SCOPE?: string;
  FIVE_AGENT_PUBLISHING_V3?: string;
  FIVE_AGENT_PUBLISHING_V3_ALLOWLIST?: string;
  DEPLOY_ENVIRONMENT?: string;
  STAGING_IMAGE_CANARY_MODE?: string;
  STAGING_IMAGE_CANARY_RUN_ID?: string;
  STAGING_IMAGE_CANARY_USER_ID?: string;
  STAGING_IMAGE_CANARY_WORKSPACE_ID?: string;
  STAGING_IMAGE_CANARY_SOURCE_KEY?: string;
  STAGING_IMAGE_CANARY_EXPIRES_AT?: string;
  MINING_V3_HANDOFF_TOKEN?: string;
  EDITORIAL_WORKFLOW: Workflow<EditorialWorkflowParams>;
  FIVE_AGENT_PUBLISHING_WORKFLOW?: Workflow<FiveAgentRunInput>;
  WRITING_AGENT?: Fetcher;
  REVIEW_AGENT?: Fetcher;
  WRITING_AGENT_BASE_URL?: string;
  REVIEW_AGENT_BASE_URL?: string;
  WRITING_AGENT_TOKEN?: string;
  REVIEW_AGENT_TOKEN?: string;
  IMAGE_GENERATION_ADAPTER?: Fetcher;
  VISUAL_PRODUCTION_V3?: string;
  VISUAL_PRODUCTION_V3_ALLOWLIST?: string;
  VISUAL_PRODUCTION_TOKEN?: string;
  WECHAT_DRAFT_SYNC_V3?: string;
  WECHAT_DRAFT_SYNC_V3_ALLOWLIST?: string;
  WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST?: string;
  WECHAT_MEDIA_URL_HOST_ALLOWLIST?: string;
  WECHAT_PUBLISHING_TOKEN?: string;
  WECHAT_PUBLISHING_ADAPTER?: Fetcher;
  GLM_MODEL?: string;
};

type RunRow = {
  run_id: string;
  article_id: string;
  recording_id: number;
  user_id: string;
  workspace_id: string;
  scenario: EditorialScenario;
  payload_hash: string;
  manifest_json: string;
  workflow_id: string | null;
  state: string;
  state_revision: number;
  approval_state: EditorialAgentState["approval_state"];
  revision_count: number;
  created_at: string;
  updated_at: string;
};

type ArtifactRow = {
  artifact_id: string;
  run_id: string;
  kind: string;
  idempotency_key: string;
  payload_hash: string;
  producer_role: string;
  producer_version: string;
  input_artifact_ids_json: string;
  summary_json: string;
  created_at: string;
};

type OutboxRow = {
  outbox_id: string;
  run_id: string;
  artifact_id: string;
  user_id: string;
  workspace_id: string;
  article_id: string;
  recording_id: number;
  kind: EditorialArtifactKind;
  payload_hash: string;
  producer_role: EditorialAgentId;
  producer_version: string;
  input_artifact_ids_json: string;
  summary_json: string;
  storage_ref: string;
  created_at: string;
};

type D1RunRow = {
  run_id: string;
  user_id: string;
  workspace_id: string;
  article_id: string;
  recording_id: number;
  schema_version: string;
  workflow_version: string;
  policy_version: string;
  agent_versions_json: string;
  skill_pins_json: string;
  status: "planned" | "running" | "completed" | "failed";
  payload_hash: string;
  idempotency_key: string;
  updated_at: string;
};

type D1ArtifactRow = {
  artifact_id: string;
  run_id: string;
  user_id: string;
  workspace_id: string;
  article_id: string;
  recording_id: number;
  schema_version: string;
  kind: string;
  producer_agent_role: string;
  producer_agent_version: string;
  skill_id: string | null;
  skill_version: string | null;
  workflow_version: string;
  policy_version: string;
  input_artifact_ids_json: string;
  payload_hash: string;
  storage_ref: string;
};

type TerminalStatus = "completed" | "failed";

type TerminalIntentRow = {
  intent_id: string;
  run_id: string;
  step_key: string;
  terminal_status: TerminalStatus;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
};

type StepRow = {
  step_name: string;
  step_key: string;
  payload_hash: string;
  result_json: string;
};

type ArtifactInput = {
  kind: EditorialArtifactKind;
  idempotency_key: string;
  producer_role: EditorialAgentId;
  producer_version: string;
  input_artifact_ids?: string[];
  summary: Record<string, unknown>;
};

type WorkflowStepInput = {
  run_id: string;
  step_name: string;
  step_key: string;
  expected_state: string;
  next_state: string;
  artifacts: ArtifactInput[];
  approval_state?: EditorialAgentState["approval_state"];
  revision_count?: number;
  terminal_status?: TerminalStatus;
};

type WorkflowStepResult = {
  state: string;
  state_revision: number;
  artifact_ids: string[];
  replayed: boolean;
  approval_state?: EditorialAgentState["approval_state"];
  revision_count?: number;
  payload_hash?: string;
  terminal_status?: TerminalStatus;
};

type HumanActionInput = {
  run_id: string;
  action: "wait" | "approve" | "reject" | "timeout";
  idempotency_key: string;
  payload_hash: string;
  workflow_id: string;
  reason?: string;
};

type HumanActionRow = {
  action: string;
  idempotency_key: string;
  payload_hash: string;
  result_json: string;
};

export type FiveAgentRunInput = {
  run_id: string;
  article_id: string;
  recording_id: number;
  user_id: string;
  workspace_id: string;
  payload_hash: string;
  manifest_hash: string;
  manifest_json: string;
  workflow_id: string;
  created_at: string;
};

export type FiveAgentStartStatus = "brief_storage_unknown" | "workflow_create_unknown";

export type FiveAgentWorkflowStartHold = {
  code: "workflow_create_unknown" | "five_agent_workflow_reconciliation_required";
  status: 503;
  start_status: "workflow_create_unknown";
};

export type FiveAgentWorkflowStartResult = {
  run: Record<string, unknown> | null;
  replayed: boolean;
  workflow_status: string;
  start_hold?: FiveAgentWorkflowStartHold;
};

type FiveAgentStartLedgerRow = {
  workflow_id: string;
  run_id: string;
  status: "intent" | "needs_action" | "started" | "reconciled";
  start_status: FiveAgentStartStatus | null;
  error_code: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
};

export type FiveAgentEnvelopeMetadata = {
  schema_version: string;
  artifact_id: string;
  artifact_key: string;
  kind: string;
  run_id: string;
  article_id: string;
  recording_id: number;
  user_id: string;
  workspace_id: string;
  producer_role: string;
  producer_version: string;
  workflow_version: string;
  policy_version: string;
  input_artifact_ids_json: string;
  payload_hash: string;
  payload_length: number;
  idempotency_key: string;
  storage_ref: string;
  created_at: string;
  skill_pins_hash: string;
  envelope_identity_hash: string;
};

export class EditorialRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409, public readonly retryCount = 1) {
    super(message);
    this.name = "EditorialRuntimeError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function validateOpaque(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new EditorialRuntimeError("invalid_opaque_id", `${field} must be an opaque identifier`, 400);
  }
  return value;
}

function validateScenario(value: string): EditorialScenario {
  if (!EDITORIAL_SCENARIOS.includes(value as EditorialScenario)) {
    throw new EditorialRuntimeError("workflow_version_not_allowed", "unknown editorial workflow scenario", 400);
  }
  return value as EditorialScenario;
}

function validateArtifactKind(value: string): asserts value is EditorialArtifactKind {
  if (!EDITORIAL_ARTIFACT_KINDS.includes(value as EditorialArtifactKind)) {
    throw new EditorialRuntimeError("artifact_kind_not_allowed", "unknown editorial artifact kind", 409);
  }
}

function validateAgent(role: string, version: string): asserts role is EditorialAgentId {
  if (!EDITORIAL_ROLES.includes(role as EditorialAgentId)) {
    throw new EditorialRuntimeError("agent_role_not_allowed", "unknown editorial agent role", 400);
  }
  if (EDITORIAL_AGENT_VERSIONS[role as EditorialAgentId] !== version) {
    throw new EditorialRuntimeError("agent_version_not_allowed", "editorial agent version is not enabled", 409);
  }
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function hashJson(value: unknown): Promise<string> {
  return hashText(canonicalJson(value));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function safeJson(value: unknown): string {
  return canonicalJson(value);
}

const FIVE_AGENT_MANIFEST_KEYS = [
  "schema_version", "run_id", "article_id", "recording_id", "user_id", "workspace_id",
  "workflow_version", "policy_version", "agent_versions", "skill_pins", "adapter_pins",
  "model_pins", "idempotency_key", "payload_hash",
] as const;

async function validateFiveAgentManifest(input: FiveAgentRunInput): Promise<Record<string, unknown>> {
  if (!WAVE2B_OPAQUE_RE.test(input.run_id) || !WAVE2B_OPAQUE_RE.test(input.workflow_id) ||
      !WAVE2B_OPAQUE_RE.test(input.user_id) || !WAVE2B_OPAQUE_RE.test(input.workspace_id) ||
      !WAVE2B_OPAQUE_RE.test(input.article_id) || !Number.isSafeInteger(input.recording_id) || input.recording_id < 1) {
    throw new EditorialRuntimeError("invalid_opaque_id", "Wave2B run identity is invalid", 400);
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(input.manifest_json) as Record<string, unknown>; } catch {
    throw new EditorialRuntimeError("manifest_invalid", "Wave2B manifest is invalid", 400);
  }
  const agentVersions = manifest.agent_versions as Record<string, unknown> | undefined;
  const skillPins = manifest.skill_pins as Record<string, unknown> | undefined;
  const adapterPins = manifest.adapter_pins as Record<string, unknown> | undefined;
  const modelPins = manifest.model_pins as Record<string, unknown> | undefined;
  const manifestPinsValid = isExactWave2PublicationSkillPins(skillPins) &&
    canonicalJson(skillPins?.adapter_pins) === canonicalJson(adapterPins) &&
    canonicalJson(skillPins?.model_pins) === canonicalJson(modelPins);
  if (safeJson(manifest) !== input.manifest_json || await hashText(input.manifest_json) !== input.manifest_hash ||
      Object.keys(manifest).length !== FIVE_AGENT_MANIFEST_KEYS.length ||
      Object.keys(manifest).some(key => !(FIVE_AGENT_MANIFEST_KEYS as readonly string[]).includes(key)) ||
      manifest.schema_version !== "editorial-orchestration.v3" || manifest.run_id !== input.run_id ||
      manifest.article_id !== input.article_id || manifest.user_id !== input.user_id ||
      manifest.workspace_id !== input.workspace_id || manifest.recording_id !== input.recording_id ||
      manifest.workflow_version !== "editorial-workflow.v3" || manifest.policy_version !== "editorial-policy.v3" ||
      manifest.idempotency_key !== `run:${input.run_id}` || manifest.payload_hash !== input.payload_hash ||
      canonicalJson(agentVersions) !== canonicalJson(PUBLICATION_AGENT_VERSIONS) || !manifestPinsValid ||
      canonicalJson(adapterPins) !== canonicalJson(PUBLICATION_WAVE2_ADAPTER_PINS) ||
      !modelPins || typeof modelPins.writing !== "string" || modelPins.writing.length === 0 ||
      modelPins.writing.length > 120 || modelPins.editorial_review !== "rules-only") {
    throw new EditorialRuntimeError("manifest_invalid", "Wave2B manifest is not an allowlisted canonical identity", 409);
  }
  return manifest;
}

function envelopeIdentityMaterial(metadata: FiveAgentEnvelopeMetadata): Record<string, unknown> {
  return {
    schema_version: metadata.schema_version,
    artifact_id: metadata.artifact_id,
    artifact_key: metadata.artifact_key,
    kind: metadata.kind,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: metadata.recording_id,
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    producer_role: metadata.producer_role,
    producer_version: metadata.producer_version,
    workflow_version: metadata.workflow_version,
    policy_version: metadata.policy_version,
    input_artifact_ids_json: metadata.input_artifact_ids_json,
    payload_hash: metadata.payload_hash,
    payload_length: metadata.payload_length,
    idempotency_key: metadata.idempotency_key,
    storage_ref: metadata.storage_ref,
    created_at: metadata.created_at,
    skill_pins_hash: metadata.skill_pins_hash,
  };
}

function expectedArtifactSkillPins(kind: string, manifest: Record<string, unknown>): Record<string, unknown> {
  const pins = manifest.skill_pins;
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) {
    throw new EditorialRuntimeError("manifest_pin_conflict", "Wave2B run manifest skill pins are invalid", 409);
  }
  const skillPins = pins as Record<string, unknown>;
  if (kind === "article_brief" || kind === "article_draft" || kind === "frozen_article_version") {
    return { style: skillPins.style, formatting: skillPins.formatting };
  }
  if (kind === "review_report") return { review: skillPins.review };
  if (kind === "revision_dispatch") return { writing: skillPins.writing, review: skillPins.review };
  throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B artifact kind is not allowed", 409);
}

function runManifestPins(run: RunRow): {
  agentVersionsJson: string;
  skillPinsJson: string;
  formattingSkillId: string | null;
  formattingSkillVersion: string | null;
} {
  const manifest = parseJson<Record<string, unknown>>(run.manifest_json);
  const skillPins = (manifest.skill_pins || {}) as Record<string, unknown>;
  const formattingPin = (skillPins.formatting || {}) as Record<string, unknown>;
  return {
    agentVersionsJson: safeJson(manifest.agent_versions || {}),
    skillPinsJson: safeJson(skillPins),
    formattingSkillId: typeof formattingPin.id === "string" ? formattingPin.id : null,
    formattingSkillVersion: typeof formattingPin.version === "string" ? formattingPin.version : null,
  };
}

function d1IdentityMatchesRun(existing: D1RunRow, run: RunRow): boolean {
  const pins = runManifestPins(run);
  return existing.run_id === run.run_id
    && existing.user_id === run.user_id
    && existing.workspace_id === run.workspace_id
    && existing.article_id === run.article_id
    && existing.recording_id === run.recording_id
    && existing.schema_version === EDITORIAL_SCHEMA_VERSION
    && existing.workflow_version === EDITORIAL_WORKFLOW_VERSION
    && existing.policy_version === EDITORIAL_POLICY_VERSION
    && existing.agent_versions_json === pins.agentVersionsJson
    && existing.skill_pins_json === pins.skillPinsJson
    && existing.payload_hash === run.payload_hash
    && existing.idempotency_key === `run:${run.run_id}`;
}

function d1IdentityMatchesArtifact(existing: D1ArtifactRow, artifact: OutboxRow, run: RunRow): boolean {
  const pins = runManifestPins(run);
  // Phase 1's D1 schema has no artifact idempotency column. The immutable
  // artifact_id is derived from the DO artifact idempotency key, so comparing
  // it here preserves that identity without adding a new production column.
  return existing.artifact_id === artifact.artifact_id
    && existing.run_id === artifact.run_id
    && existing.user_id === artifact.user_id
    && existing.workspace_id === artifact.workspace_id
    && existing.article_id === artifact.article_id
    && existing.recording_id === artifact.recording_id
    && existing.schema_version === EDITORIAL_SCHEMA_VERSION
    && existing.kind === artifact.kind
    && existing.producer_agent_role === artifact.producer_role
    && existing.producer_agent_version === artifact.producer_version
    && existing.skill_id === pins.formattingSkillId
    && existing.skill_version === pins.formattingSkillVersion
    && existing.workflow_version === EDITORIAL_WORKFLOW_VERSION
    && existing.policy_version === EDITORIAL_POLICY_VERSION
    && existing.input_artifact_ids_json === artifact.input_artifact_ids_json
    && existing.payload_hash === artifact.payload_hash
    && existing.storage_ref === artifact.storage_ref;
}

const D1_ARTIFACT_COLUMNS = `artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
  schema_version, kind, producer_agent_role, producer_agent_version, skill_id, skill_version,
  workflow_version, policy_version, input_artifact_ids_json, payload_hash, storage_ref`;

async function readD1Artifacts(db: D1Database, runId: string): Promise<D1ArtifactRow[]> {
  const result = await db.prepare(
    `SELECT ${D1_ARTIFACT_COLUMNS} FROM editorial_artifacts WHERE run_id = ? ORDER BY artifact_id`,
  ).bind(runId).all<D1ArtifactRow>();
  return result.results;
}

function d1ArtifactConflict(): EditorialRuntimeError {
  return new EditorialRuntimeError("editorial_d1_mirror_conflict", "D1 artifact set or identity conflicts", 409);
}

async function assertNoUnexpectedD1Artifacts(
  db: D1Database,
  run: RunRow,
  artifacts: readonly OutboxRow[],
): Promise<void> {
  const existingArtifacts = await readD1Artifacts(db, run.run_id);
  const expectedById = new Map(artifacts.map(artifact => [artifact.artifact_id, artifact]));
  for (const existing of existingArtifacts) {
    const expected = expectedById.get(existing.artifact_id);
    if (!expected || !d1IdentityMatchesArtifact(existing, expected, run)) {
      throw d1ArtifactConflict();
    }
  }
}

async function assertExactD1Artifacts(
  db: D1Database,
  run: RunRow,
  artifacts: readonly OutboxRow[],
): Promise<void> {
  const existingArtifacts = await readD1Artifacts(db, run.run_id);
  if (existingArtifacts.length !== artifacts.length) throw d1ArtifactConflict();
  const existingById = new Map(existingArtifacts.map(artifact => [artifact.artifact_id, artifact]));
  for (const expected of artifacts) {
    const existing = existingById.get(expected.artifact_id);
    if (!existing || !d1IdentityMatchesArtifact(existing, expected, run)) throw d1ArtifactConflict();
  }
}

function laterTimestamp(previous: string): string {
  const candidate = now();
  if (candidate > previous) return candidate;
  const parsed = Date.parse(previous);
  return Number.isFinite(parsed) ? new Date(parsed + 1).toISOString() : candidate;
}

function timestampAtOrAfter(previous: string, candidate: string): string {
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(previousMs)) return candidate;
  if (!Number.isFinite(candidateMs) || candidateMs <= previousMs) return new Date(previousMs + 1).toISOString();
  return candidate;
}

function isCloudflareWorkflowInstanceNotFoundMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const message = value.trim();
  if (message === "(instance.not_found) Instance not found") return true;
  const signature = "workflows.api.error.instance.not_found";
  if (!message.includes(signature)) return false;
  const codes = [...message.matchAll(/\[code:\s*([0-9]+)\]/gi)].map(match => match[1]);
  return codes.length === 0 || codes.every(code => code === "10400");
}

function boundedWorkflowDiagnosticValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function workflowLookupDiagnostic(error: unknown): Record<string, unknown> {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return { value_type: typeof error, value: boundedWorkflowDiagnosticValue(error) };
  }
  const record = error as Record<string, unknown>;
  let stringValue: string | null = null;
  try { stringValue = boundedWorkflowDiagnosticValue(String(error)) as string | null; } catch { /* diagnostic only */ }
  return {
    value_type: typeof error,
    object_tag: Object.prototype.toString.call(error),
    own_keys: Object.getOwnPropertyNames(error).sort().slice(0, 16),
    name: boundedWorkflowDiagnosticValue(record.name),
    message: boundedWorkflowDiagnosticValue(record.message),
    code: boundedWorkflowDiagnosticValue(record.code),
    status: boundedWorkflowDiagnosticValue(record.status),
    string_value: stringValue,
  };
}

function isStructuredWorkflowNotFound(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") return isCloudflareWorkflowInstanceNotFoundMessage(current);
    if (typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    const status = record.status;
    const code = record.code;
    // Cloudflare Workflows returns provider code 10400 when a deterministic
    // instance ID has not been created yet.
    if (status === 404 || status === "404" || code === 404 || code === "404" ||
        code === 10400 || code === "10400" ||
        code === "NOT_FOUND" || code === "WORKFLOW_NOT_FOUND") return true;
    if (isCloudflareWorkflowInstanceNotFoundMessage(record.message)) return true;
    try {
      if (isCloudflareWorkflowInstanceNotFoundMessage(String(current))) return true;
    } catch { /* keep unknown provider errors fail-closed */ }
    current = record.cause ?? record.error;
  }
  return false;
}

/**
 * Mirrors only redacted outbox metadata into the existing Phase 1 D1 tables.
 * The caller records a DO receipt only after this batch resolves, so a lost
 * response or D1 failure leaves the same outbox row available for replay.
 */
export async function mirrorEditorialOutboxToD1(
  db: D1Database,
  run: RunRow,
  artifacts: readonly OutboxRow[],
): Promise<void> {
  try {
    const existingRun = await db.prepare(
      `SELECT run_id, user_id, workspace_id, article_id, recording_id, schema_version,
              workflow_version, policy_version, agent_versions_json, skill_pins_json,
              status, payload_hash, idempotency_key, updated_at
       FROM editorial_runs WHERE run_id = ? LIMIT 1`,
    ).bind(run.run_id).first<D1RunRow>();
    if (existingRun && !d1IdentityMatchesRun(existingRun, run)) {
      throw new EditorialRuntimeError("editorial_d1_mirror_conflict", "D1 run ownership or payload conflicts", 409);
    }
    if (existingRun && (existingRun.status === "completed" || existingRun.status === "failed")) {
      await assertExactD1Artifacts(db, run, artifacts);
      return;
    }

    // Reject an extra or mismatched immutable row before any D1 INSERT. A
    // missing expected row is the only repairable condition; it is inserted
    // below and then checked again as an exact set.
    await assertNoUnexpectedD1Artifacts(db, run, artifacts);

    const pins = runManifestPins(run);
    const statements: D1PreparedStatement[] = [];
    if (!existingRun) {
      statements.push(db.prepare(
        `INSERT INTO editorial_runs
          (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
           workflow_version, policy_version, agent_versions_json, skill_pins_json,
           status, idempotency_key, payload_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      ).bind(
        run.run_id,
        run.user_id,
        run.workspace_id,
        run.article_id,
        run.recording_id,
        EDITORIAL_SCHEMA_VERSION,
        EDITORIAL_WORKFLOW_VERSION,
        EDITORIAL_POLICY_VERSION,
        pins.agentVersionsJson,
        pins.skillPinsJson,
        `run:${run.run_id}`,
        run.payload_hash,
        run.created_at,
        run.updated_at,
      ));
    }

    for (const artifact of artifacts) {
      const existingArtifact = await db.prepare(
        `SELECT ${D1_ARTIFACT_COLUMNS} FROM editorial_artifacts
         WHERE artifact_id = ? LIMIT 1`,
      ).bind(artifact.artifact_id).first<D1ArtifactRow>();
      if (existingArtifact) {
        if (!d1IdentityMatchesArtifact(existingArtifact, artifact, run)) {
          throw d1ArtifactConflict();
        }
        continue;
      }
      statements.push(db.prepare(
        `INSERT INTO editorial_artifacts
          (artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
           schema_version, kind, producer_agent_role, producer_agent_version,
           skill_id, skill_version, workflow_version, policy_version,
           input_artifact_ids_json, payload_hash, storage_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        artifact.artifact_id,
        artifact.run_id,
        artifact.user_id,
        artifact.workspace_id,
        artifact.article_id,
        artifact.recording_id,
        EDITORIAL_SCHEMA_VERSION,
        artifact.kind,
        artifact.producer_role,
        artifact.producer_version,
        pins.formattingSkillId,
        pins.formattingSkillVersion,
        EDITORIAL_WORKFLOW_VERSION,
        EDITORIAL_POLICY_VERSION,
        artifact.input_artifact_ids_json,
        artifact.payload_hash,
        artifact.storage_ref,
        artifact.created_at,
      ));
    }
    if (statements.length > 0) await db.batch(statements);
    await assertExactD1Artifacts(db, run, artifacts);
  } catch (error) {
    if (error instanceof EditorialRuntimeError) throw error;
    throw new EditorialRuntimeError("editorial_d1_mirror_unavailable", "D1 artifact mirror is temporarily unavailable", 503);
  }
}

/**
 * Completes the existing D1 run projection only after all outbox artifacts
 * reconcile. A terminal status already present in D1 is treated as a lost DO
 * receipt and is safely replayed; the opposite terminal status is a conflict.
 */
export async function mirrorEditorialTerminalToD1(
  db: D1Database,
  run: RunRow,
  artifacts: readonly OutboxRow[],
  terminalStatus: TerminalStatus,
): Promise<void> {
  await mirrorEditorialOutboxToD1(db, run, artifacts);
  try {
    const existing = await db.prepare(
      `SELECT run_id, user_id, workspace_id, article_id, recording_id, schema_version,
              workflow_version, policy_version, agent_versions_json, skill_pins_json,
              status, payload_hash, idempotency_key, updated_at
       FROM editorial_runs WHERE run_id = ? LIMIT 1`,
    ).bind(run.run_id).first<D1RunRow>();
    if (!existing || !d1IdentityMatchesRun(existing, run)) {
      throw new EditorialRuntimeError("editorial_d1_mirror_conflict", "D1 terminal run identity conflicts", 409);
    }
    if (existing.status === terminalStatus) {
      await assertExactD1Artifacts(db, run, artifacts);
      return;
    }
    if (existing.status !== "planned" && existing.status !== "running") {
      throw new EditorialRuntimeError("editorial_d1_terminal_conflict", "D1 run already has another terminal status", 409);
    }
    const updatedAt = laterTimestamp(existing.updated_at);
    const result = await db.prepare(
      `UPDATE editorial_runs SET status = ?, updated_at = ?
       WHERE run_id = ? AND status IN ('planned', 'running')`,
    ).bind(terminalStatus, updatedAt, run.run_id).run();
    if ((result.meta.changes || 0) === 1) return;
    const raced = await db.prepare(
      "SELECT status FROM editorial_runs WHERE run_id = ? LIMIT 1",
    ).bind(run.run_id).first<{ status: D1RunRow["status"] }>();
    if (raced?.status === terminalStatus) return;
    throw new EditorialRuntimeError("editorial_d1_terminal_conflict", "D1 terminal status CAS failed", 409);
  } catch (error) {
    if (error instanceof EditorialRuntimeError) throw error;
    throw new EditorialRuntimeError("editorial_d1_mirror_unavailable", "D1 terminal mirror is temporarily unavailable", 503);
  }
}

/**
 * The coordinator is named by a hash of all ownership dimensions. No request
 * can select a global singleton or discover another tenant's run by guessing.
 */
export async function coordinatorShardName(
  userId: string,
  workspaceId: string,
  articleId: string,
  runId: string,
): Promise<string> {
  return (await hashText(`${userId}\u0000${workspaceId}\u0000${articleId}\u0000${runId}`)).slice(7);
}

function coordinatorInitialState(): EditorialAgentState {
  return {
    schema_version: EDITORIAL_SCHEMA_VERSION,
    state: "idle",
    state_revision: 0,
    approval_state: "not_required",
    revision_count: 0,
    artifact_count: 0,
  };
}

const PHASE2_TRANSITIONS: Record<string, readonly string[]> = {
  queued: ["draft_generated", "failed"],
  draft_generated: ["review_pending", "reviewed", "revision_pending", "failed"],
  review_pending: ["reviewed", "revision_pending", "failed"],
  revision_pending: ["draft_generated", "failed"],
  reviewed: ["content_frozen", "failed"],
  content_frozen: ["content_frozen", "awaiting_human_confirmation", "failed"],
  awaiting_human_confirmation: ["approved_for_phase3", "failed"],
  approved_for_phase3: [],
  failed: [],
};

function canAdvancePhase2(from: string, to: string): boolean {
  return from === to || PHASE2_TRANSITIONS[from]?.includes(to) === true;
}

abstract class EditorialSpecialistAgent extends Agent<EditorialRuntimeEnv, EditorialAgentState> {
  initialState = coordinatorInitialState();

  async onStart(): Promise<void> {
    this.setState(this.initialState);
  }

  public async runtimeIdentity(): Promise<{ role: string; version: string }> {
    const role = this.constructor.name === "EditorialWritingAgent"
      ? "writing"
      : this.constructor.name === "EditorialReviewAgent"
        ? "editorial_review"
        : this.constructor.name === "EditorialIllustrationAgent"
          ? "illustration"
          : this.constructor.name === "EditorialCoverAgent"
            ? "cover"
            : "editorial_coordinator";
    return { role, version: EDITORIAL_AGENT_VERSIONS[role] };
  }
}

export class EditorialWritingAgent extends EditorialSpecialistAgent {}
export class EditorialReviewAgent extends EditorialSpecialistAgent {}
export class EditorialIllustrationAgent extends EditorialSpecialistAgent {}
export class EditorialCoverAgent extends EditorialSpecialistAgent {}

/** Active Wave 1 visual role. The old classes remain exported solely so old
 * Phase 2 objects and tests can be decoded; they are not bound in wrangler. */
export class EditorialVisualProductionAgent extends EditorialSpecialistAgent {
  public async runtimeIdentity(): Promise<{ role: string; version: string }> {
    return { role: "visual_production", version: PUBLICATION_AGENT_VERSIONS.visual_production };
  }
}

export class EditorialWechatPublishingAgent extends EditorialSpecialistAgent {
  public async runtimeIdentity(): Promise<{ role: string; version: string }> {
    return { role: "wechat_publishing", version: PUBLICATION_AGENT_VERSIONS.wechat_publishing };
  }
}

export class EditorialCoordinatorAgent extends Agent<EditorialRuntimeEnv, EditorialAgentState> {
  initialState = coordinatorInitialState();
  private failAfterTerminalMirrorOnce = false;

  private installWave2bRunUpdateGuards(): void {
    this.sql`DROP TRIGGER IF EXISTS editorial_wave2b_runs_identity_guard`;
    this.sql`CREATE TRIGGER editorial_wave2b_runs_identity_guard
      BEFORE UPDATE ON editorial_wave2b_runs
      WHEN NEW.run_id <> OLD.run_id OR NEW.article_id <> OLD.article_id OR NEW.recording_id <> OLD.recording_id
        OR NEW.user_id <> OLD.user_id OR NEW.workspace_id <> OLD.workspace_id
        OR NEW.payload_hash <> OLD.payload_hash OR NEW.manifest_hash <> OLD.manifest_hash
        OR NEW.manifest_json <> OLD.manifest_json OR NEW.created_at <> OLD.created_at
        OR NEW.state_revision <= OLD.state_revision
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_run_identity_is_immutable'); END`;
    this.sql`DROP TRIGGER IF EXISTS editorial_wave2b_runs_state_guard`;
    this.sql`CREATE TRIGGER editorial_wave2b_runs_state_guard
      BEFORE UPDATE ON editorial_wave2b_runs
      WHEN NEW.state_revision <> OLD.state_revision + 1 OR NEW.revision_count < OLD.revision_count OR
        NEW.progress_percent < OLD.progress_percent OR
        NEW.last_successful_progress_percent < OLD.last_successful_progress_percent OR NOT (
        NEW.state = OLD.state OR
        (OLD.state = 'queued' AND NEW.state IN ('transcribing', 'needs_action', 'failed')) OR
        (OLD.state = 'transcribing' AND NEW.state IN ('transcript_ready', 'failed')) OR
        (OLD.state = 'transcript_ready' AND NEW.state IN ('writing', 'failed')) OR
        (OLD.state = 'writing' AND NEW.state IN ('draft_generated', 'needs_action', 'failed')) OR
        (OLD.state = 'draft_generated' AND NEW.state IN ('reviewing', 'failed')) OR
        (OLD.state = 'reviewing' AND NEW.state IN ('revising', 'reviewed', 'needs_action', 'failed')) OR
        (OLD.state = 'revising' AND NEW.state IN ('writing', 'needs_action', 'failed')) OR
        (OLD.state = 'reviewed' AND NEW.state IN ('content_frozen', 'needs_action')) OR
        (OLD.state = 'content_frozen' AND NEW.state IN ('visual_planning', 'needs_action', 'failed')) OR
        (OLD.state = 'visual_planning' AND NEW.state IN ('visual_generating', 'needs_action', 'failed')) OR
        (OLD.state = 'visual_generating' AND NEW.state IN ('visual_ready', 'needs_action', 'failed')) OR
        (OLD.state = 'visual_ready' AND NEW.state IN ('formatting', 'needs_action', 'failed')) OR
        (OLD.state = 'formatting' AND NEW.state IN ('visual_qa', 'needs_action', 'failed')) OR
        (OLD.state = 'visual_qa' AND NEW.state IN ('draft_syncing', 'needs_action', 'failed')) OR
        (OLD.state = 'draft_syncing' AND NEW.state IN ('draft_verifying', 'needs_action', 'failed')) OR
        (OLD.state = 'draft_verifying' AND NEW.state IN ('draft_ready', 'needs_action', 'failed')) OR
        (OLD.state = 'needs_action' AND NEW.state IN ('writing', 'reviewing', 'visual_planning', 'visual_generating', 'visual_ready', 'formatting', 'visual_qa', 'draft_syncing', 'draft_verifying', 'failed')) OR
        (OLD.state = 'failed' AND NEW.state = 'writing'
          AND OLD.last_successful_state = 'writing'
          AND OLD.error_code = 'writing_adapter_non_retryable'
          AND OLD.next_action = 'retry_after_service_fix'
          AND NEW.retry_count = OLD.retry_count + 1
          AND NEW.error_code IS NULL AND NEW.next_action IS NULL)
      ) OR
        (NEW.state = 'needs_action' AND NEW.run_status <> 'needs_action') OR
        (NEW.state = 'failed' AND NEW.run_status <> 'failed') OR
        (NEW.state NOT IN ('needs_action', 'failed') AND NEW.run_status <> 'active') OR
        (NEW.state = 'needs_action' AND NEW.progress_percent <> NEW.last_successful_progress_percent)
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_state_transition_invalid'); END`;
  }

  async onStart(): Promise<void> {
    this.ensureSchema();
    const row = this.sql<EditorialAgentState>`
      SELECT state, state_revision, approval_state, revision_count,
             (SELECT count(*) FROM editorial_phase2_artifacts) AS artifact_count
      FROM editorial_phase2_runs ORDER BY updated_at DESC LIMIT 1
    `[0];
    if (row) this.setState({ ...row, schema_version: EDITORIAL_SCHEMA_VERSION });
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_runs (
      run_id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      workflow_id TEXT,
      state TEXT NOT NULL,
      state_revision INTEGER NOT NULL DEFAULT 0,
      approval_state TEXT NOT NULL,
      revision_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, workspace_id, article_id, run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      producer_role TEXT NOT NULL,
      producer_version TEXT NOT NULL,
      input_artifact_ids_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, idempotency_key),
      FOREIGN KEY(run_id) REFERENCES editorial_phase2_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_steps (
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      step_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, step_key),
      UNIQUE(run_id, step_name)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, idempotency_key),
      FOREIGN KEY(run_id) REFERENCES editorial_phase2_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_human_actions (
      action_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, idempotency_key),
      FOREIGN KEY(run_id) REFERENCES editorial_phase2_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_outbox (
      outbox_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      producer_role TEXT NOT NULL,
      producer_version TEXT NOT NULL,
      input_artifact_ids_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, artifact_id),
      FOREIGN KEY(run_id) REFERENCES editorial_phase2_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_outbox_receipts (
      outbox_id TEXT PRIMARY KEY,
      d1_payload_hash TEXT NOT NULL,
      mirrored_at TEXT NOT NULL,
      FOREIGN KEY(outbox_id) REFERENCES editorial_phase2_outbox(outbox_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_terminal_intents (
      intent_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      terminal_status TEXT NOT NULL CHECK (terminal_status IN ('completed', 'failed')),
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id),
      UNIQUE(run_id, idempotency_key),
      UNIQUE(run_id, step_key),
      FOREIGN KEY(run_id, step_key) REFERENCES editorial_phase2_steps(run_id, step_key)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_phase2_terminal_receipts (
      intent_id TEXT PRIMARY KEY,
      d1_status TEXT NOT NULL CHECK (d1_status IN ('completed', 'failed')),
      mirrored_at TEXT NOT NULL,
      FOREIGN KEY(intent_id) REFERENCES editorial_phase2_terminal_intents(intent_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_runs (
      run_id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      workflow_id TEXT,
      state TEXT NOT NULL,
      run_status TEXT NOT NULL DEFAULT 'active',
      progress_percent INTEGER NOT NULL DEFAULT 0,
      resume_state TEXT,
      last_successful_state TEXT NOT NULL DEFAULT 'queued',
      last_successful_progress_percent INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      state_revision INTEGER NOT NULL DEFAULT 0,
      revision_count INTEGER NOT NULL DEFAULT 0,
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      next_action TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, workspace_id, article_id, run_id)
    )`;
    // Older V2 DO instances may already have the Wave2B table. Add only the
    // redacted projection columns needed for restart-safe reconciliation.
    try { this.sql`ALTER TABLE editorial_wave2b_runs ADD COLUMN run_status TEXT NOT NULL DEFAULT 'active'`; } catch {}
    try { this.sql`ALTER TABLE editorial_wave2b_runs ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0`; } catch {}
    try { this.sql`ALTER TABLE editorial_wave2b_runs ADD COLUMN resume_state TEXT`; } catch {}
    try { this.sql`ALTER TABLE editorial_wave2b_runs ADD COLUMN last_successful_state TEXT NOT NULL DEFAULT 'queued'`; } catch {}
    try { this.sql`ALTER TABLE editorial_wave2b_runs ADD COLUMN last_successful_progress_percent INTEGER NOT NULL DEFAULT 0`; } catch {}
    try { this.sql`ALTER TABLE editorial_wave2b_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`; } catch {}
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_outbox (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, artifact_id),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_receipts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      mirrored_at TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES editorial_wave2b_outbox(artifact_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_calls (
      call_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      call_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, call_kind, idempotency_key, attempt),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_workflow_starts (
      workflow_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('intent', 'started', 'reconciled', 'unknown')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_start_ledger (
      workflow_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('intent', 'needs_action', 'started', 'reconciled')),
      start_status TEXT CHECK(start_status IN ('brief_storage_unknown', 'workflow_create_unknown') OR start_status IS NULL),
      error_code TEXT,
      next_action TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_start_receipts (
      receipt_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      start_status TEXT NOT NULL CHECK(start_status IN ('brief_storage_unknown', 'workflow_create_unknown')),
      reconciliation_key TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workflow_id, reconciliation_key),
      FOREIGN KEY(workflow_id) REFERENCES editorial_wave2b_start_ledger(workflow_id),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_start_events (
      event_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('start_reconciliation_required', 'start_reconciled', 'workflow_start_confirmed')),
      idempotency_key TEXT NOT NULL UNIQUE,
      evidence_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workflow_id) REFERENCES editorial_wave2b_start_ledger(workflow_id),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_call_results (
      call_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      response_hash TEXT,
      artifact_id TEXT,
      error_code TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(call_id) REFERENCES editorial_wave2b_calls(call_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_writing_restart_attempts (
      attempt_id TEXT PRIMARY KEY,
      restart_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      recovery_workflow_id TEXT NOT NULL,
      retry_event_revision INTEGER NOT NULL,
      retry_count INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      UNIQUE(restart_id, attempt),
      UNIQUE(recovery_workflow_id),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_writing_restart_receipts (
      restart_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      retry_event_revision INTEGER NOT NULL,
      retry_count INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE(run_id, retry_event_revision),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2b_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      state TEXT NOT NULL,
      state_revision INTEGER NOT NULL,
      artifact_id TEXT,
      payload_hash TEXT,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, event_type, state_revision),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2c_visual_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      binary_storage_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, artifact_id),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2c_visual_receipts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      mirrored_at TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES editorial_wave2c_visual_artifacts(artifact_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2c_visual_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('visual_plan_committed', 'visual_asset_committed', 'visual_qa_committed', 'visual_needs_action', 'visual_failed')),
      state TEXT NOT NULL,
      state_revision INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id),
      FOREIGN KEY(artifact_id) REFERENCES editorial_wave2c_visual_artifacts(artifact_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2d_wechat_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, artifact_id),
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2d_wechat_receipts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      mirrored_at TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES editorial_wave2d_wechat_artifacts(artifact_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS editorial_wave2d_wechat_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('wechat_artifact_committed', 'wechat_needs_action', 'wechat_failed')),
      state TEXT NOT NULL,
      state_revision INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES editorial_wave2b_runs(run_id),
      FOREIGN KEY(artifact_id) REFERENCES editorial_wave2d_wechat_artifacts(artifact_id)
    )`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_runs_insert_guard
      BEFORE INSERT ON editorial_wave2b_runs
      WHEN NEW.state <> 'queued' OR NEW.state_revision <> 0 OR NEW.revision_count <> 0
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_run_must_start_queued'); END`;
    // CREATE TABLE IF NOT EXISTS does not retrofit constraints on an older
    // DO instance. The unique index keeps one terminal intent per run across
    // eviction/restart while preserving the append-only table contract.
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS editorial_phase2_terminal_intents_one_per_run
      ON editorial_phase2_terminal_intents(run_id)`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_artifacts_append_only_update
      BEFORE UPDATE ON editorial_phase2_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_phase2_artifacts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_artifacts_append_only_delete
      BEFORE DELETE ON editorial_phase2_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_phase2_artifacts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_events_append_only_update
      BEFORE UPDATE ON editorial_phase2_events BEGIN SELECT RAISE(ABORT, 'editorial_phase2_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_events_append_only_delete
      BEFORE DELETE ON editorial_phase2_events BEGIN SELECT RAISE(ABORT, 'editorial_phase2_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_steps_append_only_update
      BEFORE UPDATE ON editorial_phase2_steps BEGIN SELECT RAISE(ABORT, 'editorial_phase2_steps_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_steps_append_only_delete
      BEFORE DELETE ON editorial_phase2_steps BEGIN SELECT RAISE(ABORT, 'editorial_phase2_steps_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_human_actions_append_only_update
      BEFORE UPDATE ON editorial_phase2_human_actions BEGIN SELECT RAISE(ABORT, 'editorial_phase2_human_actions_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_human_actions_append_only_delete
      BEFORE DELETE ON editorial_phase2_human_actions BEGIN SELECT RAISE(ABORT, 'editorial_phase2_human_actions_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_outbox_append_only_update
      BEFORE UPDATE ON editorial_phase2_outbox BEGIN SELECT RAISE(ABORT, 'editorial_phase2_outbox_is_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_outbox_append_only_delete
      BEFORE DELETE ON editorial_phase2_outbox BEGIN SELECT RAISE(ABORT, 'editorial_phase2_outbox_is_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_outbox_receipts_append_only_update
      BEFORE UPDATE ON editorial_phase2_outbox_receipts BEGIN SELECT RAISE(ABORT, 'editorial_phase2_outbox_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_outbox_receipts_append_only_delete
      BEFORE DELETE ON editorial_phase2_outbox_receipts BEGIN SELECT RAISE(ABORT, 'editorial_phase2_outbox_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_terminal_intents_append_only_update
      BEFORE UPDATE ON editorial_phase2_terminal_intents BEGIN SELECT RAISE(ABORT, 'editorial_phase2_terminal_intents_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_terminal_intents_append_only_delete
      BEFORE DELETE ON editorial_phase2_terminal_intents BEGIN SELECT RAISE(ABORT, 'editorial_phase2_terminal_intents_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_terminal_receipts_append_only_update
      BEFORE UPDATE ON editorial_phase2_terminal_receipts BEGIN SELECT RAISE(ABORT, 'editorial_phase2_terminal_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_phase2_terminal_receipts_append_only_delete
      BEFORE DELETE ON editorial_phase2_terminal_receipts BEGIN SELECT RAISE(ABORT, 'editorial_phase2_terminal_receipts_are_append_only'); END`;
    // Recreate this guard on every DO schema check so evicted instances pick
    // up additive state-machine fixes without changing the table contract.
    this.installWave2bRunUpdateGuards();
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_runs_append_only_delete
      BEFORE DELETE ON editorial_wave2b_runs BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_runs_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_outbox_append_only_update
      BEFORE UPDATE ON editorial_wave2b_outbox BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_outbox_is_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_outbox_append_only_delete
      BEFORE DELETE ON editorial_wave2b_outbox BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_outbox_is_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_receipts_append_only_update
      BEFORE UPDATE ON editorial_wave2b_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_receipts_append_only_delete
      BEFORE DELETE ON editorial_wave2b_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_calls_append_only_update
      BEFORE UPDATE ON editorial_wave2b_calls BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_calls_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_workflow_starts_identity_guard
      BEFORE UPDATE ON editorial_wave2b_workflow_starts
      WHEN NEW.workflow_id <> OLD.workflow_id OR NEW.run_id <> OLD.run_id OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_workflow_start_identity_is_immutable'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_start_ledger_identity_guard
      BEFORE UPDATE ON editorial_wave2b_start_ledger
      WHEN NEW.workflow_id <> OLD.workflow_id OR NEW.run_id <> OLD.run_id OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_start_ledger_identity_is_immutable'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_start_receipts_append_only_update
      BEFORE UPDATE ON editorial_wave2b_start_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_start_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_start_receipts_append_only_delete
      BEFORE DELETE ON editorial_wave2b_start_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_start_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_start_events_append_only_update
      BEFORE UPDATE ON editorial_wave2b_start_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_start_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_start_events_append_only_delete
      BEFORE DELETE ON editorial_wave2b_start_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_start_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_call_results_append_only_update
      BEFORE UPDATE ON editorial_wave2b_call_results BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_call_results_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_call_results_append_only_delete
      BEFORE DELETE ON editorial_wave2b_call_results BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_call_results_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_writing_restart_attempts_append_only_update
      BEFORE UPDATE ON editorial_wave2b_writing_restart_attempts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_writing_restart_attempts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_writing_restart_attempts_append_only_delete
      BEFORE DELETE ON editorial_wave2b_writing_restart_attempts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_writing_restart_attempts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_writing_restart_receipts_append_only_update
      BEFORE UPDATE ON editorial_wave2b_writing_restart_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_writing_restart_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_writing_restart_receipts_append_only_delete
      BEFORE DELETE ON editorial_wave2b_writing_restart_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_writing_restart_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_events_append_only_update
      BEFORE UPDATE ON editorial_wave2b_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_events_append_only_delete
      BEFORE DELETE ON editorial_wave2b_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2c_visual_artifacts_append_only_update
      BEFORE UPDATE ON editorial_wave2c_visual_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_wave2c_visual_artifacts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2c_visual_artifacts_append_only_delete
      BEFORE DELETE ON editorial_wave2c_visual_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_wave2c_visual_artifacts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2c_visual_receipts_append_only_update
      BEFORE UPDATE ON editorial_wave2c_visual_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2c_visual_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2c_visual_receipts_append_only_delete
      BEFORE DELETE ON editorial_wave2c_visual_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2c_visual_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2c_visual_events_append_only_update
      BEFORE UPDATE ON editorial_wave2c_visual_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2c_visual_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2c_visual_events_append_only_delete
      BEFORE DELETE ON editorial_wave2c_visual_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2c_visual_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2d_wechat_artifacts_append_only_update
      BEFORE UPDATE ON editorial_wave2d_wechat_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_wave2d_wechat_artifacts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2d_wechat_artifacts_append_only_delete
      BEFORE DELETE ON editorial_wave2d_wechat_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_wave2d_wechat_artifacts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2d_wechat_receipts_append_only_update
      BEFORE UPDATE ON editorial_wave2d_wechat_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2d_wechat_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2d_wechat_receipts_append_only_delete
      BEFORE DELETE ON editorial_wave2d_wechat_receipts BEGIN SELECT RAISE(ABORT, 'editorial_wave2d_wechat_receipts_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2d_wechat_events_append_only_update
      BEFORE UPDATE ON editorial_wave2d_wechat_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2d_wechat_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2d_wechat_events_append_only_delete
      BEFORE DELETE ON editorial_wave2d_wechat_events BEGIN SELECT RAISE(ABORT, 'editorial_wave2d_wechat_events_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_calls_append_only_delete
      BEFORE DELETE ON editorial_wave2b_calls BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_calls_are_append_only'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_call_results_run_guard
      BEFORE INSERT ON editorial_wave2b_call_results
      WHEN NEW.run_id <> (SELECT run_id FROM editorial_wave2b_calls WHERE call_id = NEW.call_id)
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_call_result_run_mismatch'); END`;
    this.sql`CREATE TRIGGER IF NOT EXISTS editorial_wave2b_events_contract_guard
      BEFORE INSERT ON editorial_wave2b_events
      WHEN NOT (
        NEW.event_type IN ('run_queued', 'transcription_started', 'transcript_ready', 'writing_started', 'draft_generated',
          'review_started', 'reviewed', 'revision_requested', 'content_frozen', 'visual_planning', 'visual_generating',
          'visual_ready', 'formatting', 'visual_qa', 'draft_syncing', 'draft_verifying', 'draft_ready',
          'visual_plan_committed', 'visual_asset_committed', 'visual_qa_committed', 'wechat_artifact_committed', 'needs_action', 'failed', 'artifact_committed', 'action_retry')
        AND (NEW.state_revision = 0 OR NEW.state_revision = (
          SELECT state_revision FROM editorial_wave2b_runs WHERE run_id = NEW.run_id
        ))
        AND NEW.state = (SELECT state FROM editorial_wave2b_runs WHERE run_id = NEW.run_id)
      )
      BEGIN SELECT RAISE(ABORT, 'editorial_wave2b_event_contract_invalid'); END`;
  }

  private transactionSync<T>(callback: () => T): T {
    return (this as any).ctx.storage.transactionSync(callback);
  }

  private async flushOutbox(runId: string): Promise<void> {
    const rows = this.sql<OutboxRow>`
      SELECT o.outbox_id, o.run_id, o.artifact_id, o.user_id, o.workspace_id, o.article_id,
             o.recording_id, o.kind, o.payload_hash, o.producer_role, o.producer_version,
             o.input_artifact_ids_json, o.summary_json, o.storage_ref, o.created_at
      FROM editorial_phase2_outbox o
      WHERE o.run_id = ${runId}
      ORDER BY o.created_at, o.outbox_id
    `;
    if (rows.length === 0) return;
    const run = this.runRow(runId);
    if (!run) throw new EditorialRuntimeError("run_not_found", "editorial run not found", 404);
    const db = (this.env as EditorialRuntimeEnv & { DB?: D1Database }).DB;
    if (!db) throw new EditorialRuntimeError("editorial_d1_mirror_unavailable", "D1 artifact mirror is not configured", 503);
    await mirrorEditorialOutboxToD1(db, run, rows);
    this.transactionSync(() => {
      for (const row of rows) {
        this.sql`INSERT OR IGNORE INTO editorial_phase2_outbox_receipts
          (outbox_id, d1_payload_hash, mirrored_at)
          VALUES (${row.outbox_id}, ${row.payload_hash}, ${now()})`;
      }
    });
  }

  private async flushTerminalIntent(runId: string): Promise<void> {
    const intent = this.sql<TerminalIntentRow>`
      SELECT i.intent_id, i.run_id, i.step_key, i.terminal_status,
             i.idempotency_key, i.payload_hash, i.created_at
      FROM editorial_phase2_terminal_intents i
      LEFT JOIN editorial_phase2_terminal_receipts r ON r.intent_id = i.intent_id
      WHERE i.run_id = ${runId} AND r.intent_id IS NULL
      ORDER BY i.created_at, i.intent_id LIMIT 1
    `[0];
    if (!intent) return;
    const run = this.runRow(runId);
    if (!run) throw new EditorialRuntimeError("run_not_found", "editorial run not found", 404);
    const db = (this.env as EditorialRuntimeEnv & { DB?: D1Database }).DB;
    if (!db) throw new EditorialRuntimeError("editorial_d1_mirror_unavailable", "D1 artifact mirror is not configured", 503);
    const artifacts = this.sql<OutboxRow>`
      SELECT outbox_id, run_id, artifact_id, user_id, workspace_id, article_id,
             recording_id, kind, payload_hash, producer_role, producer_version,
             input_artifact_ids_json, summary_json, storage_ref, created_at
      FROM editorial_phase2_outbox WHERE run_id = ${runId} ORDER BY created_at, outbox_id
    `;
    await mirrorEditorialTerminalToD1(db, run, artifacts, intent.terminal_status);
    if (this.failAfterTerminalMirrorOnce) {
      this.failAfterTerminalMirrorOnce = false;
      throw new EditorialRuntimeError("editorial_terminal_receipt_unavailable", "terminal receipt persistence was interrupted", 503);
    }
    this.transactionSync(() => {
      this.sql`INSERT OR IGNORE INTO editorial_phase2_terminal_receipts
        (intent_id, d1_status, mirrored_at)
        VALUES (${intent.intent_id}, ${intent.terminal_status}, ${now()})`;
    });
  }

  private async d1MirroredArtifactCount(runId: string): Promise<number> {
    const db = (this.env as EditorialRuntimeEnv & { DB?: D1Database }).DB;
    if (!db) return 0;
    const row = await db.prepare(
      "SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ?",
    ).bind(runId).first<{ count: number }>();
    return Number(row?.count || 0);
  }

  private doReceiptCount(runId: string): number {
    return Number(this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_phase2_outbox_receipts r
      JOIN editorial_phase2_outbox o ON o.outbox_id = r.outbox_id WHERE o.run_id = ${runId}`[0]?.count || 0);
  }

  private outboxPendingCount(runId: string): number {
    return Number(this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_phase2_outbox o
      LEFT JOIN editorial_phase2_outbox_receipts r ON r.outbox_id = o.outbox_id
      WHERE o.run_id = ${runId} AND r.outbox_id IS NULL`[0]?.count || 0);
  }

  private wave2bRun(runId: string, userId?: string, workspaceId?: string): Record<string, unknown> | null {
    const row = userId === undefined || workspaceId === undefined
      ? this.sql<Record<string, unknown>>`
          SELECT run_id, article_id, recording_id, user_id, workspace_id, payload_hash, manifest_hash,
                 manifest_json, workflow_id, state, run_status, progress_percent, resume_state,
                 last_successful_state, last_successful_progress_percent, retry_count,
                 state_revision, revision_count, approval_state, next_action, error_code, created_at, updated_at
          FROM editorial_wave2b_runs WHERE run_id = ${runId} LIMIT 1`[0]
      : this.sql<Record<string, unknown>>`
          SELECT run_id, article_id, recording_id, user_id, workspace_id, payload_hash, manifest_hash,
                 manifest_json, workflow_id, state, run_status, progress_percent, resume_state,
                 last_successful_state, last_successful_progress_percent, retry_count,
                 state_revision, revision_count, approval_state, next_action, error_code, created_at, updated_at
          FROM editorial_wave2b_runs
          WHERE run_id = ${runId} AND user_id = ${userId} AND workspace_id = ${workspaceId}
          LIMIT 1`[0];
    return row || null;
  }

  private wave2bStartLedger(workflowId: string, runId?: string): FiveAgentStartLedgerRow | null {
    const row = runId === undefined
      ? this.sql<FiveAgentStartLedgerRow>`
          SELECT workflow_id, run_id, status, start_status, error_code, next_action, created_at, updated_at
          FROM editorial_wave2b_start_ledger WHERE workflow_id = ${workflowId} LIMIT 1`[0]
      : this.sql<FiveAgentStartLedgerRow>`
          SELECT workflow_id, run_id, status, start_status, error_code, next_action, created_at, updated_at
          FROM editorial_wave2b_start_ledger
          WHERE workflow_id = ${workflowId} AND run_id = ${runId} LIMIT 1`[0];
    return row || null;
  }

  private ensureFiveAgentStartLedger(input: FiveAgentRunInput): void {
    this.sql`INSERT OR IGNORE INTO editorial_wave2b_start_ledger
      (workflow_id, run_id, status, start_status, error_code, next_action, created_at, updated_at)
      VALUES (${input.workflow_id}, ${input.run_id}, 'intent', NULL, NULL, NULL, ${input.created_at}, ${input.created_at})`;
  }

  private appendFiveAgentStartEvent(input: {
    workflow_id: string; run_id: string;
    event_type: "start_reconciliation_required" | "start_reconciled" | "workflow_start_confirmed";
    idempotency_key: string; evidence_hash: string; created_at: string;
  }): void {
    const existing = this.sql<{ event_id: string; evidence_hash: string }>`
      SELECT event_id, evidence_hash FROM editorial_wave2b_start_events
      WHERE idempotency_key = ${input.idempotency_key} LIMIT 1`[0];
    if (existing) {
      if (existing.evidence_hash !== input.evidence_hash) throw new EditorialRuntimeError("idempotency_conflict", "Wave2B start event conflicts", 409);
      return;
    }
    this.sql`INSERT INTO editorial_wave2b_start_events
      (event_id, workflow_id, run_id, event_type, idempotency_key, evidence_hash, created_at)
      VALUES (${`${input.workflow_id}:start-event:${input.idempotency_key}`}, ${input.workflow_id}, ${input.run_id},
        ${input.event_type}, ${input.idempotency_key}, ${input.evidence_hash}, ${input.created_at})`;
  }

  public async startFiveAgentRun(input: FiveAgentRunInput, startWorkflow = true): Promise<Record<string, unknown>> {
    this.ensureSchema();
    await validateFiveAgentManifest(input);
    const existing = this.wave2bRun(input.run_id, input.user_id, input.workspace_id);
    if (existing) {
      if (existing.manifest_hash !== input.manifest_hash || existing.payload_hash !== input.payload_hash ||
          existing.workflow_id !== input.workflow_id || existing.manifest_json !== input.manifest_json) {
        throw new EditorialRuntimeError("idempotency_conflict", "Wave2B run identity conflicts", 409);
      }
      this.ensureFiveAgentStartLedger(input);
      if (!startWorkflow) return { run: existing, replayed: true };
      return await this.startFiveAgentWorkflowInternal(input, true);
    }
    this.transactionSync(() => {
      this.sql`INSERT INTO editorial_wave2b_runs
        (run_id, article_id, recording_id, user_id, workspace_id, payload_hash,
         manifest_hash, manifest_json, workflow_id, state, run_status, progress_percent,
         resume_state, last_successful_state, last_successful_progress_percent, retry_count, state_revision,
         revision_count, approval_state, next_action, error_code, created_at, updated_at)
        VALUES (${input.run_id}, ${input.article_id}, ${input.recording_id}, ${input.user_id},
          ${input.workspace_id}, ${input.payload_hash}, ${input.manifest_hash}, ${input.manifest_json},
          ${input.workflow_id}, 'queued', 'active', 0, NULL, 'queued', 0, 0, 0,
          0, 'not_required', NULL, NULL,
          ${input.created_at}, ${input.created_at})`;
      this.sql`INSERT INTO editorial_wave2b_workflow_starts
        (workflow_id, run_id, status, created_at, updated_at)
        VALUES (${input.workflow_id}, ${input.run_id}, 'intent', ${input.created_at}, ${input.created_at})`;
      this.sql`INSERT INTO editorial_wave2b_start_ledger
        (workflow_id, run_id, status, start_status, error_code, next_action, created_at, updated_at)
        VALUES (${input.workflow_id}, ${input.run_id}, 'intent', NULL, NULL, NULL, ${input.created_at}, ${input.created_at})`;
      this.sql`INSERT INTO editorial_wave2b_events
        (run_id, event_type, state, state_revision, artifact_id, payload_hash, summary_json, created_at)
        VALUES (${input.run_id}, 'run_queued', 'queued', 0, NULL, ${input.payload_hash},
          ${safeJson({ workflow_version: "editorial-workflow.v3" })}, ${input.created_at})`;
    });
    if (!startWorkflow) return { run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id), replayed: false };
    return await this.startFiveAgentWorkflowInternal(input, false);
  }

  public async upgradeLegacyFiveAgentRunManifest(input: FiveAgentRunInput & {
    legacy_manifest_hash: string;
    legacy_manifest_json: string;
  }): Promise<{ replayed: boolean; manifest_hash: string }> {
    this.ensureSchema();
    const manifest = await validateFiveAgentManifest(input);
    let legacyManifest: Record<string, unknown>;
    try { legacyManifest = JSON.parse(input.legacy_manifest_json) as Record<string, unknown>; } catch {
      throw new EditorialRuntimeError("legacy_manifest_invalid", "Wave2B legacy manifest is invalid", 409);
    }
    const expectedLegacyManifest = { ...manifest };
    delete expectedLegacyManifest.payload_hash;
    if (safeJson(legacyManifest) !== input.legacy_manifest_json ||
        await hashText(input.legacy_manifest_json) !== input.legacy_manifest_hash ||
        safeJson(expectedLegacyManifest) !== input.legacy_manifest_json) {
      throw new EditorialRuntimeError("legacy_manifest_invalid", "Wave2B legacy manifest does not match the canonical identity", 409);
    }

    const current = this.wave2bRun(input.run_id, input.user_id, input.workspace_id);
    if (!current || current.article_id !== input.article_id || Number(current.recording_id) !== input.recording_id ||
        current.workflow_id !== input.workflow_id || current.payload_hash !== input.payload_hash ||
        current.created_at !== input.created_at) {
      throw new EditorialRuntimeError("legacy_manifest_upgrade_not_safe", "Wave2B legacy manifest run identity is not exact", 409);
    }
    if (current.manifest_hash === input.manifest_hash && current.manifest_json === input.manifest_json) {
      return { replayed: true, manifest_hash: input.manifest_hash };
    }
    // Historical repair is limited to a confirmed pre-start hold: one Brief
    // may exist, but no model, visual, Workflow, or WeChat side effect may exist.
    const workflowStatus = await this.reconcileFiveAgentWorkflow(input.workflow_id);
    if (workflowStatus.state !== "not_found") {
      throw new EditorialRuntimeError("legacy_manifest_upgrade_not_safe", "Wave2B workflow absence is not confirmed", 409);
    }
    if (current.manifest_hash !== input.legacy_manifest_hash || current.manifest_json !== input.legacy_manifest_json ||
        current.state !== "queued" || current.run_status !== "active" || Number(current.progress_percent) !== 0 ||
        current.resume_state !== null || current.last_successful_state !== "queued" ||
        Number(current.last_successful_progress_percent) !== 0 || Number(current.retry_count) !== 0 ||
        Number(current.state_revision) !== 0 || Number(current.revision_count) !== 0 ||
        current.approval_state !== "not_required" || current.next_action !== null || current.error_code !== null) {
      throw new EditorialRuntimeError("legacy_manifest_upgrade_not_safe", "Wave2B legacy manifest run has already advanced", 409);
    }

    const start = this.wave2bStartLedger(input.workflow_id, input.run_id);
    const workflowStart = this.sql<{ status: string }>`SELECT status FROM editorial_wave2b_workflow_starts
      WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id} LIMIT 1`[0];
    const startEvents = this.sql<{ event_type: string; idempotency_key: string; evidence_hash: string }>`
      SELECT event_type, idempotency_key, evidence_hash FROM editorial_wave2b_start_events
      WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id} ORDER BY created_at, event_id`;
    const startReceiptCount = Number(this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_wave2b_start_receipts
      WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id}`[0]?.count || 0);
    const runEvents = this.sql<{ event_type: string; state: string; state_revision: number; artifact_id: string | null; payload_hash: string | null; summary_json: string }>`
      SELECT event_type, state, state_revision, artifact_id, payload_hash, summary_json FROM editorial_wave2b_events
      WHERE run_id = ${input.run_id} ORDER BY seq`;
    const artifacts = this.sql<{ envelope_json: string }>`SELECT envelope_json FROM editorial_wave2b_outbox
      WHERE run_id = ${input.run_id} ORDER BY created_at, artifact_id`;
    const callCount = Number(this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_wave2b_calls
      WHERE run_id = ${input.run_id}`[0]?.count || 0);
    const callResultCount = Number(this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_wave2b_call_results
      WHERE run_id = ${input.run_id}`[0]?.count || 0);
    const visualCount = Number(this.sql<{ count: number }>`SELECT
      (SELECT count(*) FROM editorial_wave2c_visual_artifacts WHERE run_id = ${input.run_id}) +
      (SELECT count(*) FROM editorial_wave2c_visual_receipts WHERE run_id = ${input.run_id}) +
      (SELECT count(*) FROM editorial_wave2c_visual_events WHERE run_id = ${input.run_id}) AS count`[0]?.count || 0);
    const wechatCount = Number(this.sql<{ count: number }>`SELECT
      (SELECT count(*) FROM editorial_wave2d_wechat_artifacts WHERE run_id = ${input.run_id}) +
      (SELECT count(*) FROM editorial_wave2d_wechat_receipts WHERE run_id = ${input.run_id}) +
      (SELECT count(*) FROM editorial_wave2d_wechat_events WHERE run_id = ${input.run_id}) AS count`[0]?.count || 0);
    const expectedStartEvidenceHash = await hashJson({
      workflow_id: input.workflow_id, run_id: input.run_id,
      event_type: "start_reconciliation_required", start_status: "workflow_create_unknown",
      error_code: "external_side_effect_unknown", next_action: "reconcile_external_side_effect",
    });
    let briefEnvelope: Record<string, unknown> | null = null;
    try { briefEnvelope = artifacts.length === 1 ? JSON.parse(artifacts[0].envelope_json) as Record<string, unknown> : null; } catch {}
    if (!start || start.status !== "needs_action" || start.start_status !== "workflow_create_unknown" ||
        start.error_code !== "external_side_effect_unknown" || start.next_action !== "reconcile_external_side_effect" ||
        workflowStart?.status !== "unknown" || startReceiptCount !== 0 || startEvents.length !== 1 ||
        startEvents[0].event_type !== "start_reconciliation_required" ||
        startEvents[0].idempotency_key !== `start-required:${input.workflow_id}:workflow_create_unknown` ||
        startEvents[0].evidence_hash !== expectedStartEvidenceHash || runEvents.length !== 1 ||
        runEvents[0].event_type !== "run_queued" || runEvents[0].state !== "queued" ||
        Number(runEvents[0].state_revision) !== 0 || runEvents[0].artifact_id !== null ||
        runEvents[0].payload_hash !== input.payload_hash ||
        runEvents[0].summary_json !== safeJson({ workflow_version: "editorial-workflow.v3" }) ||
        !briefEnvelope || briefEnvelope.kind !== "article_brief" || briefEnvelope.run_id !== input.run_id ||
        briefEnvelope.article_id !== input.article_id || Number(briefEnvelope.recording_id) !== input.recording_id ||
        briefEnvelope.user_id !== input.user_id || briefEnvelope.workspace_id !== input.workspace_id ||
        callCount !== 0 || callResultCount !== 0 || visualCount !== 0 || wechatCount !== 0) {
      throw new EditorialRuntimeError("legacy_manifest_upgrade_not_safe", "Wave2B legacy manifest has side effects or non-canonical start evidence", 409);
    }

    this.transactionSync(() => {
      const locked = this.wave2bRun(input.run_id, input.user_id, input.workspace_id);
      if (!locked || locked.manifest_hash !== input.legacy_manifest_hash ||
          locked.manifest_json !== input.legacy_manifest_json || locked.payload_hash !== input.payload_hash ||
          locked.workflow_id !== input.workflow_id || locked.state !== "queued" || Number(locked.state_revision) !== 0) {
        throw new EditorialRuntimeError("legacy_manifest_upgrade_not_safe", "Wave2B legacy manifest changed during reconciliation", 409);
      }
      // The normal guards intentionally make manifest identity immutable. This
      // is the sole migration path: all old/new evidence is checked twice, then
      // both guards are removed and restored within one synchronous transaction.
      this.sql`DROP TRIGGER editorial_wave2b_runs_identity_guard`;
      this.sql`DROP TRIGGER editorial_wave2b_runs_state_guard`;
      try {
        this.sql`UPDATE editorial_wave2b_runs SET manifest_hash = ${input.manifest_hash}, manifest_json = ${input.manifest_json}
          WHERE run_id = ${input.run_id} AND user_id = ${input.user_id} AND workspace_id = ${input.workspace_id}
            AND manifest_hash = ${input.legacy_manifest_hash} AND manifest_json = ${input.legacy_manifest_json}`;
        const upgraded = this.wave2bRun(input.run_id, input.user_id, input.workspace_id);
        if (!upgraded || upgraded.manifest_hash !== input.manifest_hash || upgraded.manifest_json !== input.manifest_json) {
          throw new EditorialRuntimeError("legacy_manifest_upgrade_not_safe", "Wave2B legacy manifest upgrade did not commit exactly", 409);
        }
      } finally {
        this.installWave2bRunUpdateGuards();
      }
    });
    return { replayed: false, manifest_hash: input.manifest_hash };
  }

  public async startFiveAgentWorkflow(input: FiveAgentRunInput & {
    transcript_ref: string; transcript_hash: string; source_hash: string;
    brief_artifact_id: string; brief_artifact_key: string; brief_payload_hash: string;
  }): Promise<FiveAgentWorkflowStartResult> {
    return await this.startFiveAgentWorkflowInternal(input, false);
  }

  private async startFiveAgentWorkflowInternal(input: FiveAgentRunInput & Partial<{
    transcript_ref: string; transcript_hash: string; source_hash: string;
    brief_artifact_id: string; brief_artifact_key: string; brief_payload_hash: string;
  }>, replayed: boolean): Promise<FiveAgentWorkflowStartResult> {
    if (!input.transcript_ref || !input.transcript_hash || !input.source_hash ||
        !input.brief_artifact_id || !input.brief_artifact_key || !input.brief_payload_hash) {
      throw new EditorialRuntimeError("workflow_input_incomplete", "V3 workflow requires redacted artifact references", 409);
    }
    const start = this.wave2bStartLedger(input.workflow_id, input.run_id);
    const known = await this.reconcileFiveAgentWorkflow(input.workflow_id);
    if (known.state === "exists") {
      await this.markFiveAgentWorkflowStarted(input.workflow_id, input.run_id, input.created_at);
      return { run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id), replayed: true, workflow_status: known.status };
    }
    if (known.state === "unknown") {
      await this.recordFiveAgentStartHold({
        run_id: input.run_id, workflow_id: input.workflow_id,
        start_status: "workflow_create_unknown", created_at: input.created_at,
      });
      return {
        run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id),
        replayed: true,
        workflow_status: "unknown",
        start_hold: { code: "workflow_create_unknown", status: 503, start_status: "workflow_create_unknown" },
      };
    }
    if (known.state === "not_found" && start?.status !== "intent" && start?.status !== "reconciled" && start?.start_status !== "workflow_create_unknown") {
      return {
        run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id),
        replayed: true,
        workflow_status: "unknown",
        start_hold: { code: "five_agent_workflow_reconciliation_required", status: 503, start_status: "workflow_create_unknown" },
      };
    }
    try {
      await this.runWorkflow("FIVE_AGENT_PUBLISHING_WORKFLOW", input as FiveAgentRunInput & {
        transcript_ref: string; transcript_hash: string; source_hash: string;
        brief_artifact_id: string; brief_artifact_key: string; brief_payload_hash: string;
      }, {
        id: input.workflow_id,
        agentBinding: "EDITORIAL_COORDINATOR",
        metadata: {
          run_id: input.run_id,
          article_id: input.article_id,
          recording_id: input.recording_id,
          user_id: input.user_id,
          workspace_id: input.workspace_id,
          manifest_hash: input.manifest_hash,
          },
        });
    } catch (error) {
      const afterCreate = await this.reconcileFiveAgentWorkflow(input.workflow_id);
      if (afterCreate.state === "exists") {
        await this.markFiveAgentWorkflowStarted(input.workflow_id, input.run_id, input.created_at);
        return { run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id), replayed: true, workflow_status: afterCreate.status };
      }
      if (afterCreate.state === "not_found") throw error;
      this.markFiveAgentWorkflowUnknown(input.workflow_id, input.created_at);
      return {
        run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id),
        replayed: true,
        workflow_status: "unknown",
        start_hold: { code: "workflow_create_unknown", status: 503, start_status: "workflow_create_unknown" },
      };
    }
    await this.markFiveAgentWorkflowStarted(input.workflow_id, input.run_id, input.created_at);
    return { run: this.wave2bRun(input.run_id, input.user_id, input.workspace_id), replayed, workflow_status: "queued" };
  }

  private async reconcileFiveAgentWorkflow(workflowId: string): Promise<
    { state: "exists"; status: string } | { state: "not_found" } | { state: "unknown" }
  > {
    const binding = this.env.FIVE_AGENT_PUBLISHING_WORKFLOW;
    if (!binding) return { state: "unknown" };
    try {
      const response = await (await binding.get(workflowId)).status() as { status?: unknown };
      if (response?.status === "unknown" || typeof response?.status !== "string") {
        console.warn("five_agent_workflow_lookup_unknown", JSON.stringify({ phase: "status", response_status: response?.status ?? null }));
        return { state: "unknown" };
      }
      return { state: "exists", status: response.status };
    } catch (error) {
      if (isStructuredWorkflowNotFound(error)) return { state: "not_found" };
      console.warn("five_agent_workflow_lookup_unknown", JSON.stringify({ phase: "exception", ...workflowLookupDiagnostic(error) }));
      return { state: "unknown" };
    }
  }

  public async getFiveAgentWorkflowStatus(runId: string, workflowId: string): Promise<"exists" | "not_found" | "unknown"> {
    this.ensureSchema();
    const run = this.wave2bStartLedger(workflowId, runId);
    if (!run) throw new EditorialRuntimeError("workflow_start_not_found", "Wave2B start intent not found", 404);
    const result = await this.reconcileFiveAgentWorkflow(workflowId);
    return result.state;
  }

  private async markFiveAgentWorkflowStarted(workflowId: string, runId: string, updatedAt: string): Promise<void> {
    const run = this.wave2bRun(runId);
    if (!run || run.workflow_id !== workflowId) {
      throw new EditorialRuntimeError("workflow_start_identity_conflict", "Wave2B workflow start identity is invalid", 409);
    }
    const evidenceHash = await hashJson({
      workflow_id: workflowId,
      run_id: runId,
      article_id: run.article_id,
      recording_id: run.recording_id,
      user_id: run.user_id,
      workspace_id: run.workspace_id,
      payload_hash: run.payload_hash,
      manifest_hash: run.manifest_hash,
      event_type: "workflow_start_confirmed",
    });
    const currentLedger = this.wave2bStartLedger(workflowId, runId);
    const existingEvent = this.sql<{ event_id: string; evidence_hash: string; created_at: string }>`
      SELECT event_id, evidence_hash, created_at FROM editorial_wave2b_start_events
      WHERE workflow_id = ${workflowId} AND run_id = ${runId} AND event_type = 'workflow_start_confirmed'
      LIMIT 1`[0];
    if (existingEvent && existingEvent.evidence_hash !== evidenceHash) {
      throw new EditorialRuntimeError("idempotency_conflict", "Wave2B workflow confirmation conflicts", 409);
    }
    if (existingEvent && currentLedger?.status === "started") return;
    const eventCreatedAt = existingEvent?.created_at ||
      (currentLedger ? timestampAtOrAfter(currentLedger.updated_at, updatedAt) : updatedAt);
    this.transactionSync(() => {
      this.appendFiveAgentStartEvent({
        workflow_id: workflowId, run_id: runId, event_type: "workflow_start_confirmed",
        idempotency_key: `workflow-start-confirmed:${workflowId}`, evidence_hash: evidenceHash, created_at: eventCreatedAt,
      });
      this.sql`UPDATE editorial_wave2b_workflow_starts SET status = 'started', updated_at = ${eventCreatedAt} WHERE workflow_id = ${workflowId}`;
      this.sql`UPDATE editorial_wave2b_start_ledger SET status = 'started', start_status = NULL, error_code = NULL, next_action = NULL, updated_at = ${eventCreatedAt} WHERE workflow_id = ${workflowId}`;
    });
  }

  private markFiveAgentWorkflowUnknown(workflowId: string, updatedAt: string): void {
    this.sql`UPDATE editorial_wave2b_workflow_starts SET status = 'unknown', updated_at = ${updatedAt} WHERE workflow_id = ${workflowId}`;
  }

  public async recordFiveAgentStartHold(input: {
    run_id: string; workflow_id: string; start_status: FiveAgentStartStatus; created_at: string;
  }): Promise<{ replayed: boolean }> {
    this.ensureSchema();
    const current = this.wave2bStartLedger(input.workflow_id, input.run_id);
    if (!current) throw new EditorialRuntimeError("workflow_start_not_found", "Wave2B start intent not found", 404);
    if (current.status === "needs_action") {
      if (current.start_status === input.start_status) return { replayed: true };
      throw new EditorialRuntimeError("workflow_start_conflict", "Wave2B start hold conflicts", 409);
    }
    if (current.status !== "intent" && current.status !== "reconciled") {
      throw new EditorialRuntimeError("workflow_start_conflict", "Wave2B start is no longer holdable", 409);
    }
    const evidenceHash = await hashJson({
      workflow_id: input.workflow_id, run_id: input.run_id,
      event_type: "start_reconciliation_required", start_status: input.start_status,
      error_code: "external_side_effect_unknown", next_action: "reconcile_external_side_effect",
    });
    this.transactionSync(() => {
      this.appendFiveAgentStartEvent({
        workflow_id: input.workflow_id, run_id: input.run_id,
        event_type: "start_reconciliation_required",
        idempotency_key: `start-required:${input.workflow_id}:${input.start_status}`,
        evidence_hash: evidenceHash, created_at: input.created_at,
      });
      this.sql`UPDATE editorial_wave2b_start_ledger
        SET status = 'needs_action', start_status = ${input.start_status},
            error_code = 'external_side_effect_unknown', next_action = 'reconcile_external_side_effect', updated_at = ${input.created_at}
        WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id}
          AND status IN ('intent', 'reconciled')`;
      this.sql`UPDATE editorial_wave2b_workflow_starts
        SET status = 'unknown', updated_at = ${input.created_at}
        WHERE workflow_id = ${input.workflow_id}`;
    });
    return { replayed: false };
  }

  public async getFiveAgentStartLedger(runId: string, workflowId: string): Promise<Record<string, unknown> | null> {
    this.ensureSchema();
    const row = this.wave2bStartLedger(workflowId, runId);
    return row ? { ...row } : null;
  }

  public async getFiveAgentStartEvidence(runId: string, workflowId: string): Promise<{
    workflow_start_status: string | null;
    events: Array<{ event_type: string; idempotency_key: string; evidence_hash: string; created_at: string }>;
    receipts: Array<{ receipt_id: string; reconciliation_key: string; evidence_hash: string }>;
  }> {
    this.ensureSchema();
    const current = this.wave2bStartLedger(workflowId, runId);
    if (!current) throw new EditorialRuntimeError("workflow_start_not_found", "Wave2B start intent not found", 404);
    const workflow = this.sql<{ status: string }>`
      SELECT status FROM editorial_wave2b_workflow_starts
      WHERE run_id = ${runId} AND workflow_id = ${workflowId} LIMIT 1`[0];
    return {
      workflow_start_status: workflow?.status || null,
      events: this.sql<{ event_type: string; idempotency_key: string; evidence_hash: string; created_at: string }>`
        SELECT event_type, idempotency_key, evidence_hash, created_at FROM editorial_wave2b_start_events
        WHERE run_id = ${runId} AND workflow_id = ${workflowId} ORDER BY created_at, event_id`,
      receipts: this.sql<{ receipt_id: string; reconciliation_key: string; evidence_hash: string }>`
        SELECT receipt_id, reconciliation_key, evidence_hash FROM editorial_wave2b_start_receipts
        WHERE run_id = ${runId} AND workflow_id = ${workflowId} ORDER BY created_at, receipt_id`,
    };
  }

  public async getFiveAgentWorkflowStartConfirmation(input: {
    run_id: string;
    workflow_id: string;
    article_id: string;
    recording_id: number;
    user_id: string;
    workspace_id: string;
    payload_hash: string;
    manifest_hash: string;
  }): Promise<{ confirmed: boolean; event_id: string | null }> {
    this.ensureSchema();
    const run = this.wave2bRun(input.run_id);
    if (!run || run.workflow_id !== input.workflow_id ||
        run.article_id !== input.article_id || Number(run.recording_id) !== input.recording_id ||
        run.user_id !== input.user_id || run.workspace_id !== input.workspace_id ||
        run.payload_hash !== input.payload_hash || run.manifest_hash !== input.manifest_hash) {
      throw new EditorialRuntimeError("workflow_start_identity_conflict", "Wave2B workflow start identity is invalid", 409);
    }
    const ledger = this.wave2bStartLedger(input.workflow_id, input.run_id);
    const workflow = this.sql<{ status: string }>`
      SELECT status FROM editorial_wave2b_workflow_starts
      WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id} LIMIT 1`[0];
    const events = this.sql<{ event_id: string; evidence_hash: string }>`
      SELECT event_id, evidence_hash FROM editorial_wave2b_start_events
      WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id}
        AND event_type = 'workflow_start_confirmed'
      ORDER BY created_at, event_id`;
    const event = events[0];
    if (!ledger || !workflow || ledger.status !== "started" || ledger.start_status !== null ||
        ledger.error_code !== null || ledger.next_action !== null || workflow.status !== "started" || events.length !== 1 || !event) {
      return { confirmed: false, event_id: event?.event_id || null };
    }
    const expectedEvidenceHash = await hashJson({
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      article_id: input.article_id,
      recording_id: input.recording_id,
      user_id: input.user_id,
      workspace_id: input.workspace_id,
      payload_hash: input.payload_hash,
      manifest_hash: input.manifest_hash,
      event_type: "workflow_start_confirmed",
    });
    if (event.evidence_hash !== expectedEvidenceHash) {
      throw new EditorialRuntimeError("workflow_start_identity_conflict", "Wave2B workflow confirmation evidence conflicts", 409);
    }
    return { confirmed: true, event_id: event.event_id };
  }

  public async prepareFiveAgentStartReconciliation(input: {
    run_id: string; workflow_id: string; start_status: FiveAgentStartStatus;
    reconciliation_key: string; evidence_hash: string; created_at: string;
  }): Promise<{ replayed: boolean; receipt_id: string }> {
    this.ensureSchema();
    const current = this.wave2bStartLedger(input.workflow_id, input.run_id);
    if (!current || current.status !== "needs_action" || current.start_status !== input.start_status) {
      throw new EditorialRuntimeError("workflow_start_reconciliation_required", "Wave2B start is not in the requested hold", 409);
    }
    const otherReceipt = this.sql<{ reconciliation_key: string; evidence_hash: string }>`
      SELECT reconciliation_key, evidence_hash FROM editorial_wave2b_start_receipts
      WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id}
        AND start_status = ${input.start_status} AND reconciliation_key <> ${input.reconciliation_key}
      LIMIT 1`[0];
    if (otherReceipt) {
      throw new EditorialRuntimeError("idempotency_conflict", "Wave2B start reconciliation key conflicts", 409);
    }
    const existing = this.sql<{ receipt_id: string; start_status: FiveAgentStartStatus; evidence_hash: string }>`
      SELECT receipt_id, start_status, evidence_hash FROM editorial_wave2b_start_receipts
      WHERE workflow_id = ${input.workflow_id} AND reconciliation_key = ${input.reconciliation_key} LIMIT 1`[0];
    if (existing) {
      if (existing.start_status !== input.start_status || existing.evidence_hash !== input.evidence_hash) {
        throw new EditorialRuntimeError("idempotency_conflict", "Wave2B start reconciliation conflicts", 409);
      }
      return { replayed: true, receipt_id: existing.receipt_id };
    }
    const receiptId = `${input.workflow_id}:start-reconcile:${input.reconciliation_key}`;
    const reconciledEvidenceHash = await hashJson({
      workflow_id: input.workflow_id, run_id: input.run_id,
      event_type: "start_reconciled", start_status: input.start_status,
      reconciliation_key: input.reconciliation_key, evidence_hash: input.evidence_hash,
    });
    this.transactionSync(() => {
      this.appendFiveAgentStartEvent({
        workflow_id: input.workflow_id, run_id: input.run_id,
        event_type: "start_reconciled",
        idempotency_key: `start-reconciled:${input.workflow_id}:${input.reconciliation_key}`,
        evidence_hash: reconciledEvidenceHash, created_at: input.created_at,
      });
      this.sql`INSERT INTO editorial_wave2b_start_receipts
        (receipt_id, workflow_id, run_id, start_status, reconciliation_key, evidence_hash, created_at)
        VALUES (${receiptId}, ${input.workflow_id}, ${input.run_id}, ${input.start_status}, ${input.reconciliation_key}, ${input.evidence_hash}, ${input.created_at})`;
    });
    return { replayed: false, receipt_id: receiptId };
  }

  public async finalizeFiveAgentStartReconciliation(input: {
    run_id: string; workflow_id: string; start_status: FiveAgentStartStatus;
    reconciliation_key: string; evidence_hash: string; created_at: string;
  }): Promise<{ replayed: boolean; receipt_id: string }> {
    this.ensureSchema();
    const receipt = this.sql<{ receipt_id: string; start_status: FiveAgentStartStatus; evidence_hash: string }>`
      SELECT receipt_id, start_status, evidence_hash FROM editorial_wave2b_start_receipts
      WHERE workflow_id = ${input.workflow_id} AND reconciliation_key = ${input.reconciliation_key} LIMIT 1`[0];
    if (!receipt || receipt.start_status !== input.start_status || receipt.evidence_hash !== input.evidence_hash) {
      throw new EditorialRuntimeError("workflow_start_reconciliation_required", "Wave2B reconciliation receipt is missing or conflicts", 409);
    }
    const current = this.wave2bStartLedger(input.workflow_id, input.run_id);
    if (!current) throw new EditorialRuntimeError("workflow_start_not_found", "Wave2B start intent not found", 404);
    if (current.status === "reconciled" && current.start_status === input.start_status) {
      return { replayed: true, receipt_id: receipt.receipt_id };
    }
    if (current.status !== "needs_action" || current.start_status !== input.start_status) {
      throw new EditorialRuntimeError("workflow_start_reconciliation_required", "Wave2B start is not in the requested hold", 409);
    }
    this.transactionSync(() => {
      this.sql`UPDATE editorial_wave2b_start_ledger
        SET status = 'reconciled', start_status = ${input.start_status}, error_code = NULL, next_action = NULL, updated_at = ${input.created_at}
        WHERE workflow_id = ${input.workflow_id} AND run_id = ${input.run_id} AND status = 'needs_action'`;
      this.sql`UPDATE editorial_wave2b_workflow_starts SET status = 'reconciled', updated_at = ${input.created_at}
        WHERE workflow_id = ${input.workflow_id}`;
    });
    return { replayed: false, receipt_id: receipt.receipt_id };
  }

  public async reconcileFiveAgentStart(input: {
    run_id: string; workflow_id: string; start_status: FiveAgentStartStatus;
    reconciliation_key: string; evidence_hash: string; created_at: string;
  }): Promise<{ replayed: boolean; receipt_id: string }> {
    const prepared = await this.prepareFiveAgentStartReconciliation(input);
    const finalized = await this.finalizeFiveAgentStartReconciliation(input);
    return { replayed: prepared.replayed && finalized.replayed, receipt_id: prepared.receipt_id };
  }

  public async findFiveAgentRun(runId: string, userId: string, workspaceId: string): Promise<Record<string, unknown> | null> {
    this.ensureSchema();
    const row = this.wave2bRun(runId, userId, workspaceId);
    if (!row) return null;
    const artifacts = this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_wave2b_outbox WHERE run_id = ${runId}`[0]?.count || 0;
    const receipts = this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_wave2b_receipts WHERE run_id = ${runId}`[0]?.count || 0;
    const calls = this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_wave2b_calls WHERE run_id = ${runId}`[0]?.count || 0;
    const start = this.wave2bStartLedger(String(row.workflow_id), runId);
    const derivedStartStatus = start?.status === "reconciled"
      ? "reconciled_resuming"
      : start?.status === "started"
        ? "workflow_started"
        : start?.start_status || null;
    return {
      ...row,
      start_status: derivedStartStatus,
      start_ledger_status: start?.status || null,
      start_error_code: start?.error_code || null,
      start_next_action: start?.next_action || null,
      artifact_count: Number(artifacts), receipt_count: Number(receipts), call_intent_count: Number(calls),
    };
  }

  public async getFiveAgentRun(runId: string, userId: string, workspaceId: string): Promise<Record<string, unknown>> {
    const row = await this.findFiveAgentRun(runId, userId, workspaceId);
    if (!row) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    return row;
  }

  public async listFiveAgentCallAttempts(runId: string, userId: string, workspaceId: string): Promise<Array<{
    call_id: string; call_kind: string; idempotency_key: string; attempt: number;
    status: "succeeded" | "failed" | "needs_action" | null; error_code: string | null; retryable: boolean | null;
  }>> {
    this.ensureSchema();
    const run = this.wave2bRun(runId);
    if (!run || run.user_id !== userId || run.workspace_id !== workspaceId) {
      throw new EditorialRuntimeError("run_not_found", "Wave2B run is not in the requested scope", 404);
    }
    return this.sql<{
      call_id: string; call_kind: string; idempotency_key: string; attempt: number;
      status: "succeeded" | "failed" | "needs_action" | null; error_code: string | null; retryable: number | null;
    }>`SELECT c.call_id, c.call_kind, c.idempotency_key, c.attempt, r.status, r.error_code, r.retryable
      FROM editorial_wave2b_calls c LEFT JOIN editorial_wave2b_call_results r ON r.call_id = c.call_id
      WHERE c.run_id = ${runId} ORDER BY c.call_kind, c.idempotency_key, c.attempt`
      .map(row => ({ ...row, retryable: row.retryable === null ? null : row.retryable === 1 }));
  }

  public async prepareFiveAgentCall(input: {
    run_id: string; call_kind: string; idempotency_key: string; attempt: number; created_at: string;
  }): Promise<{ status: "prepared" | "completed" | "failed" | "needs_action"; call_id: string; artifact_id?: string; response_hash?: string; error_code?: string; retryable?: boolean; attempt?: number }> {
    this.ensureSchema();
    if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 3) {
      throw new EditorialRuntimeError("retry_limit_exceeded", "adapter call attempt must be between 1 and 3", 409);
    }
    const callId = `${input.run_id}:call:${input.call_kind}:${input.idempotency_key}:attempt:${input.attempt}`;
    const latest = this.sql<{
      call_id: string; attempt: number; status: "succeeded" | "failed" | "needs_action";
      artifact_id: string | null; response_hash: string | null; error_code: string | null; retryable: number;
    }>`
      SELECT c.call_id, c.attempt, r.status, r.artifact_id, r.response_hash, r.error_code, r.retryable
      FROM editorial_wave2b_calls c JOIN editorial_wave2b_call_results r ON r.call_id = c.call_id
      WHERE c.run_id = ${input.run_id} AND c.call_kind = ${input.call_kind}
        AND c.idempotency_key = ${input.idempotency_key} ORDER BY c.attempt DESC LIMIT 1`[0];
    if (latest?.status === "succeeded") {
      return { status: "completed", call_id: latest.call_id, artifact_id: latest.artifact_id || undefined, response_hash: latest.response_hash || undefined };
    }
    if (latest?.status === "needs_action") {
      return { status: "needs_action", call_id: latest.call_id, artifact_id: latest.artifact_id || undefined, response_hash: latest.response_hash || undefined, error_code: latest.error_code || undefined, retryable: false, attempt: latest.attempt };
    }
    if (latest?.status === "failed" && !latest.retryable) {
      const role = input.call_kind.startsWith("editorial_review") ? "review" : input.call_kind.startsWith("visual_") ? "visual" : input.call_kind.startsWith("wechat_") ? "wechat" : "writing";
      return { status: "failed", call_id: latest.call_id, artifact_id: latest.artifact_id || undefined, response_hash: latest.response_hash || undefined, error_code: role === "visual" ? "visual_generation_non_retryable" : role === "wechat" ? "wechat_operation_non_retryable" : `${role}_adapter_non_retryable`, retryable: false, attempt: latest.attempt };
    }
    if (latest?.status === "failed" && latest.retryable && latest.attempt >= 3) {
      const role = input.call_kind.startsWith("editorial_review") ? "review" : input.call_kind.startsWith("visual_") ? "visual" : input.call_kind.startsWith("wechat_") ? "wechat" : "writing";
      return { status: "failed", call_id: latest.call_id, artifact_id: latest.artifact_id || undefined, response_hash: latest.response_hash || undefined, error_code: role === "visual" ? "visual_generation_retry_exhausted" : role === "wechat" ? "wechat_operation_retry_exhausted" : `${role}_adapter_retry_exhausted`, retryable: false, attempt: latest.attempt };
    }
    if (latest?.status === "failed" && input.attempt === latest.attempt) {
      return { status: "failed", call_id: latest.call_id, artifact_id: latest.artifact_id || undefined, response_hash: latest.response_hash || undefined, error_code: latest.error_code || undefined, retryable: true, attempt: latest.attempt };
    }
    if (latest?.status === "failed" && latest.retryable && input.attempt < latest.attempt) {
      return { status: "failed", call_id: latest.call_id, artifact_id: latest.artifact_id || undefined, response_hash: latest.response_hash || undefined, error_code: latest.error_code || undefined, retryable: true, attempt: latest.attempt };
    }
    if (latest && input.attempt <= latest.attempt) {
      throw new EditorialRuntimeError("retry_attempt_conflict", "a retryable adapter attempt already has a durable result", 409);
    }
    const inflight = this.sql<{ call_id: string; attempt: number }>`
      SELECT c.call_id, c.attempt FROM editorial_wave2b_calls c
      LEFT JOIN editorial_wave2b_call_results r ON r.call_id = c.call_id
      WHERE c.run_id = ${input.run_id} AND c.call_kind = ${input.call_kind}
      AND c.idempotency_key = ${input.idempotency_key} AND r.call_id IS NULL LIMIT 1`[0];
    if (inflight) {
      const role = input.call_kind.startsWith("editorial_review") ? "review" : input.call_kind.startsWith("visual_") ? "visual" : input.call_kind.startsWith("wechat_") ? "wechat" : "writing";
      return {
        status: "needs_action",
        call_id: inflight.call_id,
        error_code: role === "visual" ? "external_side_effect_unknown" : "external_side_effect_unknown",
        retryable: false,
        attempt: Number(inflight.attempt),
      };
    }
    if (input.attempt > 1) {
      const priorCalls = this.sql<{
        attempt: number;
        call_id: string | null;
        result_status: "succeeded" | "failed" | "needs_action" | null;
        retryable: number | null;
      }>`
        SELECT c.attempt, c.call_id, r.status AS result_status, r.retryable
        FROM editorial_wave2b_calls c
        LEFT JOIN editorial_wave2b_call_results r ON r.call_id = c.call_id
        WHERE c.run_id = ${input.run_id} AND c.call_kind = ${input.call_kind}
          AND c.idempotency_key = ${input.idempotency_key} AND c.attempt < ${input.attempt}
        ORDER BY c.attempt`;
      for (let priorAttempt = 1; priorAttempt < input.attempt; priorAttempt += 1) {
        const prior = priorCalls.find(item => Number(item.attempt) === priorAttempt);
        if (!prior || !prior.call_id) {
          return {
            status: "failed",
            call_id: callId,
            error_code: "attempt_order_invalid",
            retryable: false,
            attempt: input.attempt,
          };
        }
        if (!prior.result_status) {
          return {
            status: "needs_action",
            call_id: prior.call_id,
            error_code: "external_side_effect_unknown",
            retryable: false,
            attempt: priorAttempt,
          };
        }
        if (prior.result_status === "needs_action" || prior.result_status === "succeeded" || prior.retryable !== 1) {
          const role = input.call_kind.startsWith("editorial_review") ? "review" : input.call_kind.startsWith("visual_") ? "visual" : "writing";
          return {
            status: prior.result_status === "succeeded" ? "completed" : "failed",
            call_id: prior.call_id,
            error_code: prior.result_status === "succeeded" ? undefined : role === "visual" ? "visual_generation_non_retryable" : `${role}_adapter_non_retryable`,
            retryable: false,
            attempt: priorAttempt,
          };
        }
      }
    }
    const row = this.wave2bRun(input.run_id);
    if (!row) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    this.transactionSync(() => {
      this.sql`INSERT INTO editorial_wave2b_calls
        (call_id, run_id, call_kind, idempotency_key, attempt, created_at)
        VALUES (${callId}, ${input.run_id}, ${input.call_kind}, ${input.idempotency_key}, ${input.attempt}, ${input.created_at})`;
    });
    return { status: "prepared", call_id: callId };
  }

  public async completeFiveAgentCall(input: {
    call_id: string; run_id: string; status: "succeeded" | "failed" | "needs_action";
    response_hash?: string; artifact_id?: string; error_code?: string; retryable?: boolean; recorded_at: string;
  }): Promise<void> {
    this.ensureSchema();
    this.transactionSync(() => {
      const call = this.sql<{ run_id: string }>`SELECT run_id FROM editorial_wave2b_calls WHERE call_id = ${input.call_id} LIMIT 1`[0];
      if (!call || call.run_id !== input.run_id) throw new EditorialRuntimeError("call_identity_conflict", "call result does not match its call intent", 409);
      const existing = this.sql<{
        call_id: string; run_id: string; status: "succeeded" | "failed" | "needs_action";
        response_hash: string | null; artifact_id: string | null; error_code: string | null; retryable: number;
      }>`
        SELECT call_id, run_id, status, response_hash, artifact_id, error_code, retryable
        FROM editorial_wave2b_call_results WHERE call_id = ${input.call_id}`[0];
      if (existing) {
        if (existing.run_id !== input.run_id || existing.status !== input.status ||
            existing.response_hash !== (input.response_hash || null) ||
            existing.artifact_id !== (input.artifact_id || null) ||
            existing.error_code !== (input.error_code || null) ||
            Boolean(existing.retryable) !== Boolean(input.retryable)) {
          throw new EditorialRuntimeError("idempotency_conflict", "call result conflicts", 409);
        }
        return;
      }
      this.sql`INSERT INTO editorial_wave2b_call_results
        (call_id, run_id, status, response_hash, artifact_id, error_code, retryable, recorded_at)
        VALUES (${input.call_id}, ${input.run_id}, ${input.status}, ${input.response_hash || null},
          ${input.artifact_id || null}, ${input.error_code || null}, ${input.retryable ? 1 : 0}, ${input.recorded_at})`;
    });
  }

  public async prepareFiveAgentArtifact(input: {
    run_id: string; metadata: FiveAgentEnvelopeMetadata; envelope_json: string;
  }): Promise<{ status: "prepared" | "replayed" }> {
    this.ensureSchema();
    if (input.run_id !== input.metadata.run_id) {
      throw new EditorialRuntimeError("artifact_scope_mismatch", "Wave2B artifact run does not match", 409);
    }
    if (!WAVE2B_OPAQUE_RE.test(input.metadata.artifact_id) || !WAVE2B_OPAQUE_RE.test(input.metadata.run_id) ||
        !WAVE2B_OPAQUE_RE.test(input.metadata.article_id) || !WAVE2B_OPAQUE_RE.test(input.metadata.user_id) ||
        !WAVE2B_OPAQUE_RE.test(input.metadata.workspace_id) || !WAVE2B_OPAQUE_RE.test(input.metadata.idempotency_key) ||
        !WAVE2B_OPAQUE_RE.test(input.metadata.producer_role) || !WAVE2B_OPAQUE_RE.test(input.metadata.producer_version) ||
        !WAVE2B_OPAQUE_RE.test(input.metadata.kind) || !WAVE2B_OPAQUE_RE.test(input.metadata.workflow_version) ||
        !WAVE2B_OPAQUE_RE.test(input.metadata.policy_version) || !WAVE2B_OPAQUE_RE.test(input.metadata.payload_hash) ||
        input.metadata.schema_version !== WAVE2_SCHEMA_VERSION ||
        !/^sha256:[a-f0-9]{64}$/.test(input.metadata.skill_pins_hash) ||
        !/^sha256:[a-f0-9]{64}$/.test(input.metadata.envelope_identity_hash)) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B artifact metadata identity is invalid", 400);
    }
    if (!WAVE2_ARTIFACT_KINDS.includes(input.metadata.kind as typeof WAVE2_ARTIFACT_KINDS[number])) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B artifact kind is not allowed", 409);
    }
    try { validateArtifactKey(input.metadata.artifact_key); } catch { throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B artifact key is invalid", 400); }
    if (input.metadata.storage_ref !== `r2://${input.metadata.artifact_key}`) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B storage reference is not canonical", 409);
    }
    let inputIds: unknown;
    try { inputIds = JSON.parse(input.metadata.input_artifact_ids_json); } catch { throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B input ids are invalid", 400); }
    if (!Array.isArray(inputIds) || inputIds.some(value => typeof value !== "string" || !WAVE2B_OPAQUE_RE.test(value)) || safeJson(inputIds) !== input.metadata.input_artifact_ids_json) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B input ids are not canonical", 400);
    }
    const run = this.wave2bRun(input.run_id);
    if (!run || run.user_id !== input.metadata.user_id || run.workspace_id !== input.metadata.workspace_id) {
      throw new EditorialRuntimeError("artifact_scope_mismatch", "Wave2B artifact owner is not bound to the run", 403);
    }
    if (String(run.article_id) !== input.metadata.article_id || Number(run.recording_id) !== Number(input.metadata.recording_id) ||
        run.workflow_id === null || run.state === "failed") {
      throw new EditorialRuntimeError("artifact_scope_mismatch", "Wave2B artifact identity is not bound to the run", 409);
    }
    let manifest: Record<string, unknown>;
    try { manifest = parseJson<Record<string, unknown>>(String(run.manifest_json)); } catch {
      throw new EditorialRuntimeError("manifest_invalid", "Wave2B run manifest is invalid", 409);
    }
    if (manifest.workflow_version !== "editorial-workflow.v3" || manifest.policy_version !== "editorial-policy.v3" ||
        input.metadata.workflow_version !== manifest.workflow_version || input.metadata.policy_version !== manifest.policy_version ||
        await hashJson(expectedArtifactSkillPins(input.metadata.kind, manifest)) !== input.metadata.skill_pins_hash) {
      throw new EditorialRuntimeError("artifact_pin_conflict", "Wave2B artifact skill pins are not bound to the run manifest", 409);
    }
    const expectedProducer: Record<string, { role: string; version: string }> = {
      article_brief: { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
      article_draft: { role: "writing", version: PUBLICATION_AGENT_VERSIONS.writing },
      review_report: { role: "editorial_review", version: PUBLICATION_AGENT_VERSIONS.editorial_review },
      revision_dispatch: { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
      frozen_article_version: { role: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
    };
    const producer = expectedProducer[input.metadata.kind];
    if (!producer || input.metadata.producer_role !== producer.role || input.metadata.producer_version !== producer.version) {
      throw new EditorialRuntimeError("artifact_producer_conflict", "Wave2B artifact producer is not active for its kind", 409);
    }
    let canonicalKey: string;
    try { canonicalKey = artifactKey(input.metadata.user_id, input.metadata.workspace_id, input.run_id, input.metadata.kind as typeof WAVE2_ARTIFACT_KINDS[number], input.metadata.artifact_id); } catch {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B artifact key cannot be derived", 400);
    }
    if (input.metadata.artifact_key !== canonicalKey || input.metadata.storage_ref !== `r2://${canonicalKey}`) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B artifact storage identity is not canonical", 409);
    }
    const allowlistedMetadata: FiveAgentEnvelopeMetadata = {
      schema_version: input.metadata.schema_version,
      artifact_id: input.metadata.artifact_id,
      artifact_key: input.metadata.artifact_key,
      kind: input.metadata.kind,
      run_id: input.metadata.run_id,
      article_id: input.metadata.article_id,
      recording_id: input.metadata.recording_id,
      user_id: input.metadata.user_id,
      workspace_id: input.metadata.workspace_id,
      producer_role: input.metadata.producer_role,
      producer_version: input.metadata.producer_version,
      workflow_version: input.metadata.workflow_version,
      policy_version: input.metadata.policy_version,
      input_artifact_ids_json: input.metadata.input_artifact_ids_json,
      payload_hash: input.metadata.payload_hash,
      payload_length: input.metadata.payload_length,
      idempotency_key: input.metadata.idempotency_key,
      storage_ref: input.metadata.storage_ref,
      created_at: input.metadata.created_at,
      skill_pins_hash: input.metadata.skill_pins_hash,
      envelope_identity_hash: input.metadata.envelope_identity_hash,
    };
    if (await hashJson(envelopeIdentityMaterial(allowlistedMetadata)) !== input.metadata.envelope_identity_hash) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B envelope identity hash is invalid", 409);
    }
    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(input.envelope_json);
    } catch {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B envelope metadata is invalid", 400);
    }
    if (safeJson(parsedMetadata) !== safeJson(allowlistedMetadata)) {
      throw new EditorialRuntimeError("artifact_metadata_invalid", "Wave2B envelope contains non-redacted fields", 400);
    }
    const existing = this.sql<{ payload_hash: string; envelope_json: string }>`
      SELECT payload_hash, envelope_json FROM editorial_wave2b_outbox WHERE artifact_id = ${input.metadata.artifact_id}`[0];
    if (existing) {
      if (existing.payload_hash !== input.metadata.payload_hash || existing.envelope_json !== input.envelope_json) throw new EditorialRuntimeError("artifact_conflict", "Wave2B artifact identity conflicts", 409);
      return { status: "replayed" };
    }
    this.transactionSync(() => {
      this.sql`INSERT INTO editorial_wave2b_outbox
        (artifact_id, run_id, user_id, workspace_id, envelope_json, payload_hash, storage_ref, created_at)
        VALUES (${input.metadata.artifact_id}, ${input.run_id}, ${input.metadata.user_id}, ${input.metadata.workspace_id},
          ${input.envelope_json}, ${input.metadata.payload_hash}, ${input.metadata.storage_ref}, ${input.metadata.created_at})`;
    });
    return { status: "prepared" };
  }

  public async listFiveAgentArtifacts(runId: string, userId: string, workspaceId: string): Promise<FiveAgentEnvelopeMetadata[]> {
    this.ensureSchema();
    const rows = this.sql<{ envelope_json: string }>`
      SELECT envelope_json FROM editorial_wave2b_outbox
      WHERE run_id = ${runId} AND user_id = ${userId} AND workspace_id = ${workspaceId}
      ORDER BY created_at, artifact_id`;
    return rows.map(row => parseJson<FiveAgentEnvelopeMetadata>(row.envelope_json));
  }

  public async getFiveAgentArtifactLedger(runId: string, userId: string, workspaceId: string): Promise<{
    artifacts: FiveAgentEnvelopeMetadata[];
    receipt_ids: string[];
  }> {
    this.ensureSchema();
    const rows = this.sql<{ envelope_json: string; artifact_id: string; receipt_artifact_id: string | null }>`
      SELECT o.envelope_json, o.artifact_id, r.artifact_id AS receipt_artifact_id
      FROM editorial_wave2b_outbox o
      LEFT JOIN editorial_wave2b_receipts r ON r.artifact_id = o.artifact_id
      WHERE o.run_id = ${runId} AND o.user_id = ${userId} AND o.workspace_id = ${workspaceId}
      ORDER BY o.created_at, o.artifact_id`;
    return {
      artifacts: rows.map(row => parseJson<FiveAgentEnvelopeMetadata>(row.envelope_json)),
      receipt_ids: rows.filter(row => row.receipt_artifact_id !== null).map(row => row.artifact_id),
    };
  }

  public async prepareFiveAgentVisualArtifact(input: {
    run_id: string;
    metadata: VisualArtifactMetadata;
    envelope_json: string;
  }): Promise<{ status: "prepared" | "replayed" }> {
    this.ensureSchema();
    const metadata = input.metadata;
    const run = this.wave2bRun(input.run_id);
    if (!run || metadata.run_id !== input.run_id || metadata.user_id !== run.user_id || metadata.workspace_id !== run.workspace_id || metadata.article_id !== run.article_id || Number(metadata.recording_id) !== Number(run.recording_id)) {
      throw new EditorialRuntimeError("visual_artifact_scope_mismatch", "visual artifact is not bound to the run", 403);
    }
    if (metadata.schema_version !== "editorial-wave2c.v1" || metadata.producer.role !== "visual_production" || metadata.producer.version !== "visual-production.agent.v1" || !["visual_plan", "visual_asset", "visual_qa_report"].includes(metadata.kind) || metadata.artifact_key !== visualArtifactKey(metadata.user_id, metadata.workspace_id, metadata.run_id, metadata.kind, metadata.artifact_id) || metadata.storage_ref !== `r2://${metadata.artifact_key}` || (metadata.kind !== "visual_asset" && metadata.binary_storage_ref !== null) || (metadata.binary_storage_ref !== null && (!metadata.binary_storage_ref.startsWith("r2://editorial/v3/") || !metadata.binary_storage_ref.includes(`/${metadata.run_id}/visual-binary/`) || metadata.binary_storage_ref === metadata.storage_ref))) {
      throw new EditorialRuntimeError("visual_artifact_metadata_invalid", "visual artifact metadata is not active", 409);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(input.envelope_json); } catch { throw new EditorialRuntimeError("visual_artifact_metadata_invalid", "visual envelope is not canonical JSON", 400); }
    if (safeJson(parsed) !== safeJson(metadata)) throw new EditorialRuntimeError("visual_artifact_metadata_invalid", "visual envelope contains non-redacted fields", 409);
    const existing = this.sql<{ payload_hash: string; envelope_json: string }>`
      SELECT payload_hash, envelope_json FROM editorial_wave2c_visual_artifacts WHERE artifact_id = ${metadata.artifact_id} LIMIT 1`[0];
    if (existing) {
      if (existing.payload_hash !== metadata.payload_hash || existing.envelope_json !== input.envelope_json) throw new EditorialRuntimeError("visual_artifact_conflict", "visual artifact identity conflicts", 409);
      return { status: "replayed" };
    }
    try {
      this.transactionSync(() => {
        this.sql`INSERT INTO editorial_wave2c_visual_artifacts
          (artifact_id, run_id, user_id, workspace_id, envelope_json, payload_hash, storage_ref, binary_storage_ref, created_at)
          VALUES (${metadata.artifact_id}, ${metadata.run_id}, ${metadata.user_id}, ${metadata.workspace_id}, ${input.envelope_json}, ${metadata.payload_hash}, ${metadata.storage_ref}, ${metadata.binary_storage_ref}, ${metadata.created_at})`;
      });
      return { status: "prepared" };
    } catch {
      const raced = this.sql<{ payload_hash: string; envelope_json: string }>`
        SELECT payload_hash, envelope_json FROM editorial_wave2c_visual_artifacts WHERE artifact_id = ${metadata.artifact_id} LIMIT 1`[0];
      if (raced && raced.payload_hash === metadata.payload_hash && raced.envelope_json === input.envelope_json) return { status: "replayed" };
      if (raced) throw new EditorialRuntimeError("visual_artifact_conflict", "visual artifact identity conflicts", 409);
      throw new EditorialRuntimeError("visual_artifact_reconciliation_required", "visual artifact write outcome is unknown", 503);
    }
  }

  public async completeFiveAgentVisualArtifact(input: {
    artifact_id: string;
    run_id: string;
    payload_hash: string;
    state: string;
    state_revision: number;
    event_type: "visual_plan_committed" | "visual_asset_committed" | "visual_qa_committed" | "visual_needs_action" | "visual_failed";
    event_idempotency_key: string;
    created_at: string;
  }): Promise<{ replayed: boolean }> {
    this.ensureSchema();
    const artifact = this.sql<{ run_id: string; payload_hash: string }>`
      SELECT run_id, payload_hash FROM editorial_wave2c_visual_artifacts WHERE artifact_id = ${input.artifact_id} LIMIT 1`[0];
    if (!artifact || artifact.run_id !== input.run_id || artifact.payload_hash !== input.payload_hash) throw new EditorialRuntimeError("visual_artifact_identity_conflict", "visual artifact receipt is not bound to its outbox", 409);
    const current = this.wave2bRun(input.run_id);
    if (!current) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    if (!["visual_planning", "visual_generating", "visual_ready", "needs_action", "failed"].includes(input.state)) throw new EditorialRuntimeError("visual_state_invalid", "visual state is not allowed", 409);
    const existingEvent = this.sql<{ event_id: string; state: string; state_revision: number; artifact_id: string; payload_hash: string; event_type: string }>`
      SELECT event_id, state, state_revision, artifact_id, payload_hash, event_type FROM editorial_wave2c_visual_events WHERE idempotency_key = ${input.event_idempotency_key} LIMIT 1`[0];
    if (existingEvent) {
      if (existingEvent.event_id === `${input.run_id}:visual:${input.event_idempotency_key}` && existingEvent.state === input.state && Number(existingEvent.state_revision) === input.state_revision && existingEvent.artifact_id === input.artifact_id && existingEvent.payload_hash === input.payload_hash && existingEvent.event_type === input.event_type) return { replayed: true };
      throw new EditorialRuntimeError("idempotency_conflict", "visual event replay conflicts", 409);
    }
    const stateChanged = input.state !== current.state;
    if (stateChanged && (Number(current.state_revision) !== input.state_revision - 1 || !WAVE2B_TRANSITIONS[String(current.state)]?.includes(input.state))) throw new EditorialRuntimeError("stale_workflow_step", "visual state CAS failed", 409);
    if (!stateChanged && (String(current.state) !== input.state || Number(current.state_revision) !== input.state_revision)) throw new EditorialRuntimeError("stale_workflow_step", "visual event revision is stale", 409);
    const projected = deriveWave2BProjection(current, input.state);
    this.transactionSync(() => {
      if (stateChanged) {
        const updated = this.sql<{ run_id: string }>`UPDATE editorial_wave2b_runs SET state = ${input.state}, state_revision = ${input.state_revision}, run_status = ${projected.runStatus}, progress_percent = ${projected.progress}, resume_state = ${projected.resumeState}, last_successful_state = ${projected.lastSuccessfulState}, last_successful_progress_percent = ${projected.lastSuccessfulProgress}, updated_at = ${input.created_at} WHERE run_id = ${input.run_id} AND state_revision = ${input.state_revision - 1} RETURNING run_id`;
        if (updated.length !== 1) throw new EditorialRuntimeError("stale_workflow_step", "visual state CAS failed", 409);
      }
      this.sql`INSERT INTO editorial_wave2c_visual_receipts (artifact_id, run_id, payload_hash, mirrored_at) VALUES (${input.artifact_id}, ${input.run_id}, ${input.payload_hash}, ${input.created_at})`;
      this.sql`INSERT INTO editorial_wave2c_visual_events (event_id, run_id, event_type, state, state_revision, artifact_id, payload_hash, idempotency_key, created_at) VALUES (${`${input.run_id}:visual:${input.event_idempotency_key}`}, ${input.run_id}, ${input.event_type}, ${input.state}, ${input.state_revision}, ${input.artifact_id}, ${input.payload_hash}, ${input.event_idempotency_key}, ${input.created_at})`;
    });
    return { replayed: false };
  }

  public async getFiveAgentVisualLedger(runId: string, userId: string, workspaceId: string): Promise<{
    artifacts: VisualArtifactMetadata[];
    receipt_ids: string[];
    event_ids: string[];
    event_artifacts: Array<{ event_id: string; artifact_id: string }>;
    visual_events: Array<{ event_id: string; event_type: string; state_revision: number; artifact_id: string; payload_hash: string; idempotency_key: string; created_at: string }>;
  }> {
    this.ensureSchema();
    const rows = this.sql<{ envelope_json: string; artifact_id: string; receipt_artifact_id: string | null }>`
      SELECT a.envelope_json, a.artifact_id, r.artifact_id AS receipt_artifact_id FROM editorial_wave2c_visual_artifacts a LEFT JOIN editorial_wave2c_visual_receipts r ON r.artifact_id = a.artifact_id WHERE a.run_id = ${runId} AND a.user_id = ${userId} AND a.workspace_id = ${workspaceId} ORDER BY a.created_at, a.artifact_id`;
    const events = this.sql<{ event_id: string; event_type: string; state_revision: number; artifact_id: string; payload_hash: string; idempotency_key: string; created_at: string }>`SELECT event_id, event_type, state_revision, artifact_id, payload_hash, idempotency_key, created_at FROM editorial_wave2c_visual_events WHERE run_id = ${runId} ORDER BY created_at, event_id`;
    return {
      artifacts: rows.map(row => parseJson<VisualArtifactMetadata>(row.envelope_json)),
      receipt_ids: rows.filter(row => row.receipt_artifact_id !== null).map(row => row.artifact_id),
      event_ids: events.map(row => row.event_id),
      event_artifacts: events.map(row => ({ event_id: row.event_id, artifact_id: row.artifact_id })),
      visual_events: events,
    };
  }

  public async prepareFiveAgentWechatArtifact(input: {
    run_id: string;
    metadata: WechatArtifactMetadata;
    envelope_json: string;
  }): Promise<{ status: "prepared" | "replayed" }> {
    this.ensureSchema();
    const metadata = input.metadata;
    const run = this.wave2bRun(input.run_id);
    if (!run || metadata.run_id !== input.run_id || metadata.user_id !== run.user_id || metadata.workspace_id !== run.workspace_id || metadata.article_id !== run.article_id || Number(metadata.recording_id) !== Number(run.recording_id)) {
      throw new EditorialRuntimeError("wechat_artifact_scope_mismatch", "wechat artifact is not bound to the run", 403);
    }
    const allowed = ["wechat_render_template", "wechat_render_qa_report", "wechat_image_upload_receipt", "rendered_article_package", "wechat_prepublish_qa_report", "wechat_draft_receipt", "wechat_draft_readback_qa"];
    if (metadata.schema_version !== "editorial-wave2d.v1" || metadata.producer.role !== "wechat_publishing" || metadata.producer.version !== "wechat-publishing.agent.v1" || !allowed.includes(metadata.kind) || metadata.artifact_key !== wechatArtifactKey({ user_id: metadata.user_id, workspace_id: metadata.workspace_id, run_id: metadata.run_id, article_id: metadata.article_id, recording_id: metadata.recording_id }, metadata.kind, metadata.artifact_id) || metadata.storage_ref !== `r2://${metadata.artifact_key}`) {
      throw new EditorialRuntimeError("wechat_artifact_metadata_invalid", "wechat artifact metadata is not active", 409);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(input.envelope_json); } catch { throw new EditorialRuntimeError("wechat_artifact_metadata_invalid", "wechat envelope is invalid", 400); }
    if (safeJson(parsed) !== safeJson(metadata)) throw new EditorialRuntimeError("wechat_artifact_metadata_invalid", "wechat envelope contains non-redacted fields", 409);
    const existing = this.sql<{ payload_hash: string; envelope_json: string }>`SELECT payload_hash, envelope_json FROM editorial_wave2d_wechat_artifacts WHERE artifact_id = ${metadata.artifact_id} LIMIT 1`[0];
    if (existing) {
      if (existing.payload_hash !== metadata.payload_hash || existing.envelope_json !== input.envelope_json) throw new EditorialRuntimeError("wechat_artifact_conflict", "wechat artifact identity conflicts", 409);
      return { status: "replayed" };
    }
    try {
      this.transactionSync(() => {
        this.sql`INSERT INTO editorial_wave2d_wechat_artifacts (artifact_id, run_id, user_id, workspace_id, envelope_json, payload_hash, storage_ref, created_at)
          VALUES (${metadata.artifact_id}, ${metadata.run_id}, ${metadata.user_id}, ${metadata.workspace_id}, ${input.envelope_json}, ${metadata.payload_hash}, ${metadata.storage_ref}, ${metadata.created_at})`;
      });
      return { status: "prepared" };
    } catch {
      const raced = this.sql<{ payload_hash: string; envelope_json: string }>`SELECT payload_hash, envelope_json FROM editorial_wave2d_wechat_artifacts WHERE artifact_id = ${metadata.artifact_id} LIMIT 1`[0];
      if (raced && raced.payload_hash === metadata.payload_hash && raced.envelope_json === input.envelope_json) return { status: "replayed" };
      if (raced) throw new EditorialRuntimeError("wechat_artifact_conflict", "wechat artifact identity conflicts", 409);
      throw new EditorialRuntimeError("wechat_artifact_reconciliation_required", "wechat artifact write outcome is unknown", 503);
    }
  }

  public async completeFiveAgentWechatArtifact(input: {
    artifact_id: string; run_id: string; payload_hash: string; state: string; state_revision: number;
    event_type: "wechat_artifact_committed" | "wechat_needs_action" | "wechat_failed"; event_idempotency_key: string; created_at: string;
  }): Promise<{ replayed: boolean; state_revision: number }> {
    this.ensureSchema();
    const artifact = this.sql<{ run_id: string; payload_hash: string }>`SELECT run_id, payload_hash FROM editorial_wave2d_wechat_artifacts WHERE artifact_id = ${input.artifact_id} LIMIT 1`[0];
    if (!artifact || artifact.run_id !== input.run_id || artifact.payload_hash !== input.payload_hash) throw new EditorialRuntimeError("wechat_artifact_identity_conflict", "wechat receipt is not bound to its outbox", 409);
    const current = this.wave2bRun(input.run_id);
    if (!current) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    if (!["formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready", "needs_action", "failed"].includes(input.state)) throw new EditorialRuntimeError("wechat_state_invalid", "wechat state is invalid", 409);
    const existing = this.sql<{ event_id: string; state: string; state_revision: number; artifact_id: string; payload_hash: string; event_type: string }>`SELECT event_id, state, state_revision, artifact_id, payload_hash, event_type FROM editorial_wave2d_wechat_events WHERE idempotency_key = ${input.event_idempotency_key} LIMIT 1`[0];
    if (existing) {
      if (existing.event_id === `${input.run_id}:wechat:${input.event_idempotency_key}` && existing.state === input.state && existing.artifact_id === input.artifact_id && existing.payload_hash === input.payload_hash && existing.event_type === input.event_type) return { replayed: true, state_revision: Number(existing.state_revision) };
      throw new EditorialRuntimeError("idempotency_conflict", "wechat event conflicts", 409);
    }
    if (Number(current.state_revision) !== input.state_revision - 1 ||
        (input.state !== current.state && !WAVE2B_TRANSITIONS[String(current.state)]?.includes(input.state))) {
      throw new EditorialRuntimeError("stale_workflow_step", "wechat state CAS failed", 409);
    }
    const projected = deriveWave2BProjection(current, input.state);
    this.transactionSync(() => {
      const updated = this.sql<{ run_id: string }>`UPDATE editorial_wave2b_runs SET state = ${input.state}, state_revision = ${input.state_revision}, run_status = ${projected.runStatus}, progress_percent = ${projected.progress}, resume_state = ${projected.resumeState}, last_successful_state = ${projected.lastSuccessfulState}, last_successful_progress_percent = ${projected.lastSuccessfulProgress}, updated_at = ${input.created_at} WHERE run_id = ${input.run_id} AND state_revision = ${input.state_revision - 1} RETURNING run_id`;
      if (updated.length !== 1) throw new EditorialRuntimeError("stale_workflow_step", "wechat state CAS failed", 409);
      this.sql`INSERT INTO editorial_wave2d_wechat_receipts (artifact_id, run_id, payload_hash, mirrored_at) VALUES (${input.artifact_id}, ${input.run_id}, ${input.payload_hash}, ${input.created_at})`;
      this.sql`INSERT INTO editorial_wave2d_wechat_events (event_id, run_id, event_type, state, state_revision, artifact_id, payload_hash, idempotency_key, created_at) VALUES (${`${input.run_id}:wechat:${input.event_idempotency_key}`}, ${input.run_id}, ${input.event_type}, ${input.state}, ${input.state_revision}, ${input.artifact_id}, ${input.payload_hash}, ${input.event_idempotency_key}, ${input.created_at})`;
    });
    return { replayed: false, state_revision: input.state_revision };
  }

  public async getFiveAgentWechatLedger(runId: string, userId: string, workspaceId: string): Promise<{
    artifacts: WechatArtifactMetadata[];
    receipt_ids: string[];
    event_artifacts: string[];
    wechat_events: Array<{ event_id: string; event_type: string; state: string; state_revision: number; artifact_id: string; payload_hash: string; idempotency_key: string; created_at: string }>;
  }> {
    this.ensureSchema();
    const rows = this.sql<{ envelope_json: string; artifact_id: string; receipt_artifact_id: string | null }>`SELECT a.envelope_json, a.artifact_id, r.artifact_id AS receipt_artifact_id FROM editorial_wave2d_wechat_artifacts a LEFT JOIN editorial_wave2d_wechat_receipts r ON r.artifact_id = a.artifact_id WHERE a.run_id = ${runId} AND a.user_id = ${userId} AND a.workspace_id = ${workspaceId} ORDER BY a.created_at, a.artifact_id`;
    const events = this.sql<{ event_id: string; event_type: string; state: string; state_revision: number; artifact_id: string; payload_hash: string; idempotency_key: string; created_at: string }>`SELECT event_id, event_type, state, state_revision, artifact_id, payload_hash, idempotency_key, created_at FROM editorial_wave2d_wechat_events WHERE run_id = ${runId} ORDER BY created_at, event_id`;
    return {
      artifacts: rows.map(row => parseJson<WechatArtifactMetadata>(row.envelope_json)),
      receipt_ids: rows.filter(row => row.receipt_artifact_id !== null).map(row => row.artifact_id),
      event_artifacts: events.map(row => row.artifact_id),
      wechat_events: events,
    };
  }

  public async listFiveAgentEvents(runId: string, userId: string, workspaceId: string): Promise<Array<{
    event_type: string;
    state: string;
    state_revision: number;
    artifact_id: string | null;
    payload_hash: string | null;
    error_code: string | null;
    next_action: string | null;
    created_at: string;
  }>> {
    this.ensureSchema();
    const current = this.wave2bRun(runId);
    if (!current || current.user_id !== userId || current.workspace_id !== workspaceId) {
      throw new EditorialRuntimeError("run_not_found", "Wave2B run is not in the requested scope", 404);
    }
    return this.sql<{
      event_type: string;
      state: string;
      state_revision: number;
      artifact_id: string | null;
      payload_hash: string | null;
      summary_json: string;
      created_at: string;
    }>`SELECT event_type, state, state_revision, artifact_id, payload_hash, summary_json, created_at
      FROM editorial_wave2b_events WHERE run_id = ${runId} ORDER BY state_revision, event_type`
      .map((row) => {
        let summary: Record<string, unknown> = {};
        try { summary = parseJson<Record<string, unknown>>(row.summary_json); } catch { /* append-only event summaries remain opaque on corruption */ }
        return {
          event_type: row.event_type,
          state: row.state,
          state_revision: row.state_revision,
          artifact_id: row.artifact_id,
          payload_hash: row.payload_hash,
          error_code: typeof summary.error_code === "string" ? summary.error_code : null,
          next_action: typeof summary.next_action === "string" ? summary.next_action : null,
          created_at: row.created_at,
        };
      });
  }

  public async completeFiveAgentArtifact(input: {
    run_id: string; artifact_id: string; payload_hash: string; state: string; state_revision: number;
    event_type: string; created_at: string; summary: Record<string, unknown>;
    next_action?: string | null; error_code?: string | null; revision_count?: number;
  }): Promise<{ replayed: boolean }> {
    this.ensureSchema();
    const current = this.wave2bRun(input.run_id);
    if (!current) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    if (!WAVE2B_STATES.includes(input.state as typeof WAVE2B_STATES[number]) || !WAVE2B_EVENT_TYPES.includes(input.event_type as typeof WAVE2B_EVENT_TYPES[number])) {
      throw new EditorialRuntimeError("state_or_event_not_allowed", "Wave2B artifact state or event is not allowed", 409);
    }
    if (input.state !== current.state && !WAVE2B_TRANSITIONS[String(current.state)]?.includes(input.state)) {
      throw new EditorialRuntimeError("state_transition_invalid", "Wave2B artifact state transition is not allowed", 409);
    }
    if ((input.state === "needs_action" || input.state === "failed") && (!input.next_action || !input.error_code)) {
      throw new EditorialRuntimeError("exceptional_state_metadata_required", "Wave2B exceptional states require a stable error and next action", 409);
    }
    if (input.state !== "needs_action" && input.state !== "failed" && (input.next_action || input.error_code)) {
      throw new EditorialRuntimeError("state_metadata_invalid", "Wave2B action metadata is only valid for exceptional states", 409);
    }
    const outbox = this.sql<{
      run_id: string; user_id: string; workspace_id: string; payload_hash: string; storage_ref: string; envelope_json: string;
    }>`SELECT run_id, user_id, workspace_id, payload_hash, storage_ref, envelope_json
      FROM editorial_wave2b_outbox WHERE artifact_id = ${input.artifact_id} LIMIT 1`[0];
    if (!outbox || outbox.run_id !== input.run_id || outbox.user_id !== current.user_id ||
        outbox.workspace_id !== current.workspace_id || outbox.payload_hash !== input.payload_hash ||
        !outbox.storage_ref.startsWith("r2://")) {
      throw new EditorialRuntimeError("artifact_identity_conflict", "Wave2B artifact outbox identity does not match", 409);
    }
    let envelope: FiveAgentEnvelopeMetadata;
    try { envelope = parseJson<FiveAgentEnvelopeMetadata>(outbox.envelope_json); } catch {
      throw new EditorialRuntimeError("artifact_identity_conflict", "Wave2B artifact envelope is invalid", 409);
    }
    if (envelope.artifact_id !== input.artifact_id || envelope.run_id !== input.run_id || envelope.user_id !== current.user_id ||
        envelope.workspace_id !== current.workspace_id || envelope.payload_hash !== input.payload_hash || envelope.storage_ref !== outbox.storage_ref ||
        !WAVE2B_OPAQUE_RE.test(envelope.kind) || !WAVE2B_OPAQUE_RE.test(envelope.producer_role) ||
        !WAVE2B_OPAQUE_RE.test(envelope.producer_version) || !WAVE2B_OPAQUE_RE.test(envelope.workflow_version) ||
        !WAVE2B_OPAQUE_RE.test(envelope.policy_version) || !WAVE2B_OPAQUE_RE.test(envelope.idempotency_key) ||
        envelope.schema_version !== WAVE2_SCHEMA_VERSION ||
        !/^sha256:[a-f0-9]{64}$/.test(envelope.skill_pins_hash) ||
        !/^sha256:[a-f0-9]{64}$/.test(envelope.envelope_identity_hash)) {
      throw new EditorialRuntimeError("artifact_identity_conflict", "Wave2B artifact envelope identity does not match", 409);
    }
    let runManifest: Record<string, unknown>;
    try { runManifest = parseJson<Record<string, unknown>>(String(current.manifest_json)); } catch {
      throw new EditorialRuntimeError("manifest_invalid", "Wave2B run manifest is invalid", 409);
    }
    if (await hashJson(expectedArtifactSkillPins(envelope.kind, runManifest)) !== envelope.skill_pins_hash ||
        await hashJson(envelopeIdentityMaterial(envelope)) !== envelope.envelope_identity_hash) {
      throw new EditorialRuntimeError("artifact_identity_conflict", "Wave2B artifact envelope hashes do not reconcile", 409);
    }
    const db = (this.env as EditorialRuntimeEnv & { DB?: D1Database }).DB;
    if (db) {
      const mirror = await db.prepare(`SELECT run_id, user_id, workspace_id, article_id, recording_id, kind,
        producer_agent_role, producer_agent_version, workflow_version, policy_version, input_artifact_ids_json,
        payload_hash, storage_ref, created_at
        FROM editorial_artifacts WHERE artifact_id = ? LIMIT 1`).bind(input.artifact_id).first<{
          run_id: string; user_id: string; workspace_id: string; article_id: string; recording_id: number; kind: string;
          producer_agent_role: string; producer_agent_version: string; workflow_version: string; policy_version: string;
          input_artifact_ids_json: string; payload_hash: string; storage_ref: string; created_at: string;
        }>();
      if (!mirror || mirror.run_id !== input.run_id || mirror.user_id !== current.user_id ||
          mirror.workspace_id !== current.workspace_id || mirror.article_id !== envelope.article_id ||
          Number(mirror.recording_id) !== Number(envelope.recording_id) || mirror.kind !== envelope.kind ||
          mirror.producer_agent_role !== envelope.producer_role || mirror.producer_agent_version !== envelope.producer_version ||
          mirror.workflow_version !== envelope.workflow_version || mirror.policy_version !== envelope.policy_version ||
          mirror.input_artifact_ids_json !== envelope.input_artifact_ids_json || mirror.payload_hash !== input.payload_hash ||
          mirror.storage_ref !== outbox.storage_ref || mirror.created_at !== envelope.created_at) {
        throw new EditorialRuntimeError("artifact_mirror_unavailable", "Wave2B artifact mirror is not reconciled", 503);
      }
    } else {
      throw new EditorialRuntimeError("artifact_mirror_unavailable", "Wave2B artifact mirror is not configured", 503);
    }
    if (Number(current.state_revision) === input.state_revision && current.state === input.state) {
      const event = this.sql<{ artifact_id: string | null; payload_hash: string | null; event_type: string }>`
        SELECT artifact_id, payload_hash, event_type FROM editorial_wave2b_events
        WHERE run_id = ${input.run_id} AND state_revision = ${input.state_revision} LIMIT 1`[0];
      if (event?.artifact_id === input.artifact_id && event.payload_hash === input.payload_hash && event.event_type === input.event_type) {
        return { replayed: true };
      }
      throw new EditorialRuntimeError("idempotency_conflict", "Wave2B artifact completion conflicts", 409);
    }
    if (input.revision_count !== undefined && (input.revision_count < Number(current.revision_count) || input.revision_count > 1)) {
      throw new EditorialRuntimeError("revision_count_invalid", "Wave2B revision count must be monotonic and at most one", 409);
    }
    const projected = deriveWave2BProjection(current, input.state, input.next_action, input.error_code);
    if (Number(current.state_revision) !== input.state_revision - 1) throw new EditorialRuntimeError("stale_workflow_step", "Wave2B state CAS failed", 409);
    this.transactionSync(() => {
      const updated = this.sql<{ run_id: string }>`UPDATE editorial_wave2b_runs
        SET state = ${input.state}, state_revision = ${input.state_revision},
            run_status = ${projected.runStatus}, progress_percent = ${projected.progress},
            resume_state = ${projected.resumeState}, last_successful_state = ${projected.lastSuccessfulState},
            last_successful_progress_percent = ${projected.lastSuccessfulProgress},
            next_action = ${input.next_action || null}, error_code = ${input.error_code || null},
            revision_count = COALESCE(${input.revision_count ?? null}, revision_count),
            updated_at = ${input.created_at}
        WHERE run_id = ${input.run_id} AND state_revision = ${input.state_revision - 1}
        RETURNING run_id`;
      if (updated.length !== 1) throw new EditorialRuntimeError("stale_workflow_step", "Wave2B state CAS failed", 409);
      this.sql`INSERT INTO editorial_wave2b_receipts
        (artifact_id, run_id, payload_hash, mirrored_at)
        VALUES (${input.artifact_id}, ${input.run_id}, ${input.payload_hash}, ${input.created_at})`;
      this.sql`INSERT INTO editorial_wave2b_events
        (run_id, event_type, state, state_revision, artifact_id, payload_hash, summary_json, created_at)
        VALUES (${input.run_id}, ${input.event_type}, ${input.state}, ${input.state_revision}, ${input.artifact_id}, ${input.payload_hash}, ${safeJson({
          ...input.summary,
          error_code: input.error_code || null,
          next_action: input.next_action || null,
        })}, ${input.created_at})`;
    });
    return { replayed: false };
  }

  public async recordFiveAgentState(input: {
    run_id: string; state: string; state_revision: number; event_type: string; created_at: string;
    next_action?: string | null; error_code?: string | null; revision_count?: number; retry_count?: number; payload_hash?: string | null;
  }): Promise<{ replayed: boolean }> {
    this.ensureSchema();
    const current = this.wave2bRun(input.run_id);
    if (!current) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    if (!WAVE2B_STATES.includes(input.state as typeof WAVE2B_STATES[number]) || !WAVE2B_EVENT_TYPES.includes(input.event_type as typeof WAVE2B_EVENT_TYPES[number])) {
      throw new EditorialRuntimeError("state_or_event_not_allowed", "Wave2B state or event is not allowed", 409);
    }
    if (Number(current.state_revision) === input.state_revision && current.state === input.state) {
      const event = this.sql<{ event_type: string; payload_hash: string | null }>`SELECT event_type, payload_hash
        FROM editorial_wave2b_events WHERE run_id = ${input.run_id} AND state_revision = ${input.state_revision} LIMIT 1`[0];
      if (event?.event_type === input.event_type && event.payload_hash === (input.payload_hash || null)) return { replayed: true };
      throw new EditorialRuntimeError("idempotency_conflict", "Wave2B state replay conflicts", 409);
    }
    if (Number(current.state_revision) !== input.state_revision - 1) throw new EditorialRuntimeError("stale_workflow_step", "Wave2B state CAS failed", 409);
    if (input.revision_count !== undefined && (input.revision_count < Number(current.revision_count) || input.revision_count > 1)) throw new EditorialRuntimeError("revision_count_invalid", "Wave2B revision count must be monotonic and at most one", 409);
    if ((input.state === "needs_action" || input.state === "failed") && (!input.next_action || !input.error_code)) throw new EditorialRuntimeError("exceptional_state_metadata_required", "Wave2B exceptional states require a stable error and next action", 409);
    if (input.state !== "needs_action" && input.state !== "failed" && (input.next_action || input.error_code)) throw new EditorialRuntimeError("state_metadata_invalid", "Wave2B action metadata is only valid for exceptional states", 409);
    if (input.state === "queued" && input.state !== current.state) throw new EditorialRuntimeError("state_transition_invalid", "queued is reserved for the initial run state", 409);
    if (input.state !== current.state && !WAVE2B_TRANSITIONS[String(current.state)]?.includes(input.state)) throw new EditorialRuntimeError("state_transition_invalid", "Wave2B state transition is not allowed", 409);
    const projected = deriveWave2BProjection(current, input.state, input.next_action, input.error_code);
    this.transactionSync(() => {
      const updated = this.sql<{ run_id: string }>`UPDATE editorial_wave2b_runs SET state = ${input.state}, state_revision = ${input.state_revision},
        run_status = ${projected.runStatus}, progress_percent = ${projected.progress}, resume_state = ${projected.resumeState},
        last_successful_state = ${projected.lastSuccessfulState}, last_successful_progress_percent = ${projected.lastSuccessfulProgress},
        retry_count = COALESCE(${input.retry_count ?? null}, retry_count),
        next_action = ${input.next_action || null}, error_code = ${input.error_code || null},
        revision_count = COALESCE(${input.revision_count ?? null}, revision_count), updated_at = ${input.created_at}
        WHERE run_id = ${input.run_id} AND state_revision = ${input.state_revision - 1}
        RETURNING run_id`;
      if (updated.length !== 1) throw new EditorialRuntimeError("stale_workflow_step", "Wave2B state CAS failed", 409);
      this.sql`INSERT INTO editorial_wave2b_events
        (run_id, event_type, state, state_revision, artifact_id, payload_hash, summary_json, created_at)
        VALUES (${input.run_id}, ${input.event_type}, ${input.state}, ${input.state_revision}, NULL, ${input.payload_hash || null}, ${safeJson({ next_action: input.next_action || null, error_code: input.error_code || null })}, ${input.created_at})`;
    });
    return { replayed: false };
  }

  public async resumeFiveAgentWritingAfterServiceFix(input: {
    run_id: string;
    failed_state_revision: number;
    retry_count: number;
    retry_event_revision: number;
    payload_hash: string;
    created_at: string;
  }): Promise<{ replayed: boolean; state_revision: number }> {
    this.ensureSchema();
    const current = this.wave2bRun(input.run_id);
    if (!current) throw new EditorialRuntimeError("run_not_found", "Wave2B run not found", 404);
    await this.verifyFiveAgentWritingRetryEvidence(current, input, true);
    const resumedRevision = input.failed_state_revision + 1;
    if (
      current.state === "writing" &&
      Number(current.state_revision) === resumedRevision &&
      Number(current.retry_count) === input.retry_count
    ) {
      const event = this.sql<{ event_type: string; payload_hash: string | null; created_at: string }>`SELECT event_type, payload_hash, created_at
        FROM editorial_wave2b_events WHERE run_id = ${input.run_id} AND state_revision = ${resumedRevision} LIMIT 1`[0];
      if (event?.event_type === "action_retry" && event.payload_hash === input.payload_hash && event.created_at === input.created_at) {
        return { replayed: true, state_revision: resumedRevision };
      }
      throw new EditorialRuntimeError("idempotency_conflict", "Wave2B writing retry replay conflicts", 409);
    }
    if (
      current.state !== "failed" ||
      Number(current.state_revision) !== input.failed_state_revision ||
      current.last_successful_state !== "writing" ||
      current.error_code !== "writing_adapter_non_retryable" ||
      current.next_action !== "retry_after_service_fix" ||
      Number(current.revision_count) !== 0
    ) {
      throw new EditorialRuntimeError("writing_retry_state_invalid", "Wave2B writing retry is not eligible", 409);
    }
    if (input.retry_count !== Number(current.retry_count) + 1) {
      throw new EditorialRuntimeError("retry_count_invalid", "Wave2B writing retry count is not the next value", 409);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.payload_hash)) {
      throw new EditorialRuntimeError("payload_hash_invalid", "Wave2B writing retry payload hash is invalid", 409);
    }
    const projected = deriveWave2BProjection(current, "writing");
    this.transactionSync(() => {
      const updated = this.sql<{ run_id: string }>`UPDATE editorial_wave2b_runs
        SET state = 'writing', state_revision = ${resumedRevision},
            run_status = ${projected.runStatus}, progress_percent = ${projected.progress},
            resume_state = NULL, last_successful_state = ${projected.lastSuccessfulState},
            last_successful_progress_percent = ${projected.lastSuccessfulProgress},
            retry_count = ${input.retry_count}, next_action = NULL, error_code = NULL,
            updated_at = ${input.created_at}
        WHERE run_id = ${input.run_id} AND state = 'failed' AND state_revision = ${input.failed_state_revision}
        RETURNING run_id`;
      if (updated.length !== 1) throw new EditorialRuntimeError("stale_workflow_step", "Wave2B writing retry CAS failed", 409);
      this.sql`INSERT INTO editorial_wave2b_events
        (run_id, event_type, state, state_revision, artifact_id, payload_hash, summary_json, created_at)
        VALUES (${input.run_id}, 'action_retry', 'writing', ${resumedRevision}, NULL, ${input.payload_hash},
          ${safeJson({ retry_count: input.retry_count, resumed_from: "failed" })}, ${input.created_at})`;
    });
    return { replayed: false, state_revision: resumedRevision };
  }

  private async verifyFiveAgentWritingRetryEvidence(
    current: Record<string, unknown>,
    input: {
      run_id: string;
      retry_count: number;
      retry_event_revision: number;
      payload_hash: string;
      created_at: string;
    },
    requireCurrentWriting: boolean,
  ): Promise<{ state: string; state_revision: number; retry_count: number; last_successful_state: string; last_event_type: string }> {
    if (!Number.isSafeInteger(input.retry_event_revision) || input.retry_event_revision < 1 ||
        !Number.isSafeInteger(input.retry_count) || input.retry_count < 1 ||
        !/^sha256:[a-f0-9]{64}$/.test(input.payload_hash) || !Number.isFinite(Date.parse(input.created_at))) {
      throw new EditorialRuntimeError("writing_retry_evidence_invalid", "Wave2B writing retry evidence is invalid", 409);
    }
    const db = (this.env as EditorialRuntimeEnv & { DB?: D1Database }).DB;
    if (!db) throw new EditorialRuntimeError("writing_retry_evidence_unavailable", "Wave2B writing retry evidence is unavailable", 503);
    try {
      const projection = await db.prepare(`SELECT state, state_revision, retry_count, last_successful_state, last_event_type
        FROM publication_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ? LIMIT 1`)
        .bind(input.run_id, current.user_id, current.workspace_id)
        .first<{ state: string; state_revision: number; retry_count: number; last_successful_state: string; last_event_type: string }>();
      const events = await db.prepare(`SELECT revision, event_type, state, retry_count, next_action, error_code, payload_hash, created_at
        FROM publication_run_events
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND revision BETWEEN ? AND ?
        ORDER BY revision ASC`)
        .bind(input.run_id, current.user_id, current.workspace_id, input.retry_event_revision - 1, input.retry_event_revision + 1)
        .all<{ revision: number; event_type: string; state: string; retry_count: number; next_action: string | null; error_code: string | null; payload_hash: string; created_at: string }>();
      const actions = await db.prepare(`SELECT action, expected_state_revision, payload_hash
        FROM publication_run_actions
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND expected_state_revision IN (?, ?)
        ORDER BY expected_state_revision ASC`)
        .bind(input.run_id, current.user_id, current.workspace_id, input.retry_event_revision - 1, input.retry_event_revision)
        .all<{ action: string; expected_state_revision: number; payload_hash: string }>();
      const revisionRequested = await db.prepare(`SELECT 1 AS present FROM publication_run_events
        WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND event_type = 'revision_requested' LIMIT 1`)
        .bind(input.run_id, current.user_id, current.workspace_id)
        .first<{ present: number }>();
      const [failed, retried, resumed] = events.results || [];
      const [retryAction, resumeAction] = actions.results || [];
      if (!projection || revisionRequested || Number(projection.state_revision) < input.retry_event_revision + 1 ||
          (requireCurrentWriting && (projection.state !== "writing" || Number(projection.state_revision) !== input.retry_event_revision + 1 ||
            Number(projection.retry_count) !== input.retry_count || projection.last_successful_state !== "writing" || projection.last_event_type !== "action_resume")) ||
          (events.results || []).length !== 3 || Number(failed?.revision) !== input.retry_event_revision - 1 ||
          failed?.event_type !== "failed" || failed.state !== "failed" || failed.error_code !== "writing_adapter_non_retryable" ||
          failed.next_action !== "retry_after_service_fix" || Number(failed.retry_count) !== input.retry_count - 1 ||
          Number(retried?.revision) !== input.retry_event_revision || retried.event_type !== "action_retry" || retried.state !== "retrying" ||
          Number(retried.retry_count) !== input.retry_count || retried.payload_hash !== input.payload_hash || retried.created_at !== input.created_at ||
          Number(resumed?.revision) !== input.retry_event_revision + 1 || resumed.event_type !== "action_resume" || resumed.state !== "writing" ||
          Number(resumed.retry_count) !== input.retry_count || (actions.results || []).length !== 2 ||
          retryAction?.action !== "retry" || Number(retryAction.expected_state_revision) !== input.retry_event_revision - 1 || retryAction.payload_hash !== input.payload_hash ||
          resumeAction?.action !== "resume" || Number(resumeAction.expected_state_revision) !== input.retry_event_revision) {
        throw new EditorialRuntimeError("writing_retry_evidence_invalid", "Wave2B writing retry evidence chain does not reconcile", 409);
      }
      return projection;
    } catch (error) {
      if (error instanceof EditorialRuntimeError) throw error;
      throw new EditorialRuntimeError("writing_retry_evidence_unavailable", "Wave2B writing retry evidence is unavailable", 503);
    }
  }

  public async startFiveAgentWritingRecovery(input: {
    run_id: string;
    user_id: string;
    workspace_id: string;
    workflow_id: string;
    retry_event_revision: number;
    retry_count: number;
    payload_hash: string;
    retry_created_at: string;
  }): Promise<{ requested: boolean; replayed: boolean; workflow_status: string; attempt: number | null; recovery_workflow_id: string | null }> {
    this.ensureSchema();
    const scoped = this.wave2bRun(input.run_id);
    if (!scoped || scoped.user_id !== input.user_id || scoped.workspace_id !== input.workspace_id || scoped.workflow_id !== input.workflow_id) {
      throw new EditorialRuntimeError("run_not_found", "Wave2B writing restart run is not in the requested scope", 404);
    }
    const briefRows = this.sql<{ envelope_json: string; payload_hash: string; storage_ref: string }>`SELECT envelope_json, payload_hash, storage_ref
      FROM editorial_wave2b_outbox WHERE run_id = ${input.run_id} ORDER BY created_at, artifact_id`;
    const briefs = briefRows.flatMap(row => {
      try {
        const envelope = parseJson<FiveAgentEnvelopeMetadata>(row.envelope_json);
        return envelope.kind === "article_brief" ? [{ row, envelope }] : [];
      } catch {
        return [];
      }
    });
    if (briefs.length !== 1) {
      throw new EditorialRuntimeError("writing_recovery_brief_invalid", "Wave2B writing recovery requires one canonical brief", 409);
    }
    const { row: briefRow, envelope: briefEnvelope } = briefs[0];
    if (briefRow.payload_hash !== briefEnvelope.payload_hash || briefRow.storage_ref !== `r2://${briefEnvelope.artifact_key}` ||
        briefEnvelope.run_id !== input.run_id || briefEnvelope.user_id !== input.user_id || briefEnvelope.workspace_id !== input.workspace_id ||
        briefEnvelope.article_id !== scoped.article_id || Number(briefEnvelope.recording_id) !== Number(scoped.recording_id)) {
      throw new EditorialRuntimeError("writing_recovery_brief_invalid", "Wave2B writing recovery brief does not reconcile", 409);
    }
    let storedBrief: R2ObjectBody | null;
    try { storedBrief = await this.env.FILES_BUCKET.get(briefEnvelope.artifact_key); } catch {
      throw new EditorialRuntimeError("writing_recovery_brief_unavailable", "Wave2B writing recovery brief read is unavailable", 503);
    }
    if (!storedBrief) throw new EditorialRuntimeError("writing_recovery_brief_unavailable", "Wave2B writing recovery brief is unavailable", 503);
    let briefObject: Record<string, unknown>;
    try { briefObject = parseJson<Record<string, unknown>>(await storedBrief.text()); } catch {
      throw new EditorialRuntimeError("writing_recovery_brief_invalid", "Wave2B writing recovery brief bytes are invalid", 409);
    }
    const storedEnvelope = briefObject.envelope as Record<string, unknown> | undefined;
    const briefPayload = briefObject.payload as Record<string, unknown> | undefined;
    if (!storedEnvelope || !briefPayload || storedEnvelope.artifact_id !== briefEnvelope.artifact_id ||
        storedEnvelope.run_id !== input.run_id || storedEnvelope.user_id !== input.user_id || storedEnvelope.workspace_id !== input.workspace_id ||
        await hashJson(briefPayload) !== briefEnvelope.payload_hash || briefPayload.run_id !== input.run_id ||
        briefPayload.article_id !== scoped.article_id || Number(briefPayload.recording_id) !== Number(scoped.recording_id)) {
      throw new EditorialRuntimeError("writing_recovery_brief_invalid", "Wave2B writing recovery brief identity is invalid", 409);
    }
    const transcriptRef = String(briefPayload.transcript_ref || "");
    const transcriptHash = String(briefPayload.transcript_hash || "");
    const sourceHash = String(briefPayload.source_hash || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(transcriptRef) ||
        !/^sha256:[a-f0-9]{64}$/.test(transcriptHash) || !/^sha256:[a-f0-9]{64}$/.test(sourceHash)) {
      throw new EditorialRuntimeError("writing_recovery_input_invalid", "Wave2B writing recovery transcript identity is invalid", 409);
    }
    const params: FiveAgentRunInput & {
      transcript_ref: string; transcript_hash: string; source_hash: string;
      brief_artifact_id: string; brief_artifact_key: string; brief_payload_hash: string;
    } = {
      run_id: input.run_id,
      article_id: String(scoped.article_id),
      recording_id: Number(scoped.recording_id),
      user_id: input.user_id,
      workspace_id: input.workspace_id,
      payload_hash: String(scoped.payload_hash),
      manifest_hash: String(scoped.manifest_hash),
      manifest_json: String(scoped.manifest_json),
      workflow_id: input.workflow_id,
      created_at: String(scoped.created_at),
      transcript_ref: transcriptRef,
      transcript_hash: transcriptHash,
      source_hash: sourceHash,
      brief_artifact_id: briefEnvelope.artifact_id,
      brief_artifact_key: briefEnvelope.artifact_key,
      brief_payload_hash: briefEnvelope.payload_hash,
    };
    await validateFiveAgentManifest(params);
    const durableContext = (this as any).ctx as DurableObjectState;
    return durableContext.blockConcurrencyWhile(async () => {
      const current = this.wave2bRun(params.run_id);
      if (!current || current.user_id !== params.user_id || current.workspace_id !== params.workspace_id || current.workflow_id !== params.workflow_id) {
        throw new EditorialRuntimeError("run_not_found", "Wave2B writing restart run is not in the requested scope", 404);
      }
      const restartId = `${params.run_id}:writing-restart:${input.retry_event_revision}`;
      const receipt = this.sql<{ workflow_id: string; retry_count: number; payload_hash: string }>`SELECT workflow_id, retry_count, payload_hash
        FROM editorial_wave2b_writing_restart_receipts WHERE restart_id = ${restartId} LIMIT 1`[0];
      if (receipt) {
        if (receipt.workflow_id !== params.workflow_id || Number(receipt.retry_count) !== input.retry_count || receipt.payload_hash !== input.payload_hash) {
          throw new EditorialRuntimeError("writing_restart_receipt_conflict", "Wave2B writing restart receipt conflicts", 409);
        }
        return { requested: true, replayed: true, workflow_status: "receipt", attempt: null, recovery_workflow_id: null };
      }
      const recordReceipt = (recordedAt: string): void => {
        this.transactionSync(() => {
          const existing = this.sql<{ workflow_id: string; retry_count: number; payload_hash: string }>`SELECT workflow_id, retry_count, payload_hash
            FROM editorial_wave2b_writing_restart_receipts WHERE restart_id = ${restartId} LIMIT 1`[0];
          if (existing) {
            if (existing.workflow_id !== params.workflow_id || Number(existing.retry_count) !== input.retry_count || existing.payload_hash !== input.payload_hash) {
              throw new EditorialRuntimeError("writing_restart_receipt_conflict", "Wave2B writing restart receipt conflicts", 409);
            }
            return;
          }
          this.sql`INSERT INTO editorial_wave2b_writing_restart_receipts
            (restart_id, run_id, workflow_id, retry_event_revision, retry_count, payload_hash, recorded_at)
            VALUES (${restartId}, ${params.run_id}, ${params.workflow_id}, ${input.retry_event_revision}, ${input.retry_count}, ${input.payload_hash}, ${recordedAt})`;
        });
      };
      const evidenceInput = {
        run_id: params.run_id,
        retry_count: input.retry_count,
        retry_event_revision: input.retry_event_revision,
        payload_hash: input.payload_hash,
        created_at: input.retry_created_at,
      };
      let projection = await this.verifyFiveAgentWritingRetryEvidence(current, evidenceInput, false);
      const isPending = () => projection.state === "writing" && Number(projection.state_revision) === input.retry_event_revision + 1;
      if (!isPending()) {
        recordReceipt(now());
        return { requested: true, replayed: true, workflow_status: projection.state, attempt: null, recovery_workflow_id: null };
      }
      const activeStatuses = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
      const previous = this.sql<{ attempt: number; workflow_id: string; recovery_workflow_id: string; retry_count: number; payload_hash: string }>`
        SELECT attempt, workflow_id, recovery_workflow_id, retry_count, payload_hash FROM editorial_wave2b_writing_restart_attempts
        WHERE restart_id = ${restartId} ORDER BY attempt DESC LIMIT 1`[0];
      if (previous && (previous.workflow_id !== params.workflow_id || Number(previous.retry_count) !== input.retry_count || previous.payload_hash !== input.payload_hash)) {
        throw new EditorialRuntimeError("writing_restart_attempt_conflict", "Wave2B writing restart attempt conflicts", 409);
      }
      let attempt = Number(previous?.attempt || 0);
      let recoveryWorkflowId = previous?.recovery_workflow_id || "";
      if (previous) {
        const known = await this.reconcileFiveAgentWorkflow(recoveryWorkflowId);
        if (known.state === "unknown") {
          return { requested: false, replayed: true, workflow_status: "unknown", attempt, recovery_workflow_id: recoveryWorkflowId };
        }
        if (known.state === "exists" && activeStatuses.has(known.status)) {
          return { requested: true, replayed: true, workflow_status: known.status, attempt, recovery_workflow_id: recoveryWorkflowId };
        }
        if (known.state === "exists" && known.status === "complete") {
          projection = await this.verifyFiveAgentWritingRetryEvidence(current, evidenceInput, false);
          if (!isPending()) {
            recordReceipt(now());
            return { requested: true, replayed: true, workflow_status: projection.state, attempt, recovery_workflow_id: recoveryWorkflowId };
          }
          return { requested: false, replayed: true, workflow_status: "complete_pending", attempt, recovery_workflow_id: recoveryWorkflowId };
        }
        if (known.state === "exists" && !["errored", "terminated"].includes(known.status)) {
          return { requested: false, replayed: true, workflow_status: known.status, attempt, recovery_workflow_id: recoveryWorkflowId };
        }
        if (known.state === "exists") recoveryWorkflowId = "";
      }
      if (!recoveryWorkflowId) {
        attempt += 1;
        recoveryWorkflowId = `five-agent-writing-recovery-${(await hashJson({
          run_id: params.run_id,
          retry_event_revision: input.retry_event_revision,
          retry_payload_hash: input.payload_hash,
          attempt,
        })).slice("sha256:".length)}`;
        const requestedAt = now();
        this.sql`INSERT INTO editorial_wave2b_writing_restart_attempts
          (attempt_id, restart_id, run_id, workflow_id, recovery_workflow_id, retry_event_revision, retry_count, payload_hash, attempt, requested_at)
          VALUES (${`${restartId}:attempt:${attempt}`}, ${restartId}, ${params.run_id}, ${params.workflow_id}, ${recoveryWorkflowId},
            ${input.retry_event_revision}, ${input.retry_count}, ${input.payload_hash}, ${attempt}, ${requestedAt})`;
      }
      try {
        await this.runWorkflow("FIVE_AGENT_PUBLISHING_WORKFLOW", params, {
          id: recoveryWorkflowId,
          agentBinding: "EDITORIAL_COORDINATOR",
          metadata: {
            run_id: params.run_id,
            article_id: params.article_id,
            recording_id: params.recording_id,
            user_id: params.user_id,
            workspace_id: params.workspace_id,
            manifest_hash: params.manifest_hash,
            recovery_attempt: attempt,
          },
        });
      } catch (error) {
        const afterCreate = await this.reconcileFiveAgentWorkflow(recoveryWorkflowId);
        if (afterCreate.state === "exists") {
          return { requested: true, replayed: true, workflow_status: afterCreate.status, attempt, recovery_workflow_id: recoveryWorkflowId };
        }
        console.error("Failed to create writing recovery workflow:", error);
        return {
          requested: false,
          replayed: false,
          workflow_status: afterCreate.state === "not_found" ? "not_found" : "unknown",
          attempt,
          recovery_workflow_id: recoveryWorkflowId,
        };
      }
      return { requested: true, replayed: false, workflow_status: "queued", attempt, recovery_workflow_id: recoveryWorkflowId };
    });
  }

  public async getFiveAgentWritingRestartReceipt(input: {
    run_id: string;
    user_id: string;
    workspace_id: string;
    workflow_id: string;
    retry_event_revision: number;
    retry_count: number;
    payload_hash: string;
  }): Promise<{ requested: boolean; recorded_at: string | null }> {
    this.ensureSchema();
    const current = this.wave2bRun(input.run_id);
    if (!current || current.user_id !== input.user_id || current.workspace_id !== input.workspace_id || current.workflow_id !== input.workflow_id) {
      throw new EditorialRuntimeError("run_not_found", "Wave2B writing restart run is not in the requested scope", 404);
    }
    const restartId = `${input.run_id}:writing-restart:${input.retry_event_revision}`;
    const receipt = this.sql<{ workflow_id: string; retry_count: number; payload_hash: string; recorded_at: string }>`SELECT workflow_id, retry_count, payload_hash, recorded_at
      FROM editorial_wave2b_writing_restart_receipts WHERE restart_id = ${restartId} LIMIT 1`[0];
    if (!receipt) return { requested: false, recorded_at: null };
    if (receipt.workflow_id !== input.workflow_id || Number(receipt.retry_count) !== input.retry_count || receipt.payload_hash !== input.payload_hash) {
      throw new EditorialRuntimeError("writing_restart_receipt_conflict", "Wave2B writing restart receipt conflicts", 409);
    }
    return { requested: true, recorded_at: receipt.recorded_at };
  }

  public async recordFiveAgentWritingRestartReceipt(input: {
    run_id: string;
    user_id: string;
    workspace_id: string;
    workflow_id: string;
    retry_event_revision: number;
    retry_count: number;
    payload_hash: string;
    retry_created_at: string;
    recorded_at: string;
  }): Promise<{ replayed: boolean }> {
    this.ensureSchema();
    const current = this.wave2bRun(input.run_id);
    if (!current || current.user_id !== input.user_id || current.workspace_id !== input.workspace_id || current.workflow_id !== input.workflow_id) {
      throw new EditorialRuntimeError("run_not_found", "Wave2B writing restart run is not in the requested scope", 404);
    }
    const recordedAtMs = Date.parse(input.recorded_at);
    if (!Number.isFinite(recordedAtMs) || new Date(recordedAtMs).toISOString() !== input.recorded_at) {
      throw new EditorialRuntimeError("writing_restart_receipt_invalid", "Wave2B writing restart receipt time is invalid", 409);
    }
    const projection = await this.verifyFiveAgentWritingRetryEvidence(current, {
      run_id: input.run_id,
      retry_count: input.retry_count,
      retry_event_revision: input.retry_event_revision,
      payload_hash: input.payload_hash,
      created_at: input.retry_created_at,
    }, false);
    const projectionAdvanced = projection.state !== "writing" || Number(projection.state_revision) !== input.retry_event_revision + 1;
    if (!projectionAdvanced) {
      throw new EditorialRuntimeError("writing_restart_receipt_requires_progress", "Wave2B writing restart receipt requires publication progress", 409);
    }
    const restartId = `${input.run_id}:writing-restart:${input.retry_event_revision}`;
    return this.transactionSync(() => {
      const existing = this.sql<{ workflow_id: string; retry_count: number; payload_hash: string }>`SELECT workflow_id, retry_count, payload_hash
        FROM editorial_wave2b_writing_restart_receipts WHERE restart_id = ${restartId} LIMIT 1`[0];
      if (existing) {
        if (existing.workflow_id !== input.workflow_id || Number(existing.retry_count) !== input.retry_count || existing.payload_hash !== input.payload_hash) {
          throw new EditorialRuntimeError("writing_restart_receipt_conflict", "Wave2B writing restart receipt conflicts", 409);
        }
        return { replayed: true };
      }
      this.sql`INSERT INTO editorial_wave2b_writing_restart_receipts
        (restart_id, run_id, workflow_id, retry_event_revision, retry_count, payload_hash, recorded_at)
        VALUES (${restartId}, ${input.run_id}, ${input.workflow_id}, ${input.retry_event_revision}, ${input.retry_count}, ${input.payload_hash}, ${input.recorded_at})`;
      return { replayed: false };
    });
  }

  public async startRun(input: EditorialWorkflowParams): Promise<Record<string, unknown>> {
    this.ensureSchema();
    const runId = validateOpaque(input.run_id, "run_id");
    const articleId = validateOpaque(input.article_id, "article_id");
    const userId = validateOpaque(input.user_id, "user_id");
    const workspaceId = validateOpaque(input.workspace_id, "workspace_id");
    const scenario = validateScenario(input.scenario);
    const payload = { run_id: runId, article_id: articleId, recording_id: input.recording_id, user_id: userId, workspace_id: workspaceId, scenario };
    const payloadHash = await hashJson(payload);
    if (input.payload_hash !== payloadHash) {
      throw new EditorialRuntimeError("payload_hash_mismatch", "run payload hash does not match trusted input", 409);
    }
    const manifest = {
      schema_version: EDITORIAL_SCHEMA_VERSION,
      run_id: runId,
      article_id: articleId,
      recording_id: input.recording_id,
      user_id: userId,
      workspace_id: workspaceId,
      workflow_version: EDITORIAL_WORKFLOW_VERSION,
      policy_version: EDITORIAL_POLICY_VERSION,
      agent_versions: EDITORIAL_AGENT_VERSIONS,
      skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
      idempotency_key: `run:${runId}`,
    };
    const manifestJson = safeJson(manifest);
    const existing = this.runRow(runId);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new EditorialRuntimeError("idempotency_conflict", "run key already has another payload", 409);
      if (existing.workflow_id) return await this.publicRun(existing, true);
    }

    if (!existing) {
      const timestamp = now();
      this.transactionSync(() => {
        this.sql`INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
          VALUES (${runId}, ${articleId}, ${input.recording_id}, ${userId}, ${workspaceId}, ${scenario}, ${payloadHash}, ${manifestJson},
            NULL, 'queued', 0, 'not_required', 0, ${timestamp}, ${timestamp})`;
        this.sql`INSERT INTO editorial_phase2_events
          (run_id, event_type, idempotency_key, payload_hash, summary_json, created_at)
          VALUES (${runId}, 'run_queued', ${`run:${runId}:queued`}, ${payloadHash}, ${safeJson({ scenario, workflow_version: EDITORIAL_WORKFLOW_VERSION })}, ${timestamp})`;
      });
    }
    const workflowId = await this.runWorkflow("EDITORIAL_WORKFLOW", input, {
      id: `editorial-${payloadHash.slice(7, 39)}`,
      agentBinding: "EDITORIAL_COORDINATOR",
      metadata: { run_id: runId, article_id: articleId, user_id: userId, workspace_id: workspaceId },
    });
    this.transactionSync(() => {
      this.sql`UPDATE editorial_phase2_runs SET workflow_id = ${workflowId}, updated_at = ${now()}
        WHERE run_id = ${runId} AND workflow_id IS NULL`;
    });
    return await this.publicRun(this.runRow(runId)!, Boolean(existing));
  }

  public async getRun(runId: string): Promise<Record<string, unknown>> {
    this.ensureSchema();
    const row = this.runRow(validateOpaque(runId, "run_id"));
    if (!row) throw new EditorialRuntimeError("run_not_found", "editorial run not found", 404);
    return await this.publicRun(row, false);
  }

  private finalizeWorkflowStep(input: WorkflowStepInput, result: WorkflowStepResult): WorkflowStepResult {
    const current = this.runRow(input.run_id);
    if (!current) throw new EditorialRuntimeError("run_not_found", "editorial run not found", 404);
    if (current.state === result.state && current.state_revision >= result.state_revision) {
      return { ...result, replayed: true };
    }
    if (current.state !== input.expected_state || current.state_revision !== result.state_revision - 1) {
      throw new EditorialRuntimeError("stale_workflow_step", "workflow state CAS failed", 409);
    }
    const timestamp = now();
    this.transactionSync(() => {
      const updated = this.sql<{ run_id: string }>`UPDATE editorial_phase2_runs
        SET state = ${result.state}, state_revision = state_revision + 1,
            approval_state = ${result.approval_state || current.approval_state},
            revision_count = ${result.revision_count ?? current.revision_count}, updated_at = ${timestamp}
        WHERE run_id = ${input.run_id} AND state = ${input.expected_state} AND state_revision = ${current.state_revision}
        RETURNING run_id`;
      if (updated.length !== 1) throw new EditorialRuntimeError("stale_workflow_step", "workflow state CAS failed", 409);
      this.sql`INSERT INTO editorial_phase2_events
        (run_id, event_type, idempotency_key, payload_hash, summary_json, created_at)
        VALUES (${input.run_id}, 'workflow_step', ${`step:${input.step_key}`}, ${result.payload_hash || "sha256:editorial-step"},
          ${safeJson({ step_name: input.step_name, next_state: result.state, artifact_count: result.artifact_ids.length })}, ${timestamp})`;
    });
    return result;
  }

  public async commitWorkflowStep(input: WorkflowStepInput): Promise<WorkflowStepResult> {
    this.ensureSchema();
    const runId = validateOpaque(input.run_id, "run_id");
    const payloadHash = await hashJson(input);
    const existingStep = this.sql<StepRow>`SELECT step_name, step_key, payload_hash, result_json
      FROM editorial_phase2_steps WHERE run_id = ${runId} AND step_key = ${input.step_key} LIMIT 1`[0];
    if (existingStep) {
      if (existingStep.payload_hash !== payloadHash) throw new EditorialRuntimeError("idempotency_conflict", "workflow step key has another payload", 409);
      const preparedResult = parseJson<WorkflowStepResult>(existingStep.result_json);
      await this.flushOutbox(runId);
      if (preparedResult.terminal_status) await this.flushTerminalIntent(runId);
      const finalized = this.finalizeWorkflowStep(input, preparedResult);
      this.setState({
        schema_version: EDITORIAL_SCHEMA_VERSION,
        run_id: runId,
        state: finalized.state,
        state_revision: finalized.state_revision,
        approval_state: finalized.approval_state || this.runRow(runId)?.approval_state || "not_required",
        revision_count: finalized.revision_count ?? (this.runRow(runId)?.revision_count || 0),
        workflow_id: this.runRow(runId)?.workflow_id || undefined,
        artifact_count: this.artifactCount(runId),
      });
      return finalized;
    }
    const row = this.runRow(runId);
    if (!row) throw new EditorialRuntimeError("run_not_found", "editorial run not found", 404);
    if (row.state !== input.expected_state) throw new EditorialRuntimeError("stale_workflow_step", "workflow step expected a different state", 409);
    if (!isAllowedPhase2State(input.next_state)) throw new EditorialRuntimeError("state_not_allowed", "workflow selected an unknown state", 409);
    if (!canAdvancePhase2(row.state, input.next_state)) throw new EditorialRuntimeError("invalid_state_transition", "workflow cannot skip editorial states", 409);
    if (input.terminal_status && ((input.terminal_status === "completed" && input.next_state !== "approved_for_phase3") || (input.terminal_status === "failed" && input.next_state !== "failed"))) {
      throw new EditorialRuntimeError("terminal_state_mismatch", "terminal status does not match workflow state", 409);
    }
    if (input.terminal_status) {
      const existingTerminal = this.sql<{ step_key: string; payload_hash: string }>`
        SELECT step_key, payload_hash FROM editorial_phase2_terminal_intents WHERE run_id = ${runId} LIMIT 1
      `[0];
      if (existingTerminal && (existingTerminal.step_key !== input.step_key || existingTerminal.payload_hash !== payloadHash)) {
        throw new EditorialRuntimeError("terminal_conflict", "run already has a different terminal intent", 409);
      }
    }
    if (row.state === "content_frozen" && input.next_state !== "content_frozen" && input.next_state !== "awaiting_human_confirmation") {
      throw new EditorialRuntimeError("frozen_content_immutable", "frozen content cannot return to a draft state", 409);
    }
    const preparedArtifacts = await Promise.all(input.artifacts.map(async artifact => ({
      artifact,
      artifactId: `${runId}:${artifact.kind}:${artifact.idempotency_key}`,
      payloadHash: await hashJson({ kind: artifact.kind, summary: artifact.summary, input_artifact_ids: artifact.input_artifact_ids || [] }),
    })));
    const plannedArtifactIds = new Set(preparedArtifacts.map(item => item.artifactId));
    for (const artifact of input.artifacts) {
      validateArtifactKind(artifact.kind);
      validateAgent(artifact.producer_role, artifact.producer_version);
      for (const inputId of artifact.input_artifact_ids || []) {
        const found = this.sql<{ artifact_id: string }>`SELECT artifact_id FROM editorial_phase2_artifacts
          WHERE artifact_id = ${inputId} AND run_id = ${runId} LIMIT 1`[0];
        if (!found && !plannedArtifactIds.has(inputId)) throw new EditorialRuntimeError("artifact_parent_missing", "workflow artifact parent is missing", 409);
      }
    }
    for (const prepared of preparedArtifacts) {
      const existingArtifact = this.sql<ArtifactRow>`SELECT artifact_id, run_id, kind, idempotency_key, payload_hash,
        producer_role, producer_version, input_artifact_ids_json, summary_json, created_at
        FROM editorial_phase2_artifacts WHERE run_id = ${runId} AND idempotency_key = ${prepared.artifact.idempotency_key} LIMIT 1`[0];
      if (existingArtifact && existingArtifact.payload_hash !== prepared.payloadHash) {
        throw new EditorialRuntimeError("idempotency_conflict", "artifact key has another payload", 409);
      }
    }
    const timestamp = now();
    const artifactIds: string[] = [];
    let result: WorkflowStepResult;
    try {
      result = this.transactionSync(() => {
      for (const artifact of input.artifacts) {
        const prepared = preparedArtifacts.find(item => item.artifact === artifact)!;
        const artifactId = prepared.artifactId;
        const existingArtifact = this.sql<{ artifact_id: string }>`SELECT artifact_id FROM editorial_phase2_artifacts
          WHERE run_id = ${runId} AND idempotency_key = ${artifact.idempotency_key} LIMIT 1`[0];
        if (!existingArtifact) {
          const summaryJson = safeJson(redactArtifactSummary(artifact.summary));
          this.sql`INSERT INTO editorial_phase2_artifacts
            (artifact_id, run_id, kind, idempotency_key, payload_hash, producer_role, producer_version,
             input_artifact_ids_json, summary_json, created_at)
            VALUES (${artifactId}, ${runId}, ${artifact.kind}, ${artifact.idempotency_key}, ${prepared.payloadHash},
              ${artifact.producer_role}, ${artifact.producer_version}, ${safeJson(artifact.input_artifact_ids || [])},
              ${summaryJson}, ${timestamp})`;
          this.sql`INSERT INTO editorial_phase2_outbox
            (outbox_id, run_id, artifact_id, user_id, workspace_id, article_id, recording_id, kind,
             payload_hash, producer_role, producer_version, input_artifact_ids_json, summary_json, storage_ref, created_at)
            VALUES (${`${runId}:outbox:${artifactId}`}, ${runId}, ${artifactId}, ${row.user_id}, ${row.workspace_id},
              ${row.article_id}, ${row.recording_id}, ${artifact.kind}, ${prepared.payloadHash}, ${artifact.producer_role},
              ${artifact.producer_version}, ${safeJson(artifact.input_artifact_ids || [])}, ${summaryJson},
              ${`do://editorial-phase2/${runId}/${artifactId}`}, ${timestamp})`;
        }
        artifactIds.push(artifactId);
      }
      const stepResult: WorkflowStepResult = {
        state: input.next_state,
        state_revision: row.state_revision + 1,
        artifact_ids: artifactIds,
        replayed: false,
        approval_state: input.approval_state || row.approval_state,
        revision_count: input.revision_count ?? row.revision_count,
        payload_hash: payloadHash,
        terminal_status: input.terminal_status,
      };
      this.sql`INSERT INTO editorial_phase2_steps
        (run_id, step_name, step_key, payload_hash, result_json, created_at)
        VALUES (${runId}, ${input.step_name}, ${input.step_key}, ${payloadHash}, ${safeJson(stepResult)}, ${timestamp})`;
      if (input.terminal_status) {
        this.sql`INSERT INTO editorial_phase2_terminal_intents
          (intent_id, run_id, step_key, terminal_status, idempotency_key, payload_hash, created_at)
          VALUES (${`${runId}:terminal:${input.step_key}`}, ${runId}, ${input.step_key}, ${input.terminal_status},
            ${input.step_key}, ${payloadHash}, ${timestamp})`;
      }
        return stepResult;
      });
    } catch (error) {
      if (input.terminal_status && /unique|constraint/i.test(String(error))) {
        throw new EditorialRuntimeError("terminal_conflict", "concurrent terminal intent won the CAS", 409);
      }
      throw error;
    }
    await this.flushOutbox(runId);
    if (input.terminal_status) await this.flushTerminalIntent(runId);
    const finalized = this.finalizeWorkflowStep({ ...input, run_id: runId }, result);
    this.setState({
      schema_version: EDITORIAL_SCHEMA_VERSION,
      run_id: runId,
      state: finalized.state,
      state_revision: finalized.state_revision,
      approval_state: finalized.approval_state || row.approval_state,
      revision_count: finalized.revision_count ?? row.revision_count,
      workflow_id: this.runRow(runId)?.workflow_id || undefined,
      artifact_count: this.artifactCount(runId),
    });
    return finalized;
  }

  public async recordHumanAction(input: HumanActionInput): Promise<Record<string, unknown>> {
    this.ensureSchema();
    const runId = validateOpaque(input.run_id, "run_id");
    const existing = this.sql<HumanActionRow>`SELECT action, idempotency_key, payload_hash, result_json
      FROM editorial_phase2_human_actions WHERE run_id = ${runId} AND idempotency_key = ${input.idempotency_key} LIMIT 1`[0];
    if (existing) {
      if (existing.payload_hash !== input.payload_hash || existing.action !== input.action) {
        throw new EditorialRuntimeError("idempotency_conflict", "human action key has another payload", 409);
      }
      const replay = parseJson<Record<string, unknown>>(existing.result_json);
      if (input.action === "approve" && input.workflow_id) await this.approveWorkflow(input.workflow_id, { reason: "replayed", metadata: { approved: true } });
      if ((input.action === "reject" || input.action === "timeout") && input.workflow_id) {
        await this.rejectWorkflow(input.workflow_id, { reason: input.action });
      }
      return { ...replay, replayed: true };
    }
    const row = this.runRow(runId);
    if (!row) throw new EditorialRuntimeError("run_not_found", "editorial run not found", 404);
    if (row.state !== "awaiting_human_confirmation") {
      if (input.action !== "wait" && (row.approval_state === "approved" || row.approval_state === "rejected" || row.approval_state === "timed_out")) {
        return { run_id: runId, action: input.action, ignored: true, replayed: true };
      }
      throw new EditorialRuntimeError("human_action_not_ready", "run is not waiting for human confirmation", 409);
    }
    if (row.approval_state !== "awaiting") {
      if (input.action !== "wait") return { run_id: runId, action: input.action, ignored: true, replayed: true };
      throw new EditorialRuntimeError("human_action_not_ready", "run is not waiting for human confirmation", 409);
    }
    const nextApproval = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : input.action === "timeout" ? "timed_out" : "awaiting";
    // Every user decision is recorded while the run remains in the durable
    // confirmation state. The Workflow owns the terminal state transition and
    // its D1 mirror, so a lost signal can be retried without a second action.
    const nextState = "awaiting_human_confirmation";
    const result = { run_id: runId, action: input.action, approval_state: nextApproval, state: nextState, reason: input.reason ? "provided" : null };
    const timestamp = now();
    this.transactionSync(() => {
      this.sql`INSERT INTO editorial_phase2_human_actions
        (action_id, run_id, action, idempotency_key, payload_hash, result_json, created_at)
        VALUES (${`${runId}:human:${input.idempotency_key}`}, ${runId}, ${input.action}, ${input.idempotency_key}, ${input.payload_hash}, ${safeJson(result)}, ${timestamp})`;
      const updated = this.sql<{ run_id: string }>`UPDATE editorial_phase2_runs SET state = ${nextState}, approval_state = ${nextApproval},
        state_revision = state_revision + 1, updated_at = ${timestamp}
        WHERE run_id = ${runId} AND state = 'awaiting_human_confirmation'
          AND state_revision = ${row.state_revision} RETURNING run_id`;
      if (updated.length !== 1) throw new EditorialRuntimeError("stale_human_action", "human action state CAS failed", 409);
      this.sql`INSERT INTO editorial_phase2_events
        (run_id, event_type, idempotency_key, payload_hash, summary_json, created_at)
        VALUES (${runId}, 'human_action', ${`human:${input.idempotency_key}`}, ${input.payload_hash},
          ${safeJson({ action: input.action, approval_state: nextApproval })}, ${timestamp})`;
    });
    if (input.action === "approve") await this.approveWorkflow(input.workflow_id, { reason: "approved", metadata: { approved: true } });
    if (input.action === "reject" || input.action === "timeout") await this.rejectWorkflow(input.workflow_id, { reason: input.action });
    this.setState({ ...this.state, run_id: runId, state: nextState, state_revision: row.state_revision + 1, approval_state: nextApproval, artifact_count: this.artifactCount(runId) });
    return { ...result, replayed: false };
  }

  public async onWorkflowComplete(_workflowName: string, workflowId: string, _result?: unknown): Promise<void> {
    const row = this.sql<{ run_id: string; state: string }>`SELECT run_id, state FROM editorial_phase2_runs WHERE workflow_id = ${workflowId} LIMIT 1`[0];
    if (row) this.setState({ ...this.state, run_id: row.run_id, state: row.state, artifact_count: this.artifactCount(row.run_id) });
  }

  public async onWorkflowError(_workflowName: string, workflowId: string, _error: string): Promise<void> {
    const row = this.runRow(this.sql<{ run_id: string }>`SELECT run_id FROM editorial_phase2_runs WHERE workflow_id = ${workflowId} LIMIT 1`[0]?.run_id || "");
    if (!row || row.state === "approved_for_phase3" || row.state === "failed") return;
    await this.commitWorkflowStep({
      run_id: row.run_id,
      step_name: "workflow-error",
      step_key: `${row.run_id}:workflow-error`,
      expected_state: row.state,
      next_state: "failed",
      approval_state: "human_action_required",
      terminal_status: "failed",
      artifacts: [],
    });
  }

  private runRow(runId: string): RunRow | null {
    return this.sql<RunRow>`SELECT run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash,
      workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at, manifest_json
      FROM editorial_phase2_runs WHERE run_id = ${runId} LIMIT 1`[0] || null;
  }

  private artifactCount(runId: string): number {
    return Number(this.sql<{ count: number }>`SELECT count(*) AS count FROM editorial_phase2_artifacts WHERE run_id = ${runId}`[0]?.count || 0);
  }

  private async publicRun(row: RunRow, replayed: boolean): Promise<Record<string, unknown>> {
    return {
      run_id: row.run_id,
      article_id: row.article_id,
      recording_id: row.recording_id,
      state: row.state,
      state_revision: row.state_revision,
      approval_state: row.approval_state,
      revision_count: row.revision_count,
      workflow_id: row.workflow_id,
      workflow_version: EDITORIAL_WORKFLOW_VERSION,
      policy_version: EDITORIAL_POLICY_VERSION,
      artifact_count: this.artifactCount(row.run_id),
      d1_mirrored_artifact_count: await this.d1MirroredArtifactCount(row.run_id),
      do_receipt_count: this.doReceiptCount(row.run_id),
      outbox_pending_count: this.outboxPendingCount(row.run_id),
      pins: parseJson<Record<string, unknown>>(row.manifest_json),
      replayed,
    };
  }
}

function isAllowedPhase2State(value: string): boolean {
  return ["queued", "draft_generated", "review_pending", "reviewed", "revision_pending", "content_frozen", "awaiting_human_confirmation", "approved_for_phase3", "failed"].includes(value);
}

function redactArtifactSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["block_ids", "decision", "finding_codes", "changed_block_ids", "visual_ids", "source", "version_no", "parent_artifact_ids", "warning_codes"];
  return Object.fromEntries(Object.entries(summary).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, 64) : typeof value === "string" ? value.slice(0, 160) : value]));
}

export class EditorialWorkflow extends AgentWorkflow<EditorialCoordinatorAgent, EditorialWorkflowParams, { step: string; status: "pending" | "running" | "complete" | "error"; percent?: number }, EditorialRuntimeEnv> {
  async run(event: AgentWorkflowEvent<EditorialWorkflowParams>, step: AgentWorkflowStep): Promise<Record<string, unknown>> {
    const params = event.payload;
    const coordinator = this.agent;
    const retry = { retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const };
    const commit = (input: Omit<WorkflowStepInput, "run_id">) => coordinator.commitWorkflowStep({ ...input, run_id: params.run_id });
    const draft = await step.do("draft-v1", retry, () => commit({
      step_name: "draft-v1",
      step_key: `${params.run_id}:draft-v1`,
      expected_state: "queued",
      next_state: "draft_generated",
      artifacts: [
        { kind: "article_brief", idempotency_key: `${params.run_id}:brief:v1`, producer_role: "editorial_coordinator", producer_version: EDITORIAL_AGENT_VERSIONS.editorial_coordinator, summary: { source: "synthetic", block_ids: ["block_1", "block_2"] } },
        { kind: "article_draft", idempotency_key: `${params.run_id}:draft:v1`, producer_role: "writing", producer_version: EDITORIAL_AGENT_VERSIONS.writing, input_artifact_ids: [`${params.run_id}:article_brief:${params.run_id}:brief:v1`], summary: { source: "synthetic", version_no: 1, block_ids: ["block_1", "block_2"] } },
      ],
    }));
    await this.reportProgress({ step: "draft-v1", status: "complete", percent: 0.2 });
    const reviewDecision = params.scenario === "p0" ? "block" : params.scenario === "p1_once" || params.scenario === "p1_second_failure" ? "revise" : "pass";
    const review = await step.do("review-v1", retry, () => commit({
      step_name: "review-v1",
      step_key: `${params.run_id}:review-v1`,
      expected_state: "draft_generated",
      next_state: reviewDecision === "block" ? "failed" : reviewDecision === "revise" ? "revision_pending" : "reviewed",
      approval_state: reviewDecision === "block" ? "human_action_required" : "not_required",
      terminal_status: reviewDecision === "block" ? "failed" : undefined,
      artifacts: [{ kind: "review_report", idempotency_key: `${params.run_id}:review:v1`, producer_role: "editorial_review", producer_version: EDITORIAL_AGENT_VERSIONS.editorial_review, input_artifact_ids: draft.artifact_ids, summary: { decision: reviewDecision, finding_codes: reviewDecision === "pass" ? [] : [reviewDecision === "block" ? "P0_SYNTHETIC_BLOCK" : "P1_SYNTHETIC_REVISE"], changed_block_ids: reviewDecision === "revise" ? ["block_2"] : [] } }],
    }));
    if (reviewDecision === "block") return { state: "failed", approval_state: "human_action_required", artifact_ids: review.artifact_ids };
    let current = review;
    if (reviewDecision === "revise") {
      const revision = await step.do("revision-v2", retry, () => commit({
        step_name: "revision-v2",
        step_key: `${params.run_id}:revision-v2`,
        expected_state: "revision_pending",
        next_state: "draft_generated",
        revision_count: 1,
        artifacts: [{ kind: "article_draft", idempotency_key: `${params.run_id}:draft:v2`, producer_role: "writing", producer_version: EDITORIAL_AGENT_VERSIONS.writing, input_artifact_ids: review.artifact_ids, summary: { source: "synthetic", version_no: 2, parent_artifact_ids: review.artifact_ids, changed_block_ids: ["block_2"] } }],
      }));
      const secondDecision = params.scenario === "p1_second_failure" ? "block" : "pass";
      current = await step.do("review-v2", retry, () => commit({
        step_name: "review-v2",
        step_key: `${params.run_id}:review-v2`,
        expected_state: "draft_generated",
        next_state: secondDecision === "block" ? "failed" : "reviewed",
        approval_state: secondDecision === "block" ? "human_action_required" : "not_required",
        terminal_status: secondDecision === "block" ? "failed" : undefined,
        artifacts: [{ kind: "review_report", idempotency_key: `${params.run_id}:review:v2`, producer_role: "editorial_review", producer_version: EDITORIAL_AGENT_VERSIONS.editorial_review, input_artifact_ids: revision.artifact_ids, summary: { decision: secondDecision, finding_codes: secondDecision === "pass" ? [] : ["P1_SECOND_FAILURE"], changed_block_ids: ["block_2"] } }],
      }));
      if (secondDecision === "block") return { state: "failed", approval_state: "human_action_required", artifact_ids: current.artifact_ids };
    }
    const frozen = await step.do("freeze-content", retry, () => commit({
      step_name: "freeze-content",
      step_key: `${params.run_id}:freeze`,
      expected_state: "reviewed",
      next_state: "content_frozen",
      artifacts: [{ kind: "frozen_article_version", idempotency_key: `${params.run_id}:frozen:v${params.scenario === "happy" ? 1 : 2}`, producer_role: "editorial_coordinator", producer_version: EDITORIAL_AGENT_VERSIONS.editorial_coordinator, input_artifact_ids: current.artifact_ids, summary: { source: "synthetic", version_no: params.scenario === "happy" ? 1 : 2, block_ids: ["block_1", "block_2"] } }],
    }));
    const plans = await step.do("plan-visuals", retry, () => commit({
      step_name: "plan-visuals",
      step_key: `${params.run_id}:plans`,
      expected_state: "content_frozen",
      next_state: "content_frozen",
      artifacts: [
        { kind: "illustration_plan", idempotency_key: `${params.run_id}:illustration-plan`, producer_role: "illustration", producer_version: EDITORIAL_AGENT_VERSIONS.illustration, input_artifact_ids: frozen.artifact_ids, summary: { source: "synthetic", visual_ids: ["visual_1"], block_ids: ["block_2"], warning_codes: [] } },
        { kind: "cover_plan", idempotency_key: `${params.run_id}:cover-plan`, producer_role: "cover", producer_version: EDITORIAL_AGENT_VERSIONS.cover, input_artifact_ids: frozen.artifact_ids, summary: { source: "synthetic", visual_ids: ["cover_1"], block_ids: ["block_1"], warning_codes: [] } },
      ],
    }));
    await step.do("await-human-confirmation", retry, () => commit({ step_name: "await-human-confirmation", step_key: `${params.run_id}:human-wait`, expected_state: "content_frozen", next_state: "awaiting_human_confirmation", approval_state: "awaiting", artifacts: [] }));
    let approval: { approved: boolean; reason?: string };
    try {
      const approvalEvent = await step.waitForEvent("human-confirmation", { type: "approval", timeout: "7 days" });
      approval = approvalEvent.payload as { approved: boolean; reason?: string };
    } catch (error) {
      const reason: "timed_out" | "rejected" = String(error).toLowerCase().includes("timeout") ? "timed_out" : "rejected";
      const rejected = await step.do("record-rejection", retry, () => coordinator.commitWorkflowStep({ run_id: params.run_id, step_name: "record-approval", step_key: `${params.run_id}:approval`, expected_state: "awaiting_human_confirmation", next_state: "failed", approval_state: reason, terminal_status: "failed", artifacts: [] }));
      return { state: rejected.state, approval_state: reason, artifact_ids: [...plans.artifact_ids, ...rejected.artifact_ids] };
    }
    if (!approval.approved) {
      const reason: "timed_out" | "rejected" = approval.reason?.toLowerCase().includes("timeout") ? "timed_out" : "rejected";
      const rejected = await step.do("record-rejection", retry, () => coordinator.commitWorkflowStep({ run_id: params.run_id, step_name: "record-approval", step_key: `${params.run_id}:approval`, expected_state: "awaiting_human_confirmation", next_state: "failed", approval_state: reason, terminal_status: "failed", artifacts: [] }));
      return { state: rejected.state, approval_state: reason, artifact_ids: [...plans.artifact_ids, ...rejected.artifact_ids] };
    }
    const approved = await step.do("record-approval", retry, () => coordinator.commitWorkflowStep({ run_id: params.run_id, step_name: "record-approval", step_key: `${params.run_id}:approval`, expected_state: "awaiting_human_confirmation", next_state: "approved_for_phase3", approval_state: "approved", terminal_status: "completed", artifacts: [] }));
    return { state: approved.state, approval_state: "approved", artifact_ids: [...plans.artifact_ids, ...approved.artifact_ids] };
  }
}

type OrchestrationResult = Record<string, unknown> & { replayed?: boolean };
type OrchestrationCoordinator = {
  startRun(input: Record<string, unknown>): Promise<OrchestrationResult>;
  getRun(runId: string): Promise<Record<string, unknown>>;
  recordHumanAction(input: Record<string, unknown>): Promise<OrchestrationResult>;
};
export type OrchestrationEnv = {
  EDITORIAL_COORDINATOR: { getByName(name: string): OrchestrationCoordinator };
  EDITORIAL_WORKFLOW_V2?: string;
  EDITORIAL_WORKFLOW_V2_ALLOWLIST?: string;
};

export function phase2Enabled(env: { EDITORIAL_WORKFLOW_V2?: string; EDITORIAL_WORKFLOW_V2_ALLOWLIST?: string }, userId: string, workspaceId: string): boolean {
  if (env.EDITORIAL_WORKFLOW_V2?.trim().toLowerCase() !== "true") return false;
  const allowlist = (env.EDITORIAL_WORKFLOW_V2_ALLOWLIST || "").split(",").map(value => value.trim()).filter(Boolean);
  return allowlist.includes(`${userId}:${workspaceId}`);
}

export function phase2ErrorResponse(error: unknown): Response {
  if (error instanceof EditorialRuntimeError) return Response.json({ error: error.code }, { status: error.status });
  return Response.json({ error: "editorial_orchestration_unavailable" }, { status: 503 });
}

function trustedHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim() || "";
  return validateOpaque(value, name);
}

function orchestrationBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EditorialRuntimeError("payload_required", "editorial orchestration payload is required", 400);
  }
  const body = value as Record<string, unknown>;
  for (const forbidden of ["user_id", "workspace_id", "role", "producer_role", "state", "workflow_id"]) {
    if (body[forbidden] !== undefined) {
      throw new EditorialRuntimeError("server_owned_field", `${forbidden} is assigned by the internal runtime`, 400);
    }
  }
  return body;
}

/**
 * The only Worker entry point for the new runtime. It is called after the
 * existing internal service token check in index.ts; no client route reaches
 * this function. Ownership comes from the authenticated internal headers.
 */
export async function handleEditorialOrchestrationInternalRoute(
  request: Request,
  env: OrchestrationEnv,
  url: URL,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "internal" || parts[2] !== "editorial" || parts[3] !== "runs") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  let userId: string;
  let workspaceId: string;
  try {
    userId = trustedHeader(request, "x-vibepub-user-id");
    workspaceId = trustedHeader(request, "x-vibepub-workspace-id");
  } catch (error) {
    return phase2ErrorResponse(error);
  }
  if (!phase2Enabled(env, userId, workspaceId)) {
    return Response.json({ error: "editorial_workflow_disabled" }, { status: 404 });
  }
  const shardName = async (articleId: string, runId: string) => coordinatorShardName(userId, workspaceId, articleId, runId);
  try {
    if (request.method === "POST" && parts.length === 4) {
      const body = orchestrationBody(await request.json());
      const articleId = validateOpaque(String(body.article_id || ""), "article_id");
      const runId = validateOpaque(String(body.run_id || ""), "run_id");
      const recordingId = Number(body.recording_id);
      if (!Number.isSafeInteger(recordingId) || recordingId <= 0) throw new EditorialRuntimeError("recording_id_invalid", "recording_id must be positive", 400);
      const scenario = validateScenario(String(body.scenario || "happy"));
      const payload = { run_id: runId, article_id: articleId, recording_id: recordingId, user_id: userId, workspace_id: workspaceId, scenario };
      const payloadHash = await hashJson(payload);
      const namespace = env.EDITORIAL_COORDINATOR;
      const coordinator = namespace.getByName(await shardName(articleId, runId));
      const result = await coordinator.startRun({ ...payload, payload_hash: payloadHash });
      return Response.json({ run: result }, { status: result.replayed ? 200 : 202 });
    }
    if (request.method === "GET" && parts.length === 5) {
      const runId = validateOpaque(parts[4], "run_id");
      const body = url.searchParams;
      const articleId = validateOpaque(body.get("article_id") || "", "article_id");
      const namespace = env.EDITORIAL_COORDINATOR;
      const coordinator = namespace.getByName(await shardName(articleId, runId));
      return Response.json({ run: await coordinator.getRun(runId) });
    }
    if (request.method === "POST" && parts.length === 6 && parts[5] === "human") {
      const runId = validateOpaque(parts[4], "run_id");
      const body = orchestrationBody(await request.json());
      const action = String(body.action || "");
      if (!(action === "wait" || action === "approve" || action === "reject" || action === "timeout")) {
        throw new EditorialRuntimeError("human_action_invalid", "human action is not allowed", 400);
      }
      const articleId = validateOpaque(String(body.article_id || ""), "article_id");
      const idempotencyKey = validateOpaque(String(body.idempotency_key || request.headers.get("Idempotency-Key") || ""), "idempotency_key");
      const namespace = env.EDITORIAL_COORDINATOR;
      const coordinator = namespace.getByName(await shardName(articleId, runId));
      const run = await coordinator.getRun(runId);
      const payloadHash = await hashJson({ action, reason: body.reason === undefined ? null : String(body.reason) });
      const result = await coordinator.recordHumanAction({
        run_id: runId,
        action: action as HumanActionInput["action"],
        idempotency_key: idempotencyKey,
        payload_hash: payloadHash,
        workflow_id: String(run.workflow_id || ""),
        reason: body.reason === undefined ? undefined : String(body.reason),
      });
      return Response.json({ human_action: result }, { status: result.replayed ? 200 : 202 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return phase2ErrorResponse(error);
  }
}
