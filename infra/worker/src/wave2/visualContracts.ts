import {
  canonicalJson,
  sha256,
  type ArticleBlock,
  type FrozenArticleVersion,
  type VersionPin,
} from "./artifactContracts";
import { PUBLICATION_SKILL_PINS } from "../editorialContracts";

export const WAVE2C_SCHEMA_VERSION = "editorial-wave2c.v1" as const;
export const VISUAL_PLAN_PROTOCOL = "visual_plan.v2" as const;
export const VISUAL_ASSET_PROTOCOL = "visual_asset.v2" as const;
export const VISUAL_QA_PROTOCOL = "visual_qa_report.v2" as const;
export const VISUAL_MODEL_VERSION = "gpt-image-2" as const;
export const VISUAL_ADAPTER_VERSION = "visual-generation.adapter.1.0.0" as const;
export const COVER_SKILL_PIN: VersionPin = { id: "punk-cover", version: "1.0.0" };
export const BODY_SKILL_PIN: VersionPin = { id: "ian-xiaohei-illustrations", version: "1.0.0" };
export const COVER_STYLE_PIN: VersionPin = { id: "retro-ink-dot-matrix-metaphor", version: "1.0.0" };

export type VisualErrorCode =
  | "visual_plan_insufficient_unique_blocks"
  | "visual_contract_invalid"
  | "visual_slot_conflict"
  | "visual_pin_conflict"
  | "visual_asset_contract_invalid"
  | "visual_qa_failed";

export class VisualContractError extends Error {
  constructor(public readonly code: VisualErrorCode, message: string, public readonly status = 409) {
    super(message);
    this.name = "VisualContractError";
  }
}

export type VisualMode = "normal" | "long";
export type VisualPurpose = "cover" | "body";

export type VisualSkillPin = VersionPin & { version_source: "project_adapter_manifest" };

export type VisualPinSet = {
  model: VisualSkillPin;
  adapter: VisualSkillPin;
  cover_skill: VisualSkillPin;
  body_skill: VisualSkillPin;
  formatting: VisualSkillPin;
  cover_style: VisualSkillPin;
};

export const ACTIVE_VISUAL_PINS: VisualPinSet = {
  model: { id: "gpt-image-2", version: "gpt-image-2", version_source: "project_adapter_manifest" },
  adapter: { id: "visual_generation_adapter", version: VISUAL_ADAPTER_VERSION, version_source: "project_adapter_manifest" },
  cover_skill: { ...COVER_SKILL_PIN, version_source: "project_adapter_manifest" },
  body_skill: { ...BODY_SKILL_PIN, version_source: "project_adapter_manifest" },
  formatting: { ...PUBLICATION_SKILL_PINS.formatting, version_source: "project_adapter_manifest" },
  cover_style: { ...COVER_STYLE_PIN, version_source: "project_adapter_manifest" },
};

export const VISUAL_PIN_SNAPSHOT_ID = "visual_pin_snapshot.v1" as const;
export const VISUAL_PROMPT_SERIALIZATION = "canonical_utf8_v1" as const;

export const COVER_PROJECT_ADAPTER_MANIFEST = {
  id: "punk-cover",
  version: "1.0.0",
  version_source: "project_adapter_manifest",
  style: { id: "retro-ink-dot-matrix-metaphor", version: "1.0.0", version_source: "project_adapter_manifest" },
  prompt_serialization: VISUAL_PROMPT_SERIALIZATION,
  output_count: 1,
  random_style_extension: "forbidden",
  output_contract: { mime: "image/png", width: 2256, height: 960, aspect_ratio: "47:20" },
  composition: {
    layout: "fixed_left_text_right_illustration",
    title_position: "left_upper_middle",
    illustration_position: "right_vertical_center",
    illustration_width_percent: "22-26",
    illustration_visual_weight: "less_than_title",
    negative_space: "prominent",
    metaphor_count: 1,
    metaphor_shape: "one_subject_or_two_objects_simple_relation",
  },
  color_material: {
    background: "#DED9CF_flat_solid",
    title_and_illustration: "#111111",
    fourth_color: "forbidden",
    typography: "narrow_square_stable_retro_mechanical_letterpress",
    texture: "subtle_ink_spread_and_print_irregularity_only",
    illustration: "black_dots_sparse_linear_dot_matrix_limited_ink_halftone",
    illustration_detail: "outline_one_primary_action_at_most_two_identity_features",
  },
  text_policy: {
    cover_title_lines: "exact_1_to_4_lines_preserve_order_and_line_breaks",
    rewrite_merge_truncate_append: "forbidden",
    auto_scale_to_length: "forbidden",
    other_text: "forbidden",
    exact_title_failure: "qa_fail",
  },
  negative_constraints: [
    "pixel_font", "songti", "calligraphy", "handwriting", "modern_geometric_sans", "exaggerated_distressed_type",
    "subtitle", "footer_words", "english_explanation", "labels", "logo", "watermark", "qr_code", "numbering", "random_text", "article_body",
    "multiple_metaphors", "complex_scene", "decorative_clutter", "oversized_illustration", "high_saturation", "gradient", "glow", "3d", "photography",
    "complex_background", "heavy_aging", "stains", "visible_paper_texture", "ppt", "course_cover", "advertisement", "generic_information_card",
  ],
  final_check: ["exact_cover_title_lines", "single_clear_metaphor", "restrained_dot_matrix", "no_extra_text"],
} as const;

export const BODY_PROJECT_ADAPTER_MANIFEST = {
  id: "ian-xiaohei-illustrations",
  version: "1.0.0",
  version_source: "project_adapter_manifest",
  prompt_serialization: VISUAL_PROMPT_SERIALIZATION,
  output_count: 1,
  random_style_extension: "forbidden",
  output_contract: { mime: "image/png", width: 1536, height: 864, aspect_ratio: "16:9" },
  composition: {
    expression_count: 1,
    content_scope: "one_cognitive_turn_mechanism_or_metaphor_from_bound_block",
    concrete_action_required: true,
    example_actions: ["pull", "carry", "insert", "press", "connect", "dismantle", "repair", "guard"],
    supporting_objects: "one_or_two_low_technology_objects",
    abstract_nodes_arrows_icons: "secondary_only",
    subject_coverage_percent: "40-60",
    negative_space_minimum_percent: 35,
    same_article_slot_reuse: "forbidden_for_primary_object_core_action_and_metaphor",
  },
  color_material: {
    background: "pure_flat_white",
    primary: "black_hand_drawn_thin_line",
    line_quality: "slightly_wobbly_non_mechanical_non_vector",
    orange: "limited_primary_flow_or_action_path",
    red: "limited_problem_warning_or_result",
    blue: "optional_limited_secondary_state_or_feedback",
  },
  subject: {
    id: "xiaohei",
    required: true,
    role: "core_action_actor",
    appearance: "solid_black_irregular_hand_drawn_outline_white_dot_eyes_thin_legs_blank_serious_expression",
    temperament: "calm_serious_slightly_absurd",
    forbidden: ["cute", "mascot", "children_cartoon", "complex_clothing", "decorative_only"],
  },
  text_policy: { visible_text_policy: "none", forbidden: ["chinese", "english", "digits", "title", "label", "logo", "watermark"] },
  negative_constraints: [
    "beige", "warm_gray", "paper_texture", "gradient", "shadow", "noise", "retro_paper", "ppt", "formal_flowchart", "complex_architecture_diagram",
    "commercial_flat_illustration", "courseware", "real_ui", "technology_interface", "business_person", "robot_avatar", "random_cartoon", "complex_background",
    "regular_grid", "dense_nodes", "too_many_arrows", "historical_case_composition_copy",
  ],
  final_check: ["understandable_without_labels", "xiaohei_executes_concrete_action", "no_visible_text"],
} as const;

export function encodeVisualPinSnapshot(pins: VisualPinSet = ACTIVE_VISUAL_PINS): string {
  assertVisualPins(pins);
  return canonicalJson(pins);
}

export function decodeVisualPinSnapshot(value: unknown): VisualPinSet {
  if (typeof value !== "string") throw new VisualContractError("visual_pin_conflict", "visual pin snapshot is missing", 409);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new VisualContractError("visual_pin_conflict", "visual pin snapshot is invalid", 409); }
  assertVisualPins(parsed);
  if (canonicalJson(parsed) !== value) throw new VisualContractError("visual_pin_conflict", "visual pin snapshot is not canonical", 409);
  return parsed;
}

export type VisualSlot = {
  slot_id: string;
  order: number;
  purpose: VisualPurpose;
  kind: "cover" | "illustration";
  block_id: string | null;
  block_text_hash: string | null;
  aspect_ratio: "47:20" | "16:9";
  width: 2256 | 1536;
  height: 960 | 864;
  alt: string;
  caption: string | null;
  content: {
    core_idea: string;
    metaphor: string;
    concrete_action: string;
    objects: string[];
  };
  prompt: string;
  prompt_hash: string;
  slot_seed: string;
  idempotency_key: string;
};

export type VisualPlanPayload = {
  protocol_version: typeof VISUAL_PLAN_PROTOCOL;
  article_id: string;
  run_id: string;
  recording_id: number;
  frozen_artifact_id: string;
  frozen_payload_hash: string;
  selected_title: string;
  cover_title_lines: string[];
  mode: VisualMode;
  body_code_point_count: number;
  slots: VisualSlot[];
  pins: VisualPinSet;
  created_at: string;
};

export type VisualAssetPayload = {
  protocol_version: typeof VISUAL_ASSET_PROTOCOL;
  article_id: string;
  run_id: string;
  recording_id: number;
  frozen_artifact_id: string;
  frozen_payload_hash: string;
  plan_artifact_id: string;
  plan_payload_hash: string;
  slot_id: string;
  order: number;
  purpose: VisualPurpose;
  aspect_ratio: "47:20" | "16:9";
  block_id: string | null;
  block_text_hash: string | null;
  binary_storage_ref: string;
  byte_hash: string;
  byte_length: number;
  mime: "image/png";
  width: 2256 | 1536;
  height: 960 | 864;
  prompt_hash: string;
  model_version: typeof VISUAL_MODEL_VERSION;
  adapter_version: typeof VISUAL_ADAPTER_VERSION;
  pins: VisualPinSet;
  visible_text: string[];
  visible_text_evidence: "prompt_contract";
  white_background_verified: boolean;
  created_at: string;
};

export type VisualQAReportPayload = {
  protocol_version: typeof VISUAL_QA_PROTOCOL;
  article_id: string;
  run_id: string;
  recording_id: number;
  frozen_artifact_id: string;
  frozen_payload_hash: string;
  plan_artifact_id: string;
  plan_payload_hash: string;
  asset_artifact_ids: string[];
  asset_byte_hashes: string[];
  checks: {
    ordered_slots: true;
    png_signature: true;
    dimensions: true;
    metadata: true;
    white_background: "not_applicable" | "verified" | "failed";
    visible_text_pin: "evidence_only";
  };
  visible_text_evidence: "prompt_contract";
  passed: boolean;
  pins: VisualPinSet;
  created_at: string;
};

export type VisualArtifactKind = "visual_plan" | "visual_asset" | "visual_qa_report";
export type VisualArtifactPayload = VisualPlanPayload | VisualAssetPayload | VisualQAReportPayload;

export type VisualArtifactEnvelope = {
  schema_version: typeof WAVE2C_SCHEMA_VERSION;
  artifact_id: string;
  artifact_key: string;
  kind: VisualArtifactKind;
  producer: { role: "visual_production"; version: "visual-production.agent.v1" };
  run_id: string;
  article_id: string;
  recording_id: number;
  user_id: string;
  workspace_id: string;
  input_artifact_ids: string[];
  idempotency_key: string;
  payload_hash: string;
  payload_length: number;
  created_at: string;
  storage_ref: string;
  binary_storage_ref: string | null;
};

export type VisualArtifactObject = {
  envelope: VisualArtifactEnvelope;
  payload: VisualArtifactPayload;
};

export type VisualArtifactMetadata = Omit<VisualArtifactEnvelope, "binary_storage_ref"> & {
  binary_storage_ref: string | null;
  payload_summary: {
    frozen_payload_hash?: string;
    plan_artifact_id?: string;
    plan_payload_hash?: string;
    slot_id?: string;
    slot_kind?: "cover" | "illustration";
    purpose?: VisualPurpose;
    order?: number;
    mode?: VisualMode;
    asset_count?: number;
    model_version?: string;
    adapter_version?: string;
    skill_pins?: VisualPinSet;
    operation_id?: string;
    binary_storage_ref?: string;
    byte_hash?: string;
    byte_length?: number;
    mime?: string;
    width?: number;
    height?: number;
    white_background_verified?: boolean;
    qa_decision?: "pass" | "failed";
    qa_version?: typeof VISUAL_QA_PROTOCOL;
    visible_text_evidence?: "prompt_contract";
  };
};

function assertOpaque(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new VisualContractError("visual_contract_invalid", `${field} is invalid`, 400);
  }
  return value;
}

function assertHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new VisualContractError("visual_contract_invalid", `${field} is invalid`, 400);
  }
  return value;
}

function assertIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new VisualContractError("visual_contract_invalid", `${field} is invalid`, 400);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function visualShard(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 2);
}

export function visualArtifactKey(userId: string, workspaceId: string, runId: string, kind: VisualArtifactKind, artifactId: string): string {
  assertOpaque(userId, "user_id");
  assertOpaque(workspaceId, "workspace_id");
  assertOpaque(runId, "run_id");
  assertOpaque(artifactId, "artifact_id");
  return `editorial/v3/${visualShard(`${userId}\u0000${workspaceId}\u0000${runId}`)}/${runId}/visual/${kind}/${artifactId}.v1.json`;
}

export function visualBinaryKey(userId: string, workspaceId: string, runId: string, frozenHash: string, slotId: string): string {
  assertHash(frozenHash, "frozen_payload_hash");
  assertOpaque(slotId, "slot_id");
  return `editorial/v3/${visualShard(`${userId}\u0000${workspaceId}\u0000${runId}`)}/${runId}/visual-binary/${frozenHash.slice(7, 23)}/${slotId}.png`;
}

export async function deriveVisualArtifactId(kind: VisualArtifactKind, runId: string, frozenHash: string, discriminator: string): Promise<string> {
  return `${kind}_${(await sha256(canonicalJson({ kind, run_id: runId, frozen_hash: frozenHash, discriminator }))).slice(7, 31)}`;
}

export async function makeVisualArtifactObject(input: {
  kind: VisualArtifactKind;
  payload: VisualArtifactPayload;
  user_id: string;
  workspace_id: string;
  input_artifact_ids: string[];
  idempotency_key: string;
  created_at: string;
  binary_storage_ref?: string | null;
}): Promise<VisualArtifactObject> {
  const frozenHash = assertHash((input.payload as Record<string, unknown>).frozen_payload_hash, "frozen_payload_hash");
  const artifactId = await deriveVisualArtifactId(input.kind, input.payload.run_id, frozenHash, input.idempotency_key);
  const artifactKeyValue = visualArtifactKey(input.user_id, input.workspace_id, input.payload.run_id, input.kind, artifactId);
  const payloadBytes = new TextEncoder().encode(canonicalJson(input.payload));
  const payloadHash = await sha256(payloadBytes);
  const envelope: VisualArtifactEnvelope = {
    schema_version: WAVE2C_SCHEMA_VERSION,
    artifact_id: artifactId,
    artifact_key: artifactKeyValue,
    kind: input.kind,
    producer: { role: "visual_production", version: "visual-production.agent.v1" },
    run_id: input.payload.run_id,
    article_id: input.payload.article_id,
    recording_id: input.payload.recording_id,
    user_id: assertOpaque(input.user_id, "user_id"),
    workspace_id: assertOpaque(input.workspace_id, "workspace_id"),
    input_artifact_ids: [...input.input_artifact_ids],
    idempotency_key: assertOpaque(input.idempotency_key, "idempotency_key"),
    payload_hash: payloadHash,
    payload_length: payloadBytes.byteLength,
    created_at: assertIso(input.created_at, "created_at"),
    storage_ref: `r2://${artifactKeyValue}`,
    binary_storage_ref: input.binary_storage_ref ?? null,
  };
  return { envelope, payload: input.payload };
}

function compileVisualPrompt(sections: ReadonlyArray<{ name: string; value: unknown }>): string {
  return sections.map(section => `[${section.name}]\n${canonicalJson(section.value)}`).join("\n");
}

function buildCoverPrompt(selectedTitle: string, coverTitleLines: string[], content: VisualSlot["content"]): string {
  return compileVisualPrompt([
    { name: "output_contract", value: COVER_PROJECT_ADAPTER_MANIFEST.output_contract },
    { name: "immutable_input", value: { cover_title_lines: coverTitleLines, line_count: coverTitleLines.length, preserve_order_and_line_breaks: true } },
    { name: "style_pins", value: {
      manifest: {
        id: COVER_PROJECT_ADAPTER_MANIFEST.id,
        version: COVER_PROJECT_ADAPTER_MANIFEST.version,
        version_source: COVER_PROJECT_ADAPTER_MANIFEST.version_source,
        prompt_serialization: COVER_PROJECT_ADAPTER_MANIFEST.prompt_serialization,
        output_count: COVER_PROJECT_ADAPTER_MANIFEST.output_count,
        random_style_extension: COVER_PROJECT_ADAPTER_MANIFEST.random_style_extension,
      },
      skill: ACTIVE_VISUAL_PINS.cover_skill,
      style: ACTIVE_VISUAL_PINS.cover_style,
    } },
    { name: "content", value: { selected_title: selectedTitle, ...content } },
    { name: "slot_binding", value: { slot_id: "cover_01", purpose: "cover", block_id: null, block_text_hash: null } },
    { name: "composition", value: COVER_PROJECT_ADAPTER_MANIFEST.composition },
    { name: "color_material", value: COVER_PROJECT_ADAPTER_MANIFEST.color_material },
    { name: "text_policy", value: COVER_PROJECT_ADAPTER_MANIFEST.text_policy },
    { name: "negative_constraints", value: COVER_PROJECT_ADAPTER_MANIFEST.negative_constraints },
    { name: "final_check", value: COVER_PROJECT_ADAPTER_MANIFEST.final_check },
  ]);
}

function buildBodyPrompt(articleId: string, blockId: string, blockTextHash: string, slotId: string, content: VisualSlot["content"]): string {
  return compileVisualPrompt([
    { name: "output_contract", value: BODY_PROJECT_ADAPTER_MANIFEST.output_contract },
    { name: "immutable_input", value: { article_id: articleId, block_text: content.core_idea } },
    { name: "style_pins", value: {
      manifest: {
        id: BODY_PROJECT_ADAPTER_MANIFEST.id,
        version: BODY_PROJECT_ADAPTER_MANIFEST.version,
        version_source: BODY_PROJECT_ADAPTER_MANIFEST.version_source,
        prompt_serialization: BODY_PROJECT_ADAPTER_MANIFEST.prompt_serialization,
        output_count: BODY_PROJECT_ADAPTER_MANIFEST.output_count,
        random_style_extension: BODY_PROJECT_ADAPTER_MANIFEST.random_style_extension,
      },
      skill: ACTIVE_VISUAL_PINS.body_skill,
    } },
    { name: "content", value: content },
    { name: "slot_binding", value: { slot_id: slotId, purpose: "body", block_id: blockId, block_text_hash: blockTextHash } },
    { name: "composition", value: { ...BODY_PROJECT_ADAPTER_MANIFEST.composition, subject: BODY_PROJECT_ADAPTER_MANIFEST.subject } },
    { name: "color_material", value: BODY_PROJECT_ADAPTER_MANIFEST.color_material },
    { name: "text_policy", value: BODY_PROJECT_ADAPTER_MANIFEST.text_policy },
    { name: "negative_constraints", value: BODY_PROJECT_ADAPTER_MANIFEST.negative_constraints },
    { name: "final_check", value: BODY_PROJECT_ADAPTER_MANIFEST.final_check },
  ]);
}

const BODY_CONTENT_BINDINGS: ReadonlyArray<Omit<VisualSlot["content"], "core_idea">> = [
  { metaphor: "a taut rope passing through one narrow gate", concrete_action: "pull", objects: ["rope", "gate"] },
  { metaphor: "one solid block carried across a clean gap", concrete_action: "carry", objects: ["block", "gap"] },
  { metaphor: "one precise key inserted into one mechanical lock", concrete_action: "insert", objects: ["key", "lock"] },
  { metaphor: "one lever pressed to redirect a single path", concrete_action: "press", objects: ["lever", "path"] },
  { metaphor: "one broken bridge repaired at its only joint", concrete_action: "repair", objects: ["bridge", "joint"] },
] as const;

async function coverContentBinding(selectedTitle: string): Promise<VisualSlot["content"]> {
  const variants = [
    { metaphor: "one archive key opens one restrained mechanical drawer", concrete_action: "open", objects: ["archive_key", "mechanical_drawer"] },
    { metaphor: "one small bridge connects two isolated dot-matrix forms", concrete_action: "connect", objects: ["bridge", "dot_matrix_forms"] },
    { metaphor: "one precise gear moves one otherwise still gate", concrete_action: "move", objects: ["gear", "gate"] },
  ] as const;
  const digest = await sha256(selectedTitle);
  const selected = variants[Number.parseInt(digest.slice(7, 9), 16) % variants.length];
  return { core_idea: selectedTitle, metaphor: selected.metaphor, concrete_action: selected.concrete_action, objects: [...selected.objects] };
}

async function deriveVisualSlotIdempotencyKey(runId: string, frozenHash: string, slotId: string, promptHash: string): Promise<string> {
  return `visual_${(await sha256(canonicalJson({ run_id: runId, frozen_hash: frozenHash, slot_id: slotId, prompt_hash: promptHash, model: ACTIVE_VISUAL_PINS.model, adapter: ACTIVE_VISUAL_PINS.adapter, skills: { cover: ACTIVE_VISUAL_PINS.cover_skill, body: ACTIVE_VISUAL_PINS.body_skill }, style: ACTIVE_VISUAL_PINS.cover_style }))).slice(7, 31)}`;
}

export async function deriveVisualImageOperationKey(runId: string, frozenHash: string, planPayloadHash: string, slotId: string, promptHash: string): Promise<string> {
  return `visual_image_${(await sha256(canonicalJson({
    run_id: runId,
    frozen_payload_hash: frozenHash,
    plan_payload_hash: planPayloadHash,
    slot_id: slotId,
    prompt_hash: promptHash,
    model: ACTIVE_VISUAL_PINS.model,
    adapter: ACTIVE_VISUAL_PINS.adapter,
    skills: { cover: ACTIVE_VISUAL_PINS.cover_skill, body: ACTIVE_VISUAL_PINS.body_skill },
    style: ACTIVE_VISUAL_PINS.cover_style,
  }))).slice(7, 31)}`;
}

function nonBlankUniqueBlocks(blocks: ArticleBlock[]): ArticleBlock[] {
  const seen = new Set<string>();
  return [...blocks].sort((left, right) => left.order - right.order).filter((block) => {
    if (block.text.trim() === "" || seen.has(block.text_hash)) return false;
    seen.add(block.text_hash);
    return true;
  });
}

export async function buildVisualPlan(input: {
  frozen: FrozenArticleVersion;
  user_id: string;
  workspace_id: string;
  frozen_artifact_id: string;
  frozen_payload_hash: string;
  created_at: string;
}): Promise<VisualPlanPayload> {
  const frozen = input.frozen;
  const bodyCodePointCount = Array.from(frozen.body).length;
  const mode: VisualMode = bodyCodePointCount >= 5_000 ? "long" : "normal";
  const bodySlotCount = mode === "long" ? 5 : 2;
  const candidates = nonBlankUniqueBlocks(frozen.blocks);
  if (candidates.length < bodySlotCount) {
    throw new VisualContractError("visual_plan_insufficient_unique_blocks", "visual planning requires enough unique non-blank blocks", 409);
  }
  const selected = Array.from({ length: bodySlotCount }, (_, index) => {
    const sourceIndex = Math.floor(index * (candidates.length - 1) / (bodySlotCount - 1));
    return candidates[sourceIndex];
  });
  const coverContent = await coverContentBinding(frozen.selected_title);
  const coverPrompt = buildCoverPrompt(frozen.selected_title, frozen.cover_title, coverContent);
  const coverPromptHash = await sha256(coverPrompt);
  const slots: VisualSlot[] = [{
    slot_id: "cover_01",
    order: 0,
    purpose: "cover",
    kind: "cover",
    block_id: null,
    block_text_hash: null,
    aspect_ratio: "47:20",
    width: 2256,
    height: 960,
    alt: frozen.cover_title.join(" "),
    caption: null,
    content: coverContent,
    prompt: coverPrompt,
    prompt_hash: coverPromptHash,
    slot_seed: await deriveVisualSlotIdempotencyKey(frozen.run_id, input.frozen_payload_hash, "cover_01", coverPromptHash),
    idempotency_key: await deriveVisualSlotIdempotencyKey(frozen.run_id, input.frozen_payload_hash, "cover_01", coverPromptHash),
  }];
  for (const [index, block] of selected.entries()) {
    const slotId = `body_${String(index + 1).padStart(2, "0")}`;
    const binding = BODY_CONTENT_BINDINGS[index];
    const content: VisualSlot["content"] = { core_idea: block.text, metaphor: binding.metaphor, concrete_action: binding.concrete_action, objects: [...binding.objects] };
    const prompt = buildBodyPrompt(frozen.article_id, block.block_id, block.text_hash, slotId, content);
    const promptHash = await sha256(prompt);
    slots.push({
      slot_id: slotId,
      order: index + 1,
      purpose: "body",
      kind: "illustration",
      block_id: block.block_id,
      block_text_hash: block.text_hash,
      aspect_ratio: "16:9",
      width: 1536,
      height: 864,
      alt: `Illustration for ${block.block_id}`,
      caption: null,
      content,
      prompt,
      prompt_hash: promptHash,
      slot_seed: await deriveVisualSlotIdempotencyKey(frozen.run_id, input.frozen_payload_hash, slotId, promptHash),
      idempotency_key: await deriveVisualSlotIdempotencyKey(frozen.run_id, input.frozen_payload_hash, slotId, promptHash),
    });
  }
  const result: VisualPlanPayload = {
    protocol_version: VISUAL_PLAN_PROTOCOL,
    article_id: frozen.article_id,
    run_id: frozen.run_id,
    recording_id: frozen.recording_id,
    frozen_artifact_id: input.frozen_artifact_id,
    frozen_payload_hash: assertHash(input.frozen_payload_hash, "frozen_payload_hash"),
    selected_title: frozen.selected_title,
    cover_title_lines: [...frozen.cover_title],
    mode,
    body_code_point_count: bodyCodePointCount,
    slots,
    pins: ACTIVE_VISUAL_PINS,
    created_at: assertIso(input.created_at, "created_at"),
  };
  return result;
}

export function assertVisualPins(value: unknown): asserts value is VisualPinSet {
  if (!value || typeof value !== "object" || Array.isArray(value) || !sameJson(value, ACTIVE_VISUAL_PINS)) {
    throw new VisualContractError("visual_pin_conflict", "visual pins are not active", 409);
  }
}

export async function assertVisualAssetMatchesPlanSlot(asset: VisualAssetPayload, slot: VisualSlot, planPayloadHash: string, envelopeIdempotencyKey: string): Promise<void> {
  if (asset.slot_id !== slot.slot_id || asset.order !== slot.order || asset.purpose !== slot.purpose || asset.aspect_ratio !== slot.aspect_ratio || asset.width !== slot.width || asset.height !== slot.height || asset.prompt_hash !== slot.prompt_hash || asset.block_id !== slot.block_id || asset.block_text_hash !== slot.block_text_hash) {
    throw new VisualContractError("visual_slot_conflict", "visual asset does not exactly match its plan slot", 409);
  }
  if (envelopeIdempotencyKey !== await deriveVisualImageOperationKey(asset.run_id, asset.frozen_payload_hash, planPayloadHash, slot.slot_id, slot.prompt_hash)) throw new VisualContractError("visual_slot_conflict", "visual asset operation identity is not bound to the plan hash", 409);
}

export async function normalizeVisualArtifact(input: {
  schema_version?: unknown;
  artifact_id: unknown;
  artifact_key: unknown;
  kind: unknown;
  run_id: unknown;
  article_id: unknown;
  recording_id: unknown;
  user_id: unknown;
  workspace_id: unknown;
  input_artifact_ids: unknown;
  idempotency_key: unknown;
  created_at: unknown;
  storage_ref: unknown;
  binary_storage_ref?: unknown;
  producer?: unknown;
  payload_hash?: unknown;
  payload_length?: unknown;
  payload: unknown;
}): Promise<VisualArtifactObject> {
  const kind = input.kind;
  if (kind !== "visual_plan" && kind !== "visual_asset" && kind !== "visual_qa_report") {
    throw new VisualContractError("visual_contract_invalid", "visual artifact kind is invalid", 400);
  }
  const runId = assertOpaque(input.run_id, "run_id");
  const articleId = assertOpaque(input.article_id, "article_id");
  const userId = assertOpaque(input.user_id, "user_id");
  const workspaceId = assertOpaque(input.workspace_id, "workspace_id");
  const artifactId = assertOpaque(input.artifact_id, "artifact_id");
  if (input.schema_version !== WAVE2C_SCHEMA_VERSION) throw new VisualContractError("visual_contract_invalid", "visual schema version is invalid", 409);
  if (!sameJson(input.producer, { role: "visual_production", version: "visual-production.agent.v1" })) throw new VisualContractError("visual_contract_invalid", "visual producer is invalid", 409);
  const recordingId = Number(input.recording_id);
  if (!Number.isSafeInteger(recordingId) || recordingId <= 0) throw new VisualContractError("visual_contract_invalid", "recording_id is invalid", 400);
  const inputIds = input.input_artifact_ids;
  if (!Array.isArray(inputIds) || inputIds.some((value) => typeof value !== "string")) throw new VisualContractError("visual_contract_invalid", "input artifact ids are invalid", 400);
  const createdAt = assertIso(input.created_at, "created_at");
  if (typeof input.storage_ref !== "string" || input.storage_ref !== `r2://${input.artifact_key}`) throw new VisualContractError("visual_contract_invalid", "visual storage ref is invalid", 400);
  if (input.binary_storage_ref !== null && input.binary_storage_ref !== undefined && typeof input.binary_storage_ref !== "string") throw new VisualContractError("visual_contract_invalid", "binary storage ref is invalid", 400);
  const payload = input.payload as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new VisualContractError("visual_contract_invalid", "visual payload is invalid", 400);
  if (payload.protocol_version !== (kind === "visual_plan" ? VISUAL_PLAN_PROTOCOL : kind === "visual_asset" ? VISUAL_ASSET_PROTOCOL : VISUAL_QA_PROTOCOL)) throw new VisualContractError("visual_contract_invalid", "visual payload protocol is invalid", 409);
  if (payload.run_id !== runId || payload.article_id !== articleId || Number(payload.recording_id) !== recordingId) throw new VisualContractError("visual_contract_invalid", "visual payload identity is invalid", 409);
  const frozenHash = assertHash(payload.frozen_payload_hash, "frozen_payload_hash");
  const payloadCreatedAt = assertIso(payload.created_at, "payload.created_at");
  if (payloadCreatedAt !== createdAt) throw new VisualContractError("visual_contract_invalid", "visual payload timestamp does not match envelope", 409);
  if (kind === "visual_plan" && (inputIds.length !== 1 || inputIds[0] !== String(payload.frozen_artifact_id))) throw new VisualContractError("visual_contract_invalid", "visual plan must bind exactly one frozen artifact", 409);
  if (kind === "visual_asset" && inputIds.length !== 2) throw new VisualContractError("visual_contract_invalid", "visual asset must bind frozen and plan artifacts", 409);
  if (kind === "visual_qa_report" && inputIds.length < 2) throw new VisualContractError("visual_contract_invalid", "visual QA must bind frozen and plan artifacts", 409);
  assertVisualPins(payload.pins);
  if (kind !== "visual_asset" && input.binary_storage_ref !== null && input.binary_storage_ref !== undefined) throw new VisualContractError("visual_asset_contract_invalid", "only visual assets may bind binary storage", 409);
  if (kind === "visual_plan") {
    const plan = payload as Partial<VisualPlanPayload>;
    const expectedCount = plan.mode === "long" ? 6 : plan.mode === "normal" ? 3 : 0;
    const bodyCodePointCount = Number(plan.body_code_point_count);
    if (!Number.isSafeInteger(bodyCodePointCount) || bodyCodePointCount < 0 ||
        (plan.mode === "normal" && bodyCodePointCount >= 5_000) ||
        (plan.mode === "long" && bodyCodePointCount < 5_000) ||
        !Array.isArray(plan.slots) || plan.slots.length !== expectedCount) {
      throw new VisualContractError("visual_contract_invalid", "visual plan slot count is invalid", 409);
    }
    if (typeof plan.selected_title !== "string" || plan.selected_title.length === 0 ||
        !Array.isArray(plan.cover_title_lines) || plan.cover_title_lines.length < 1 || plan.cover_title_lines.length > 4 ||
        plan.cover_title_lines.some(value => typeof value !== "string" || value.length === 0)) {
      throw new VisualContractError("visual_contract_invalid", "visual plan title binding is invalid", 409);
    }
    const slots = plan.slots as VisualSlot[];
    if (slots.some((slot, index) => slot.order !== index || slot.slot_id !== (index === 0 ? "cover_01" : `body_${String(index).padStart(2, "0")}`))) {
      throw new VisualContractError("visual_slot_conflict", "visual plan slot order is invalid", 409);
    }
    const bodySlots = slots.slice(1);
    if (slots[0].purpose !== "cover" || slots[0].kind !== "cover" || slots[0].aspect_ratio !== "47:20" || slots[0].block_id !== null || slots[0].block_text_hash !== null ||
        slots[0].width !== 2256 || slots[0].height !== 960 ||
        bodySlots.some(slot => slot.purpose !== "body" || slot.kind !== "illustration" || slot.aspect_ratio !== "16:9" || slot.block_id === null ||
          typeof slot.block_id !== "string" || slot.block_id.length === 0 || typeof slot.block_text_hash !== "string" ||
          slot.width !== 1536 || slot.height !== 864 || typeof slot.prompt_hash !== "string" || typeof slot.idempotency_key !== "string" || typeof slot.slot_seed !== "string")) {
      throw new VisualContractError("visual_slot_conflict", "visual plan slot binding is invalid", 409);
    }
    for (const slot of slots) {
      if (!slot.content || typeof slot.content.core_idea !== "string" || slot.content.core_idea.length === 0 ||
          typeof slot.content.metaphor !== "string" || slot.content.metaphor.length === 0 ||
          typeof slot.content.concrete_action !== "string" || slot.content.concrete_action.length === 0 ||
          !Array.isArray(slot.content.objects) || slot.content.objects.length < 1 || slot.content.objects.length > 2 ||
          slot.content.objects.some(value => typeof value !== "string" || value.length === 0) ||
          typeof slot.prompt !== "string" || slot.prompt_hash !== await sha256(slot.prompt) ||
          slot.slot_seed !== await deriveVisualSlotIdempotencyKey(runId, frozenHash, slot.slot_id, slot.prompt_hash) ||
          slot.idempotency_key !== slot.slot_seed) {
        throw new VisualContractError("visual_slot_conflict", "visual slot identity is not deterministic", 409);
      }
    }
    const expectedCoverContent = await coverContentBinding(plan.selected_title);
    if (!sameJson(slots[0].content, expectedCoverContent) || slots[0].prompt !== buildCoverPrompt(plan.selected_title, plan.cover_title_lines, expectedCoverContent)) {
      throw new VisualContractError("visual_slot_conflict", "visual cover manifest or prompt is not exact", 409);
    }
    for (const [index, slot] of bodySlots.entries()) {
      const binding = BODY_CONTENT_BINDINGS[index];
      const expectedContent: VisualSlot["content"] = {
        core_idea: slot.content.core_idea,
        metaphor: binding.metaphor,
        concrete_action: binding.concrete_action,
        objects: [...binding.objects],
      };
      if (slot.block_id === null || slot.block_text_hash === null || await sha256(slot.content.core_idea) !== slot.block_text_hash ||
          !sameJson(slot.content, expectedContent) || slot.prompt !== buildBodyPrompt(articleId, slot.block_id, slot.block_text_hash, slot.slot_id, expectedContent)) {
        throw new VisualContractError("visual_slot_conflict", "visual body manifest or prompt is not exact", 409);
      }
    }
    const blockIds = bodySlots.map(slot => slot.block_id as string);
    const blockHashes = bodySlots.map(slot => slot.block_text_hash as string);
    const actions = bodySlots.map(slot => slot.content.concrete_action);
    const metaphors = bodySlots.map(slot => slot.content.metaphor);
    const objects = bodySlots.flatMap(slot => slot.content.objects);
    if (new Set(blockIds).size !== blockIds.length || new Set(blockHashes).size !== blockHashes.length ||
        new Set(actions).size !== actions.length || new Set(metaphors).size !== metaphors.length || new Set(objects).size !== objects.length ||
        blockHashes.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new VisualContractError("visual_slot_conflict", "visual plan contains duplicate or invalid block bindings", 409);
  } else if (kind === "visual_asset") {
    const asset = payload as Partial<VisualAssetPayload>;
    const binaryRef = asset.binary_storage_ref;
    if (typeof binaryRef !== "string" || binaryRef !== input.binary_storage_ref || binaryRef === String(input.storage_ref) ||
        asset.mime !== "image/png" || !Number.isSafeInteger(asset.byte_length) || (asset.byte_length ?? 0) <= 0 ||
        asset.width !== 2256 && asset.width !== 1536 || asset.height !== 960 && asset.height !== 864 ||
        typeof asset.slot_id !== "string" || typeof asset.byte_hash !== "string" || typeof asset.prompt_hash !== "string" || typeof asset.aspect_ratio !== "string" ||
        asset.model_version !== VISUAL_MODEL_VERSION || asset.adapter_version !== VISUAL_ADAPTER_VERSION ||
        typeof asset.white_background_verified !== "boolean" || asset.visible_text_evidence !== "prompt_contract") {
      throw new VisualContractError("visual_asset_contract_invalid", "visual asset contract is invalid", 409);
    }
    assertHash(asset.byte_hash, "byte_hash");
    assertHash(asset.prompt_hash, "prompt_hash");
    assertHash(asset.plan_payload_hash, "plan_payload_hash");
    if (asset.purpose !== "cover" && asset.purpose !== "body") {
      throw new VisualContractError("visual_asset_contract_invalid", "visual asset purpose is invalid", 409);
    }
    const expectedSlot = asset.purpose === "cover" ? "cover_01" : /^body_[0-9]{2}$/.test(asset.slot_id) ? asset.slot_id : null;
    if (expectedSlot !== asset.slot_id ||
        (asset.purpose === "cover" && (asset.order !== 0 || asset.aspect_ratio !== "47:20" || asset.block_id !== null || asset.block_text_hash !== null || asset.width !== 2256 || asset.height !== 960)) ||
        (asset.purpose === "body" && (Number(asset.order) < 1 || !Number.isSafeInteger(Number(asset.order)) || asset.slot_id !== `body_${String(asset.order).padStart(2, "0")}` || asset.aspect_ratio !== "16:9" || typeof asset.block_id !== "string" || asset.block_id.length === 0 || typeof asset.block_text_hash !== "string" || asset.block_text_hash === null || asset.width !== 1536 || asset.height !== 864)) ||
        !Array.isArray(asset.visible_text) || asset.visible_text.some(value => typeof value !== "string") ||
        (asset.purpose === "body" && asset.visible_text.length !== 0) ||
        binaryRef !== `r2://${visualBinaryKey(userId, workspaceId, runId, frozenHash, asset.slot_id)}`) {
      throw new VisualContractError("visual_asset_contract_invalid", "visual binary storage ref is not canonical", 409);
    }
    if (asset.purpose === "body") assertHash(asset.block_text_hash, "block_text_hash");
    if (input.idempotency_key !== await deriveVisualImageOperationKey(runId, frozenHash, String(asset.plan_payload_hash), asset.slot_id, asset.prompt_hash)) throw new VisualContractError("visual_slot_conflict", "visual asset operation identity is not bound to the plan hash", 409);
    if (inputIds[0] !== String(asset.frozen_artifact_id) || inputIds[1] !== String(asset.plan_artifact_id)) {
      throw new VisualContractError("visual_contract_invalid", "visual asset parent chain is invalid", 409);
    }
  } else {
    const report = payload as Partial<VisualQAReportPayload>;
    if (!Array.isArray(report.asset_artifact_ids) || !Array.isArray(report.asset_byte_hashes) ||
        report.asset_artifact_ids.length === 0 || report.asset_artifact_ids.length !== report.asset_byte_hashes.length ||
        new Set(report.asset_artifact_ids).size !== report.asset_artifact_ids.length ||
        typeof report.passed !== "boolean" || !report.checks ||
        report.checks.ordered_slots !== true || report.checks.png_signature !== true || report.checks.dimensions !== true ||
        report.checks.metadata !== true || report.checks.visible_text_pin !== "evidence_only" ||
        !["not_applicable", "verified", "failed"].includes(String(report.checks.white_background)) ||
        report.visible_text_evidence !== "prompt_contract") {
      throw new VisualContractError("visual_qa_failed", "visual QA report is not a passed deterministic report", 409);
    }
    if ((report.passed && report.checks.white_background !== "verified") || (!report.passed && report.checks.white_background !== "failed")) {
      throw new VisualContractError("visual_qa_failed", "visual QA pass state does not match its checks", 409);
    }
    if (inputIds.length !== report.asset_artifact_ids.length + 2 ||
        inputIds[0] !== String(report.frozen_artifact_id) || inputIds[1] !== String(report.plan_artifact_id) ||
        inputIds.slice(2).some((id, index) => id !== report.asset_artifact_ids?.[index])) {
      throw new VisualContractError("visual_contract_invalid", "visual QA artifact set is not exact", 409);
    }
    assertHash(report.plan_payload_hash, "plan_payload_hash");
    report.asset_byte_hashes.forEach((hash, index) => assertHash(hash, `asset_byte_hashes[${index}]`));
  }
  const payloadHash = await sha256(canonicalJson(payload));
  const payloadLength = new TextEncoder().encode(canonicalJson(payload)).byteLength;
  if (input.payload_hash !== undefined && input.payload_hash !== payloadHash) throw new VisualContractError("visual_contract_invalid", "visual payload hash is invalid", 409);
  if (input.payload_length !== undefined && Number(input.payload_length) !== payloadLength) throw new VisualContractError("visual_contract_invalid", "visual payload length is invalid", 409);
  const envelope: VisualArtifactEnvelope = {
    schema_version: WAVE2C_SCHEMA_VERSION,
    artifact_id: artifactId,
    artifact_key: String(input.artifact_key),
    kind,
    producer: { role: "visual_production", version: "visual-production.agent.v1" },
    run_id: runId,
    article_id: articleId,
    recording_id: recordingId,
    user_id: userId,
    workspace_id: workspaceId,
    input_artifact_ids: [...inputIds],
    idempotency_key: assertOpaque(input.idempotency_key, "idempotency_key"),
    payload_hash: payloadHash,
    payload_length: payloadLength,
    created_at: createdAt,
    storage_ref: String(input.storage_ref),
    binary_storage_ref: input.binary_storage_ref === undefined ? null : input.binary_storage_ref as string | null,
  };
  if (envelope.artifact_key !== visualArtifactKey(userId, workspaceId, runId, kind, artifactId)) throw new VisualContractError("visual_contract_invalid", "visual artifact key is not canonical", 409);
  const expectedId = await deriveVisualArtifactId(kind, runId, String((payload as Record<string, unknown>).frozen_payload_hash), envelope.idempotency_key);
  if (expectedId !== artifactId) throw new VisualContractError("visual_contract_invalid", "visual artifact id is not deterministic", 409);
  return { envelope, payload: payload as VisualArtifactPayload };
}

export function toVisualArtifactMetadata(object: VisualArtifactObject): VisualArtifactMetadata {
  const payload = object.payload;
  const summary: VisualArtifactMetadata["payload_summary"] = {
    frozen_payload_hash: payload.frozen_payload_hash,
    model_version: "model_version" in payload ? payload.model_version : ACTIVE_VISUAL_PINS.model.version,
    adapter_version: "adapter_version" in payload ? payload.adapter_version : ACTIVE_VISUAL_PINS.adapter.version,
    skill_pins: payload.pins,
    operation_id: object.envelope.idempotency_key,
  };
  if ("slot_id" in payload) summary.slot_id = payload.slot_id;
  if ("purpose" in payload) summary.slot_kind = payload.purpose === "cover" ? "cover" : "illustration";
  if ("purpose" in payload) summary.purpose = payload.purpose;
  if ("order" in payload) summary.order = payload.order;
  if ("plan_artifact_id" in payload) summary.plan_artifact_id = payload.plan_artifact_id;
  if ("plan_payload_hash" in payload) summary.plan_payload_hash = payload.plan_payload_hash;
  if ("mode" in payload) summary.mode = payload.mode;
  if ("slots" in payload) summary.asset_count = payload.slots.length;
  if ("binary_storage_ref" in payload) summary.binary_storage_ref = payload.binary_storage_ref;
  if ("byte_hash" in payload) summary.byte_hash = payload.byte_hash;
  if ("byte_length" in payload) summary.byte_length = payload.byte_length;
  if ("mime" in payload) summary.mime = payload.mime;
  if ("width" in payload) summary.width = payload.width;
  if ("height" in payload) summary.height = payload.height;
  if ("white_background_verified" in payload) summary.white_background_verified = payload.white_background_verified;
  if ("visible_text_evidence" in payload) summary.visible_text_evidence = payload.visible_text_evidence;
  if ("passed" in payload) {
    summary.qa_decision = payload.passed ? "pass" : "failed";
    summary.qa_version = VISUAL_QA_PROTOCOL;
  }
  return { ...object.envelope, payload_summary: summary };
}
