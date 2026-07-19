import { describe, expect, it, vi, afterEach } from "vitest";
import { callReviewAgentV3, callWritingAgentV3, InternalServiceError, type InternalServiceEnv } from "../src/wave2/serviceClients";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Wave 2A internal service clients", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a binding and authenticates it with the adapter token", async () => {
    let seen = "";
    const env: InternalServiceEnv = {
      WRITING_AGENT: { fetch: async request => { seen = request.headers.get("authorization") || ""; return response(200, { protocol_version: "vibepub.editorial.v3", result: { ok: true } }); } },
      WRITING_AGENT_TOKEN: "synthetic-writing-token",
    };
    await expect(callWritingAgentV3(env, { synthetic: true })).resolves.toMatchObject({ result: { ok: true } });
    expect(seen).toBe("Bearer synthetic-writing-token");
  });

  it("fails closed before a binding call when its token is absent", async () => {
    let calls = 0;
    const env: InternalServiceEnv = { REVIEW_AGENT: { fetch: async () => { calls += 1; return response(200, { result: {} }); } } };
    await expect(callReviewAgentV3(env, {})).rejects.toMatchObject({ code: "service_unconfigured", retryable: false });
    expect(calls).toBe(0);
  });

  it("preserves downstream unauthorized and retryable classifications", async () => {
    const unauthorized: InternalServiceEnv = {
      REVIEW_AGENT: { fetch: async () => response(401, { error: { code: "unauthorized", retryable: true, body: "never expose" } }) },
      REVIEW_AGENT_TOKEN: "wrong-token",
    };
    await expect(callReviewAgentV3(unauthorized, {})).rejects.toMatchObject({ code: "service_unavailable", status: 401, retryable: false, upstreamCode: "unauthorized" });
    const rateLimited: InternalServiceEnv = {
      WRITING_AGENT: { fetch: async () => response(429, { error: { code: "quota", retryable: false } }) },
      WRITING_AGENT_TOKEN: "synthetic-writing-token",
    };
    await expect(callWritingAgentV3(rateLimited, {})).rejects.toMatchObject({ status: 429, retryable: true, upstreamCode: "quota" });
  });

  it.each([
    [408, { error: { code: "request_timeout" } }, true],
    [429, { error: { code: "quota", retryable: false } }, true],
    [502, { error: { code: "invalid_model_response", retryable: false } }, false],
    [503, { error: { code: "upstream_unconfigured", retryable: false } }, false],
    [500, { error: { code: "review_failed" } }, false],
    [500, { error: { code: "upstream_retryable", retryable: true } }, true],
    [504, { error: { code: "upstream_timeout", retryable: true } }, true],
  ])("only retries controlled 5xx responses (%s)", async (status, body, retryable) => {
    const env: InternalServiceEnv = { WRITING_AGENT: { fetch: async () => response(status, body) }, WRITING_AGENT_TOKEN: "synthetic-writing-token" };
    await expect(callWritingAgentV3(env, {})).rejects.toMatchObject({ status, retryable });
  });

  it("uses URL fallback with the same token contract", async () => {
    let seenUrl = "";
    let seenAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      seenUrl = request.url;
      seenAuth = request.headers.get("authorization") || "";
      return response(200, { protocol_version: "vibepub.editorial.review.v1", result: { fallback: true } });
    }));
    const env: InternalServiceEnv = { REVIEW_AGENT_BASE_URL: "https://review.synthetic.test/", REVIEW_AGENT_TOKEN: "synthetic-review-token" };
    await expect(callReviewAgentV3(env, { synthetic: true })).resolves.toMatchObject({ result: { fallback: true } });
    expect(seenUrl).toBe("https://review.synthetic.test/internal/v3/review");
    expect(seenAuth).toBe("Bearer synthetic-review-token");
  });

  it("does not turn malformed success into a provider error", async () => {
    const env: InternalServiceEnv = { WRITING_AGENT: { fetch: async () => response(200, { prompt: "hidden" }) }, WRITING_AGENT_TOKEN: "synthetic-writing-token" };
    await expect(callWritingAgentV3(env, {})).rejects.toBeInstanceOf(InternalServiceError);
    await expect(callWritingAgentV3(env, {})).rejects.toMatchObject({ code: "service_invalid_response", retryable: false });
  });

  it("prefers the binding and validates its protocol before URL fallback", async () => {
    let urlCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { urlCalls += 1; return response(200, { protocol_version: "vibepub.editorial.v3", result: { fallback: true } }); }));
    const env: InternalServiceEnv = {
      WRITING_AGENT: { fetch: async () => response(200, { protocol_version: "vibepub.editorial.v3", result: { binding: true } }) },
      WRITING_AGENT_BASE_URL: "https://writing.synthetic.test",
      WRITING_AGENT_TOKEN: "synthetic-writing-token",
    };
    await expect(callWritingAgentV3(env, {})).resolves.toMatchObject({ result: { binding: true } });
    expect(urlCalls).toBe(0);
  });

  it("classifies network failure as retryable without exposing the error", async () => {
    const env: InternalServiceEnv = { REVIEW_AGENT: { fetch: async () => { throw new Error("provider body"); } }, REVIEW_AGENT_TOKEN: "synthetic-review-token" };
    await expect(callReviewAgentV3(env, {})).rejects.toMatchObject({ code: "service_unavailable", status: 503, retryable: true });
  });
});
