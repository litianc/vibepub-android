import { describe, expect, it } from "vitest";
import {
  WAVE2D_SCHEMA_VERSION,
  assertWechatHtml,
  canonicalWechatHtml,
  deriveWechatArtifactId,
  deriveWechatDraftIdentity,
  makeWechatArtifact,
  normalizeWechatArtifact,
  renderWechatPackage,
  toWechatArtifactMetadata,
  wechatScopeHash,
  WechatContractError,
} from "../src/wave2/wechatContracts";
import { projectPublicationTransition, type PublicationRunRow } from "../src/publicationProjection";
import { putImmutableWechatArtifact, readExactWechatArtifact } from "../src/wave2/wechatArtifactStore";
import { isWechatMediaUrlAllowed } from "../src/wave2/wechatServiceClients";
import {
  assertUniquePassingWechatExecutionScopeForVerification,
  assertWechatHoldRevisionForVerification,
  assertWechatRecoveryProjectionFieldsForVerification,
  assertWechatScopeRecoveryBindingsForVerification,
  assertWechatScopeTopologyForVerification,
} from "../src/fiveAgentPublishing";

const owner = { user_id: "user-wave2d", workspace_id: "workspace-wave2d", article_id: "article-wave2d", recording_id: 9, run_id: "run-wave2d" };
const h = (char: string) => `sha256:${char.repeat(64)}`;
const executionScope = h("e");

function projectionAt(state: PublicationRunRow["state"]): PublicationRunRow {
  return {
    run_id: "run-wave2d", user_id: owner.user_id, workspace_id: owner.workspace_id, article_id: owner.article_id, recording_id: owner.recording_id,
    source_run_id: "source-run", source_manifest_hash: h("0"), source_state: state, source_state_revision: 1,
    schema_version: "publication-projection.v1", workflow_version: "publishing-workflow.v1", policy_version: "publishing-policy.v1",
    agent_versions_json: "{}", skill_pins_json: "{}", state, run_status: "active", state_revision: 3,
    progress_percent: state === "visual_ready" ? 80 : state === "formatting" ? 84 : 90,
    resume_state: null, last_successful_state: state, last_successful_progress_percent: state === "visual_ready" ? 80 : state === "formatting" ? 84 : 90,
    retry_count: 0, next_action: null, error_code: null, idempotency_key: "run-key", payload_hash: h("1"),
    created_at: "2026-07-21T00:00:00.000Z", updated_at: "2026-07-21T00:00:00.000Z",
    last_event_id: "event-3", last_event_type: "visual", last_event_idempotency_key: "visual:3", last_event_payload_hash: h("2"), last_event_created_at: "2026-07-21T00:00:00.000Z",
  };
}

class MemoryBucket {
  readonly records = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async get(key: string) {
    const record = this.records.get(key);
    return record ? {
      arrayBuffer: async () => record.bytes.slice().buffer,
      customMetadata: { ...record.metadata },
    } : null;
  }
  async head(key: string) {
    const record = this.records.get(key);
    return record ? { size: record.bytes.byteLength, customMetadata: { ...record.metadata } } : null;
  }
  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { customMetadata?: Record<string, string>; onlyIf?: { etagDoesNotMatch?: string } }) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.records.has(key)) throw new Error("conditional conflict");
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.records.set(key, { bytes: bytes.slice(), metadata: { ...(options?.customMetadata || {}) } });
    return { key };
  }
}

async function renderQaObject(decision: "pass" | "failed" = "pass") {
  const payload = {
    protocol_version: "wechat_render_qa_report.v1" as const, execution_scope: executionScope, recovery_cycle: null, template_artifact_id: "template-1", template_payload_hash: h("a"), decision,
    checks: { safe_html: true, placeholders: true, list_continuity: true, preview_widths: [390, 430] as [390, 430] }, created_at: "2026-07-21T00:00:00.000Z",
  };
  return makeWechatArtifact({ owner, kind: "wechat_render_qa_report", payload, input_artifact_ids: ["template-1"], idempotency_key: `wave2d:render-qa:${h("a")}`, created_at: payload.created_at });
}

async function topologyScope(input: {
  scope: string;
  recoveryCycle: string | null;
  prefix: string;
  decision?: "pass" | "failed";
  stopAfter?: "template";
  packageTemplate?: { id: string; hash: string };
}) {
  const createdAt = "2026-07-21T00:00:00.000Z";
  const key = (kind: string) => `wave2d:topology:${input.prefix}:${kind}`;
  const templatePayload = {
    protocol_version: "wechat_render_template.v1" as const,
    execution_scope: input.scope,
    recovery_cycle: input.recoveryCycle,
    run_id: owner.run_id,
    article_id: owner.article_id,
    recording_id: owner.recording_id,
    frozen_artifact_id: "frozen-1",
    frozen_payload_hash: h("a"),
    visual_plan_artifact_id: "plan-1",
    visual_plan_payload_hash: h("b"),
    visual_qa_artifact_id: "visual-qa-1",
    visual_qa_payload_hash: h("c"),
    asset_artifact_ids: ["asset-cover", "asset-body-1", "asset-body-2"],
    account_binding_id: "wab_topology",
    account_receipt_hash: h("d"),
    pin_snapshot: {
      role: { id: "wechat_publishing", version: "wechat-publishing.agent.v1" },
      publishing: { id: "vibepub-wechat-publishing", version: "1.0.0" },
      formatting: { id: "md_to_wechat", version: "1.0.0" },
      html_adapter: { id: "vibepub-wechat-html", version: "1.0.0", version_source: "project_adapter_manifest" as const },
      adapter: { id: "wechat-publishing.adapter", version: "1.0.0" },
      api: { id: "wechat-api-contract", version: "v1" },
      error_policy: { id: "wechat-error-policy", version: "v1" },
    },
    title: "Topology title",
    cover_slot_id: "cover_01",
    body_slots: [
      { slot_id: "body_01", order: 1, block_id: "block-1", alt: "one", caption: null },
      { slot_id: "body_02", order: 2, block_id: "block-2", alt: "two", caption: null },
    ],
    html_template: '<section style="max-width:677px;margin:0 auto;color:#202020;font-size:16px;line-height:1.75;overflow-wrap:anywhere"><p style="font-size:24px;font-weight:700;margin:0 0 20px">Topology title</p><p style="margin:10px 0">One</p><figure style="margin:18px 0"><img src="{{wechat_image:body_01}}" alt="one" style="display:block;width:100%;height:auto"/></figure><p style="margin:10px 0">Two</p><figure style="margin:18px 0"><img src="{{wechat_image:body_02}}" alt="two" style="display:block;width:100%;height:auto"/></figure></section>',
    created_at: createdAt,
  };
  const template = await makeWechatArtifact({ owner, kind: "wechat_render_template", payload: templatePayload, input_artifact_ids: ["frozen-1", "plan-1", "asset-cover", "asset-body-1", "asset-body-2", "visual-qa-1"], idempotency_key: key("template"), created_at: createdAt });
  if (input.stopAfter === "template") return [template];
  const renderQaPayload = {
    protocol_version: "wechat_render_qa_report.v1" as const, execution_scope: input.scope, recovery_cycle: input.recoveryCycle,
    template_artifact_id: template.envelope.artifact_id, template_payload_hash: template.envelope.payload_hash,
    decision: "pass" as const, checks: { safe_html: true, placeholders: true, list_continuity: true, preview_widths: [390, 430] as [390, 430] }, created_at: createdAt,
  };
  const renderQa = await makeWechatArtifact({ owner, kind: "wechat_render_qa_report", payload: renderQaPayload, input_artifact_ids: [template.envelope.artifact_id], idempotency_key: key("render-qa"), created_at: createdAt });
  const uploads = await Promise.all(["cover_01", "body_01", "body_02"].map(async (slotId, order) => {
    const purpose = order === 0 ? "cover" as const : "body" as const;
    const operation = `${input.prefix}-upload-${slotId}`;
    const payload = {
      protocol_version: "wechat_image_upload_receipt.v1" as const, execution_scope: input.scope, recovery_cycle: input.recoveryCycle,
      frozen_artifact_id: templatePayload.frozen_artifact_id, frozen_payload_hash: templatePayload.frozen_payload_hash,
      visual_plan_artifact_id: templatePayload.visual_plan_artifact_id, visual_plan_payload_hash: templatePayload.visual_plan_payload_hash,
      visual_asset_artifact_id: templatePayload.asset_artifact_ids[order], visual_asset_payload_hash: h(order === 0 ? "e" : order === 1 ? "f" : "a"),
      visual_qa_artifact_id: templatePayload.visual_qa_artifact_id, visual_qa_payload_hash: templatePayload.visual_qa_payload_hash,
      account_binding_id: templatePayload.account_binding_id, slot_id: slotId, purpose, order, asset_byte_hash: h(order === 0 ? "b" : order === 1 ? "c" : "d"), operation_id: operation,
      provider_result_ref: `wechat-adapter/v1/result/${operation}/1.json`, provider_result_hash: h(order === 0 ? "e" : order === 1 ? "f" : "a"),
      media_url: `https://wechat.example/${input.prefix}-${slotId}.png`, cover_media_id: purpose === "cover" ? `${input.prefix}-cover-media` : null,
      media_kind: purpose === "cover" ? "thumb" as const : "body" as const, created_at: createdAt,
    };
    return makeWechatArtifact({ owner, kind: "wechat_image_upload_receipt", payload, input_artifact_ids: [payload.frozen_artifact_id, payload.visual_plan_artifact_id, payload.visual_asset_artifact_id, payload.visual_qa_artifact_id], idempotency_key: key(`upload-${slotId}`), created_at: createdAt });
  }));
  const templateRef = input.packageTemplate || { id: template.envelope.artifact_id, hash: template.envelope.payload_hash };
  const packagePayload = {
    protocol_version: "rendered_article_package.v1" as const, execution_scope: input.scope, recovery_cycle: input.recoveryCycle,
    template_artifact_id: templateRef.id, template_payload_hash: templateRef.hash,
    render_qa_artifact_id: renderQa.envelope.artifact_id, render_qa_payload_hash: renderQa.envelope.payload_hash,
    title: templatePayload.title,
    canonical_html: templatePayload.html_template.replace("{{wechat_image:body_01}}", (uploads[1].payload as any).media_url).replace("{{wechat_image:body_02}}", (uploads[2].payload as any).media_url),
    html_hash: "", body_image_slots: ["body_01", "body_02"], thumb_slot_id: "cover_01", upload_receipt_ids: uploads.map(item => item.envelope.artifact_id), created_at: createdAt,
  };
  packagePayload.html_hash = await (async value => {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
  })(packagePayload.canonical_html);
  const packageObject = await makeWechatArtifact({ owner, kind: "rendered_article_package", payload: packagePayload, input_artifact_ids: [templateRef.id, renderQa.envelope.artifact_id, ...uploads.map(item => item.envelope.artifact_id)], idempotency_key: key("package"), created_at: createdAt });
  const prePayload = { protocol_version: "wechat_prepublish_qa_report.v1" as const, execution_scope: input.scope, recovery_cycle: input.recoveryCycle, package_artifact_id: packageObject.envelope.artifact_id, package_payload_hash: packageObject.envelope.payload_hash, ordered_upload_receipt_ids: uploads.map(item => item.envelope.artifact_id), decision: "pass" as const, checks: { title: true, html_hash: true, image_order: true, safe_urls: true, preview_widths: [390, 430] as [390, 430] }, created_at: createdAt };
  const pre = await makeWechatArtifact({ owner, kind: "wechat_prepublish_qa_report", payload: prePayload, input_artifact_ids: [packageObject.envelope.artifact_id, ...uploads.map(item => item.envelope.artifact_id)], idempotency_key: key("pre-qa"), created_at: createdAt });
  const receiptPayload = { protocol_version: "wechat_draft_receipt.v1" as const, execution_scope: input.scope, recovery_cycle: input.recoveryCycle, draft_identity_hash: h("a"), package_artifact_id: packageObject.envelope.artifact_id, package_payload_hash: packageObject.envelope.payload_hash, prepublish_qa_artifact_id: pre.envelope.artifact_id, prepublish_qa_payload_hash: pre.envelope.payload_hash, upload_receipt_ids: uploads.map(item => item.envelope.artifact_id), account_binding_id: templatePayload.account_binding_id, operation_id: `${input.prefix}-draft`, mutation: "add" as const, verified_draft_media_id: `${input.prefix}-draft-media`, verified_thumb_media_id: `${input.prefix}-cover-media`, verified_cover_image_url: (uploads[0].payload as any).media_url, created_at: createdAt };
  const receipt = await makeWechatArtifact({ owner, kind: "wechat_draft_receipt", payload: receiptPayload, input_artifact_ids: [packageObject.envelope.artifact_id, pre.envelope.artifact_id, ...uploads.map(item => item.envelope.artifact_id)], idempotency_key: key("draft"), created_at: createdAt });
  const readbackPayload = { protocol_version: "wechat_draft_readback_qa.v1" as const, execution_scope: input.scope, recovery_cycle: input.recoveryCycle, draft_receipt_artifact_id: receipt.envelope.artifact_id, draft_receipt_payload_hash: receipt.envelope.payload_hash, package_artifact_id: packageObject.envelope.artifact_id, package_payload_hash: packageObject.envelope.payload_hash, prepublish_qa_artifact_id: pre.envelope.artifact_id, prepublish_qa_payload_hash: pre.envelope.payload_hash, upload_receipt_ids: uploads.map(item => item.envelope.artifact_id), decision: input.decision || "pass", checks: { media: true, title: true, html: true, urls: true, thumb: true, article_index: 0 as const }, verified_draft_media_id: receiptPayload.verified_draft_media_id, verified_thumb_media_id: receiptPayload.verified_thumb_media_id, verified_cover_image_url: receiptPayload.verified_cover_image_url, created_at: createdAt };
  const readback = await makeWechatArtifact({ owner, kind: "wechat_draft_readback_qa", payload: readbackPayload, input_artifact_ids: [packageObject.envelope.artifact_id, pre.envelope.artifact_id, receipt.envelope.artifact_id, ...uploads.map(item => item.envelope.artifact_id)], idempotency_key: key("readback"), created_at: createdAt });
  return [template, renderQa, ...uploads, packageObject, pre, receipt, readback];
}

describe("Wave2D WeChat contracts", () => {
  it("derives owner/account/frozen scoped identities deterministically", async () => {
    const scope = await wechatScopeHash({
      owner, frozen: { id: "frozen-1", hash: h("a") }, plan: { id: "plan-1", hash: h("b") },
      assets: [{ id: "asset-1", hash: h("c"), slot: "cover_01" }, { id: "asset-2", hash: h("d"), slot: "body_01" }, { id: "asset-3", hash: h("e"), slot: "body_02" }],
      visualQA: { id: "qa-1", hash: h("f") }, pin_snapshot_id: "wechat-pin-snapshot.v1", account_binding_id: "wab_wave2d",
    });
    const same = await wechatScopeHash({
      owner, frozen: { id: "frozen-1", hash: h("a") }, plan: { id: "plan-1", hash: h("b") },
      assets: [{ id: "asset-1", hash: h("c"), slot: "cover_01" }, { id: "asset-2", hash: h("d"), slot: "body_01" }, { id: "asset-3", hash: h("e"), slot: "body_02" }],
      visualQA: { id: "qa-1", hash: h("f") }, pin_snapshot_id: "wechat-pin-snapshot.v1", account_binding_id: "wab_wave2d",
    });
    expect(scope).toBe(same);
    expect(await deriveWechatDraftIdentity("wab_wave2d", owner)).not.toEqual(await deriveWechatDraftIdentity("wab_other", owner));
    // These tuples collide under delimiter-free concatenation. Versioned
    // canonical identity material keeps the account/article mapping stable.
    expect(await deriveWechatDraftIdentity("wab_ab", { user_id: "c", workspace_id: "d", article_id: "e" }))
      .not.toEqual(await deriveWechatDraftIdentity("wab_a", { user_id: "bc", workspace_id: "d", article_id: "e" }));
  });

  it("keeps HTML deterministic and rejects unsafe/non-WeChat image references", () => {
    const html = canonicalWechatHtml("Title", [
      { block_id: "b-1", kind: "paragraph", order: 0, text: "One", text_hash: h("1"), claim_ids: [], image_ref_ids: [] },
      { block_id: "b-2", kind: "paragraph", order: 1, text: "Two", text_hash: h("2"), claim_ids: [], image_ref_ids: [] },
    ], [{ slot_id: "body_01", block_id: "b-1", alt: "One", caption: null }]);
    const packagePayload = renderWechatPackage({
      protocol_version: "wechat_render_template.v1", execution_scope: executionScope, recovery_cycle: null, run_id: owner.run_id, article_id: owner.article_id, recording_id: owner.recording_id,
      frozen_artifact_id: "frozen-1", frozen_payload_hash: h("a"), visual_plan_artifact_id: "plan-1", visual_plan_payload_hash: h("b"), visual_qa_artifact_id: "qa-1", visual_qa_payload_hash: h("c"), asset_artifact_ids: ["asset-1", "asset-2", "asset-3"], account_binding_id: "wab_wave2d", account_receipt_hash: h("d"),
      pin_snapshot: {
        role: { id: "wechat_publishing", version: "wechat-publishing.agent.v1" }, publishing: { id: "vibepub-wechat-publishing", version: "1.0.0" }, formatting: { id: "md_to_wechat", version: "1.0.0" }, html_adapter: { id: "vibepub-wechat-html", version: "1.0.0", version_source: "project_adapter_manifest" }, adapter: { id: "wechat-publishing.adapter", version: "1.0.0" }, api: { id: "wechat-api-contract", version: "v1" }, error_policy: { id: "wechat-error-policy", version: "v1" },
      }, title: "Title", cover_slot_id: "cover_01", body_slots: [{ slot_id: "body_01", order: 1, block_id: "b-1", alt: "One", caption: null }], html_template: html, created_at: "2026-07-21T00:00:00.000Z",
    }, [{ slot_id: "body_01", url: "https://wechat.example/body.png" }], "2026-07-21T00:00:01.000Z");
    expect(packagePayload.canonical_html).toContain("https://wechat.example/body.png");
    assertWechatHtml(packagePayload.canonical_html, ["https://wechat.example/body.png"]);
    expect(() => assertWechatHtml("<script>x</script>", [])).toThrow(WechatContractError);
    expect(() => assertWechatHtml("<!-- hidden --><section style=\"max-width:677px;overflow-wrap:anywhere\"><p style=\"margin:0\">x</p></section>", [])).toThrow(WechatContractError);
    expect(() => assertWechatHtml("<section style=\"max-width:677px;overflow-wrap:anywhere\"><img src=\"https://localhost/body.png\" alt=\"x\" style=\"display:block;width:100%;height:auto\"/></section>", ["https://localhost/body.png"])).toThrow(WechatContractError);
    expect(() => assertWechatHtml("<section style=\"max-width:677px;overflow-wrap:anywhere\"><img src=\"https://user:password@wechat.example/body.png\" alt=\"x\" style=\"display:block;width:100%;height:auto\"/></section>", ["https://user:password@wechat.example/body.png"])).toThrow(WechatContractError);
    expect(() => assertWechatHtml("<section style=\"max-width:677px\"><p style=\"margin:0\">x</p></section>", [])).toThrow(WechatContractError);
    expect(() => assertWechatHtml("<section style=\"max-width:677px;overflow-wrap:anywhere\"><p style=\"width:900px\">x</p></section>", [])).toThrow(WechatContractError);
  });

  it("applies the deployment-owned exact media host policy before WeChat draft evidence is accepted", () => {
    expect(isWechatMediaUrlAllowed("wechat.example", "https://wechat.example/media.png")).toBe(true);
    for (const value of [
      "https://wechat.example.evil/media.png",
      "https://evil.example/media.png",
      "https://127.0.0.1/media.png",
      "https://localhost/media.png",
      "https://localhost./media.png",
      "https://foo.local./media.png",
      "https://foo.internal./media.png",
      "https://metadata./media.png",
      "https://[::1]/media.png",
      "https://user:pass@wechat.example/media.png",
      "http://wechat.example/media.png",
    ]) expect(isWechatMediaUrlAllowed("wechat.example", value)).toBe(false);
    expect(isWechatMediaUrlAllowed("[fd00::1]", "https://[fd00::1]/media.png")).toBe(false);
    expect(isWechatMediaUrlAllowed("metadata", "https://metadata/media.png")).toBe(false);
    expect(isWechatMediaUrlAllowed("localhost.", "https://localhost./media.png")).toBe(false);
    expect(isWechatMediaUrlAllowed("foo.local.", "https://foo.local./media.png")).toBe(false);
    expect(isWechatMediaUrlAllowed("", "https://wechat.example/media.png")).toBe(false);
  });

  it("rejects hash-self-consistent malicious WeChat epoch topologies before terminal replay", async () => {
    const active = await topologyScope({ scope: h("e"), recoveryCycle: null, prefix: "active" });
    const secondPass = await topologyScope({ scope: h("f"), recoveryCycle: "a".repeat(32), prefix: "second-pass" });
    const twoPass = new Map([...active, ...secondPass].map(object => [object.envelope.artifact_id, object]));
    expect(() => assertWechatScopeTopologyForVerification(twoPass)).not.toThrow();
    expect(() => assertUniquePassingWechatExecutionScopeForVerification(twoPass)).toThrow(/ambiguous/);

    const initialOrphan = await topologyScope({ scope: h("d"), recoveryCycle: null, prefix: "initial-orphan", stopAfter: "template" });
    const extraInitial = new Map([...active, ...initialOrphan].map(object => [object.envelope.artifact_id, object]));
    expect(() => assertWechatScopeTopologyForVerification(extraInitial)).toThrow(/initial execution scope/);

    const historical = await topologyScope({ scope: h("c"), recoveryCycle: "b".repeat(32), prefix: "historical", decision: "failed" });
    const missingParent = new Map([...active, ...historical.filter(object => object.envelope.kind !== "wechat_render_template")]
      .map(object => [object.envelope.artifact_id, object]));
    expect(() => assertWechatScopeTopologyForVerification(missingParent)).toThrow(/template root/);

    const spliced = await topologyScope({
      scope: h("b"), recoveryCycle: "c".repeat(32), prefix: "spliced", decision: "failed",
      packageTemplate: { id: active[0].envelope.artifact_id, hash: active[0].envelope.payload_hash },
    });
    const crossScope = new Map([...active, ...spliced].map(object => [object.envelope.artifact_id, object]));
    expect(() => assertWechatScopeTopologyForVerification(crossScope)).toThrow(/package parents conflict/);
  });

  it("binds every recovered scope, including the active one, to one preceding complete recovery group", async () => {
    const historical = await topologyScope({ scope: h("a"), recoveryCycle: "1".repeat(32), prefix: "historical", decision: "failed" });
    const active = await topologyScope({ scope: h("b"), recoveryCycle: "2".repeat(32), prefix: "active-recovered" });
    const objects = new Map([...historical, ...active].map(object => [object.envelope.artifact_id, object]));
    const revisions = {
      [h("a")]: historical.map((_object, index) => index + 4),
      [h("b")]: active.map((_object, index) => index + 17),
    };
    const groups = {
      ["1".repeat(32)]: { target: "draft_verifying", holdRevision: 0, reconciledRevision: 1, retryingRevision: 2, resumedRevision: 3 },
      ["2".repeat(32)]: { target: "draft_verifying", holdRevision: 13, reconciledRevision: 14, retryingRevision: 15, resumedRevision: 16 },
    };
    expect(() => assertWechatScopeRecoveryBindingsForVerification({ objects, selectedScope: h("b"), artifactRevisions: revisions, recoveryGroups: groups })).not.toThrow();

    expect(() => assertWechatScopeRecoveryBindingsForVerification({
      objects,
      selectedScope: h("b"),
      artifactRevisions: revisions,
      recoveryGroups: {
        ...groups,
        ["2".repeat(32)]: {
          ...groups["2".repeat(32)],
          holdRevision: 14,
          reconciledRevision: 15,
          retryingRevision: 16,
          resumedRevision: 17,
        },
      },
    })).toThrow(/not ordered/);
  });

  it("rejects a reused recovery cycle and a checkpointed historical epoch without a later hold", async () => {
    const active = await topologyScope({ scope: h("c"), recoveryCycle: "3".repeat(32), prefix: "active-cycle" });
    const duplicateCycle = await topologyScope({ scope: h("d"), recoveryCycle: "3".repeat(32), prefix: "duplicate-cycle", decision: "failed" });
    const duplicateObjects = new Map([...active, ...duplicateCycle].map(object => [object.envelope.artifact_id, object]));
    const duplicateRevisions = {
      [h("c")]: active.map((_object, index) => index + 20),
      [h("d")]: duplicateCycle.map((_object, index) => index + 1),
    };
    const group = { ["3".repeat(32)]: { target: "draft_syncing", holdRevision: 0, reconciledRevision: 1, retryingRevision: 2, resumedRevision: 3 } };
    expect(() => assertWechatScopeRecoveryBindingsForVerification({
      objects: duplicateObjects, selectedScope: h("c"), artifactRevisions: duplicateRevisions, recoveryGroups: group,
    })).toThrow(/multiple execution scopes/);

    const historical = await topologyScope({ scope: h("e"), recoveryCycle: null, prefix: "checkpointed-history", decision: "failed" });
    const objects = new Map([...historical, ...active].map(object => [object.envelope.artifact_id, object]));
    const revisions = {
      [h("e")]: historical.map((_object, index) => index + 1),
      [h("c")]: active.map((_object, index) => index + 20),
    };
    // The active recovery group precedes the active scope but is not a hold
    // after the historical scope's final receipt, so a checkpoint cannot hide
    // that abandoned history.
    expect(() => assertWechatScopeRecoveryBindingsForVerification({
      objects, selectedScope: h("c"), artifactRevisions: revisions,
      recoveryGroups: { ["3".repeat(32)]: { target: "draft_syncing", holdRevision: 8, reconciledRevision: 9, retryingRevision: 10, resumedRevision: 11 } },
    })).toThrow(/lacks a following hold/);
  });

  it("rejects a backward triplet and a hold whose embedded state revision is not its predecessor", async () => {
    const active = await topologyScope({ scope: h("f"), recoveryCycle: "4".repeat(32), prefix: "future-hold-active" });
    const objects = new Map(active.map(object => [object.envelope.artifact_id, object]));
    const revisions = { [h("f")]: active.map((_object, index) => index + 21) };
    expect(() => assertWechatScopeRecoveryBindingsForVerification({
      objects,
      selectedScope: h("f"),
      artifactRevisions: revisions,
      recoveryGroups: {
        ["4".repeat(32)]: { target: "draft_verifying", holdRevision: 20, reconciledRevision: 10, retryingRevision: 11, resumedRevision: 12 },
      },
    })).toThrow(/not contiguous/);
  });

  it("rejects a recovery target or projection fields that drift from its held checkpoint", () => {
    const base = {
      runId: owner.run_id,
      target: "draft_syncing",
      checkpointState: "draft_syncing",
      hold: { revision: 20, retry_count: 2 },
      reconciled: { revision: 21, event_id: `${owner.run_id}:event:21`, event_type: "wechat_side_effect_reconciled", state: "needs_action", error_code: "wechat_side_effect_reconciled", next_action: "resume_reconciled_wechat", retry_count: 2 },
      retrying: { revision: 22, event_id: `${owner.run_id}:event:22`, event_type: "wechat_reconciliation_retrying", state: "retrying", error_code: null, next_action: null, retry_count: 2 },
      resumed: { revision: 23, event_id: `${owner.run_id}:event:23`, event_type: "wechat_reconciliation_resumed", state: "draft_syncing", error_code: null, next_action: null, retry_count: 2 },
    };
    expect(() => assertWechatRecoveryProjectionFieldsForVerification(base)).not.toThrow();
    expect(() => assertWechatRecoveryProjectionFieldsForVerification({ ...base, target: "visual_qa" })).toThrow(/target/);
    expect(() => assertWechatRecoveryProjectionFieldsForVerification({
      ...base,
      reconciled: { ...base.reconciled, next_action: null },
    })).toThrow(/fields/);
    expect(() => assertWechatRecoveryProjectionFieldsForVerification({
      ...base,
      retrying: { ...base.retrying, error_code: "drift" },
    })).toThrow(/fields/);
  });

  it("rejects a hold whose canonical key embeds a revision other than its predecessor", () => {
    expect(() => assertWechatHoldRevisionForVerification(19, 20)).not.toThrow();
    expect(() => assertWechatHoldRevisionForVerification(18, 20)).toThrow(/embedded predecessor/);
  });

  it("stores only canonical derived logical artifact identities", async () => {
    const payload = {
      protocol_version: "wechat_render_qa_report.v1", execution_scope: executionScope, recovery_cycle: null, template_artifact_id: "template-1", template_payload_hash: h("a"), decision: "pass" as const,
      checks: { safe_html: true, placeholders: true, list_continuity: true, preview_widths: [390, 430] as [390, 430] }, created_at: "2026-07-21T00:00:00.000Z",
    };
    const key = "wave2d:render-qa:sha256:" + "a".repeat(64);
    const object = await makeWechatArtifact({ owner, kind: "wechat_render_qa_report", payload, input_artifact_ids: ["template-1"], idempotency_key: key, created_at: payload.created_at });
    expect(object.envelope.schema_version).toBe(WAVE2D_SCHEMA_VERSION);
    expect(object.envelope.artifact_id).toBe(await deriveWechatArtifactId("wechat_render_qa_report", owner.run_id, key));
    expect(object.envelope.payload_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects malformed recovery-cycle evidence instead of admitting a synthetic historical epoch", async () => {
    const object = await renderQaObject();
    await expect(makeWechatArtifact({
      owner,
      kind: "wechat_render_qa_report",
      payload: { ...object.payload, recovery_cycle: "not-a-canonical-cycle" },
      input_artifact_ids: ["template-1"],
      idempotency_key: object.envelope.idempotency_key,
      created_at: object.envelope.created_at,
    })).rejects.toMatchObject({ code: "wechat_contract_invalid" });
  });

  it("rejects an artifact whose envelope parents do not exactly match its typed payload", async () => {
    const object = await renderQaObject();
    await expect(normalizeWechatArtifact({
      ...object.envelope,
      input_artifact_ids: ["other-template"],
      payload: object.payload,
    })).rejects.toMatchObject({ code: "wechat_parent_chain_conflict" });
  });

  it("binds each private upload receipt to its exact adapter operation evidence without mirroring media data", async () => {
    const payload = {
      protocol_version: "wechat_image_upload_receipt.v1" as const, execution_scope: executionScope, recovery_cycle: null,
      frozen_artifact_id: "frozen-1", frozen_payload_hash: h("a"),
      visual_plan_artifact_id: "plan-1", visual_plan_payload_hash: h("b"),
      visual_asset_artifact_id: "asset-1", visual_asset_payload_hash: h("c"),
      visual_qa_artifact_id: "qa-1", visual_qa_payload_hash: h("d"),
      account_binding_id: "wab_wave2d", slot_id: "body_01", purpose: "body" as const,
      order: 1, asset_byte_hash: h("e"), operation_id: "upload-body-01",
      provider_result_ref: "wechat-adapter/v1/result/upload-body-01/1.json",
      provider_result_hash: h("f"), media_url: "https://wechat.example/body-01.png",
      cover_media_id: null, media_kind: "body" as const, created_at: "2026-07-21T00:00:00.000Z",
    };
    const object = await makeWechatArtifact({
      owner,
      kind: "wechat_image_upload_receipt",
      payload,
      input_artifact_ids: ["frozen-1", "plan-1", "asset-1", "qa-1"],
      idempotency_key: "wave2d:upload:body-01",
      created_at: payload.created_at,
    });
    const metadata = toWechatArtifactMetadata(object) as Record<string, unknown>;
    expect(JSON.stringify(metadata)).not.toContain("wechat.example");
    expect(JSON.stringify(metadata)).not.toContain("provider_result_ref");
    await expect(makeWechatArtifact({
      owner,
      kind: "wechat_image_upload_receipt",
      payload: { ...payload, provider_result_ref: "wechat-adapter/v1/result/other-operation/1.json" },
      input_artifact_ids: ["frozen-1", "plan-1", "asset-1", "qa-1"],
      idempotency_key: "wave2d:upload:wrong-evidence",
      created_at: payload.created_at,
    })).rejects.toMatchObject({ code: "wechat_contract_invalid" });
  });

  it("keeps an immutable main R2 artifact exact across replay and rejects a changed payload under its stable key", async () => {
    const bucket = new MemoryBucket();
    const first = await renderQaObject();
    expect((await putImmutableWechatArtifact(bucket as unknown as R2Bucket, first)).status).toBe("created");
    expect((await putImmutableWechatArtifact(bucket as unknown as R2Bucket, first)).status).toBe("replayed");
    await readExactWechatArtifact(bucket as unknown as R2Bucket, first);
    const changed = await renderQaObject("failed");
    await expect(putImmutableWechatArtifact(bucket as unknown as R2Bucket, changed)).rejects.toMatchObject({ code: "wechat_artifact_conflict" });
    expect(toWechatArtifactMetadata(first)).not.toHaveProperty("payload");
  });

  it("keeps normal and long WeChat logical artifact counts tied to the ordered visual slots", async () => {
    const normalSlots = ["cover_01", "body_01", "body_02"];
    const longSlots = ["cover_01", "body_01", "body_02", "body_03", "body_04", "body_05"];
    const logicalCount = (slots: string[]) => 1 + 1 + slots.length + 1 + 1 + 1 + 1;
    expect(logicalCount(normalSlots)).toBe(9);
    expect(logicalCount(longSlots)).toBe(12);
    const normalScope = await wechatScopeHash({ owner, frozen: { id: "frozen", hash: h("a") }, plan: { id: "plan", hash: h("b") }, assets: normalSlots.map((slot, index) => ({ id: `asset-${index}`, hash: h(String(index + 1)), slot })), visualQA: { id: "qa", hash: h("d") }, pin_snapshot_id: "wechat-pin-snapshot.v1", account_binding_id: "wab_wave2d" });
    const reorderedScope = await wechatScopeHash({ owner, frozen: { id: "frozen", hash: h("a") }, plan: { id: "plan", hash: h("b") }, assets: [...normalSlots].reverse().map((slot, index) => ({ id: `asset-${index}`, hash: h(String(index + 1)), slot })), visualQA: { id: "qa", hash: h("d") }, pin_snapshot_id: "wechat-pin-snapshot.v1", account_binding_id: "wab_wave2d" });
    expect(normalScope).not.toBe(reorderedScope);
  });

  it("keeps the TypeScript projection parity with the published visual hold trigger", () => {
    for (const state of ["visual_ready", "formatting", "visual_qa"] as const) {
      const next = projectPublicationTransition(projectionAt(state), "needs_action", {
        eventId: `event-${state}`, eventType: "needs_action", eventIdempotencyKey: `hold-${state}`,
        eventPayloadHash: h("b"), eventCreatedAt: "2026-07-21T00:00:01.000Z",
        errorCode: "wechat_publishing_account_unavailable", nextAction: "repair_publishing_account",
      });
      expect(next.state).toBe("needs_action");
      expect(next.last_successful_state).toBe(state);
    }
  });
});
