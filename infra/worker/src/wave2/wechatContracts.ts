import { canonicalJson, sha256, type FrozenArticleVersion, type VersionPin } from "./artifactContracts";

export const WAVE2D_SCHEMA_VERSION = "editorial-wave2d.v1" as const;
export const WECHAT_PUBLISHING_AGENT_VERSION = "wechat-publishing.agent.v1" as const;
export const WECHAT_RENDER_TEMPLATE_PROTOCOL = "wechat_render_template.v1" as const;
export const WECHAT_RENDER_QA_PROTOCOL = "wechat_render_qa_report.v1" as const;
export const WECHAT_UPLOAD_RECEIPT_PROTOCOL = "wechat_image_upload_receipt.v1" as const;
export const RENDERED_ARTICLE_PACKAGE_PROTOCOL = "rendered_article_package.v1" as const;
export const WECHAT_PREPUBLISH_QA_PROTOCOL = "wechat_prepublish_qa_report.v1" as const;
export const WECHAT_DRAFT_RECEIPT_PROTOCOL = "wechat_draft_receipt.v1" as const;
export const WECHAT_READBACK_QA_PROTOCOL = "wechat_draft_readback_qa.v1" as const;

export const WECHAT_ACTIVE_PINS = {
  role: { id: "wechat_publishing", version: WECHAT_PUBLISHING_AGENT_VERSION },
  publishing: { id: "vibepub-wechat-publishing", version: "1.0.0" },
  formatting: { id: "md_to_wechat", version: "1.0.0" },
  html_adapter: { id: "vibepub-wechat-html", version: "1.0.0", version_source: "project_adapter_manifest" },
  adapter: { id: "wechat-publishing.adapter", version: "1.0.0" },
  api: { id: "wechat-api-contract", version: "v1" },
  error_policy: { id: "wechat-error-policy", version: "v1" },
} as const;

export type WechatArtifactKind =
  | "wechat_render_template"
  | "wechat_render_qa_report"
  | "wechat_image_upload_receipt"
  | "rendered_article_package"
  | "wechat_prepublish_qa_report"
  | "wechat_draft_receipt"
  | "wechat_draft_readback_qa";

export type WechatSourceRef = { id: string; hash: string; slot?: string };
export type WechatOwner = { user_id: string; workspace_id: string; article_id: string; recording_id: number; run_id: string };
export type WechatPin = VersionPin & { version_source?: "project_adapter_manifest" };

export type WechatPinSnapshot = {
  role: WechatPin;
  publishing: WechatPin;
  formatting: WechatPin;
  html_adapter: WechatPin;
  adapter: WechatPin;
  api: WechatPin;
  error_policy: WechatPin;
};

export type WechatRenderTemplatePayload = {
  protocol_version: typeof WECHAT_RENDER_TEMPLATE_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  run_id: string;
  article_id: string;
  recording_id: number;
  frozen_artifact_id: string;
  frozen_payload_hash: string;
  visual_plan_artifact_id: string;
  visual_plan_payload_hash: string;
  visual_qa_artifact_id: string;
  visual_qa_payload_hash: string;
  asset_artifact_ids: string[];
  account_binding_id: string;
  account_receipt_hash: string;
  pin_snapshot: WechatPinSnapshot;
  title: string;
  cover_slot_id: string;
  body_slots: Array<{ slot_id: string; order: number; block_id: string; alt: string; caption: string | null }>;
  html_template: string;
  created_at: string;
};

export type WechatRenderQAReportPayload = {
  protocol_version: typeof WECHAT_RENDER_QA_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  template_artifact_id: string;
  template_payload_hash: string;
  decision: "pass" | "failed";
  checks: { safe_html: boolean; placeholders: boolean; list_continuity: boolean; preview_widths: [390, 430] };
  created_at: string;
};

export type WechatImageUploadReceiptPayload = {
  protocol_version: typeof WECHAT_UPLOAD_RECEIPT_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  frozen_artifact_id: string;
  frozen_payload_hash: string;
  visual_plan_artifact_id: string;
  visual_plan_payload_hash: string;
  visual_asset_artifact_id: string;
  visual_asset_payload_hash: string;
  visual_qa_artifact_id: string;
  visual_qa_payload_hash: string;
  account_binding_id: string;
  slot_id: string;
  purpose: "cover" | "body";
  order: number;
  asset_byte_hash: string;
  operation_id: string;
  provider_result_ref: string;
  provider_result_hash: string;
  media_url: string;
  cover_media_id: string | null;
  media_kind: "thumb" | "body";
  created_at: string;
};

export type RenderedArticlePackagePayload = {
  protocol_version: typeof RENDERED_ARTICLE_PACKAGE_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  template_artifact_id: string;
  template_payload_hash: string;
  render_qa_artifact_id: string;
  render_qa_payload_hash: string;
  title: string;
  canonical_html: string;
  html_hash: string;
  body_image_slots: string[];
  thumb_slot_id: string;
  upload_receipt_ids: string[];
  created_at: string;
};

export type WechatPrepublishQAReportPayload = {
  protocol_version: typeof WECHAT_PREPUBLISH_QA_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  package_artifact_id: string;
  package_payload_hash: string;
  ordered_upload_receipt_ids: string[];
  decision: "pass" | "failed";
  checks: { title: boolean; html_hash: boolean; image_order: boolean; safe_urls: boolean; preview_widths: [390, 430] };
  created_at: string;
};

export type WechatDraftReceiptPayload = {
  protocol_version: typeof WECHAT_DRAFT_RECEIPT_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  draft_identity_hash: string;
  package_artifact_id: string;
  package_payload_hash: string;
  prepublish_qa_artifact_id: string;
  prepublish_qa_payload_hash: string;
  upload_receipt_ids: string[];
  account_binding_id: string;
  operation_id: string;
  mutation: "add" | "update" | "noop";
  // Provider identity remains private in the immutable artifact payload. D1
  // and Coordinator mirrors intentionally retain only its artifact hash/ref.
  verified_draft_media_id: string;
  verified_thumb_media_id: string;
  verified_cover_image_url: string | null;
  created_at: string;
};

export type WechatDraftReadbackQAPayload = {
  protocol_version: typeof WECHAT_READBACK_QA_PROTOCOL;
  execution_scope: string;
  recovery_cycle: string | null;
  draft_receipt_artifact_id: string;
  draft_receipt_payload_hash: string;
  package_artifact_id: string;
  package_payload_hash: string;
  prepublish_qa_artifact_id: string;
  prepublish_qa_payload_hash: string;
  upload_receipt_ids: string[];
  decision: "pass" | "failed";
  checks: { media: boolean; title: boolean; html: boolean; urls: boolean; thumb: boolean; article_index: 0 };
  verified_draft_media_id: string;
  verified_thumb_media_id: string;
  verified_cover_image_url: string | null;
  created_at: string;
};

export type WechatArtifactPayload =
  | WechatRenderTemplatePayload
  | WechatRenderQAReportPayload
  | WechatImageUploadReceiptPayload
  | RenderedArticlePackagePayload
  | WechatPrepublishQAReportPayload
  | WechatDraftReceiptPayload
  | WechatDraftReadbackQAPayload;

export type WechatArtifactEnvelope = {
  schema_version: typeof WAVE2D_SCHEMA_VERSION;
  artifact_id: string;
  artifact_key: string;
  kind: WechatArtifactKind;
  producer: { role: "wechat_publishing"; version: typeof WECHAT_PUBLISHING_AGENT_VERSION };
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
};

export type WechatArtifactObject = { envelope: WechatArtifactEnvelope; payload: WechatArtifactPayload };
export type WechatArtifactMetadata = Omit<WechatArtifactEnvelope, "storage_ref"> & {
  storage_ref: string;
  payload_summary: {
    account_binding_id?: string;
    account_receipt_hash?: string;
    execution_scope?: string;
    recovery_cycle?: string | null;
    slot_id?: string;
    purpose?: "cover" | "body";
    order?: number;
    operation_id?: string;
    byte_hash?: string;
    pin_snapshot?: WechatPinSnapshot;
    decision?: "pass" | "failed";
  };
};

export class WechatContractError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function opaque(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new WechatContractError("wechat_contract_invalid", `${field} is invalid`, 400);
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new WechatContractError("wechat_contract_invalid", `${field} is invalid`, 400);
  return value;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) throw new WechatContractError("wechat_contract_invalid", `${field} is invalid`, 400);
  return value;
}

function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

function nonEmpty(value: unknown, field: string, max = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new WechatContractError("wechat_contract_invalid", `${field} is invalid`, 409);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !ID.test(item)) || new Set(value).size !== value.length) {
    throw new WechatContractError("wechat_contract_invalid", `${field} is invalid`, 409);
  }
  return [...value];
}

function payloadHash(value: unknown, field: string): string { return hash(value, field); }

function recoveryCycle(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
    throw new WechatContractError("wechat_contract_invalid", "payload.recovery_cycle is invalid", 409);
  }
  return value;
}

function assertWechatPayload(kind: WechatArtifactKind, payload: Record<string, unknown>): void {
  const createdAt = iso(payload.created_at, "payload.created_at");
  void createdAt;
  payloadHash(payload.execution_scope, "payload.execution_scope");
  recoveryCycle(payload.recovery_cycle);
  switch (kind) {
    case "wechat_render_template": {
      opaque(payload.run_id, "payload.run_id"); opaque(payload.article_id, "payload.article_id");
      if (!Number.isSafeInteger(payload.recording_id) || Number(payload.recording_id) < 1) throw new WechatContractError("wechat_contract_invalid", "template recording is invalid", 409);
      opaque(payload.frozen_artifact_id, "payload.frozen_artifact_id"); payloadHash(payload.frozen_payload_hash, "payload.frozen_payload_hash");
      opaque(payload.visual_plan_artifact_id, "payload.visual_plan_artifact_id"); payloadHash(payload.visual_plan_payload_hash, "payload.visual_plan_payload_hash");
      opaque(payload.visual_qa_artifact_id, "payload.visual_qa_artifact_id"); payloadHash(payload.visual_qa_payload_hash, "payload.visual_qa_payload_hash");
      stringList(payload.asset_artifact_ids, "payload.asset_artifact_ids");
      opaque(payload.account_binding_id, "payload.account_binding_id"); payloadHash(payload.account_receipt_hash, "payload.account_receipt_hash");
      assertWechatPinSnapshot(payload.pin_snapshot);
      nonEmpty(payload.title, "payload.title", 256); opaque(payload.cover_slot_id, "payload.cover_slot_id");
      if (!Array.isArray(payload.body_slots) || payload.body_slots.length === 0) throw new WechatContractError("wechat_contract_invalid", "template body slots are invalid", 409);
      const slots = payload.body_slots.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WechatContractError("wechat_contract_invalid", "template body slot is invalid", 409);
        const slot = raw as Record<string, unknown>;
        if (slot.order !== index + 1) throw new WechatContractError("wechat_contract_invalid", "template body slot order is invalid", 409);
        return { slot: opaque(slot.slot_id, "template slot"), block: opaque(slot.block_id, "template block"), alt: nonEmpty(slot.alt, "template alt", 512), caption: slot.caption };
      });
      if (new Set(slots.map(slot => slot.slot)).size !== slots.length || new Set(slots.map(slot => slot.block)).size !== slots.length || slots.some(slot => slot.caption !== null && typeof slot.caption !== "string")) throw new WechatContractError("wechat_contract_invalid", "template body slots are duplicated", 409);
      const templateHtml = nonEmpty(payload.html_template, "payload.html_template", 1_000_000);
      const placeholderUrls = slots.map(slot => `https://wechat-placeholder.invalid/${slot.slot}`);
      const normalizedTemplate = slots.reduce((html, slot) => html.replace(`{{wechat_image:${slot.slot}}}`, `https://wechat-placeholder.invalid/${slot.slot}`), templateHtml);
      if (/\{\{wechat_image:/.test(normalizedTemplate)) throw new WechatContractError("wechat_html_contract_invalid", "template placeholders are invalid", 422);
      assertWechatHtml(normalizedTemplate, placeholderUrls);
      return;
    }
    case "wechat_render_qa_report":
      opaque(payload.template_artifact_id, "payload.template_artifact_id"); payloadHash(payload.template_payload_hash, "payload.template_payload_hash");
      if (payload.decision !== "pass" && payload.decision !== "failed") throw new WechatContractError("wechat_contract_invalid", "render QA decision is invalid", 409);
      return;
    case "wechat_image_upload_receipt":
      opaque(payload.frozen_artifact_id, "payload.frozen_artifact_id"); payloadHash(payload.frozen_payload_hash, "payload.frozen_payload_hash");
      opaque(payload.visual_plan_artifact_id, "payload.visual_plan_artifact_id"); payloadHash(payload.visual_plan_payload_hash, "payload.visual_plan_payload_hash");
      opaque(payload.visual_asset_artifact_id, "payload.visual_asset_artifact_id"); payloadHash(payload.visual_asset_payload_hash, "payload.visual_asset_payload_hash");
      opaque(payload.visual_qa_artifact_id, "payload.visual_qa_artifact_id"); payloadHash(payload.visual_qa_payload_hash, "payload.visual_qa_payload_hash");
      opaque(payload.account_binding_id, "payload.account_binding_id"); opaque(payload.slot_id, "payload.slot_id"); opaque(payload.operation_id, "payload.operation_id"); payloadHash(payload.asset_byte_hash, "payload.asset_byte_hash");
      const operationId = opaque(payload.operation_id, "payload.operation_id");
      const evidencePrefix = `wechat-adapter/v1/result/${operationId}/`;
      if (typeof payload.provider_result_ref !== "string" || !payload.provider_result_ref.startsWith(evidencePrefix) ||
          !/^[1-3]\.json$/.test(payload.provider_result_ref.slice(evidencePrefix.length))) {
        throw new WechatContractError("wechat_contract_invalid", "upload provider result reference is invalid", 409);
      }
      payloadHash(payload.provider_result_hash, "payload.provider_result_hash");
      if (typeof payload.media_url !== "string" || !/^https:\/\//.test(payload.media_url)) {
        throw new WechatContractError("wechat_contract_invalid", "upload media URL is invalid", 409);
      }
      if ((payload.purpose !== "cover" && payload.purpose !== "body") || !Number.isSafeInteger(payload.order) || Number(payload.order) < 0 || (payload.media_kind !== "thumb" && payload.media_kind !== "body")) throw new WechatContractError("wechat_contract_invalid", "upload receipt slot is invalid", 409);
      if ((payload.purpose === "cover") !== (payload.media_kind === "thumb")) throw new WechatContractError("wechat_contract_invalid", "upload receipt media kind is invalid", 409);
      if (payload.purpose === "cover") opaque(payload.cover_media_id, "payload.cover_media_id");
      else if (payload.cover_media_id !== null) throw new WechatContractError("wechat_contract_invalid", "body upload cannot contain a cover media ID", 409);
      return;
    case "rendered_article_package":
      opaque(payload.template_artifact_id, "payload.template_artifact_id"); payloadHash(payload.template_payload_hash, "payload.template_payload_hash");
      opaque(payload.render_qa_artifact_id, "payload.render_qa_artifact_id"); payloadHash(payload.render_qa_payload_hash, "payload.render_qa_payload_hash");
      nonEmpty(payload.title, "package title", 256); nonEmpty(payload.canonical_html, "package html", 1_000_000); payloadHash(payload.html_hash, "package html hash");
      stringList(payload.body_image_slots, "package body image slots"); opaque(payload.thumb_slot_id, "package thumb slot"); stringList(payload.upload_receipt_ids, "package upload receipts");
      return;
    case "wechat_prepublish_qa_report":
      opaque(payload.package_artifact_id, "payload.package_artifact_id"); payloadHash(payload.package_payload_hash, "payload.package_payload_hash"); stringList(payload.ordered_upload_receipt_ids, "payload.ordered_upload_receipt_ids");
      if (payload.decision !== "pass" && payload.decision !== "failed") throw new WechatContractError("wechat_contract_invalid", "prepublish decision is invalid", 409);
      return;
    case "wechat_draft_receipt":
      payloadHash(payload.draft_identity_hash, "payload.draft_identity_hash"); opaque(payload.package_artifact_id, "payload.package_artifact_id"); payloadHash(payload.package_payload_hash, "payload.package_payload_hash");
      opaque(payload.prepublish_qa_artifact_id, "payload.prepublish_qa_artifact_id"); payloadHash(payload.prepublish_qa_payload_hash, "payload.prepublish_qa_payload_hash"); opaque(payload.account_binding_id, "payload.account_binding_id"); opaque(payload.operation_id, "payload.operation_id");
      stringList(payload.upload_receipt_ids, "payload.upload_receipt_ids");
      if (payload.mutation !== "add" && payload.mutation !== "update" && payload.mutation !== "noop") throw new WechatContractError("wechat_contract_invalid", "draft mutation is invalid", 409);
      opaque(payload.verified_draft_media_id, "payload.verified_draft_media_id");
      opaque(payload.verified_thumb_media_id, "payload.verified_thumb_media_id");
      if (payload.verified_cover_image_url !== null && (typeof payload.verified_cover_image_url !== "string" || !/^https:\/\//.test(payload.verified_cover_image_url))) throw new WechatContractError("wechat_contract_invalid", "draft cover evidence is invalid", 409);
      return;
    case "wechat_draft_readback_qa":
      opaque(payload.draft_receipt_artifact_id, "payload.draft_receipt_artifact_id"); payloadHash(payload.draft_receipt_payload_hash, "payload.draft_receipt_payload_hash");
      opaque(payload.package_artifact_id, "payload.package_artifact_id"); payloadHash(payload.package_payload_hash, "payload.package_payload_hash");
      opaque(payload.prepublish_qa_artifact_id, "payload.prepublish_qa_artifact_id"); payloadHash(payload.prepublish_qa_payload_hash, "payload.prepublish_qa_payload_hash");
      stringList(payload.upload_receipt_ids, "payload.upload_receipt_ids");
      if (payload.decision !== "pass" && payload.decision !== "failed") throw new WechatContractError("wechat_contract_invalid", "readback decision is invalid", 409);
      opaque(payload.verified_draft_media_id, "payload.verified_draft_media_id");
      opaque(payload.verified_thumb_media_id, "payload.verified_thumb_media_id");
      if (payload.verified_cover_image_url !== null && (typeof payload.verified_cover_image_url !== "string" || !/^https:\/\//.test(payload.verified_cover_image_url))) throw new WechatContractError("wechat_contract_invalid", "readback cover evidence is invalid", 409);
      return;
  }
}

function equalStrings(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/**
 * The parent graph is duplicated in the envelope inputs and the typed payload
 * so neither representation can be spliced into a valid immutable object.
 */
function assertWechatInputChain(kind: WechatArtifactKind, inputIds: string[], payload: Record<string, unknown>): void {
  const values = (field: string) => stringList(payload[field], `payload.${field}`);
  let expected: string[];
  switch (kind) {
    case "wechat_render_template":
      expected = [
        opaque(payload.frozen_artifact_id, "payload.frozen_artifact_id"),
        opaque(payload.visual_plan_artifact_id, "payload.visual_plan_artifact_id"),
        ...values("asset_artifact_ids"),
        opaque(payload.visual_qa_artifact_id, "payload.visual_qa_artifact_id"),
      ];
      break;
    case "wechat_render_qa_report":
      expected = [opaque(payload.template_artifact_id, "payload.template_artifact_id")];
      break;
    case "wechat_image_upload_receipt":
      expected = [
        opaque(payload.frozen_artifact_id, "payload.frozen_artifact_id"),
        opaque(payload.visual_plan_artifact_id, "payload.visual_plan_artifact_id"),
        opaque(payload.visual_asset_artifact_id, "payload.visual_asset_artifact_id"),
        opaque(payload.visual_qa_artifact_id, "payload.visual_qa_artifact_id"),
      ];
      break;
    case "rendered_article_package":
      expected = [
        opaque(payload.template_artifact_id, "payload.template_artifact_id"),
        opaque(payload.render_qa_artifact_id, "payload.render_qa_artifact_id"),
        ...values("upload_receipt_ids"),
      ];
      break;
    case "wechat_prepublish_qa_report":
      expected = [opaque(payload.package_artifact_id, "payload.package_artifact_id"), ...values("ordered_upload_receipt_ids")];
      break;
    case "wechat_draft_receipt":
      expected = [
        opaque(payload.package_artifact_id, "payload.package_artifact_id"),
        opaque(payload.prepublish_qa_artifact_id, "payload.prepublish_qa_artifact_id"),
        ...values("upload_receipt_ids"),
      ];
      break;
    case "wechat_draft_readback_qa":
      expected = [
        opaque(payload.package_artifact_id, "payload.package_artifact_id"),
        opaque(payload.prepublish_qa_artifact_id, "payload.prepublish_qa_artifact_id"),
        opaque(payload.draft_receipt_artifact_id, "payload.draft_receipt_artifact_id"),
        ...values("upload_receipt_ids"),
      ];
      break;
  }
  if (!equalStrings(inputIds, expected)) throw new WechatContractError("wechat_parent_chain_conflict", "wechat artifact inputs do not match its payload", 409);
}

export function activeWechatPinSnapshot(): WechatPinSnapshot {
  return JSON.parse(canonicalJson(WECHAT_ACTIVE_PINS)) as WechatPinSnapshot;
}

export function assertWechatPinSnapshot(value: unknown): asserts value is WechatPinSnapshot {
  if (!same(value, WECHAT_ACTIVE_PINS)) throw new WechatContractError("wechat_pin_conflict", "wechat pin snapshot is not active", 409);
}

function shard(owner: Pick<WechatOwner, "user_id" | "workspace_id" | "run_id">): string {
  let value = 2166136261;
  for (const char of `${owner.user_id}\u0000${owner.workspace_id}\u0000${owner.run_id}`) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0").slice(0, 2);
}

export function wechatArtifactKey(owner: WechatOwner, kind: WechatArtifactKind, artifactId: string): string {
  opaque(owner.user_id, "user_id"); opaque(owner.workspace_id, "workspace_id"); opaque(owner.run_id, "run_id"); opaque(artifactId, "artifact_id");
  return `editorial/v3/${shard(owner)}/${owner.run_id}/wechat/${kind}/${artifactId}.v1.json`;
}

export async function wechatScopeHash(input: {
  owner: WechatOwner;
  frozen: WechatSourceRef;
  plan: WechatSourceRef;
  assets: WechatSourceRef[];
  visualQA: WechatSourceRef;
  pin_snapshot_id: string;
  account_binding_id: string;
}): Promise<string> {
  const assets = [...input.assets].map(asset => ({ id: opaque(asset.id, "asset id"), hash: hash(asset.hash, "asset hash"), slot: opaque(asset.slot || "", "asset slot") }));
  if (new Set(assets.map(asset => asset.slot)).size !== assets.length) throw new WechatContractError("wechat_scope_conflict", "asset slots are duplicated");
  return sha256(canonicalJson({
    schema_version: WAVE2D_SCHEMA_VERSION,
    run_id: opaque(input.owner.run_id, "run_id"),
    owner: { user_id: opaque(input.owner.user_id, "user_id"), workspace_id: opaque(input.owner.workspace_id, "workspace_id"), article_id: opaque(input.owner.article_id, "article_id"), recording_id: input.owner.recording_id },
    F: { id: opaque(input.frozen.id, "frozen id"), hash: hash(input.frozen.hash, "frozen hash") },
    P: { id: opaque(input.plan.id, "plan id"), hash: hash(input.plan.hash, "plan hash") },
    A: assets,
    VQ: { id: opaque(input.visualQA.id, "visual qa id"), hash: hash(input.visualQA.hash, "visual qa hash") },
    pin_snapshot_id: opaque(input.pin_snapshot_id, "pin snapshot id"),
    account_binding_id: opaque(input.account_binding_id, "account binding id"),
  }));
}

export async function deriveWechatDraftIdentity(accountBindingId: string, owner: Pick<WechatOwner, "user_id" | "workspace_id" | "article_id">): Promise<string> {
  return sha256(canonicalJson({
    version: "wechat-draft:v1",
    account_binding_id: opaque(accountBindingId, "account_binding_id"),
    user_id: opaque(owner.user_id, "user_id"),
    workspace_id: opaque(owner.workspace_id, "workspace_id"),
    article_id: opaque(owner.article_id, "article_id"),
  }));
}

export async function deriveWechatArtifactId(kind: WechatArtifactKind, runId: string, idempotencyKey: string): Promise<string> {
  return `${kind}_${(await sha256(canonicalJson({ kind, run_id: runId, idempotency_key: idempotencyKey }))).slice(7, 31)}`;
}

export async function makeWechatArtifact(input: {
  owner: WechatOwner;
  kind: WechatArtifactKind;
  payload: WechatArtifactPayload;
  input_artifact_ids: string[];
  idempotency_key: string;
  created_at: string;
}): Promise<WechatArtifactObject> {
  const payloadBytes = new TextEncoder().encode(canonicalJson(input.payload));
  const payloadHash = await sha256(payloadBytes);
  const artifactId = await deriveWechatArtifactId(input.kind, input.owner.run_id, opaque(input.idempotency_key, "idempotency_key"));
  const artifactKey = wechatArtifactKey(input.owner, input.kind, artifactId);
  const envelope: WechatArtifactEnvelope = {
    schema_version: WAVE2D_SCHEMA_VERSION,
    artifact_id: artifactId,
    artifact_key: artifactKey,
    kind: input.kind,
    producer: { role: "wechat_publishing", version: WECHAT_PUBLISHING_AGENT_VERSION },
    run_id: opaque(input.owner.run_id, "run_id"), article_id: opaque(input.owner.article_id, "article_id"), recording_id: input.owner.recording_id,
    user_id: opaque(input.owner.user_id, "user_id"), workspace_id: opaque(input.owner.workspace_id, "workspace_id"),
    input_artifact_ids: input.input_artifact_ids.map(value => opaque(value, "input_artifact_id")),
    idempotency_key: opaque(input.idempotency_key, "idempotency_key"), payload_hash: payloadHash, payload_length: payloadBytes.byteLength,
    created_at: iso(input.created_at, "created_at"), storage_ref: `r2://${artifactKey}`,
  };
  return normalizeWechatArtifact({ ...envelope, payload: input.payload });
}

export async function normalizeWechatArtifact(input: Record<string, unknown>): Promise<WechatArtifactObject> {
  const kind = input.kind;
  if (!["wechat_render_template", "wechat_render_qa_report", "wechat_image_upload_receipt", "rendered_article_package", "wechat_prepublish_qa_report", "wechat_draft_receipt", "wechat_draft_readback_qa"].includes(String(kind))) {
    throw new WechatContractError("wechat_contract_invalid", "artifact kind is invalid", 400);
  }
  const owner: WechatOwner = {
    run_id: opaque(input.run_id, "run_id"), article_id: opaque(input.article_id, "article_id"), recording_id: Number(input.recording_id),
    user_id: opaque(input.user_id, "user_id"), workspace_id: opaque(input.workspace_id, "workspace_id"),
  };
  if (!Number.isSafeInteger(owner.recording_id) || owner.recording_id < 1) throw new WechatContractError("wechat_contract_invalid", "recording_id is invalid", 400);
  const artifactId = opaque(input.artifact_id, "artifact_id");
  const idempotencyKey = opaque(input.idempotency_key, "idempotency_key");
  const expectedId = await deriveWechatArtifactId(kind as WechatArtifactKind, owner.run_id, idempotencyKey);
  if (artifactId !== expectedId || input.artifact_key !== wechatArtifactKey(owner, kind as WechatArtifactKind, artifactId)) throw new WechatContractError("wechat_identity_conflict", "artifact identity is not canonical", 409);
  if (input.schema_version !== WAVE2D_SCHEMA_VERSION || !same(input.producer, { role: "wechat_publishing", version: WECHAT_PUBLISHING_AGENT_VERSION })) throw new WechatContractError("wechat_contract_invalid", "artifact producer is invalid", 409);
  if (!Array.isArray(input.input_artifact_ids) || new Set(input.input_artifact_ids).size !== input.input_artifact_ids.length) throw new WechatContractError("wechat_contract_invalid", "artifact inputs are invalid", 409);
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new WechatContractError("wechat_contract_invalid", "artifact payload is invalid", 400);
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const payloadHash = await sha256(payloadBytes);
  if (input.payload_hash !== payloadHash || Number(input.payload_length) !== payloadBytes.byteLength) throw new WechatContractError("wechat_payload_hash_conflict", "artifact payload hash is invalid", 409);
  const expectedProtocol: Record<string, string> = {
    wechat_render_template: WECHAT_RENDER_TEMPLATE_PROTOCOL,
    wechat_render_qa_report: WECHAT_RENDER_QA_PROTOCOL,
    wechat_image_upload_receipt: WECHAT_UPLOAD_RECEIPT_PROTOCOL,
    rendered_article_package: RENDERED_ARTICLE_PACKAGE_PROTOCOL,
    wechat_prepublish_qa_report: WECHAT_PREPUBLISH_QA_PROTOCOL,
    wechat_draft_receipt: WECHAT_DRAFT_RECEIPT_PROTOCOL,
    wechat_draft_readback_qa: WECHAT_READBACK_QA_PROTOCOL,
  };
  if ((payload as Record<string, unknown>).protocol_version !== expectedProtocol[String(kind)]) throw new WechatContractError("wechat_contract_invalid", "payload protocol is invalid", 409);
  assertWechatPayload(kind as WechatArtifactKind, payload as Record<string, unknown>);
  const inputArtifactIds = (input.input_artifact_ids as unknown[]).map(value => opaque(value, "input_artifact_id"));
  assertWechatInputChain(kind as WechatArtifactKind, inputArtifactIds, payload as Record<string, unknown>);
  const envelope: WechatArtifactEnvelope = {
    schema_version: WAVE2D_SCHEMA_VERSION, artifact_id: artifactId, artifact_key: String(input.artifact_key), kind: kind as WechatArtifactKind,
    producer: { role: "wechat_publishing", version: WECHAT_PUBLISHING_AGENT_VERSION }, ...owner,
    input_artifact_ids: inputArtifactIds, idempotency_key: idempotencyKey,
    payload_hash: payloadHash, payload_length: payloadBytes.byteLength, created_at: iso(input.created_at, "created_at"), storage_ref: `r2://${String(input.artifact_key)}`,
  };
  if (input.storage_ref !== envelope.storage_ref) throw new WechatContractError("wechat_contract_invalid", "storage ref is invalid", 409);
  return { envelope, payload: payload as WechatArtifactPayload };
}

export function toWechatArtifactMetadata(object: WechatArtifactObject): WechatArtifactMetadata {
  const { envelope, payload } = object;
  const base: WechatArtifactMetadata = { ...envelope, payload_summary: { pin_snapshot: activeWechatPinSnapshot() } };
  const value = payload as Record<string, unknown>;
  if (typeof value.account_binding_id === "string") base.payload_summary.account_binding_id = value.account_binding_id;
  if (typeof value.account_receipt_hash === "string") base.payload_summary.account_receipt_hash = value.account_receipt_hash;
  if (typeof value.execution_scope === "string") base.payload_summary.execution_scope = value.execution_scope;
  if (value.recovery_cycle === null || typeof value.recovery_cycle === "string") base.payload_summary.recovery_cycle = value.recovery_cycle;
  if (typeof value.slot_id === "string") base.payload_summary.slot_id = value.slot_id;
  if (value.purpose === "cover" || value.purpose === "body") base.payload_summary.purpose = value.purpose;
  if (typeof value.order === "number") base.payload_summary.order = value.order;
  if (typeof value.operation_id === "string") base.payload_summary.operation_id = value.operation_id;
  if (typeof value.asset_byte_hash === "string") base.payload_summary.byte_hash = value.asset_byte_hash;
  if (value.pin_snapshot && typeof value.pin_snapshot === "object") base.payload_summary.pin_snapshot = value.pin_snapshot as WechatPinSnapshot;
  if (value.decision === "pass" || value.decision === "failed") base.payload_summary.decision = value.decision;
  return base;
}

export function canonicalWechatHtml(title: string, blocks: FrozenArticleVersion["blocks"], bodySlots: Array<{ slot_id: string; block_id: string; alt: string; caption: string | null }>): string {
  const byBlock = new Map(bodySlots.map(slot => [slot.block_id, slot]));
  const parts = [`<section style="max-width:677px;margin:0 auto;color:#202020;font-size:16px;line-height:1.75;overflow-wrap:anywhere"><p style="font-size:24px;font-weight:700;margin:0 0 20px">${escapeHtml(title)}</p>`];
  for (const block of [...blocks].sort((left, right) => left.order - right.order)) {
    if (block.kind === "heading") parts.push(`<p style="font-size:19px;font-weight:700;margin:24px 0 10px">${escapeHtml(block.text)}</p>`);
    else if (block.kind === "list") parts.push(`<p style="margin:10px 0;padding-left:1em">&#8226; ${escapeHtml(block.text)}</p>`);
    else if (block.kind === "table") parts.push(`<p style="margin:10px 0;border-left:3px solid #d0d0d0;padding-left:12px">${escapeHtml(block.text)}</p>`);
    else parts.push(`<p style="margin:10px 0">${escapeHtml(block.text)}</p>`);
    const slot = byBlock.get(block.block_id);
    if (slot) {
      const marker = `{{wechat_image:${slot.slot_id}}}`;
      parts.push(`<figure style="margin:18px 0"><img src="${marker}" alt="${escapeAttribute(slot.alt)}" style="display:block;width:100%;height:auto"/>${slot.caption ? `<figcaption style="color:#666;font-size:13px;margin-top:6px">${escapeHtml(slot.caption)}</figcaption>` : ""}</figure>`);
    }
  }
  parts.push("</section>");
  return parts.join("");
}

export function renderWechatPackage(template: WechatRenderTemplatePayload, uploads: Array<{ slot_id: string; url: string }>, createdAt: string): RenderedArticlePackagePayload {
  const bodyUpload = uploads.filter(upload => template.body_slots.some(slot => slot.slot_id === upload.slot_id));
  if (bodyUpload.length !== template.body_slots.length || new Set(bodyUpload.map(upload => upload.slot_id)).size !== bodyUpload.length || bodyUpload.some(upload => !/^https:\/\//.test(upload.url))) {
    throw new WechatContractError("wechat_html_contract_invalid", "body upload set is invalid", 422);
  }
  let html = template.html_template;
  for (const slot of template.body_slots) {
    const upload = bodyUpload.find(value => value.slot_id === slot.slot_id);
    if (!upload) throw new WechatContractError("wechat_html_contract_invalid", "body upload is missing", 422);
    html = html.replace(`{{wechat_image:${slot.slot_id}}}`, upload.url);
  }
  if (/\{\{wechat_image:/.test(html)) throw new WechatContractError("wechat_html_contract_invalid", "rendered html has unresolved images", 422);
  return {
    protocol_version: RENDERED_ARTICLE_PACKAGE_PROTOCOL,
    execution_scope: template.execution_scope,
    recovery_cycle: template.recovery_cycle,
    template_artifact_id: template.run_id,
    template_payload_hash: "",
    render_qa_artifact_id: "",
    render_qa_payload_hash: "",
    title: template.title,
    canonical_html: html,
    html_hash: "",
    body_image_slots: template.body_slots.map(slot => slot.slot_id),
    thumb_slot_id: template.cover_slot_id,
    upload_receipt_ids: [],
    created_at: iso(createdAt, "created_at"),
  };
}

export async function finalizeWechatPackage(input: Omit<RenderedArticlePackagePayload, "html_hash">): Promise<RenderedArticlePackagePayload> {
  const canonicalHtml = normalizeWechatHtml(input.canonical_html);
  return { ...input, canonical_html: canonicalHtml, html_hash: await sha256(canonicalHtml) };
}

export type WechatHtmlValidation = {
  canonical_html: string;
  body_urls: string[];
  safe_html: boolean;
  list_continuity: boolean;
  preview_widths: [390, 430];
};

/**
 * This is deliberately a small project-owned HTML grammar. The renderer only
 * emits these tags and attributes, so accepting a broader browser grammar
 * would weaken the final WeChat safety boundary.
 */
export function normalizeWechatHtml(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000_000) throw new WechatContractError("wechat_html_contract_invalid", "HTML is invalid", 422);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new WechatContractError("wechat_html_contract_invalid", "HTML is empty", 422);
  return normalized;
}

function isAllowedWechatHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      hostname !== "localhost" && !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

function parseStyle(value: string, tag: string): Record<string, string> {
  const allowed = new Set(["max-width", "margin", "color", "font-size", "line-height", "font-weight", "padding-left", "border-left", "display", "width", "height", "margin-top", "overflow-wrap"]);
  const result: Record<string, string> = {};
  for (const part of value.split(";")) {
    if (!part.trim()) continue;
    const separator = part.indexOf(":");
    if (separator < 1) throw new WechatContractError("wechat_html_contract_invalid", "inline style is invalid", 422);
    const property = part.slice(0, separator).trim().toLowerCase();
    const styleValue = part.slice(separator + 1).trim().toLowerCase();
    if (!allowed.has(property) || !styleValue || /url\(|expression\(|@font|javascript:|data:|blob:|file:/i.test(styleValue)) throw new WechatContractError("wechat_html_contract_invalid", "inline style is unsafe", 422);
    result[property] = styleValue;
  }
  if (tag !== "img" && ("width" in result || "height" in result)) {
    throw new WechatContractError("wechat_html_contract_invalid", "only images may declare dimensions", 422);
  }
  if (tag === "img" && (result.width !== "100%" || result.height !== "auto" || result.display !== "block")) {
    throw new WechatContractError("wechat_html_contract_invalid", "image layout is invalid", 422);
  }
  if (tag === "section" && (result["max-width"] !== "677px" || result["overflow-wrap"] !== "anywhere")) {
    throw new WechatContractError("wechat_html_contract_invalid", "preview width containment is invalid", 422);
  }
  if (tag !== "section" && ("max-width" in result || "overflow-wrap" in result)) {
    throw new WechatContractError("wechat_html_contract_invalid", "preview containment is only valid on the article section", 422);
  }
  return result;
}

export function validateWechatHtml(html: string, expectedUrls: string[]): WechatHtmlValidation {
  const canonicalHtml = normalizeWechatHtml(html);
  if (/<(?:script|style|link|h1|iframe|object|embed)\b|<![-A-Z]|\sclass\s*=|\son[a-z]+\s*=|(?:javascript:|data:|blob:|r2:\/\/|file:)/i.test(canonicalHtml)) {
    throw new WechatContractError("wechat_html_contract_invalid", "unsafe HTML is not allowed", 422);
  }
  const allowedTags = new Set(["section", "p", "figure", "img", "figcaption", "strong", "em", "br"]);
  const urls: string[] = [];
  const stack: string[] = [];
  let sectionCount = 0;
  let listParagraphs = 0;
  let invalidListParagraph = false;
  for (const match of canonicalHtml.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    const closing = match[0].startsWith("</");
    const tag = match[1].toLowerCase();
    const attributes = match[2] || "";
    if (!allowedTags.has(tag)) throw new WechatContractError("wechat_html_contract_invalid", "HTML tag is not allowed", 422);
    if (closing) {
      if (stack.pop() !== tag) throw new WechatContractError("wechat_html_contract_invalid", "HTML tags are not balanced", 422);
      continue;
    }
    const selfClosing = /\/$/.test(attributes.trim());
    if ((tag === "img" || tag === "br") && !selfClosing) throw new WechatContractError("wechat_html_contract_invalid", "void HTML tags must be self-closing", 422);
    if (tag !== "img" && tag !== "br") stack.push(tag);
    if (tag === "section") sectionCount += 1;
    const allowedAttributes = tag === "img" ? new Set(["src", "alt", "style"]) : new Set(["style"]);
    const attributeEntries = [...attributes.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)];
    const stripped = attributes.replace(/\s*([a-zA-Z-]+)="[^"]*"/g, "").replace(/\/?\s*/g, "");
    if (stripped) throw new WechatContractError("wechat_html_contract_invalid", "HTML attribute syntax is invalid", 422);
    const attributeNames = new Set<string>();
    for (const attribute of attributeEntries) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2];
      attributeNames.add(name);
      if (!allowedAttributes.has(name)) throw new WechatContractError("wechat_html_contract_invalid", "HTML attribute is not allowed", 422);
      if (name === "style") {
        void parseStyle(value, tag);
      }
      if (name === "src") {
        if (!isAllowedWechatHttpsUrl(value)) throw new WechatContractError("wechat_html_contract_invalid", "image source is invalid", 422);
        urls.push(value);
      }
    }
    if ((tag === "section" || tag === "img") && !attributeNames.has("style")) {
      throw new WechatContractError("wechat_html_contract_invalid", "layout style is required", 422);
    }
    if (tag === "img" && (!attributeNames.has("src") || !attributeNames.has("alt"))) {
      throw new WechatContractError("wechat_html_contract_invalid", "image provenance attributes are required", 422);
    }
  }
  if (stack.length !== 0 || sectionCount !== 1) throw new WechatContractError("wechat_html_contract_invalid", "article structure is invalid", 422);
  for (const paragraph of canonicalHtml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    if (/padding-left:1em/.test(paragraph[1])) {
      listParagraphs += 1;
      if (!paragraph[2].startsWith("&#8226; ")) invalidListParagraph = true;
    }
  }
  if (!same(urls, expectedUrls) || urls.some(url => !isAllowedWechatHttpsUrl(url))) throw new WechatContractError("wechat_html_contract_invalid", "rendered image URLs are invalid", 422);
  if (invalidListParagraph || (listParagraphs > 0 && !canonicalHtml.includes("&#8226;"))) throw new WechatContractError("wechat_html_contract_invalid", "list continuity is invalid", 422);
  return { canonical_html: canonicalHtml, body_urls: urls, safe_html: true, list_continuity: true, preview_widths: [390, 430] };
}

export function assertWechatHtml(html: string, expectedUrls: string[]): void {
  void validateWechatHtml(html, expectedUrls);
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char); }
function escapeAttribute(value: string): string { return escapeHtml(value); }
