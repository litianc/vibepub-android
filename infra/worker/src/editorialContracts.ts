export const EDITORIAL_CONTRACT_VERSION = "editorial.v1";

export const VERSION_SOURCES = [
  "initial",
  "revision",
  "human_final",
  "legacy_snapshot",
] as const;

export const REVIEW_DECISIONS = ["pass", "revise", "block"] as const;
export const FINDING_SEVERITIES = ["P0", "P1", "P2"] as const;
export const PIPELINE_STAGES = [
  "queued",
  "asr",
  "draft_generated",
  "review_pending",
  "reviewed",
  "revision_pending",
  "content_frozen",
  "visuals_generating",
  "rendering",
  "visual_qa",
  "draft_sync",
  "completed",
  "failed",
] as const;

export type VersionSource = (typeof VERSION_SOURCES)[number];
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const PIPELINE_TRANSITIONS: Record<PipelineStage, readonly PipelineStage[]> = {
  queued: ["asr", "draft_generated", "failed"],
  asr: ["draft_generated", "failed"],
  draft_generated: ["review_pending", "failed"],
  review_pending: ["reviewed", "revision_pending", "failed"],
  reviewed: ["content_frozen", "revision_pending", "failed"],
  revision_pending: ["draft_generated", "failed"],
  content_frozen: ["visuals_generating", "rendering", "failed"],
  visuals_generating: ["rendering", "failed"],
  rendering: ["visual_qa", "failed"],
  visual_qa: ["draft_sync", "failed"],
  draft_sync: ["completed", "failed"],
  completed: [],
  failed: ["queued"],
};

export type ArticleBlock = {
  block_id: string;
  kind: string;
  order: number;
  text: string;
  claim_ids?: string[];
  image_ids?: string[];
};

export type ClaimLedgerEntry = {
  claim_id: string;
  block_id: string;
  classification: "author_view" | "source_fact" | "external_fact";
  verification_required: boolean;
  verification_status?: "not_required" | "pending" | "verified" | "failed";
};

export type VisualPlanItem = {
  visual_id: string;
  block_id: string;
  purpose: string;
  kind: "cover" | "illustration" | "chart";
  aspect_ratio: string;
  alt: string;
  caption?: string;
  source: "generated" | "provided" | "data";
  data_provenance?: string;
};

export type ReviewFinding = {
  severity: FindingSeverity;
  code: string;
  block_id?: string;
  evidence?: string;
  suggested_action?: string;
  requires_human: boolean;
};

export type NormalizedVersionInput = {
  article_id: string;
  recording_id: number;
  parent_version_id: string | null;
  source: VersionSource;
  source_job_id: string | null;
  source_hash: string | null;
  title: string;
  body: string;
  cover: Record<string, unknown>;
  blocks: ArticleBlock[];
  title_candidates: string[];
  selected_title: string;
  cover_title: string[];
  claim_ledger: ClaimLedgerEntry[];
  visual_plan: VisualPlanItem[];
  formatting_skill_id: string | null;
  formatting_skill_version: string | null;
  content_html_hash: string | null;
  html_warnings: string[];
  generation_status: "generated" | "review_pending" | "reviewed" | "frozen";
  idempotency_key: string;
};

export type NormalizedReviewInput = {
  findings: ReviewFinding[];
  decision: ReviewDecision;
  reviewer_version: string;
  idempotency_key: string;
};

export type NormalizedVisualPlanInput = {
  items: VisualPlanItem[];
  idempotency_key: string;
};

export class EditorialContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "EditorialContractError";
  }
}

export function canAdvancePipelineStage(from: PipelineStage, to: PipelineStage): boolean {
  return PIPELINE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPipelineStageTransition(from: PipelineStage, to: PipelineStage): void {
  if (!canAdvancePipelineStage(from, to)) {
    throw new EditorialContractError("invalid_pipeline_transition", `${from} cannot advance to ${to}`, 409);
  }
}

export function normalizeVersionInput(body: unknown): NormalizedVersionInput {
  const record = objectValue(body, "version payload");
  const articleId = requiredId(record.article_id ?? record.articleId, "article_id");
  const recordingId = positiveInteger(record.recording_id ?? record.recordingId, "recording_id");
  const source = enumValue(record.source, VERSION_SOURCES, "source");
  const title = requiredText(record.title, "title", 300);
  const bodyText = requiredText(record.body ?? record.content ?? record.content_html, "body", 500_000);
  const idempotencyKey = requiredKey(record.idempotency_key ?? record.idempotencyKey, "idempotency_key");
  const parentVersionId = optionalId(record.parent_version_id ?? record.parentVersionId);

  if (source === "initial" && parentVersionId) {
    throw new EditorialContractError("parent_not_allowed_for_initial", "initial version cannot have a parent");
  }
  if (source === "revision" && !parentVersionId) {
    throw new EditorialContractError("parent_required_for_revision", "revision version requires parent_version_id");
  }

  const blocks = normalizeBlocks(record.blocks, bodyText);
  const claimLedger = normalizeClaimLedger(record.claim_ledger ?? record.claimLedger, blocks);
  const visualPlan = normalizeVisualPlan(record.visual_plan ?? record.visualPlan, blocks);
  const titleCandidates = stringArray(record.title_candidates ?? record.titleCandidates, "title_candidates", 12, 300);
  const selectedTitle = optionalText(record.selected_title ?? record.selectedTitle, 300) || title;
  const coverTitle = stringArray(record.cover_title ?? record.coverTitle, "cover_title", 4, 120);
  const htmlWarnings = stringArray(record.html_warnings ?? record.htmlWarnings, "html_warnings", 32, 500);

  return {
    article_id: articleId,
    recording_id: recordingId,
    parent_version_id: parentVersionId,
    source,
    source_job_id: optionalId(record.source_job_id ?? record.sourceJobId),
    source_hash: optionalText(record.source_hash ?? record.sourceHash, 200),
    title,
    body: bodyText,
    cover: objectValue(record.cover ?? {
      cover_title: coverTitle,
      cover_subtitle: optionalText(record.cover_subtitle ?? record.coverSubtitle, 300),
      image_prompt: optionalText(record.image_prompt ?? record.imagePrompt, 2_000),
    }, "cover"),
    blocks,
    title_candidates: titleCandidates,
    selected_title: selectedTitle,
    cover_title: coverTitle,
    claim_ledger: claimLedger,
    visual_plan: visualPlan,
    formatting_skill_id: optionalId(record.formatting_skill_id ?? record.formattingSkillId),
    formatting_skill_version: optionalText(record.formatting_skill_version ?? record.formattingSkillVersion, 80),
    content_html_hash: optionalText(record.content_html_hash ?? record.contentHtmlHash, 200),
    html_warnings: htmlWarnings,
    generation_status: enumValue(
      record.generation_status ?? record.generationStatus ?? "frozen",
      ["generated", "review_pending", "reviewed", "frozen"] as const,
      "generation_status",
    ),
    idempotency_key: idempotencyKey,
  };
}

export function normalizeReviewInput(body: unknown): NormalizedReviewInput {
  const record = objectValue(body, "review payload");
  const findingsValue = record.findings;
  if (!Array.isArray(findingsValue)) {
    throw new EditorialContractError("findings_required", "findings must be an array");
  }
  const findings = findingsValue.map((finding, index) => normalizeFinding(finding, index));
  const decision = enumValue(record.decision, REVIEW_DECISIONS, "decision");
  if (findings.some(finding => finding.severity === "P0") && decision !== "block") {
    throw new EditorialContractError("p0_requires_block", "P0 findings must block the article");
  }
  if (findings.some(finding => finding.severity === "P1") && decision === "pass") {
    throw new EditorialContractError("p1_requires_revision", "P1 findings require revision or block");
  }
  return {
    findings,
    decision,
    reviewer_version: requiredText(record.reviewer_version ?? record.reviewerVersion, "reviewer_version", 120),
    idempotency_key: requiredKey(record.idempotency_key ?? record.idempotencyKey, "idempotency_key"),
  };
}

export function normalizeVisualPlanInput(body: unknown, blocks: ArticleBlock[]): NormalizedVisualPlanInput {
  const record = objectValue(body, "visual plan payload");
  const items = normalizeVisualPlan(record.items ?? record.visual_plan, blocks);
  if (items.length === 0) {
    throw new EditorialContractError("visual_plan_empty", "visual plan requires at least one item");
  }
  return {
    items,
    idempotency_key: requiredKey(record.idempotency_key ?? record.idempotencyKey, "idempotency_key"),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function normalizeBlocks(value: unknown, body: string): ArticleBlock[] {
  if (value === undefined) {
    return body
      .split(/\n+/)
      .map(text => text.trim())
      .filter(Boolean)
      .map((text, order) => ({ block_id: `block_${order + 1}`, kind: "paragraph", order, text }));
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new EditorialContractError("blocks_required", "blocks must be a non-empty array");
  }
  const blockIds = new Set<string>();
  return value.map((item, index) => {
    const record = objectValue(item, `blocks[${index}]`);
    const blockId = requiredId(record.block_id ?? record.blockId, `blocks[${index}].block_id`);
    if (blockIds.has(blockId)) {
      throw new EditorialContractError("duplicate_block_id", `duplicate block_id: ${blockId}`);
    }
    blockIds.add(blockId);
    const order = nonNegativeInteger(record.order, `blocks[${index}].order`);
    return {
      block_id: blockId,
      kind: requiredText(record.kind, `blocks[${index}].kind`, 80),
      order,
      text: requiredText(record.text, `blocks[${index}].text`, 50_000),
      claim_ids: stringArray(record.claim_ids ?? record.claimIds, `blocks[${index}].claim_ids`, 32, 120),
      image_ids: stringArray(record.image_ids ?? record.imageIds, `blocks[${index}].image_ids`, 32, 120),
    };
  }).sort((left, right) => left.order - right.order);
}

function normalizeClaimLedger(value: unknown, blocks: ArticleBlock[]): ClaimLedgerEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new EditorialContractError("claim_ledger_invalid", "claim_ledger must be an array");
  const blockIds = new Set(blocks.map(block => block.block_id));
  return value.map((item, index) => {
    const record = objectValue(item, `claim_ledger[${index}]`);
    const blockId = requiredId(record.block_id ?? record.blockId, `claim_ledger[${index}].block_id`);
    if (!blockIds.has(blockId)) throw new EditorialContractError("claim_block_not_found", `claim block does not exist: ${blockId}`);
    return {
      claim_id: requiredId(record.claim_id ?? record.claimId, `claim_ledger[${index}].claim_id`),
      block_id: blockId,
      classification: enumValue(record.classification, ["author_view", "source_fact", "external_fact"] as const, `claim_ledger[${index}].classification`),
      verification_required: Boolean(record.verification_required ?? record.verificationRequired),
      verification_status: optionalEnum(record.verification_status ?? record.verificationStatus, ["not_required", "pending", "verified", "failed"] as const),
    };
  });
}

function normalizeVisualPlan(value: unknown, blocks: ArticleBlock[]): VisualPlanItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new EditorialContractError("visual_plan_invalid", "visual_plan must be an array");
  const blockIds = new Set(blocks.map(block => block.block_id));
  const visualIds = new Set<string>();
  return value.map((item, index) => {
    const record = objectValue(item, `visual_plan[${index}]`);
    const visualId = requiredId(record.visual_id ?? record.visualId, `visual_plan[${index}].visual_id`);
    if (visualIds.has(visualId)) throw new EditorialContractError("duplicate_visual_id", `duplicate visual_id: ${visualId}`);
    visualIds.add(visualId);
    const blockId = requiredId(record.block_id ?? record.blockId, `visual_plan[${index}].block_id`);
    if (!blockIds.has(blockId)) throw new EditorialContractError("visual_block_not_found", `visual block does not exist: ${blockId}`);
    const kind = enumValue(record.kind, ["cover", "illustration", "chart"] as const, `visual_plan[${index}].kind`);
    if (kind === "chart" && !optionalText(record.data_provenance ?? record.dataProvenance, 2_000)) {
      throw new EditorialContractError("chart_provenance_required", "chart visual requires data_provenance");
    }
    return {
      visual_id: visualId,
      block_id: blockId,
      purpose: requiredText(record.purpose, `visual_plan[${index}].purpose`, 300),
      kind,
      aspect_ratio: requiredText(record.aspect_ratio ?? record.aspectRatio, `visual_plan[${index}].aspect_ratio`, 40),
      alt: requiredText(record.alt, `visual_plan[${index}].alt`, 500),
      caption: optionalText(record.caption, 500) || undefined,
      source: enumValue(record.source, ["generated", "provided", "data"] as const, `visual_plan[${index}].source`),
      data_provenance: optionalText(record.data_provenance ?? record.dataProvenance, 2_000) || undefined,
    };
  });
}

function normalizeFinding(value: unknown, index: number): ReviewFinding {
  const record = objectValue(value, `findings[${index}]`);
  return {
    severity: enumValue(record.severity, FINDING_SEVERITIES, `findings[${index}].severity`),
    code: requiredId(record.code, `findings[${index}].code`),
    block_id: optionalId(record.block_id ?? record.blockId) || undefined,
    evidence: optionalText(record.evidence, 2_000) || undefined,
    suggested_action: optionalText(record.suggested_action ?? record.suggestedAction, 2_000) || undefined,
    requires_human: Boolean(record.requires_human ?? record.requiresHuman),
  };
}

function objectValue(value: unknown, label: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EditorialContractError("object_required", `${label} must be an object`);
  }
  return value as Record<string, any>;
}

function requiredId(value: unknown, label: string): string {
  const result = optionalId(value);
  if (!result) throw new EditorialContractError(`${label}_required`, `${label} is required`);
  return result;
}

function optionalId(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result) ? result : null;
}

function requiredKey(value: unknown, label: string): string {
  const result = optionalText(value, 200);
  if (!result) throw new EditorialContractError(`${label}_required`, `${label} is required`);
  return result;
}

function requiredText(value: unknown, label: string, max: number): string {
  const result = optionalText(value, max);
  if (!result) throw new EditorialContractError(`${label}_required`, `${label} is required`);
  return result;
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result.slice(0, max) : null;
}

function stringArray(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new EditorialContractError(`${label}_invalid`, `${label} must be an array`);
  return value.slice(0, maxItems).map((item, index) => requiredText(item, `${label}[${index}]`, maxItemLength));
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EditorialContractError(`${label}_invalid`, `${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new EditorialContractError(`${label}_invalid`, `${label} must be a non-negative integer`);
  }
  return parsed;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new EditorialContractError(`${label}_invalid`, `${label} is invalid`);
  }
  return value as T[number];
}

function optionalEnum<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return enumValue(value, values, "enum");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}
