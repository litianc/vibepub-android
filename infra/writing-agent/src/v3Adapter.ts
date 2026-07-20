import { DEFAULT_STYLE_PROFILES, findStyleProfile } from "./defaultProfiles";

export const V3_WRITING_ADAPTER_VERSION = "writing-v3.adapter.1.0.0";
export const V3_WRITING_MODEL_VERSION = "glm-5.2";
export const V3_FORMATTING_SKILL = { id: "md_to_wechat", version: "1.0.0" } as const;
export const V3_DEFAULT_STYLE_PROFILE = { id: "style_litianc_default", version: "2026-07-05" } as const;
export const V3_PROTOCOL_VERSION = "vibepub.editorial.v3";
export const V3_TIMEOUT_MS = 30_000;

export type V3Block = {
  block_id: string;
  kind: "paragraph" | "heading" | "quote" | "list" | "code" | "table";
  order: number;
  text: string;
  text_hash: string;
  claim_ids: string[];
  image_ref_ids: string[];
};

type ArtifactRef = { artifact_id: string; payload_hash: string };

type DraftPayload = Record<string, unknown> & {
  article_id: string;
  run_id: string;
  recording_id: number;
  source_hash: string;
  content_hash: string;
  revision: number;
  title: string;
  body: string;
  blocks: V3Block[];
  title_candidates: string[];
  selected_title: string;
  cover_title: string[];
  adapter_version: string;
  model_version: string;
  formatting_skill: { id: string; version: string };
  profile_pins: Record<string, { id: string; version: string }>;
  style_profile_body_hash?: string;
};

type CurrentDraft = ArtifactRef & { payload: DraftPayload };

type ReviewPayload = Record<string, unknown> & {
  article_id: string;
  run_id: string;
  recording_id: number;
  input_artifact_id: string;
  input_payload_hash: string;
  decision: "pass" | "revise" | "block";
  revision_targets: string[];
};

type ReviewRef = ArtifactRef & { payload: ReviewPayload };

type RevisionDispatchPayload = Record<string, unknown> & {
  article_id: string;
  run_id: string;
  recording_id: number;
  source_draft_artifact_id: string;
  source_draft_payload_hash: string;
  source_review_artifact_id: string;
  source_review_payload_hash: string;
  target_block_ids: string[];
  target: string[];
  protected_block_hashes: Record<string, string>;
  revision_limit: 1;
  instruction_text: string;
  producer_pins: Array<{ id: string; version: string }>;
};

type RevisionDispatchRef = ArtifactRef & { payload: RevisionDispatchPayload };

export type V3WriteRequest = {
  protocol_version: string;
  job_id: string;
  idempotency_key: string;
  mode: "initial" | "revision";
  article_id: string;
  run_id: string;
  recording_id: number;
  source_text?: string;
  source_hash?: string;
  current_draft?: CurrentDraft;
  review_report?: ReviewRef;
  revision_dispatch?: RevisionDispatchRef;
  formatting_skill_id?: string;
  formatting_skill_version?: string;
  style_profile_id?: string;
  style_profile_version?: string;
  style_profile_body?: string;
  style_profile_body_hash?: string;
};

export type V3ArticleDraft = {
  article_id: string;
  run_id: string;
  recording_id: number;
  revision: number;
  parent_artifact_id: string | null;
  parent_review_artifact_id: string | null;
  parent_dispatch_artifact_id: string | null;
  title: string;
  body: string;
  blocks: V3Block[];
  title_candidates: string[];
  selected_title: string;
  cover_title: string[];
  adapter_version: string;
  model_version: string;
  formatting_skill: typeof V3_FORMATTING_SKILL;
  profile_pins: Record<string, { id: string; version: string }>;
  style_profile_body_hash?: string;
  content_hash: string;
  claim_ledger: Array<{
    claim_id: string;
    block_id: string;
    classification: "author_view" | "source_fact" | "external_fact";
    verification_status: "not_required" | "pending" | "verified" | "failed";
  }>;
  changed_block_ids: string[];
  source_hash: string;
};

type ResolvedStyleProfile = {
  id: string;
  version: string;
  body: string;
  bodyHash: string;
};

export class V3WritingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "V3WritingError";
  }
}

function fail(code: string, status: number, retryable = false): never {
  throw new V3WritingError(code, code.replaceAll("_", " "), status, retryable);
}

function stringValue(value: unknown, _field: string, max = 1_000, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max) fail("invalid_request", 400);
  return value;
}

function safeId(value: unknown): string {
  const result = stringValue(value, "id", 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result)) fail("invalid_request", 400);
  return result;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

async function contentHash(title: string, body: string, blocks: V3Block[]): Promise<string> {
  return hashText(canonical({ title, body, blocks }));
}

async function blockFromText(value: string, index: number): Promise<V3Block> {
  const text = value.trim();
  return {
    block_id: `block_v1_${index + 1}`,
    kind: "paragraph",
    order: index,
    text,
    text_hash: await hashText(text),
    claim_ids: [],
    image_ref_ids: [],
  };
}

async function normalizeBlocks(value: unknown, emptyBody?: string, requireTextHash = false, errorCode = "invalid_model_response", status = 502): Promise<V3Block[]> {
  if (Array.isArray(value) && value.length > 0) {
    return Promise.all(value.map(async (raw, index) => {
      if (!raw || typeof raw !== "object") fail(errorCode, status);
      const record = raw as Record<string, unknown>;
      const text = stringValue(record.text, `blocks[${index}].text`, 100_000).trim();
      if (!/^(paragraph|heading|quote|list|code|table)$/.test(String(record.kind)) || record.block_id !== `block_v1_${index + 1}` || record.order !== index) fail(errorCode, status);
      const computedTextHash = await hashText(text);
      if (record.text_hash !== undefined && (!validHash(record.text_hash) || record.text_hash !== computedTextHash)) fail(errorCode, status);
      if (requireTextHash && record.text_hash === undefined) fail(errorCode, status);
      if (!Array.isArray(record.claim_ids) || record.claim_ids.length > 64 || record.claim_ids.some(item => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item))) fail(errorCode, status);
      if (!Array.isArray(record.image_ref_ids) || record.image_ref_ids.length > 32 || record.image_ref_ids.some(item => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item))) fail(errorCode, status);
      const claims = record.claim_ids as string[];
      const images = record.image_ref_ids as string[];
      return { block_id: record.block_id, kind: record.kind as V3Block["kind"], order: index, text, text_hash: computedTextHash, claim_ids: claims, image_ref_ids: images } satisfies V3Block;
    }));
  }
  if (typeof emptyBody !== "string" || emptyBody.trim().length === 0) fail(errorCode, status);
  return Promise.all(emptyBody.split(/\n{2,}/).map(blockFromText));
}

function assertClaimLedgerMatchesBlocks(blocks: V3Block[], ledger: V3ArticleDraft["claim_ledger"], errorCode = "invalid_model_response", status = 502): void {
  const blockIds = new Set(blocks.map(block => block.block_id));
  const ledgerClaims = new Map<string, string[]>();
  const claimIds = new Set<string>();
  for (const claim of ledger) {
    if (!blockIds.has(claim.block_id) || claimIds.has(claim.claim_id)) fail(errorCode, status);
    claimIds.add(claim.claim_id);
    const claims = ledgerClaims.get(claim.block_id) || [];
    claims.push(claim.claim_id);
    ledgerClaims.set(claim.block_id, claims);
  }
  for (const block of blocks) {
    const expected = [...new Set(block.claim_ids)].sort();
    const actual = [...new Set(ledgerClaims.get(block.block_id) || [])].sort();
    if (expected.length !== block.claim_ids.length || canonical(expected) !== canonical(actual)) fail(errorCode, status);
  }
}

function validateTitleMetadata(title: string, titleCandidates: string[], selectedTitle: string, coverTitle: string[], errorCode = "invalid_model_response", status = 502): void {
  if (titleCandidates.length === 0 || selectedTitle !== title || !titleCandidates.includes(selectedTitle)) fail(errorCode, status);
  if (coverTitle.length < 1 || coverTitle.length > 4) fail(errorCode, status);
}

function normalizeClaims(value: unknown, blocks: V3Block[], errorCode = "invalid_model_response", status = 502): V3ArticleDraft["claim_ledger"] {
  if (!Array.isArray(value) || value.length > 256) fail(errorCode, status);
  const blockIds = new Set(blocks.map(block => block.block_id));
  const claimIds = new Set<string>();
  const ledger = value.map(raw => {
    if (!raw || typeof raw !== "object") fail(errorCode, status);
    const claim = raw as Record<string, unknown>;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(String(claim.claim_id)) || claimIds.has(String(claim.claim_id)) || !blockIds.has(String(claim.block_id))) fail(errorCode, status);
    claimIds.add(String(claim.claim_id));
    if (!(claim.classification === "author_view" || claim.classification === "source_fact" || claim.classification === "external_fact")) fail(errorCode, status);
    if (!(claim.verification_status === "not_required" || claim.verification_status === "pending" || claim.verification_status === "verified" || claim.verification_status === "failed")) fail(errorCode, status);
    return {
      claim_id: String(claim.claim_id),
      block_id: String(claim.block_id),
      classification: claim.classification as V3ArticleDraft["claim_ledger"][number]["classification"],
      verification_status: claim.verification_status as V3ArticleDraft["claim_ledger"][number]["verification_status"],
    };
  });
  assertClaimLedgerMatchesBlocks(blocks, ledger, errorCode, status);
  return ledger;
}

async function normalizeModelDraft(value: unknown, request: V3WriteRequest, style: ResolvedStyleProfile, modelVersion: string): Promise<Omit<V3ArticleDraft, "revision" | "parent_artifact_id" | "parent_review_artifact_id" | "parent_dispatch_artifact_id">> {
  if (!value || typeof value !== "object") fail("invalid_model_response", 502);
  const record = value as Record<string, unknown>;
  const title = stringValue(record.title, "title", 2_000);
  const blocks = await normalizeBlocks(record.blocks);
  const body = blocks.map(block => block.text).join("\n\n");
  if (record.body !== undefined && (typeof record.body !== "string" || record.body !== body)) fail("invalid_model_response", 502);
  if (!Array.isArray(record.title_candidates) || record.title_candidates.length === 0 || record.title_candidates.length > 20 || record.title_candidates.some(item => typeof item !== "string" || item.length === 0 || item.length > 2_000)) fail("invalid_model_response", 502);
  const titleCandidates = record.title_candidates as string[];
  const selectedTitle = stringValue(record.selected_title, "selected_title", 2_000);
  if (!Array.isArray(record.cover_title) || record.cover_title.length < 1 || record.cover_title.length > 4 || record.cover_title.some(item => typeof item !== "string" || item.length === 0 || item.length > 2_000)) fail("invalid_model_response", 502);
  const coverTitle = record.cover_title as string[];
  validateTitleMetadata(title, titleCandidates, selectedTitle, coverTitle);
  return {
    article_id: request.article_id,
    run_id: request.run_id,
    recording_id: request.recording_id,
    title,
    body,
    blocks,
    title_candidates: titleCandidates,
    selected_title: selectedTitle,
    cover_title: coverTitle,
    adapter_version: V3_WRITING_ADAPTER_VERSION,
    model_version: modelVersion,
    formatting_skill: V3_FORMATTING_SKILL,
    profile_pins: { style: { id: style.id, version: style.version }, formatting: V3_FORMATTING_SKILL },
    ...(style.id === V3_DEFAULT_STYLE_PROFILE.id ? {} : { style_profile_body_hash: style.bodyHash }),
    content_hash: await contentHash(title, body, blocks),
    claim_ledger: normalizeClaims(record.claim_ledger, blocks),
    changed_block_ids: [],
    source_hash: validHash(request.source_hash) ? request.source_hash : await hashText(request.source_text || ""),
  };
}

async function resolveStyleProfile(request: V3WriteRequest): Promise<ResolvedStyleProfile> {
  const id = request.style_profile_id ?? V3_DEFAULT_STYLE_PROFILE.id;
  const version = request.style_profile_version ?? V3_DEFAULT_STYLE_PROFILE.version;
  if (!safeId(id) || typeof version !== "string" || version.length === 0) fail("style_profile_invalid", 409);
  const inlineBody = request.style_profile_body;
  const inlineHash = request.style_profile_body_hash;
  if (inlineBody !== undefined && typeof inlineBody !== "string") fail("style_profile_invalid", 409);
  if (inlineHash !== undefined && !validHash(inlineHash)) fail("style_profile_hash_invalid", 409);
  const registered = findStyleProfile(id);
  if (registered && registered.version !== version) fail("style_profile_version_conflict", 409);
  if (!registered && (!inlineBody || !inlineHash)) fail("style_profile_not_found", 409);
  const body = inlineBody ?? registered?.body;
  if (!body) fail("style_profile_body_required", 409);
  const actualHash = await hashText(body);
  if (inlineHash !== undefined && inlineHash !== actualHash) fail("style_profile_hash_mismatch", 409);
  if (registered && inlineBody !== undefined && actualHash !== await hashText(registered.body)) fail("style_profile_pin_body_conflict", 409);
  return { id, version, body, bodyHash: actualHash };
}

function validateFormattingSkill(request: V3WriteRequest): void {
  const id = request.formatting_skill_id ?? V3_FORMATTING_SKILL.id;
  const version = request.formatting_skill_version ?? V3_FORMATTING_SKILL.version;
  if (id !== V3_FORMATTING_SKILL.id) fail("formatting_profile_not_found", 404);
  if (version !== V3_FORMATTING_SKILL.version) fail("formatting_profile_version_conflict", 409);
}

async function validateRevisionInputs(request: V3WriteRequest, style: ResolvedStyleProfile, modelVersion: string): Promise<void> {
  const draft = request.current_draft;
  const review = request.review_report;
  const dispatch = request.revision_dispatch;
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (!draft || !safeId(draft.artifact_id) || !validHash(draft.payload_hash) || !isRecord(draft.payload) || !review || !dispatch || !safeId(review.artifact_id) || !validHash(review.payload_hash) || !isRecord(review.payload) || !safeId(dispatch.artifact_id) || !validHash(dispatch.payload_hash) || !isRecord(dispatch.payload)) fail("revision_input_required", 400);
  const draftPayload = draft.payload;
  const reviewPayload = review.payload;
  const dispatchPayload = dispatch.payload;
  if (await hashText(canonical(draftPayload)) !== draft.payload_hash || await hashText(canonical(reviewPayload)) !== review.payload_hash || await hashText(canonical(dispatchPayload)) !== dispatch.payload_hash) fail("artifact_payload_hash_mismatch", 409);
  if (draftPayload.article_id !== request.article_id || draftPayload.run_id !== request.run_id || draftPayload.recording_id !== request.recording_id || draftPayload.revision !== 1 || typeof draftPayload.title !== "string" || typeof draftPayload.body !== "string" || !validHash(draftPayload.source_hash) || !validHash(draftPayload.content_hash) || !Array.isArray(draftPayload.blocks) || draftPayload.blocks.some(block => !isRecord(block)) || !Array.isArray(draftPayload.claim_ledger) || !isRecord(draftPayload.formatting_skill) || !isRecord(draftPayload.profile_pins)) fail("revision_input_invalid", 409);
  if (!Array.isArray(draftPayload.title_candidates) || draftPayload.title_candidates.length === 0 || draftPayload.title_candidates.length > 20 || draftPayload.title_candidates.some(candidate => typeof candidate !== "string" || candidate.length === 0 || candidate.length > 2_000) || typeof draftPayload.selected_title !== "string" || !Array.isArray(draftPayload.cover_title) || draftPayload.cover_title.length < 1 || draftPayload.cover_title.length > 4 || draftPayload.cover_title.some(candidate => typeof candidate !== "string" || candidate.length === 0 || candidate.length > 2_000)) fail("revision_input_invalid", 409);
  validateTitleMetadata(draftPayload.title, draftPayload.title_candidates as string[], draftPayload.selected_title, draftPayload.cover_title as string[], "revision_input_invalid", 409);
  const styleBodyHashMatches = style.id === V3_DEFAULT_STYLE_PROFILE.id
    ? draftPayload.style_profile_body_hash === undefined
    : draftPayload.style_profile_body_hash === style.bodyHash;
  if (draftPayload.adapter_version !== V3_WRITING_ADAPTER_VERSION || draftPayload.model_version !== modelVersion || draftPayload.formatting_skill.id !== V3_FORMATTING_SKILL.id || draftPayload.formatting_skill.version !== V3_FORMATTING_SKILL.version || !isRecord(draftPayload.profile_pins.style) || draftPayload.profile_pins.style.id !== style.id || draftPayload.profile_pins.style.version !== style.version || !isRecord(draftPayload.profile_pins.formatting) || draftPayload.profile_pins.formatting.id !== V3_FORMATTING_SKILL.id || draftPayload.profile_pins.formatting.version !== V3_FORMATTING_SKILL.version || !styleBodyHashMatches) fail("style_profile_pin_conflict", 409);
  if (request.source_hash !== undefined && request.source_hash !== draftPayload.source_hash) fail("source_hash_mismatch", 409);
  const currentBlocks = await normalizeBlocks(draftPayload.blocks, undefined, true, "revision_input_invalid", 409);
  normalizeClaims(draftPayload.claim_ledger, currentBlocks, "revision_input_invalid", 409);
  if (draftPayload.body !== currentBlocks.map(block => block.text).join("\n\n") || draftPayload.content_hash !== await contentHash(draftPayload.title, draftPayload.body, currentBlocks)) fail("current_draft_hash_mismatch", 409);
  if (reviewPayload.article_id !== request.article_id || reviewPayload.run_id !== request.run_id || reviewPayload.recording_id !== request.recording_id || reviewPayload.decision !== "revise" || reviewPayload.input_artifact_id !== draft.artifact_id || reviewPayload.input_payload_hash !== draft.payload_hash || !Array.isArray(reviewPayload.revision_targets)) fail("revision_input_conflict", 409);
  if (dispatchPayload.article_id !== request.article_id || dispatchPayload.run_id !== request.run_id || dispatchPayload.recording_id !== request.recording_id || dispatchPayload.source_draft_artifact_id !== draft.artifact_id || dispatchPayload.source_draft_payload_hash !== draft.payload_hash || dispatchPayload.source_review_artifact_id !== review.artifact_id || dispatchPayload.source_review_payload_hash !== review.payload_hash || dispatchPayload.revision_limit !== 1 || typeof dispatchPayload.instruction_text !== "string" || dispatchPayload.instruction_text.length === 0) fail("revision_dispatch_conflict", 409);
  const expectedProducerPins = [
    { id: "editorial_coordinator", version: "editorial-coordinator.agent.v3" },
    { id: "writing", version: "writing.agent.v3" },
    { id: "editorial_review", version: "editorial-review.agent.v3" },
  ];
  if (!Array.isArray(dispatchPayload.producer_pins) || canonical(dispatchPayload.producer_pins) !== canonical(expectedProducerPins)) fail("agent_version_conflict", 409);
  if (!Array.isArray(dispatchPayload.target) || !Array.isArray(dispatchPayload.target_block_ids) || !isRecord(dispatchPayload.protected_block_hashes)) fail("revision_dispatch_invalid", 409);
  const reviewTargets = [...new Set(reviewPayload.revision_targets)].sort();
  const dispatchTargets = [...new Set(dispatchPayload.target)].sort();
  const dispatchBlockTargets = [...new Set(dispatchPayload.target_block_ids)].sort();
  if (reviewTargets.length !== reviewPayload.revision_targets.length || dispatchTargets.length !== dispatchPayload.target.length || dispatchBlockTargets.length !== dispatchPayload.target_block_ids.length) fail("revision_target_conflict", 409);
  if (canonical(reviewTargets) !== canonical(dispatchTargets) || canonical(dispatchBlockTargets) !== canonical(dispatchTargets.filter(target => target !== "@title"))) fail("revision_target_conflict", 409);
  const targetIds = new Set(dispatchTargets);
  const validIds = new Set(["@title", ...draftPayload.blocks.map(block => block.block_id)]);
  if (targetIds.size === 0 || [...targetIds].some(target => !validIds.has(target))) fail("revision_dispatch_invalid", 409);
  const protectedHashes = dispatchPayload.protected_block_hashes;
  if (!protectedHashes || typeof protectedHashes !== "object") fail("protected_block_hash_mismatch", 409);
  const expectedProtected = new Set(draftPayload.blocks.filter(block => !targetIds.has(block.block_id)).map(block => block.block_id));
  if (!targetIds.has("@title")) expectedProtected.add("@title");
  if (canonical(Object.keys(protectedHashes).sort()) !== canonical([...expectedProtected].sort())) fail("protected_block_hash_mismatch", 409);
  for (const block of draftPayload.blocks) if (!targetIds.has(block.block_id) && protectedHashes[block.block_id] !== block.text_hash) fail("protected_block_hash_mismatch", 409);
  if (!targetIds.has("@title") && protectedHashes["@title"] !== await hashText(draftPayload.title)) fail("protected_title_hash_mismatch", 409);
}

async function validateInitialSource(request: V3WriteRequest): Promise<void> {
  const source = stringValue(request.source_text, "source_text", 200_000);
  if (!source.trim()) fail("invalid_request", 400);
  const actualHash = await hashText(source);
  if (request.source_hash !== undefined && (!validHash(request.source_hash) || request.source_hash !== actualHash)) fail("source_hash_mismatch", 409);
}

function validateRequest(input: V3WriteRequest): V3WriteRequest {
  if (input.protocol_version !== V3_PROTOCOL_VERSION) fail("protocol_version_conflict", 409);
  if (input.mode !== "initial" && input.mode !== "revision") fail("invalid_request", 400);
  safeId(input.job_id); safeId(input.idempotency_key); safeId(input.article_id); safeId(input.run_id);
  if (!Number.isSafeInteger(input.recording_id) || input.recording_id < 1) fail("invalid_request", 400);
  validateFormattingSkill(input);
  return input;
}

function promptFor(request: V3WriteRequest, style: ResolvedStyleProfile): string {
  if (request.mode === "initial") return `${style.body}\n\n请将以下受控素材写成结构化文章，返回完整 JSON：title、blocks（含 block_id、kind、order、text、claim_ids、image_ref_ids；body 与 text_hash 由 adapter 计算）、claim_ledger、title_candidates、selected_title、cover_title。claim_ledger 必须完整覆盖 blocks 中的 claim_ids。\n${request.source_text}`;
  const draft = request.current_draft!.payload;
  const dispatch = request.revision_dispatch!.payload;
  const currentDraftProjection = {
    title: draft.title,
    body: draft.body,
    blocks: draft.blocks.map(block => ({ block_id: block.block_id, kind: block.kind, order: block.order, text: block.text, text_hash: block.text_hash, claim_ids: block.claim_ids, image_ref_ids: block.image_ref_ids })),
    claim_ledger: draft.claim_ledger,
    title_candidates: draft.title_candidates,
    selected_title: draft.selected_title,
    cover_title: draft.cover_title,
  };
  const revisionScope = { target: dispatch.target, target_block_ids: dispatch.target_block_ids, issue_codes: dispatch.issue_codes, instruction_text: dispatch.instruction_text };
  return `${style.body}\n\n只修改 RevisionDispatch 指定的目标，未指定的标题、block 和 claim_ledger 条目必须逐字保留。返回完整 JSON：title、blocks（含 block_id、kind、order、text、claim_ids、image_ref_ids；body 与 text_hash 由 adapter 计算）、claim_ledger、title_candidates、selected_title、cover_title。claim_ledger 必须完整覆盖 blocks 中的 claim_ids。\n受控修订范围（canonical 白名单）：${canonical(revisionScope)}\n当前 Draft（canonical 白名单，只读）：${canonical(currentDraftProjection)}`;
}

function modelError(status: number): V3WritingError {
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) return new V3WritingError("upstream_retryable", "writing service temporarily unavailable", status, true);
  if (status === 401 || status === 403) return new V3WritingError("upstream_unauthorized", "writing service authorization failed", status, false);
  return new V3WritingError("upstream_failed", "writing service rejected the request", status, false);
}

async function applyRevision(normalized: Omit<V3ArticleDraft, "revision" | "parent_artifact_id" | "parent_review_artifact_id" | "parent_dispatch_artifact_id">, request: V3WriteRequest, style: ResolvedStyleProfile, modelVersion: string): Promise<V3ArticleDraft> {
  await validateRevisionInputs(request, style, modelVersion);
  const current = request.current_draft!;
  const dispatch = request.revision_dispatch!;
  const currentPayload = current.payload;
  const currentBlocks = await normalizeBlocks(currentPayload.blocks, undefined, true, "revision_input_invalid", 409);
  const currentClaims = normalizeClaims(currentPayload.claim_ledger, currentBlocks, "revision_input_invalid", 409);
  const targets = new Set(dispatch.payload.target);
  const incomingById = new Map(normalized.blocks.map(block => [block.block_id, block]));
  if (normalized.blocks.length !== currentPayload.blocks.length) fail("revision_structure_changed", 409);
  const blocks = currentPayload.blocks.map((oldBlock, index) => {
    const next = incomingById.get(oldBlock.block_id);
    if (!next || next.order !== index || next.block_id !== oldBlock.block_id) fail("revision_structure_changed", 409);
    if (!targets.has(oldBlock.block_id) && canonical(next) !== canonical(oldBlock)) fail("protected_block_changed", 409);
    if (!targets.has(oldBlock.block_id)) {
      const oldClaims = currentClaims.filter(claim => claim.block_id === oldBlock.block_id).sort((left, right) => left.claim_id < right.claim_id ? -1 : left.claim_id > right.claim_id ? 1 : 0);
      const nextClaims = normalized.claim_ledger.filter(claim => claim.block_id === oldBlock.block_id).sort((left, right) => left.claim_id < right.claim_id ? -1 : left.claim_id > right.claim_id ? 1 : 0);
      if (canonical(oldClaims) !== canonical(nextClaims)) fail("protected_claim_ledger_changed", 409);
    }
    return next;
  });
  const title = targets.has("@title") ? normalized.title : currentPayload.title;
  if (!targets.has("@title") && normalized.title !== currentPayload.title) fail("protected_title_changed", 409);
  if (!targets.has("@title") && (canonical(normalized.title_candidates) !== canonical(currentPayload.title_candidates) || normalized.selected_title !== currentPayload.selected_title || canonical(normalized.cover_title) !== canonical(currentPayload.cover_title))) fail("protected_title_metadata_changed", 409);
  const titleMetadataChanged = canonical({ title: normalized.title, title_candidates: normalized.title_candidates, selected_title: normalized.selected_title, cover_title: normalized.cover_title }) !== canonical({ title: currentPayload.title, title_candidates: currentPayload.title_candidates, selected_title: currentPayload.selected_title, cover_title: currentPayload.cover_title });
  const body = blocks.map(block => block.text).join("\n\n");
  const changedBlockIds = blocks.filter((block, index) => canonical(block) !== canonical(currentPayload.blocks[index])).map(block => block.block_id);
  if (targets.has("@title") && titleMetadataChanged) changedBlockIds.unshift("@title");
  return {
    ...normalized,
    title,
    body,
    blocks,
    revision: 2,
    parent_artifact_id: current.artifact_id,
    parent_review_artifact_id: request.review_report!.artifact_id,
    parent_dispatch_artifact_id: dispatch.artifact_id,
    changed_block_ids: [...new Set(changedBlockIds)],
    source_hash: currentPayload.source_hash,
    content_hash: await contentHash(title, body, blocks),
  };
}

export async function runV3WritingAdapter(env: {
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
}, rawRequest: V3WriteRequest, fetchImpl: typeof fetch = fetch): Promise<V3ArticleDraft> {
  const request = validateRequest(rawRequest);
  const style = await resolveStyleProfile(request);
  const modelVersion = stringValue(env.GLM_MODEL || V3_WRITING_MODEL_VERSION, "model_version", 120);
  if (request.mode === "revision") await validateRevisionInputs(request, style, modelVersion);
  else await validateInitialSource(request);
  const apiKey = env.GLM_API_KEY?.trim();
  if (!apiKey) fail("upstream_unconfigured", 503, false);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), V3_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${(env.GLM_BASE_URL || "https://open.bigmodel.cn/api/coding/paas/v4/").replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.GLM_MODEL || V3_WRITING_MODEL_VERSION, messages: [{ role: "user", content: promptFor(request, style) }], response_format: { type: "json_object" }, temperature: 0.2 }),
        signal: controller.signal,
      });
    } catch {
      throw new V3WritingError("upstream_timeout", "writing service request timed out", 504, true);
    }
    if (!response.ok) throw modelError(response.status);
    let parsed: unknown;
    try { parsed = JSON.parse(await response.text()); } catch { fail("invalid_model_response", 502); }
    const content = (parsed as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
    if (typeof content !== "string") fail("invalid_model_response", 502);
    let modelPayload: unknown;
    try { modelPayload = JSON.parse(content); } catch { fail("invalid_model_response", 502); }
    const normalized = await normalizeModelDraft(modelPayload, request, style, modelVersion);
    if (request.mode === "revision") return applyRevision(normalized, request, style, modelVersion);
    return { ...normalized, revision: 1, parent_artifact_id: null, parent_review_artifact_id: null, parent_dispatch_artifact_id: null };
  } finally {
    clearTimeout(timeout);
  }
}
