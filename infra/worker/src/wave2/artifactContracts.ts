import { PUBLICATION_AGENT_VERSIONS, PUBLICATION_SKILL_PINS } from "../editorialContracts";
import { CANONICAL_EDITORIAL_POLICY_VERSION, CANONICAL_EDITORIAL_WORKFLOW_VERSION } from "../publicationProjection";

export const WAVE2_SCHEMA_VERSION = "editorial-wave2a.v1";
export const WAVE2_WORKFLOW_VERSION = CANONICAL_EDITORIAL_WORKFLOW_VERSION;
export const WAVE2_POLICY_VERSION = CANONICAL_EDITORIAL_POLICY_VERSION;
export const WAVE2_ACTIVE_AGENT_VERSIONS: Record<Wave2AgentRole, string> = { ...PUBLICATION_AGENT_VERSIONS };

export const WAVE2_ARTIFACT_KINDS = [
  "article_brief",
  "article_draft",
  "review_report",
  "revision_dispatch",
  "frozen_article_version",
] as const;
export type Wave2ArtifactKind = (typeof WAVE2_ARTIFACT_KINDS)[number];

export type Wave2AgentRole =
  | "editorial_coordinator"
  | "writing"
  | "editorial_review"
  | "visual_production"
  | "wechat_publishing";
export type VersionPin = { id: string; version: string };
export type AgentPin = { role: Wave2AgentRole; version: string };

export type ArticleBlock = {
  block_id: string;
  kind: "paragraph" | "heading" | "quote" | "list" | "code" | "table";
  order: number;
  text: string;
  text_hash: string;
  claim_ids: string[];
  image_ref_ids: string[];
};

export type ArticleBrief = {
  article_id: string;
  run_id: string;
  recording_id: number;
  source_type: "audio" | "text";
  language: string;
  transcript_ref: string;
  transcript_hash: string;
  source_hash: string;
  title_hint: string | null;
  content_goal: string;
  profile_pins: Record<string, VersionPin>;
  style_profile_body?: string;
  style_profile_body_hash?: string;
  block_strategy: "stable_block_v1";
};

export type ClaimLedgerEntry = {
  claim_id: string;
  block_id: string;
  classification: "author_view" | "source_fact" | "external_fact";
  verification_status: "not_required" | "pending" | "verified" | "failed";
};

export type ArticleDraft = {
  article_id: string;
  run_id: string;
  recording_id: number;
  revision: number;
  parent_artifact_id: string | null;
  parent_review_artifact_id: string | null;
  parent_dispatch_artifact_id: string | null;
  title: string;
  body: string;
  blocks: ArticleBlock[];
  title_candidates: string[];
  selected_title: string;
  cover_title: string[];
  adapter_version: string;
  model_version: string;
  formatting_skill: VersionPin;
  profile_pins: Record<string, VersionPin>;
  style_profile_body_hash?: string;
  content_hash: string;
  claim_ledger: ClaimLedgerEntry[];
  changed_block_ids: string[];
  source_hash: string;
};

export type ReviewFinding = {
  finding_id: string;
  severity: "P0" | "P1" | "P2";
  code: string;
  target: string;
  evidence: { text_hash: string; start: number; end: number };
  evidence_hash: string;
  suggested_action: string | null;
  requires_human: boolean;
};

export type ReviewReport = {
  article_id: string;
  run_id: string;
  recording_id: number;
  input_artifact_id: string;
  input_payload_hash: string;
  review_round: 1 | 2;
  decision: "pass" | "revise" | "block";
  findings: ReviewFinding[];
  revision_targets: string[];
  suggested_actions: string[];
  reviewer_version: string;
  rules_pins: { dbs_ai_check: VersionPin; humanizer: VersionPin };
};

export type RevisionDispatch = {
  article_id: string;
  run_id: string;
  recording_id: number;
  source_draft_artifact_id: string;
  source_draft_payload_hash: string;
  source_review_artifact_id: string;
  source_review_payload_hash: string;
  target_block_ids: string[];
  target: string[];
  issue_codes: string[];
  protected_block_hashes: Record<string, string>;
  revision_limit: 1;
  instruction_text: string;
  workflow_version: string;
  policy_version: string;
  producer_pins: VersionPin[];
};

export type FrozenArticleVersion = {
  article_id: string;
  run_id: string;
  recording_id: number;
  version: number;
  parent_artifact_id: string | null;
  draft_artifact_id: string;
  review_artifact_id: string;
  title: string;
  body: string;
  blocks: ArticleBlock[];
  title_candidates: string[];
  selected_title: string;
  cover_title: string[];
  claim_ledger: ClaimLedgerEntry[];
  content_hash: string;
  formatting_skill: VersionPin;
  html_hash: string | null;
  warnings: string[];
  immutable: true;
  frozen_at: string;
  accepted_draft_payload_hash: string;
  accepted_review_payload_hash: string;
  profile_pins: Record<string, VersionPin>;
};

export type ArtifactPayload = ArticleBrief | ArticleDraft | ReviewReport | RevisionDispatch | FrozenArticleVersion;
export type ArtifactEnvelope = {
  schema_version: typeof WAVE2_SCHEMA_VERSION;
  artifact_id: string;
  artifact_key: string;
  kind: Wave2ArtifactKind;
  run_id: string;
  article_id: string;
  recording_id: number;
  user_id: string;
  workspace_id: string;
  producer: AgentPin;
  workflow_version: string;
  policy_version: string;
  skill_pins: Record<string, VersionPin>;
  input_artifact_ids: string[];
  idempotency_key: string;
  payload_hash: string;
  payload_length: number;
  created_at: string;
  storage_ref: string;
};
export type ArtifactObject = { envelope: ArtifactEnvelope; payload: ArtifactPayload };

export type ArtifactMetadata = Omit<ArtifactEnvelope, "payload"> & {
  payload_summary: {
    block_count?: number;
    decision?: ReviewReport["decision"];
    review_round?: ReviewReport["review_round"];
    content_hash?: string;
    style_profile_body_hash?: string;
    revision_limit?: 1;
  };
};

export class Wave2ContractError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "Wave2ContractError";
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
// Mining V3 persists its canonical transcript as a private, owner-sharded
// object. Existing opaque transcript references remain valid for prior V3
// callers; no other slash-containing reference is accepted here.
const MINING_V3_TRANSCRIPT_REF_RE = /^editorial\/v3\/[a-f0-9]{24}\/mining-handoffs\/handoff_v3_[a-f0-9]{64}\/transcripts\/[a-f0-9]{64}\.v1\.txt$/;

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Wave2ContractError("invalid_field", `${field} is invalid`);
  return value;
}
function id(value: unknown, field: string): string {
  const result = text(value, field, 160);
  if (!ID_RE.test(result)) throw new Wave2ContractError("invalid_id", `${field} is invalid`);
  return result;
}
function transcriptRef(value: unknown): string {
  const result = text(value, "transcript_ref", 512);
  if (!ID_RE.test(result) && !MINING_V3_TRANSCRIPT_REF_RE.test(result)) {
    throw new Wave2ContractError("invalid_transcript_ref", "transcript_ref is invalid");
  }
  return result;
}
function key(value: unknown, field: string): string {
  const result = text(value, field, 160);
  if (!KEY_RE.test(result)) throw new Wave2ContractError("invalid_idempotency_key", `${field} is invalid`);
  return result;
}
function hash(value: unknown, field: string): string {
  const result = text(value, field, 71);
  if (!HASH_RE.test(result)) throw new Wave2ContractError("invalid_hash", `${field} is invalid`);
  return result;
}
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Wave2ContractError("invalid_integer", `${field} is invalid`);
  return Number(value);
}
function stringArray(value: unknown, field: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== "string")) throw new Wave2ContractError("invalid_array", `${field} is invalid`);
  return value.map(item => text(item, field, 4_000));
}
function opaqueIdArray(value: unknown, field: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Wave2ContractError("invalid_array", `${field} is invalid`);
  return value.map(item => id(item, field));
}
function pin(value: unknown, field: string): VersionPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Wave2ContractError("invalid_pin", `${field} is invalid`);
  const record = value as Record<string, unknown>;
  return { id: id(record.id, `${field}.id`), version: text(record.version, `${field}.version`, 120) };
}
function pinMap(value: unknown, field: string): Record<string, VersionPin> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Wave2ContractError("invalid_pin_map", `${field} is invalid`);
  return Object.fromEntries(Object.entries(value).map(([name, value]) => [id(name, `${field}.name`), pin(value, `${field}.${name}`)]));
}
function textHash(value: string): Promise<string> { return sha256(value); }
async function contentHash(title: string, body: string, blocks: ArticleBlock[]): Promise<string> {
  return sha256(canonicalJson({ title, body, blocks }));
}

async function normalizeBlocks(value: unknown): Promise<ArticleBlock[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new Wave2ContractError("invalid_blocks", "blocks are invalid");
  const result = await Promise.all(value.map(async (raw, index) => {
    if (!raw || typeof raw !== "object") throw new Wave2ContractError("invalid_block", `blocks[${index}] is invalid`);
    const record = raw as Record<string, unknown>;
    const kind = String(record.kind);
    if (!["paragraph", "heading", "quote", "list", "code", "table"].includes(kind)) throw new Wave2ContractError("invalid_block_kind", `blocks[${index}] is invalid`);
    if (record.block_id !== `block_v1_${index + 1}` || record.order !== index) throw new Wave2ContractError("invalid_block_identity", "block ids/order must be continuous");
    const blockText = text(record.text, `blocks[${index}].text`, 100_000);
    if (record.text_hash !== await textHash(blockText)) throw new Wave2ContractError("block_hash_mismatch", "block text hash is not canonical");
    return {
      block_id: record.block_id,
      kind: kind as ArticleBlock["kind"],
      order: index,
      text: blockText,
      text_hash: hash(record.text_hash, `blocks[${index}].text_hash`),
      claim_ids: opaqueIdArray(record.claim_ids ?? [], `blocks[${index}].claim_ids`),
      image_ref_ids: opaqueIdArray(record.image_ref_ids ?? [], `blocks[${index}].image_ref_ids`),
    } satisfies ArticleBlock;
  }));
  if (new Set(result.map(block => block.block_id)).size !== result.length) throw new Wave2ContractError("invalid_block_identity", "block ids must be unique");
  return result;
}

export async function deriveArtifactId(kind: Wave2ArtifactKind, runId: string, idempotencyKey: string): Promise<string> {
  return `${kind}_${(await sha256(canonicalJson({ kind, run_id: runId, idempotency_key: idempotencyKey }))).slice(7, 31)}`;
}

export function revisionDispatchIdempotencyKey(runId: string, reviewArtifactId: string): string {
  return `revision-dispatch:${runId}:${reviewArtifactId}`;
}

function shardHash(value: string): string {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16).padStart(8, "0").slice(0, 2);
}
export function artifactKey(userId: string, workspaceId: string, runId: string, kind: Wave2ArtifactKind, artifactId: string): string {
  id(userId, "user_id"); id(workspaceId, "workspace_id"); id(runId, "run_id"); id(artifactId, "artifact_id");
  if (!WAVE2_ARTIFACT_KINDS.includes(kind)) throw new Wave2ContractError("invalid_artifact_kind", "kind is invalid");
  return `editorial/v3/${shardHash(`${userId}\u0000${workspaceId}\u0000${runId}`)}/${runId}/artifacts/${kind}/${artifactId}.v1.json`;
}
export function validateArtifactKey(value: unknown): string {
  const result = text(value, "artifact_key", 512);
  if (result.includes("..") || result.includes("\\") || !result.startsWith("editorial/v3/")) throw new Wave2ContractError("artifact_key_invalid", "artifact key is outside V3 namespace");
  return result;
}

function recordingFrom(payload: ArtifactPayload): number { return payload.recording_id; }
function runFrom(payload: ArtifactPayload): string { return payload.run_id; }
function articleFrom(payload: ArtifactPayload): string { return payload.article_id; }

function assertClaimLedgerMatchesBlocks(blocks: ArticleBlock[], ledger: ClaimLedgerEntry[]): void {
  const blockIds = new Set(blocks.map(block => block.block_id));
  const blockClaims = new Map(blocks.map(block => [block.block_id, block.claim_ids]));
  const ledgerClaims = new Map<string, string[]>();
  const claimIds = new Set<string>();
  for (const claim of ledger) {
    if (!blockIds.has(claim.block_id) || claimIds.has(claim.claim_id)) throw new Wave2ContractError("claim_ledger_mismatch", "claim ledger must exactly match block claim provenance");
    claimIds.add(claim.claim_id);
    const claims = ledgerClaims.get(claim.block_id) || [];
    claims.push(claim.claim_id);
    ledgerClaims.set(claim.block_id, claims);
  }
  for (const block of blocks) {
    const expected = [...new Set(blockClaims.get(block.block_id) || [])].sort();
    const actual = [...new Set(ledgerClaims.get(block.block_id) || [])].sort();
    if (expected.length !== block.claim_ids.length || canonicalJson(expected) !== canonicalJson(actual)) throw new Wave2ContractError("claim_ledger_mismatch", "claim ledger must exactly match block claim provenance");
  }
}

function validateTitleMetadata(title: string, titleCandidates: string[], selectedTitle: string, coverTitle: string[]): void {
  if (titleCandidates.length === 0 || selectedTitle !== title || !titleCandidates.includes(selectedTitle)) throw new Wave2ContractError("title_metadata_invalid", "selected title must equal a non-empty title candidate list");
  if (coverTitle.length < 1 || coverTitle.length > 4) throw new Wave2ContractError("cover_title_invalid", "cover title must contain one to four lines");
}

function normalizeClaimLedger(value: unknown, blocks: ArticleBlock[]): ClaimLedgerEntry[] {
  if (!Array.isArray(value)) throw new Wave2ContractError("invalid_claim_ledger", "claim ledger is invalid");
  const ledger = value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Wave2ContractError("invalid_claim_ledger", `claim_ledger[${index}] is invalid`);
    const claim = raw as Record<string, unknown>;
    if (!["author_view", "source_fact", "external_fact"].includes(String(claim.classification)) || !["not_required", "pending", "verified", "failed"].includes(String(claim.verification_status))) throw new Wave2ContractError("invalid_claim_ledger", "claim is invalid");
    return { claim_id: id(claim.claim_id, "claim_id"), block_id: id(claim.block_id, "block_id"), classification: claim.classification as ClaimLedgerEntry["classification"], verification_status: claim.verification_status as ClaimLedgerEntry["verification_status"] };
  });
  assertClaimLedgerMatchesBlocks(blocks, ledger);
  return ledger;
}

async function normalizePayload(kind: Wave2ArtifactKind, value: unknown): Promise<ArtifactPayload> {
  if (!value || typeof value !== "object") throw new Wave2ContractError("invalid_payload", "payload is invalid");
  const record = value as Record<string, unknown>;
  if (kind === "article_brief") {
    const sourceType = record.source_type;
    if (sourceType !== "audio" && sourceType !== "text") throw new Wave2ContractError("invalid_source_type", "source type is invalid");
    const styleProfileBody = record.style_profile_body === undefined ? undefined : text(record.style_profile_body, "style_profile_body", 20_000);
    const styleProfileBodyHash = record.style_profile_body_hash === undefined ? undefined : hash(record.style_profile_body_hash, "style_profile_body_hash");
    if (styleProfileBody !== undefined && styleProfileBodyHash !== await sha256(styleProfileBody)) throw new Wave2ContractError("style_profile_body_hash_mismatch", "style profile body hash is not canonical", 409);
    if (styleProfileBody === undefined && styleProfileBodyHash !== undefined) throw new Wave2ContractError("style_profile_body_required", "style profile body is required when its hash is supplied");
    const profilePins = pinMap(record.profile_pins, "profile_pins");
    const stylePin = profilePins.style;
    if (!stylePin) throw new Wave2ContractError("style_profile_pin_required", "brief style profile pin is required", 409);
    if (profilePins.formatting?.id !== PUBLICATION_SKILL_PINS.formatting.id || profilePins.formatting?.version !== PUBLICATION_SKILL_PINS.formatting.version) throw new Wave2ContractError("active_pin_conflict", "brief formatting skill pin is not active", 409);
    if (stylePin.id === "style_litianc_default") {
      if (stylePin.version !== "2026-07-05" || styleProfileBody !== undefined || styleProfileBodyHash !== undefined) throw new Wave2ContractError("style_profile_pin_conflict", "default style profile is resolved by the Writing registry and cannot be overridden", 409);
    } else if (styleProfileBody === undefined || styleProfileBodyHash === undefined) {
      throw new Wave2ContractError("style_profile_body_required", "custom style profiles require an inline body and hash", 409);
    }
    return {
      article_id: id(record.article_id, "article_id"), run_id: id(record.run_id, "run_id"), recording_id: positiveInteger(record.recording_id, "recording_id"),
      source_type: sourceType, language: text(record.language, "language", 32), transcript_ref: transcriptRef(record.transcript_ref),
      transcript_hash: hash(record.transcript_hash, "transcript_hash"), source_hash: hash(record.source_hash, "source_hash"),
      title_hint: record.title_hint === null ? null : text(record.title_hint, "title_hint", 2_000), content_goal: text(record.content_goal, "content_goal", 4_000),
      profile_pins: profilePins,
      ...(styleProfileBody === undefined ? {} : { style_profile_body: styleProfileBody }),
      ...(styleProfileBodyHash === undefined ? {} : { style_profile_body_hash: styleProfileBodyHash }),
      block_strategy: record.block_strategy === "stable_block_v1" ? "stable_block_v1" : (() => { throw new Wave2ContractError("invalid_block_strategy", "block strategy is invalid"); })(),
    } satisfies ArticleBrief;
  }
  if (kind === "article_draft") {
    const revision = record.revision;
    if (revision !== 1 && revision !== 2) throw new Wave2ContractError("invalid_revision", "revision is invalid");
    const blocks = await normalizeBlocks(record.blocks);
    const title = text(record.title, "title", 2_000); const body = text(record.body, "body", 500_000);
    const normalized: ArticleDraft = {
      article_id: id(record.article_id, "article_id"), run_id: id(record.run_id, "run_id"), recording_id: positiveInteger(record.recording_id, "recording_id"), revision: Number(revision),
      parent_artifact_id: record.parent_artifact_id === null ? null : id(record.parent_artifact_id, "parent_artifact_id"),
      parent_review_artifact_id: record.parent_review_artifact_id === null ? null : id(record.parent_review_artifact_id, "parent_review_artifact_id"),
      parent_dispatch_artifact_id: record.parent_dispatch_artifact_id === null ? null : id(record.parent_dispatch_artifact_id, "parent_dispatch_artifact_id"),
      title, body, blocks, title_candidates: stringArray(record.title_candidates, "title_candidates", 20), selected_title: text(record.selected_title, "selected_title", 2_000), cover_title: stringArray(record.cover_title, "cover_title", 4),
      adapter_version: text(record.adapter_version, "adapter_version", 120), model_version: text(record.model_version, "model_version", 120), formatting_skill: pin(record.formatting_skill, "formatting_skill"),
      profile_pins: pinMap(record.profile_pins, "profile_pins"), ...(record.style_profile_body_hash === undefined ? {} : { style_profile_body_hash: hash(record.style_profile_body_hash, "style_profile_body_hash") }), content_hash: hash(record.content_hash, "content_hash"),
      claim_ledger: normalizeClaimLedger(record.claim_ledger, blocks),
      changed_block_ids: stringArray(record.changed_block_ids, "changed_block_ids"), source_hash: hash(record.source_hash, "source_hash"),
    };
    if (!normalized.profile_pins.style) throw new Wave2ContractError("active_pin_conflict", "draft style pin is required", 409);
    validateTitleMetadata(normalized.title, normalized.title_candidates, normalized.selected_title, normalized.cover_title);
    if (body !== blocks.map(block => block.text).join("\n\n")) throw new Wave2ContractError("body_blocks_mismatch", "draft body is not the canonical block projection");
    if (normalized.content_hash !== await contentHash(title, body, blocks)) throw new Wave2ContractError("content_hash_mismatch", "draft content hash is not canonical");
    assertClaimLedgerMatchesBlocks(blocks, normalized.claim_ledger);
    if (normalized.revision === 1 && (normalized.parent_artifact_id !== null || normalized.parent_review_artifact_id !== null || normalized.parent_dispatch_artifact_id !== null)) throw new Wave2ContractError("artifact_inputs_invalid", "initial draft cannot have revision parents");
    if (normalized.revision === 2 && (!normalized.parent_artifact_id || !normalized.parent_review_artifact_id || !normalized.parent_dispatch_artifact_id)) throw new Wave2ContractError("artifact_inputs_invalid", "revision draft needs draft/review/dispatch parents");
    if (normalized.adapter_version !== "writing-v3.adapter.1.0.0" || normalized.formatting_skill.id !== "md_to_wechat" || normalized.formatting_skill.version !== "1.0.0" || normalized.profile_pins.formatting?.id !== "md_to_wechat" || normalized.profile_pins.formatting?.version !== "1.0.0" || !normalized.model_version) throw new Wave2ContractError("active_pin_conflict", "draft pins are not an active V3 writing contract", 409);
    return normalized;
  }
  if (kind === "review_report") {
    const findings = Array.isArray(record.findings) ? await Promise.all(record.findings.map(async (raw, index) => {
      if (!raw || typeof raw !== "object") throw new Wave2ContractError("invalid_finding", `findings[${index}] is invalid`);
      const finding = raw as Record<string, unknown>; const severity = finding.severity;
      if (!["P0", "P1", "P2"].includes(String(severity))) throw new Wave2ContractError("invalid_finding", "severity is invalid");
      if (!finding.evidence || typeof finding.evidence !== "object") throw new Wave2ContractError("invalid_finding_evidence", "evidence is invalid");
      const evidence = finding.evidence as Record<string, unknown>; const start = evidence.start; const end = evidence.end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) < Number(start)) throw new Wave2ContractError("invalid_finding_evidence", "span is invalid");
      const target = text(finding.target, "finding.target", 160);
      if (!/^(@title|@body|block_v1_\d+)$/.test(target)) throw new Wave2ContractError("invalid_finding_target", "finding target is not a stable title/body/block target");
      if (severity === "P1" && target === "@body") throw new Wave2ContractError("invalid_finding_target", "P1 findings must target @title or a stable block");
      const evidenceTextHash = hash(evidence.text_hash, "evidence.text_hash");
      if (finding.evidence_hash !== evidence.text_hash) throw new Wave2ContractError("invalid_finding_evidence", "evidence hash must bind the cited text");
      return { finding_id: id(finding.finding_id, "finding_id"), severity: severity as ReviewFinding["severity"], code: text(finding.code, "finding.code", 120), target, evidence: { text_hash: evidenceTextHash, start: Number(start), end: Number(end) }, evidence_hash: hash(finding.evidence_hash, "finding.evidence_hash"), suggested_action: finding.suggested_action === null ? null : text(finding.suggested_action, "suggested_action", 200), requires_human: finding.requires_human === true } satisfies ReviewFinding;
    })) : (() => { throw new Wave2ContractError("invalid_findings", "findings are invalid"); })();
    const decision = record.decision;
    if (decision !== "pass" && decision !== "revise" && decision !== "block") throw new Wave2ContractError("invalid_review_decision", "decision is invalid");
    const hasP0 = findings.some(finding => finding.severity === "P0");
    const hasP1 = findings.some(finding => finding.severity === "P1");
    const expectedDecision = hasP0 || record.review_round === 2 && hasP1 ? "block" : record.review_round === 1 && hasP1 ? "revise" : "pass";
    if (decision !== expectedDecision) throw new Wave2ContractError("invalid_review_decision", "review decision does not match round and findings");
    const revisionTargets = stringArray(record.revision_targets, "revision_targets", 20);
    const expectedRevisionTargets = [...new Set(findings.filter(finding => finding.severity === "P1").map(finding => finding.target))].sort();
    if (canonicalJson(revisionTargets.slice().sort()) !== canonicalJson(expectedRevisionTargets)) throw new Wave2ContractError("revision_targets_mismatch", "revision targets must cover exactly the P1 findings");
    const reviewerVersion = text(record.reviewer_version, "reviewer_version", 120);
    const rulesPins = { dbs_ai_check: pin((record.rules_pins as Record<string, unknown>)?.dbs_ai_check, "rules_pins.dbs_ai_check"), humanizer: pin((record.rules_pins as Record<string, unknown>)?.humanizer, "rules_pins.humanizer") };
    if (reviewerVersion !== "editorial-review.adapter.1.0.0" || rulesPins.dbs_ai_check.id !== "dbs-ai-check" || rulesPins.dbs_ai_check.version !== "1.0.0" || rulesPins.humanizer.id !== "humanizer-zh" || rulesPins.humanizer.version !== "1.0.0") throw new Wave2ContractError("active_pin_conflict", "review rules are not active", 409);
    return { article_id: id(record.article_id, "article_id"), run_id: id(record.run_id, "run_id"), recording_id: positiveInteger(record.recording_id, "recording_id"), input_artifact_id: id(record.input_artifact_id, "input_artifact_id"), input_payload_hash: hash(record.input_payload_hash, "input_payload_hash"), review_round: record.review_round === 1 || record.review_round === 2 ? record.review_round : (() => { throw new Wave2ContractError("invalid_review_round", "review round is invalid"); })(), decision, findings, revision_targets: revisionTargets, suggested_actions: stringArray(record.suggested_actions, "suggested_actions", 20), reviewer_version: reviewerVersion, rules_pins: rulesPins } satisfies ReviewReport;
  }
  if (kind === "revision_dispatch") {
    if (!Array.isArray(record.producer_pins) || record.producer_pins.length !== 3) throw new Wave2ContractError("agent_version_conflict", "dispatch producer pins must contain exactly three roles", 409);
    const producerPins = record.producer_pins.map((value, index) => pin(value, `producer_pins[${index}]`));
    const expectedProducerPins = [
      { id: "editorial_coordinator", version: PUBLICATION_AGENT_VERSIONS.editorial_coordinator },
      { id: "writing", version: PUBLICATION_AGENT_VERSIONS.writing },
      { id: "editorial_review", version: PUBLICATION_AGENT_VERSIONS.editorial_review },
    ];
    if (canonicalJson(producerPins) !== canonicalJson(expectedProducerPins)) throw new Wave2ContractError("agent_version_conflict", "dispatch producer pins do not match the exact text-chain role map", 409);
    const dispatch = { article_id: id(record.article_id, "article_id"), run_id: id(record.run_id, "run_id"), recording_id: positiveInteger(record.recording_id, "recording_id"), source_draft_artifact_id: id(record.source_draft_artifact_id, "source_draft_artifact_id"), source_draft_payload_hash: hash(record.source_draft_payload_hash, "source_draft_payload_hash"), source_review_artifact_id: id(record.source_review_artifact_id, "source_review_artifact_id"), source_review_payload_hash: hash(record.source_review_payload_hash, "source_review_payload_hash"), target_block_ids: stringArray(record.target_block_ids, "target_block_ids", 20), target: stringArray(record.target, "target", 20), issue_codes: stringArray(record.issue_codes, "issue_codes", 20), protected_block_hashes: pinHashMap(record.protected_block_hashes), revision_limit: record.revision_limit === 1 ? 1 : (() => { throw new Wave2ContractError("invalid_revision_limit", "revision limit must be one"); })(), instruction_text: text(record.instruction_text, "instruction_text", 4_000), workflow_version: text(record.workflow_version, "workflow_version", 120), policy_version: text(record.policy_version, "policy_version", 120), producer_pins: producerPins } satisfies RevisionDispatch;
    const targetSet = new Set(dispatch.target);
    const blockTargetSet = new Set(dispatch.target.filter(target => target !== "@title"));
    if (targetSet.size === 0 || targetSet.size !== dispatch.target.length || blockTargetSet.size !== dispatch.target_block_ids.length || dispatch.target_block_ids.some(target => !blockTargetSet.has(target)) || dispatch.target.some(target => target !== "@title" && !/^block_v1_\d+$/.test(target))) throw new Wave2ContractError("dispatch_target_invalid", "dispatch target sets are inconsistent");
    if ([...Object.keys(dispatch.protected_block_hashes)].some(target => targetSet.has(target))) throw new Wave2ContractError("dispatch_protected_target", "a dispatch target cannot also be protected");
    if (dispatch.workflow_version !== WAVE2_WORKFLOW_VERSION || dispatch.policy_version !== WAVE2_POLICY_VERSION) throw new Wave2ContractError("active_pin_conflict", "dispatch pins are not active", 409);
    return dispatch;
  }
  const frozenAt = text(record.frozen_at, "frozen_at", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(frozenAt) || Number.isNaN(Date.parse(frozenAt))) throw new Wave2ContractError("frozen_at_invalid", "frozen_at must be an ISO UTC timestamp");
  const blocks = await normalizeBlocks(record.blocks);
  const title = text(record.title, "title", 2_000);
  const body = text(record.body, "body", 500_000);
  const titleCandidates = stringArray(record.title_candidates, "title_candidates", 20);
  const selectedTitle = text(record.selected_title, "selected_title", 2_000);
  const coverTitle = stringArray(record.cover_title, "cover_title", 4);
  if (record.html_hash !== null) throw new Wave2ContractError("html_hash_not_allowed", "content_frozen versions cannot carry an HTML hash", 409);
  const profilePins = pinMap(record.profile_pins, "profile_pins");
  if (!profilePins.style) throw new Wave2ContractError("style_profile_pin_required", "frozen version style profile pin is required", 409);
  const frozen = { article_id: id(record.article_id, "article_id"), run_id: id(record.run_id, "run_id"), recording_id: positiveInteger(record.recording_id, "recording_id"), version: positiveInteger(record.version, "version"), parent_artifact_id: record.parent_artifact_id === null ? null : id(record.parent_artifact_id, "parent_artifact_id"), draft_artifact_id: id(record.draft_artifact_id, "draft_artifact_id"), review_artifact_id: id(record.review_artifact_id, "review_artifact_id"), title, body, blocks, title_candidates: titleCandidates, selected_title: selectedTitle, cover_title: coverTitle, claim_ledger: normalizeClaimLedger(record.claim_ledger, blocks), content_hash: hash(record.content_hash, "content_hash"), formatting_skill: pin(record.formatting_skill, "formatting_skill"), html_hash: null, warnings: stringArray(record.warnings ?? [], "warnings", 50), immutable: record.immutable === true ? true : (() => { throw new Wave2ContractError("frozen_version_not_immutable", "frozen version must be immutable"); })(), frozen_at: frozenAt, accepted_draft_payload_hash: hash(record.accepted_draft_payload_hash, "accepted_draft_payload_hash"), accepted_review_payload_hash: hash(record.accepted_review_payload_hash, "accepted_review_payload_hash"), profile_pins: profilePins } satisfies FrozenArticleVersion;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(frozen.frozen_at) || Number.isNaN(Date.parse(frozen.frozen_at))) throw new Wave2ContractError("frozen_at_invalid", "frozen_at must be ISO UTC");
  if (frozen.body !== frozen.blocks.map(block => block.text).join("\n\n")) throw new Wave2ContractError("body_blocks_mismatch", "frozen body is not the canonical block projection");
  validateTitleMetadata(frozen.title, frozen.title_candidates, frozen.selected_title, frozen.cover_title);
  if (frozen.formatting_skill.id !== PUBLICATION_SKILL_PINS.formatting.id || frozen.formatting_skill.version !== PUBLICATION_SKILL_PINS.formatting.version || frozen.profile_pins.formatting?.id !== PUBLICATION_SKILL_PINS.formatting.id || frozen.profile_pins.formatting?.version !== PUBLICATION_SKILL_PINS.formatting.version) throw new Wave2ContractError("active_pin_conflict", "frozen formatting pins are not active", 409);
  if (frozen.content_hash !== await contentHash(frozen.title, frozen.body, frozen.blocks)) throw new Wave2ContractError("content_hash_mismatch", "frozen content hash is not canonical");
  return frozen;
}

function pinHashMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Wave2ContractError("invalid_pin_map", "protected hashes are invalid");
  return Object.fromEntries(Object.entries(value).map(([name, value]) => {
    if (name !== "@title" && !/^block_v1_\d+$/.test(name)) throw new Wave2ContractError("invalid_pin_map", "protected hashes must target @title or stable blocks");
    return [name, hash(value, `protected_block_hashes.${name}`)];
  }));
}

export async function normalizeArtifactEnvelope(input: {
  artifact_id: unknown; kind: unknown; run_id: unknown; article_id: unknown; recording_id: unknown; user_id: unknown; workspace_id: unknown; producer: unknown; workflow_version?: unknown; policy_version?: unknown; skill_pins?: unknown; input_artifact_ids?: unknown; idempotency_key: unknown; created_at: unknown; payload: unknown;
}): Promise<ArtifactObject> {
  if (!WAVE2_ARTIFACT_KINDS.includes(input.kind as Wave2ArtifactKind)) throw new Wave2ContractError("invalid_artifact_kind", "artifact kind is not allowed");
  const kind = input.kind as Wave2ArtifactKind; const artifactId = id(input.artifact_id, "artifact_id"); const runId = id(input.run_id, "run_id"); const articleId = id(input.article_id, "article_id"); const userId = id(input.user_id, "user_id"); const workspaceId = id(input.workspace_id, "workspace_id"); const recordingId = positiveInteger(input.recording_id, "recording_id");
  if (!input.producer || typeof input.producer !== "object") throw new Wave2ContractError("invalid_producer", "producer is invalid");
  const producer = input.producer as Record<string, unknown>; const role = producer.role;
  const expectedProducer: Record<Wave2ArtifactKind, Wave2AgentRole> = { article_brief: "editorial_coordinator", article_draft: "writing", review_report: "editorial_review", revision_dispatch: "editorial_coordinator", frozen_article_version: "editorial_coordinator" };
  if (role !== expectedProducer[kind]) throw new Wave2ContractError("producer_kind_mismatch", "producer cannot create this artifact kind", 403);
  const producerVersion = text(producer.version, "producer.version", 120);
  if (producerVersion !== WAVE2_ACTIVE_AGENT_VERSIONS[role as Wave2AgentRole]) throw new Wave2ContractError("active_pin_conflict", "producer version is not active", 409);
  const payload = await normalizePayload(kind, input.payload);
  if (runFrom(payload) !== runId || articleFrom(payload) !== articleId || recordingFrom(payload) !== recordingId) throw new Wave2ContractError("artifact_scope_mismatch", "payload identity does not match envelope", 409);
  const inputIds = stringArray(input.input_artifact_ids ?? [], "input_artifact_ids");
  if (kind === "article_brief" && inputIds.length !== 0) throw new Wave2ContractError("artifact_inputs_invalid", "brief cannot have inputs");
  if (kind === "article_draft") {
    const draft = payload as ArticleDraft;
    if (draft.revision === 1 && (inputIds.length !== 1 || draft.parent_artifact_id !== null)) throw new Wave2ContractError("artifact_inputs_invalid", "initial draft must reference its brief only");
    if (draft.revision === 2 && (inputIds.length !== 3 || !draft.parent_artifact_id || !draft.parent_review_artifact_id || !draft.parent_dispatch_artifact_id || !inputIds.includes(draft.parent_artifact_id) || !inputIds.includes(draft.parent_review_artifact_id) || !inputIds.includes(draft.parent_dispatch_artifact_id))) throw new Wave2ContractError("artifact_inputs_invalid", "revision draft must reference draft/review/dispatch");
  }
  if (kind === "review_report" && (inputIds.length !== 1 || inputIds[0] !== (payload as ReviewReport).input_artifact_id)) throw new Wave2ContractError("artifact_inputs_invalid", "review must reference its draft");
  if (kind === "revision_dispatch") { const dispatch = payload as RevisionDispatch; if (inputIds.length !== 2 || !inputIds.includes(dispatch.source_draft_artifact_id) || !inputIds.includes(dispatch.source_review_artifact_id)) throw new Wave2ContractError("artifact_inputs_invalid", "dispatch must reference draft and review"); }
  if (kind === "frozen_article_version") { const frozen = payload as FrozenArticleVersion; if (inputIds.length !== 2 || !inputIds.includes(frozen.draft_artifact_id) || !inputIds.includes(frozen.review_artifact_id)) throw new Wave2ContractError("artifact_inputs_invalid", "frozen version must reference draft and review"); }
  const idempotencyKey = key(input.idempotency_key, "idempotency_key");
  if (kind === "revision_dispatch" && idempotencyKey !== revisionDispatchIdempotencyKey(runId, (payload as RevisionDispatch).source_review_artifact_id)) throw new Wave2ContractError("dispatch_identity_conflict", "one review can have only one canonical revision dispatch", 409);
  const expectedId = await deriveArtifactId(kind, runId, idempotencyKey);
  if (artifactId !== expectedId) throw new Wave2ContractError("artifact_id_not_derived", "artifact id must be derived from logical identity", 409);
  const workflowVersion = text(input.workflow_version ?? WAVE2_WORKFLOW_VERSION, "workflow_version", 120);
  const policyVersion = text(input.policy_version ?? WAVE2_POLICY_VERSION, "policy_version", 120);
  if (workflowVersion !== WAVE2_WORKFLOW_VERSION || policyVersion !== WAVE2_POLICY_VERSION) throw new Wave2ContractError("active_pin_conflict", "workflow or policy version is not active", 409);
  const skillPins = pinMap(input.skill_pins ?? {}, "skill_pins");
  if (kind === "article_draft" || kind === "frozen_article_version") {
    const formattingPin = skillPins.formatting;
    if (!formattingPin || formattingPin.id !== PUBLICATION_SKILL_PINS.formatting.id || formattingPin.version !== PUBLICATION_SKILL_PINS.formatting.version) throw new Wave2ContractError("active_pin_conflict", "formatting skill pin is not active", 409);
  }
  if (kind === "frozen_article_version") {
    const frozenFormatting = (payload as FrozenArticleVersion).formatting_skill;
    const envelopeFormatting = skillPins.formatting;
    if (frozenFormatting.id !== envelopeFormatting.id || frozenFormatting.version !== envelopeFormatting.version) throw new Wave2ContractError("active_pin_conflict", "frozen payload formatting pin differs from envelope", 409);
  }
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload)); const payloadHash = await sha256(payloadBytes); const artifactKeyValue = artifactKey(userId, workspaceId, runId, kind, artifactId);
  if (typeof input.created_at !== "string" || input.created_at.length === 0 || input.created_at.length > 40) throw new Wave2ContractError("created_at_required", "created_at must be supplied by the durable coordinator", 400);
  const createdAt = input.created_at;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw new Wave2ContractError("created_at_required", "created_at must be an ISO UTC timestamp", 400);
  const envelope: ArtifactEnvelope = { schema_version: WAVE2_SCHEMA_VERSION, artifact_id: artifactId, artifact_key: artifactKeyValue, kind, run_id: runId, article_id: articleId, recording_id: recordingId, user_id: userId, workspace_id: workspaceId, producer: { role: role as Wave2AgentRole, version: producerVersion }, workflow_version: workflowVersion, policy_version: policyVersion, skill_pins: skillPins, input_artifact_ids: inputIds, idempotency_key: idempotencyKey, payload_hash: payloadHash, payload_length: payloadBytes.byteLength, created_at: createdAt, storage_ref: `r2://${artifactKeyValue}` };
  return { envelope, payload };
}

export function toArtifactMetadata(object: ArtifactObject): ArtifactMetadata {
  const { envelope, payload } = object; const summary: ArtifactMetadata["payload_summary"] = {};
  if ("blocks" in payload) summary.block_count = payload.blocks.length;
  if ("decision" in payload) { summary.decision = payload.decision; summary.review_round = payload.review_round; }
  if ("content_hash" in payload) summary.content_hash = payload.content_hash;
  if ("style_profile_body_hash" in payload) summary.style_profile_body_hash = payload.style_profile_body_hash;
  if ("revision_limit" in payload) summary.revision_limit = payload.revision_limit;
  return {
    schema_version: envelope.schema_version,
    artifact_id: envelope.artifact_id,
    artifact_key: envelope.artifact_key,
    kind: envelope.kind,
    run_id: envelope.run_id,
    article_id: envelope.article_id,
    recording_id: envelope.recording_id,
    user_id: envelope.user_id,
    workspace_id: envelope.workspace_id,
    producer: { ...envelope.producer },
    workflow_version: envelope.workflow_version,
    policy_version: envelope.policy_version,
    skill_pins: { ...envelope.skill_pins },
    input_artifact_ids: [...envelope.input_artifact_ids],
    idempotency_key: envelope.idempotency_key,
    payload_hash: envelope.payload_hash,
    payload_length: envelope.payload_length,
    created_at: envelope.created_at,
    storage_ref: envelope.storage_ref,
    payload_summary: summary,
  };
}
