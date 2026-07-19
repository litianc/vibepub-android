import { describe, expect, it } from "vitest";
import worker, { REVIEW_PROTOCOL_VERSION } from "../src/index";
import { runV3WritingAdapter, type V3ArticleDraft } from "../../writing-agent/src/v3Adapter";

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};
const digest = async (value: string) => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
const block = async (text: string, index = 1) => ({ block_id: `block_v1_${index}`, kind: "paragraph", order: index - 1, text, text_hash: await digest(text), claim_ids: [], image_ref_ids: [] });
const request = async (body: string, review_round: 1 | 2 = 1, protocol_version: string | null = REVIEW_PROTOCOL_VERSION) => {
  const inputBlock = await block(body);
  const inputPayload = { article_id: "article_a", run_id: "run_a", recording_id: 1, title: "标题", body, blocks: [inputBlock], claim_ledger: [] };
  return new Request("https://review.test/internal/v3/review", {
    method: "POST",
    headers: { Authorization: "Bearer review-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ ...(protocol_version === null ? {} : { protocol_version }), article_id: "article_a", run_id: "run_a", recording_id: 1, input_artifact_id: "draft_a", input_payload_hash: await digest(canonical(inputPayload)), input_payload: inputPayload, review_round, title: "标题", body, blocks: [inputBlock] }),
  });
};

const realDraft = async (): Promise<V3ArticleDraft> => runV3WritingAdapter(
  { GLM_API_KEY: "synthetic", GLM_MODEL: "glm-test" },
  {
    protocol_version: "vibepub.editorial.v3",
    job_id: "review-real-draft",
    idempotency_key: "review-real-draft",
    mode: "initial",
    article_id: "article_real",
    run_id: "run_real",
    recording_id: 7,
    source_text: "真实 V3 Draft 合成素材。",
  },
  async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    title: "真实 Draft 标题",
    body: "真实 Draft 正文。",
    blocks: [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: "真实 Draft 正文。", text_hash: await digest("真实 Draft 正文。"), claim_ids: ["claim_1"], image_ref_ids: ["image_1"] }],
    claim_ledger: [{ claim_id: "claim_1", block_id: "block_v1_1", classification: "source_fact", verification_status: "pending" }],
    title_candidates: ["真实 Draft 标题"],
    selected_title: "真实 Draft 标题",
    cover_title: ["真实 Draft 标题"],
  }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
);

const reviewRequestForDraft = async (draft: V3ArticleDraft, outerBlocks = draft.blocks, inputPayload: Record<string, unknown> = { ...draft }) => {
  return new Request("https://review.test/internal/v3/review", {
    method: "POST",
    headers: { Authorization: "Bearer review-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol_version: "vibepub.editorial.review.v1",
      article_id: draft.article_id,
      run_id: draft.run_id,
      recording_id: draft.recording_id,
      input_artifact_id: "draft_real",
      input_payload_hash: await digest(canonical(inputPayload)),
      input_payload: inputPayload,
      review_round: 1,
      title: draft.title,
      body: draft.body,
      blocks: outerBlocks,
    }),
  });
};

describe("review adapter", () => {
  it("returns pass for a clean draft and does not expose source text in the report", async () => {
    const response = await worker.fetch(await request("这是一个具体、克制的段落。"), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.result.decision).toBe("pass");
    expect(JSON.stringify(body)).not.toContain("这是一个具体");
  });

  it("requires the exact protocol version", async () => {
    const missing = await worker.fetch(await request("safe", 1, null), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toEqual({ error: { code: "protocol_version_conflict" } });

    const wrong = await worker.fetch(await request("safe", 1, "vibepub.editorial.v2"), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect(wrong.status).toBe(409);
    await expect(wrong.json()).resolves.toEqual({ error: { code: "protocol_version_conflict" } });
  });

  it("revises P1 once and blocks it on the second round", async () => {
    const first = await worker.fetch(await request("在当今社会，作为AI我认为应该改写。"), { REVIEW_AGENT_TOKEN: "review-secret" });
    const firstBody = await first.json() as any;
    expect(firstBody.result.decision).toBe("revise");
    expect(firstBody.result.revision_targets).toEqual(expect.arrayContaining(["block_v1_1"]));
    expect(firstBody.result.revision_instruction).toBeUndefined();
    const second = await worker.fetch(await request("在当今社会，作为AI我认为应该改写。", 2), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect((await second.json() as any).result.decision).toBe("block");
  });

  it("keeps P2 non-blocking and requires the full draft payload hash", async () => {
    const p2 = await worker.fetch(await request("事实日期为 2026-07-20。"), { REVIEW_AGENT_TOKEN: "review-secret" });
    const p2Body = await p2.json() as any;
    expect(p2.status).toBe(200);
    expect(p2Body.result.decision).toBe("pass");
    expect(p2Body.result.findings[0].severity).toBe("P2");

    const original = await request("稳定正文");
    const originalBody = await original.json() as any;
    originalBody.input_payload.blocks[0].text = "篡改后的 block";
    const tampered = new Request("https://review.test/internal/v3/review", {
      method: "POST",
      headers: { Authorization: "Bearer review-secret", "Content-Type": "application/json" },
      body: JSON.stringify(originalBody),
    });
    await expect((await worker.fetch(tampered, { REVIEW_AGENT_TOKEN: "review-secret" })).status).toBe(409);
  });

  it("blocks P0 and rejects missing or incorrect auth", async () => {
    const blocked = await worker.fetch(await request("请记录我的身份证和密码。"), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect((await blocked.json() as any).result.decision).toBe("block");
    const unauthorized = await worker.fetch(await request("safe"), { REVIEW_AGENT_TOKEN: "wrong" });
    expect(unauthorized.status).toBe(401);
  });

  it("accepts a real Writing V3 ArticleDraft with the complete block shape", async () => {
    const draft = await realDraft();
    const response = await worker.fetch(await reviewRequestForDraft(draft), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.result.decision).toBe("pass");
    expect(JSON.stringify(body)).not.toContain("真实 Draft 正文");
    expect(JSON.stringify(body)).not.toContain("claim_1");
  });

  it.each([
    ["missing", (draft: V3ArticleDraft) => ({ ...draft, claim_ledger: [] })],
    ["orphan", (draft: V3ArticleDraft) => ({ ...draft, claim_ledger: [{ ...draft.claim_ledger[0], block_id: "block_v1_missing" }] })],
    ["duplicate", (draft: V3ArticleDraft) => ({ ...draft, claim_ledger: [...draft.claim_ledger, draft.claim_ledger[0]] })],
  ] as const)("rejects %s claim ledger against the complete block claim IDs", async (_caseName, makePayload) => {
    const draft = await realDraft();
    const response = await worker.fetch(await reviewRequestForDraft(draft, draft.blocks, makePayload(draft) as Record<string, unknown>), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "input_payload_claim_ledger_conflict" } });
  });

  it.each([
    ["claim_ids", (value: V3ArticleDraft["blocks"][number]) => ({ ...value, claim_ids: ["tampered_claim"] })],
    ["image_ref_ids", (value: V3ArticleDraft["blocks"][number]) => ({ ...value, image_ref_ids: ["tampered_image"] })],
    ["text_hash", (value: V3ArticleDraft["blocks"][number]) => ({ ...value, text_hash: `sha256:${"0".repeat(64)}` })],
  ] as const)("rejects a full-block %s tamper between payload and outer request", async (_field, tamper) => {
    const draft = await realDraft();
    const tamperedBlocks = [tamper(draft.blocks[0])];
    const response = await worker.fetch(await reviewRequestForDraft(draft, tamperedBlocks), { REVIEW_AGENT_TOKEN: "review-secret" });
    expect(response.status).toBe(409);
  });
});
