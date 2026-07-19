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
  canonicalJson,
} from "./editorialContracts";
import type { EditorialAgentId } from "./editorialContracts";

export const EDITORIAL_WORKFLOW_VERSION = "editorial-workflow.v2";
export const EDITORIAL_POLICY_VERSION = "editorial-policy.v2";
export const EDITORIAL_SCHEMA_VERSION = "editorial-orchestration.v2";

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
  EDITORIAL_WORKFLOW: Workflow<EditorialWorkflowParams>;
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

export class EditorialRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
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

export type OrchestrationEnv = EditorialRuntimeEnv & {
  EDITORIAL_COORDINATOR: DurableObjectNamespace<any>;
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
      const namespace = (env as unknown as { EDITORIAL_COORDINATOR: { getByName(name: string): any } }).EDITORIAL_COORDINATOR;
      const coordinator: any = namespace.getByName(await shardName(articleId, runId));
      const result = await coordinator.startRun({ ...payload, payload_hash: payloadHash });
      return Response.json({ run: result }, { status: result.replayed ? 200 : 202 });
    }
    if (request.method === "GET" && parts.length === 5) {
      const runId = validateOpaque(parts[4], "run_id");
      const body = url.searchParams;
      const articleId = validateOpaque(body.get("article_id") || "", "article_id");
      const namespace = (env as unknown as { EDITORIAL_COORDINATOR: { getByName(name: string): any } }).EDITORIAL_COORDINATOR;
      const coordinator: any = namespace.getByName(await shardName(articleId, runId));
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
      const namespace = (env as unknown as { EDITORIAL_COORDINATOR: { getByName(name: string): any } }).EDITORIAL_COORDINATOR;
      const coordinator: any = namespace.getByName(await shardName(articleId, runId));
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
