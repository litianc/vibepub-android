import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STYLE_PROFILES } from "../src/defaultProfiles";
import { V3_DEFAULT_STYLE_PROFILE, V3_FORMATTING_SKILL, V3_PROTOCOL_VERSION, runV3WritingAdapter, V3WritingError, type V3ArticleDraft, type V3WriteRequest } from "../src/v3Adapter";

const hash = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};
const payloadHash = (value: unknown) => hash(canonical(value));

const modelResponse = async (title: string, first: string, second = "保留的第二段", includeBody = true, includeTextHash = true) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    title,
    ...(includeBody ? { body: `${first}\n\n${second}` } : {}),
    blocks: [
      { block_id: "block_v1_1", kind: "paragraph", order: 0, text: first, ...(includeTextHash ? { text_hash: await hash(first) } : {}), claim_ids: [], image_ref_ids: [] },
      { block_id: "block_v1_2", kind: "paragraph", order: 1, text: second, ...(includeTextHash ? { text_hash: await hash(second) } : {}), claim_ids: [], image_ref_ids: [] },
    ],
    claim_ledger: [],
    title_candidates: [title],
    selected_title: title,
    cover_title: [title],
  }) } }],
}), { status: 200, headers: { "content-type": "application/json" } });

const modelResponseWithClaims = async (
  title: string,
  first: string,
  second: string,
  firstClaimIds: string[],
  secondClaimIds: string[],
  claimLedger: Array<{ claim_id: string; block_id: string; classification: string; verification_status: string }>,
) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    title,
    body: `${first}\n\n${second}`,
    blocks: [
      { block_id: "block_v1_1", kind: "paragraph", order: 0, text: first, text_hash: await hash(first), claim_ids: firstClaimIds, image_ref_ids: [] },
      { block_id: "block_v1_2", kind: "paragraph", order: 1, text: second, text_hash: await hash(second), claim_ids: secondClaimIds, image_ref_ids: [] },
    ],
    claim_ledger: claimLedger,
    title_candidates: [title],
    selected_title: title,
    cover_title: [title],
  }) } }],
}), { status: 200, headers: { "content-type": "application/json" } });

const rawModelResponse = (payload: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status, headers: { "content-type": "application/json" } });

const baseRequest = (overrides: Partial<V3WriteRequest> = {}): V3WriteRequest => ({
  protocol_version: V3_PROTOCOL_VERSION,
  job_id: "job_a",
  idempotency_key: "job_a:v1",
  mode: "initial",
  article_id: "article_a",
  run_id: "run_a",
  recording_id: 1,
  source_text: "合成素材。",
  ...overrides,
});

async function revisionRequest(initial: V3ArticleDraft): Promise<V3WriteRequest> {
  const draftPayload = initial;
  const draftHash = await payloadHash(draftPayload);
  const reviewPayload = {
    article_id: initial.article_id,
    run_id: initial.run_id,
    recording_id: initial.recording_id,
    input_artifact_id: "draft_a",
    input_payload_hash: draftHash,
    review_round: 1 as const,
    decision: "revise" as const,
    findings: [],
    revision_targets: ["block_v1_1"],
    suggested_actions: ["rewrite"],
    reviewer_version: "editorial-review.adapter.1.0.0",
    rules_pins: { dbs_ai_check: { id: "dbs-ai-check", version: "1.0.0" }, humanizer: { id: "humanizer-zh", version: "1.0.0" } },
  };
  const reviewHash = await payloadHash(reviewPayload);
  const dispatchPayload = {
    article_id: initial.article_id,
    run_id: initial.run_id,
    recording_id: initial.recording_id,
    source_draft_artifact_id: "draft_a",
    source_draft_payload_hash: draftHash,
    source_review_artifact_id: "review_a",
    source_review_payload_hash: reviewHash,
    target_block_ids: ["block_v1_1"],
    target: ["block_v1_1"],
    issue_codes: ["rewrite"],
    protected_block_hashes: { "@title": await hash(initial.title), block_v1_2: initial.blocks[1].text_hash },
    revision_limit: 1 as const,
    instruction_text: "只改第一段。",
    workflow_version: "editorial-workflow.v3",
    policy_version: "editorial-policy.v3",
    producer_pins: [{ id: "editorial_coordinator", version: "editorial-coordinator.agent.v3" }, { id: "writing", version: "writing.agent.v3" }, { id: "editorial_review", version: "editorial-review.agent.v3" }],
  };
  return baseRequest({
    mode: "revision",
    idempotency_key: "job_a:revision:1",
    current_draft: { artifact_id: "draft_a", payload_hash: draftHash, payload: draftPayload },
    review_report: { artifact_id: "review_a", payload_hash: reviewHash, payload: reviewPayload },
    revision_dispatch: { artifact_id: "dispatch_a", payload_hash: await payloadHash(dispatchPayload), payload: dispatchPayload },
  });
}

describe("WritingAgent V3 adapter", () => {
  it("uses the canonical default profile body and emits a complete draft", async () => {
    const calls: string[] = [];
    const result = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async (_url, init) => {
      calls.push(String(init?.body));
      return modelResponse("合成标题", "第一段", "保留的第二段", false, false);
    });
    const requestBody = JSON.parse(calls[0]) as { messages: Array<{ content: string }>; thinking: { type: string } };
    expect(requestBody.messages[0].content).toContain(DEFAULT_STYLE_PROFILES[0].body);
    expect(requestBody.messages[0].content).toContain("不得使用 header 或 subheading");
    expect(requestBody.messages[0].content).toContain("至少生成两个内容不同的非空 block");
    expect(requestBody.messages[0].content).toContain('"cover_title":["第一行","第二行"]');
    expect(requestBody.thinking).toEqual({ type: "disabled" });
    expect(result.formatting_skill).toEqual(V3_FORMATTING_SKILL);
    expect(result.profile_pins.style).toEqual(V3_DEFAULT_STYLE_PROFILE);
    expect(result.revision).toBe(1);
    expect(result.parent_review_artifact_id).toBeNull();
    expect(result.content_hash).toMatch(/^sha256:/);
    expect(result.body).toBe("第一段\n\n保留的第二段");
    expect(result.blocks[0].text_hash).toBe(await hash("第一段"));
  });

  it("splits one multi-sentence initial paragraph without adding text and keeps claim ownership exact", async () => {
    const first = "先确认基础环境是否可用。";
    const second = "然后我们做一个简单的测试，避免盲目排查。";
    const source = "我们做一个简单的测试。";
    const result = await runV3WritingAdapter(
      { GLM_API_KEY: "synthetic" },
      baseRequest({ source_text: source }),
      async () => rawModelResponse({
        title: "测试标题",
        body: `${first}${second}`,
        blocks: [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: `${first}${second}`, claim_ids: ["claim_1"], image_ref_ids: [] }],
        claim_ledger: [{ claim_id: "claim_1", block_id: "block_v1_1", classification: "author_view", verification_status: "not_required" }],
        title_candidates: ["测试标题"],
        selected_title: "测试标题",
        cover_title: ["测试标题"],
      }),
    );

    expect(result.body.replaceAll("\n", "")).toBe(`${first}${second}`);
    expect(result.blocks.map(block => block.text)).toEqual([first, second]);
    expect(result.blocks.map(block => block.block_id)).toEqual(["block_v1_1", "block_v1_2"]);
    expect(result.blocks[1].claim_ids).toEqual(["claim_1"]);
    expect(result.claim_ledger).toEqual([{ claim_id: "claim_1", block_id: "block_v1_2", classification: "author_view", verification_status: "not_required" }]);
  });

  it("asks the workflow for a controlled retry when one initial block cannot be split", async () => {
    await expect(runV3WritingAdapter(
      { GLM_API_KEY: "synthetic" },
      baseRequest(),
      async () => rawModelResponse({
        title: "测试标题",
        body: "过短正文",
        blocks: [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: "过短正文", claim_ids: [], image_ref_ids: [] }],
        claim_ledger: [],
        title_candidates: ["测试标题"],
        selected_title: "测试标题",
        cover_title: ["测试标题"],
      }),
    )).rejects.toMatchObject({ code: "upstream_retryable", retryable: true, status: 502 });
  });

  it("requires the exact protocol version before invoking the model", async () => {
    const fetchImpl = vi.fn(async () => modelResponse("不应调用", "不应调用"));
    const missing: Partial<V3WriteRequest> = { ...baseRequest() };
    delete missing.protocol_version;
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, missing as V3WriteRequest, fetchImpl)).rejects.toMatchObject({ code: "protocol_version_conflict", retryable: false });
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest({ protocol_version: "vibepub.editorial.v2" }), fetchImpl)).rejects.toMatchObject({ code: "protocol_version_conflict", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects incomplete or drifting title metadata from the model", async () => {
    const block = { block_id: "block_v1_1", kind: "paragraph", order: 0, text: "正文", text_hash: await hash("正文"), claim_ids: [], image_ref_ids: [] };
    const basePayload = { title: "标题", body: "正文", blocks: [block], claim_ledger: [], title_candidates: ["标题"], selected_title: "标题", cover_title: ["标题"] };
    const cases = [
      { ...basePayload, title_candidates: [] },
      { ...basePayload, selected_title: "漂移标题" },
      { ...basePayload, cover_title: [] },
    ];
    for (const payload of cases) {
      const fetchImpl = vi.fn(async () => rawModelResponse(payload));
      await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), fetchImpl)).rejects.toMatchObject({ code: "invalid_model_response", retryable: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("uses the shared default-key canonical bytes for Unicode and @title keys", async () => {
    const value = { "中文": "值", a: 2, "@title": "标题", A: 1, "é": "accent" };
    const bytes = canonical(value);
    expect(bytes).toBe('{"@title":"标题","A":1,"a":2,"é":"accent","中文":"值"}');
    expect(await hash(bytes)).toBe("sha256:9d0571a9957dfc769e97dd563e640a56f87b89c9281b1e73340ba9db3b2c7937");
  });

  it("requires an exact source hash when one is supplied", async () => {
    const fetchImpl = vi.fn(async () => modelResponse("不应调用", "不应调用"));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest({ source_hash: "sha256:" + "0".repeat(64) }), fetchImpl)).rejects.toMatchObject({ code: "source_hash_mismatch", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps original-source identity separate from the exact transcript hash", async () => {
    const sourceHash = await hash("synthetic original audio bytes");
    const sourceTextHash = await hash("合成素材。");
    const result = await runV3WritingAdapter(
      { GLM_API_KEY: "synthetic" },
      baseRequest({ source_hash: sourceHash, source_text_hash: sourceTextHash }),
      async () => modelResponse("标题", "正文"),
    );
    expect(result.source_hash).toBe(sourceHash);

    const fetchImpl = vi.fn(async () => modelResponse("不应调用", "不应调用"));
    await expect(runV3WritingAdapter(
      { GLM_API_KEY: "synthetic" },
      baseRequest({ source_hash: sourceHash, source_text_hash: "sha256:" + "0".repeat(64) }),
      fetchImpl,
    )).rejects.toMatchObject({ code: "source_text_hash_mismatch", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts an inline profile only when its body hash is bound", async () => {
    const body = "只保留合成测试风格。";
    const bodyHash = await hash(body);
    const result = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest({ style_profile_id: "style_custom", style_profile_version: "v1", style_profile_body: body, style_profile_body_hash: bodyHash }), async (_url, init) => {
      expect(String(init?.body)).toContain(body);
      return modelResponse("自定义标题", "自定义段落");
    });
    expect(result.profile_pins.style).toEqual({ id: "style_custom", version: "v1" });
    expect(result.style_profile_body_hash).toBe(bodyHash);
  });

  it("rejects unknown or mismatched profiles before model fetch", async () => {
    const fetchImpl = vi.fn(async () => modelResponse("不应调用", "不应调用"));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest({ style_profile_id: "missing", style_profile_version: "1.0.0" }), fetchImpl)).rejects.toMatchObject({ code: "style_profile_not_found", retryable: false });
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest({ style_profile_id: V3_DEFAULT_STYLE_PROFILE.id, style_profile_version: V3_DEFAULT_STYLE_PROFILE.version, style_profile_body: "篡改", style_profile_body_hash: await hash("原文") }), fetchImpl)).rejects.toMatchObject({ code: "style_profile_hash_mismatch" });
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest({ style_profile_id: V3_DEFAULT_STYLE_PROFILE.id, style_profile_version: V3_DEFAULT_STYLE_PROFILE.version, style_profile_body: "篡改", style_profile_body_hash: await hash("篡改") }), fetchImpl)).rejects.toMatchObject({ code: "style_profile_pin_body_conflict" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the draft, review and dispatch payload hashes for one protected revision", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponse("旧标题", "目标段落"));
    const request = await revisionRequest(initial);
    const revision = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, request, async () => modelResponse("旧标题", "修改后的目标段落", "保留的第二段", false, false));
    expect(revision.revision).toBe(2);
    expect(revision.parent_artifact_id).toBe("draft_a");
    expect(revision.parent_review_artifact_id).toBe("review_a");
    expect(revision.parent_dispatch_artifact_id).toBe("dispatch_a");
    expect(revision.blocks[1].text).toBe(initial.blocks[1].text);
    expect(revision.changed_block_ids).toEqual(["block_v1_1"]);
  });

  it("passes a canonical protected Draft projection and exact revision scope to the model", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponseWithClaims(
      "旧标题", "目标段落", "受保护段落", ["claim_target"], ["claim_protected"], [
        { claim_id: "claim_target", block_id: "block_v1_1", classification: "author_view", verification_status: "not_required" },
        { claim_id: "claim_protected", block_id: "block_v1_2", classification: "source_fact", verification_status: "pending" },
      ],
    ));
    const request = await revisionRequest(initial);
    let prompt = "";
    await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, request, async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompt = requestBody.messages[0].content;
      return modelResponseWithClaims(
        "旧标题", "修改后的目标段落", "受保护段落", ["claim_target"], ["claim_protected"], [
          { claim_id: "claim_target", block_id: "block_v1_1", classification: "author_view", verification_status: "not_required" },
          { claim_id: "claim_protected", block_id: "block_v1_2", classification: "source_fact", verification_status: "pending" },
        ],
      );
    });
    expect(prompt).toContain(initial.blocks[0].text_hash);
    expect(prompt).toContain("block_v1_1");
    expect(prompt).toContain("claim_protected");
    expect(prompt).toContain("旧标题");
    expect(prompt).toContain("claim_target");
    expect(prompt).toContain("target");
    expect(prompt).toContain("只改第一段。");
    expect(prompt).not.toContain(request.current_draft!.payload_hash);
    expect(prompt).not.toContain(request.review_report!.payload_hash);
    expect(prompt).not.toContain(request.revision_dispatch!.payload_hash);
    expect(prompt).not.toContain("editorial_coordinator.agent.v3");
    expect(prompt).not.toContain("WRITING_AGENT_TOKEN");
  });

  it("rejects jointly forged refs and protected metadata changes", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponse("旧标题", "目标段落"));
    const request = await revisionRequest(initial);
    const forged = { ...request, current_draft: { ...request.current_draft!, payload_hash: "sha256:" + "4".repeat(64) }, review_report: { ...request.review_report!, payload_hash: "sha256:" + "5".repeat(64) }, revision_dispatch: { ...request.revision_dispatch!, payload_hash: "sha256:" + "6".repeat(64) } };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, forged, async () => modelResponse("不应调用", "不应调用"))).rejects.toMatchObject({ code: "artifact_payload_hash_mismatch" });
    const changed = await revisionRequest(initial);
    const dispatchPayload = { ...changed.revision_dispatch!.payload, protected_block_hashes: { ...changed.revision_dispatch!.payload.protected_block_hashes, block_v1_2: await hash("别的内容") } };
    const changedRequest = { ...changed, revision_dispatch: { ...changed.revision_dispatch!, payload: dispatchPayload, payload_hash: await payloadHash(dispatchPayload) } };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, changedRequest, async () => modelResponse("旧标题", "修改第一段"))).rejects.toMatchObject({ code: "protected_block_hash_mismatch" });
  });

  it("rejects a model response that changes a protected block", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponse("旧标题", "目标段落"));
    const request = await revisionRequest(initial);
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, request, async () => modelResponse("旧标题", "修改第一段", "偷偷改第二段"))).rejects.toMatchObject({ code: "protected_block_changed", retryable: false });
  });

  it("rejects malformed claims and body/block drift after the model response", async () => {
    const malformedClaim = { title: "标题", body: "正文", blocks: [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: "正文", claim_ids: [], image_ref_ids: [] }], claim_ledger: [{ claim_id: "c1", block_id: "block_v1_1", classification: "not_a_claim", verification_status: "pending" }] };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => rawModelResponse(malformedClaim))).rejects.toMatchObject({ code: "invalid_model_response", retryable: false });
    const drifted = { ...malformedClaim, body: "正文\n\n额外内容" };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => rawModelResponse(drifted))).rejects.toMatchObject({ code: "invalid_model_response", retryable: false });
  });

  it("requires an exact claim ledger for every initial block claim", async () => {
    const block = { block_id: "block_v1_1", kind: "paragraph", order: 0, text: "声明正文", text_hash: await hash("声明正文"), claim_ids: ["claim_1"], image_ref_ids: [] };
    const payload = { title: "标题", body: "声明正文", blocks: [block] };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => rawModelResponse({ ...payload, claim_ledger: [] }))).rejects.toMatchObject({ code: "invalid_model_response", retryable: false });
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => rawModelResponse({ ...payload, claim_ledger: [{ claim_id: "claim_orphan", block_id: "block_v1_1", classification: "source_fact", verification_status: "pending" }] }))).rejects.toMatchObject({ code: "invalid_model_response", retryable: false });
  });

  it("preserves protected claim provenance while allowing targeted claim changes", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponseWithClaims(
      "旧标题", "目标段落", "受保护段落", ["claim_target"], ["claim_protected"], [
        { claim_id: "claim_target", block_id: "block_v1_1", classification: "author_view", verification_status: "not_required" },
        { claim_id: "claim_protected", block_id: "block_v1_2", classification: "source_fact", verification_status: "pending" },
      ],
    ));
    const request = await revisionRequest(initial);
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, request, async () => modelResponseWithClaims(
      "旧标题", "修改后的目标段落", "受保护段落", ["claim_target"], ["claim_protected"], [
        { claim_id: "claim_target", block_id: "block_v1_1", classification: "author_view", verification_status: "not_required" },
        { claim_id: "claim_protected", block_id: "block_v1_2", classification: "external_fact", verification_status: "verified" },
      ],
    ))).rejects.toMatchObject({ code: "protected_claim_ledger_changed", retryable: false });

    const revision = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, request, async () => modelResponseWithClaims(
      "旧标题", "修改后的目标段落", "受保护段落", ["claim_revised"], ["claim_protected"], [
        { claim_id: "claim_revised", block_id: "block_v1_1", classification: "source_fact", verification_status: "verified" },
        { claim_id: "claim_protected", block_id: "block_v1_2", classification: "source_fact", verification_status: "pending" },
      ],
    ));
    expect(revision.blocks[0].claim_ids).toEqual(["claim_revised"]);
    expect(revision.claim_ledger.find(claim => claim.block_id === "block_v1_2")).toEqual({ claim_id: "claim_protected", block_id: "block_v1_2", classification: "source_fact", verification_status: "pending" });
  });

  it("classifies upstream retry and auth failures without replaying the model call", async () => {
    const network = vi.fn(async () => { throw new Error("network unavailable"); });
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), network)).rejects.toMatchObject({ code: "upstream_timeout", retryable: true });
    const rateLimited = vi.fn(async () => new Response("", { status: 429 }));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), rateLimited)).rejects.toMatchObject({ code: "upstream_retryable", retryable: true });
    const controlledUnavailable = vi.fn(async () => new Response("", { status: 503 }));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), controlledUnavailable)).rejects.toMatchObject({ code: "upstream_retryable", retryable: true });
    const genericServerError = vi.fn(async () => new Response("", { status: 500 }));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), genericServerError)).rejects.toMatchObject({ code: "upstream_failed", retryable: false });
    const unknownServerError = vi.fn(async () => new Response("", { status: 599 }));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), unknownServerError)).rejects.toMatchObject({ code: "upstream_failed", retryable: false });
    const unauthorized = vi.fn(async () => new Response("", { status: 401 }));
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), unauthorized)).rejects.toMatchObject({ code: "upstream_unauthorized", retryable: false });
  });

  it("rejects revision pin drift and invalid revision rounds before the model call", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponse("旧标题", "目标段落"));
    const request = await revisionRequest(initial);
    const fetchImpl = vi.fn(async () => modelResponse("不应调用", "不应调用"));
    const styleBody = "另一份受控风格";
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, { ...request, style_profile_id: "style_custom", style_profile_version: "v1", style_profile_body: styleBody, style_profile_body_hash: await hash(styleBody) }, fetchImpl)).rejects.toMatchObject({ code: "style_profile_pin_conflict", retryable: false });
    const invalidRoundPayload = { ...request.current_draft!.payload, revision: 3 };
    const invalidRound = { ...request, current_draft: { ...request.current_draft!, payload: invalidRoundPayload, payload_hash: await payloadHash(invalidRoundPayload) } };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, invalidRound, fetchImpl)).rejects.toMatchObject({ code: "revision_input_invalid", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a tampered stored Draft after its envelope hash is recomputed", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponse("旧标题", "目标段落"));
    const request = await revisionRequest(initial);
    const fetchImpl = vi.fn(async () => modelResponse("不应调用", "不应调用"));
    const tamperedBlocks = await Promise.all(initial.blocks.map(async (block, index) => index === 0 ? { ...block, text_hash: await hash("篡改 hash") } : block));
    const tamperedPayload = { ...request.current_draft!.payload, blocks: tamperedBlocks };
    const tamperedDraft = { ...request.current_draft!, payload: tamperedPayload, payload_hash: await payloadHash(tamperedPayload) };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, { ...request, current_draft: tamperedDraft }, fetchImpl)).rejects.toMatchObject({ code: "revision_input_invalid", retryable: false });

    const metadataPayload = { ...request.current_draft!.payload, selected_title: "漂移标题" };
    const metadataDraft = { ...request.current_draft!, payload: metadataPayload, payload_hash: await payloadHash(metadataPayload) };
    await expect(runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, { ...request, current_draft: metadataDraft }, fetchImpl)).rejects.toMatchObject({ code: "revision_input_invalid", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("counts title metadata-only changes when @title is targeted", async () => {
    const initial = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, baseRequest(), async () => modelResponse("旧标题", "目标段落"));
    const request = await revisionRequest(initial);
    const titleMetadataResponse = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "旧标题", body: "修改后的标题关联段落\n\n保留的第二段", blocks: [
      { block_id: "block_v1_1", kind: "paragraph", order: 0, text: "修改后的标题关联段落", text_hash: await hash("修改后的标题关联段落"), claim_ids: [], image_ref_ids: [] },
      { block_id: "block_v1_2", kind: "paragraph", order: 1, text: "保留的第二段", text_hash: await hash("保留的第二段"), claim_ids: [], image_ref_ids: [] },
    ], claim_ledger: [], title_candidates: ["旧标题", "另一种候选"], selected_title: "旧标题", cover_title: ["另一种候选"] }) } }] }), { status: 200 });
    const reviewPayload = { ...request.review_report!.payload, revision_targets: ["@title", "block_v1_1"] };
    const reviewHash = await payloadHash(reviewPayload);
    const dispatchPayload = { ...request.revision_dispatch!.payload, source_review_payload_hash: reviewHash, target: ["@title", "block_v1_1"], target_block_ids: ["block_v1_1"], protected_block_hashes: { block_v1_2: initial.blocks[1].text_hash } };
    const dispatchHash = await payloadHash(dispatchPayload);
    const validTitleTarget = { ...request, review_report: { ...request.review_report!, payload: reviewPayload, payload_hash: reviewHash }, revision_dispatch: { ...request.revision_dispatch!, payload: dispatchPayload, payload_hash: dispatchHash } };
    const revision = await runV3WritingAdapter({ GLM_API_KEY: "synthetic" }, validTitleTarget, async () => titleMetadataResponse);
    expect(revision.changed_block_ids).toEqual(expect.arrayContaining(["@title", "block_v1_1"]));
  });
});
