import { afterEach, describe, expect, it, vi } from "vitest";
import adapter, { VisualOperationAgent } from "../src/index";

class FakeBucket {
  objects = new Map<string, { bytes: string; metadata: Record<string, string> }>();
  failNextPut = false;
  failNextResultPut = false;
  failReads = false;
  headMetadataOverride: Record<string, string> | null = null;
  sizeOverride: number | null = null;
  textReads = 0;

  async get(key: string): Promise<any> {
    if (this.failReads) throw new Error("read outcome unknown");
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: this.sizeOverride ?? new TextEncoder().encode(value.bytes).byteLength,
      customMetadata: { ...value.metadata },
      text: async () => { this.textReads += 1; return value.bytes; },
    };
  }

  async head(key: string): Promise<any> {
    const value = this.objects.get(key);
    if (!value) return null;
    return { size: this.sizeOverride ?? new TextEncoder().encode(value.bytes).byteLength, customMetadata: this.headMetadataOverride || { ...value.metadata } };
  }

  async put(key: string, value: string, options: any): Promise<any> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("put outcome unknown");
    }
    if (this.objects.has(key)) return null;
    this.objects.set(key, { bytes: value, metadata: { ...(options.customMetadata || {}) } });
    if (this.failNextResultPut && key.endsWith("/result.json")) {
      this.failNextResultPut = false;
      throw new Error("response lost");
    }
    return { size: value.length, customMetadata: options.customMetadata };
  }
}

class FakeStorage {
  private values = new Map<string, unknown>();
  private tail = Promise.resolve();
  failNextTerminalPut = false;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> {
    const status = value && typeof value === "object" ? (value as { status?: unknown }).status : undefined;
    if (this.failNextTerminalPut && (status === "completed" || status === "failed")) {
      this.failNextTerminalPut = false;
      throw new Error("terminal claim response lost");
    }
    this.values.set(key, value);
  }
  async transaction<T>(callback: (storage: FakeStorage) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => callback(this));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

class FakeOperationNamespace {
  private states = new Map<string, FakeStorage>();
  constructor(private readonly baseEnv: Record<string, unknown>) {}
  idFromName(name: string): string { return name; }
  get(id: string): { fetch: (request: Request) => Promise<Response> } {
    let storage = this.states.get(id);
    if (!storage) { storage = new FakeStorage(); this.states.set(id, storage); }
    const agent = new VisualOperationAgent({ storage } as any, this.baseEnv as any);
    return { fetch: request => agent.fetch(request) };
  }
  failNextTerminalPut(id: string): void {
    let storage = this.states.get(id);
    if (!storage) { storage = new FakeStorage(); this.states.set(id, storage); }
    storage.failNextTerminalPut = true;
  }
}

const bucket = () => new FakeBucket();
const env = (results = bucket()) => ({
  VISUAL_PRODUCTION_TOKEN: "visual-token",
  GPT_IMAGE_API_KEY: "synthetic-provider-token",
  IMAGE_PROVIDER_URL: "https://gateway.example/v1/images/generations",
  IMAGE_PROVIDER_HOST: "gateway.example",
  VISUAL_RESULTS_BUCKET: results,
  VISUAL_OPERATION: undefined as unknown,
});

function durableEnv(results: FakeBucket | undefined = bucket(), overrides: Record<string, unknown> = {}): any {
  const base = { VISUAL_PRODUCTION_TOKEN: "visual-token", GPT_IMAGE_API_KEY: "synthetic-provider-token", IMAGE_PROVIDER_URL: "https://gateway.example/v1/images/generations", IMAGE_PROVIDER_HOST: "gateway.example", VISUAL_RESULTS_BUCKET: results, ...overrides };
  const runtime: Record<string, unknown> = { ...base };
  runtime.VISUAL_OPERATION = new FakeOperationNamespace(runtime);
  return runtime;
}

const CANARY_RUN_ID = `run_v3_${"8".repeat(64)}`;
const CANARY_USER_ID = "staging_canary_user";
const CANARY_WORKSPACE_ID = "staging_canary_workspace";

function imageCanaryEnv(results: FakeBucket = bucket(), overrides: Record<string, unknown> = {}): any {
  return durableEnv(results, {
    IMAGE_PROVIDER_URL: "https://api.clawparty.cn/v1/images/generations",
    IMAGE_PROVIDER_HOST: "api.clawparty.cn",
    DEPLOY_ENVIRONMENT: "staging",
    IMAGE_PROVIDER_CANARY_MODE: "staging_single_run",
    IMAGE_PROVIDER_CANARY_RUN_ID: CANARY_RUN_ID,
    IMAGE_PROVIDER_CANARY_USER_ID: CANARY_USER_ID,
    IMAGE_PROVIDER_CANARY_WORKSPACE_ID: CANARY_WORKSPACE_ID,
    IMAGE_PROVIDER_CANARY_ID: `staging_https_${"9".repeat(32)}`,
    IMAGE_PROVIDER_CANARY_MAX_OPERATIONS: "3",
    IMAGE_PROVIDER_CANARY_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

function request(path: string, token: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://adapter.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body,
  });
}

function imageBody(operationId: string, attempt = 1, runId?: string, userId?: string, workspaceId?: string): string {
  return JSON.stringify({ operation_id: operationId, attempt, ...(runId ? { run_id: runId } : {}), ...(userId ? { user_id: userId } : {}), ...(workspaceId ? { workspace_id: workspaceId } : {}), model: "gpt-image-2", prompt: "synthetic prompt", size: "1536x864" });
}

describe("controlled visual adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns only non-secret deployment evidence from health", async () => {
    const response = await adapter.fetch(new Request("https://adapter.test/health"), {
      DEPLOY_COMMIT: "abc123",
      DEPLOY_REF: "codex/staging",
      DEPLOYED_AT: "2026-07-22T00:00:00.000Z",
      GPT_IMAGE_API_KEY: "synthetic-secret",
    } as any);
    expect(await response.json()).toEqual({
      ok: true,
      service: "image-generation-adapter",
      version: { commit: "abc123", ref: "codex/staging", deployed_at: "2026-07-22T00:00:00.000Z" },
    });
  });

  it("authenticates before parsing JSON and accepts only Authorization Bearer", async () => {
    const response = await adapter.fetch(request("/internal/v3/visual/plan", "wrong-token", "not-json"), env());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
    const legacyHeader = await adapter.fetch(new Request("https://adapter.test/internal/v3/visual/plan", { method: "POST", headers: { "x-visual-production-token": "visual-token" }, body: "not-json" }), env());
    expect(legacyHeader.status).toBe(401);
  });

  it("writes a plan result durably and replays without a provider call", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { providerCalls += 1; return new Response("{}", { status: 500 }); }));
    const results = bucket();
    const body = JSON.stringify({ operation_id: "plan-1", attempt: 1, model: "gpt-image-2", plan: { slots: [{ prompt_hash: "sha256:slot" }] } });
    const first = await adapter.fetch(request("/internal/v3/visual/plan", "visual-token", body), durableEnv(results));
    const replay = await adapter.fetch(request("/internal/v3/visual/plan", "visual-token", body), durableEnv(results));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ operation_id: "plan-1", attempt: 1, result: { model_version: "gpt-image-2" } });
    expect(providerCalls).toBe(0);
    expect(results.objects.size).toBe(2);
  });

  it("uses a deployment HTTPS gateway and persists a successful image for replay", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      providerCalls += 1;
      seenUrl = url;
      seenAuth = String(new Headers(init.headers).get("authorization"));
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("image-1")), durableEnv(results));
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("image-1")), durableEnv(results));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ operation_id: "image-1", attempt: 1, result: { b64_json: "synthetic-image", model_version: "gpt-image-2" } });
    expect(replay.status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(seenUrl).toBe("https://gateway.example/v1/images/generations");
    expect(seenAuth).toBe("Bearer synthetic-provider-token");
  });

  it("rejects an oversized legacy R2 image result before reading or replaying its body", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("legacy-oversized-result")), durable);
    expect(first.status).toBe(200);
    const textReadsBeforeReplay = results.textReads;
    results.sizeOverride = 12 * 1024 * 1024;
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("legacy-oversized-result")), durable);
    expect(replay.status).toBe(503);
    expect(results.textReads).toBe(textReadsBeforeReplay);
    expect(providerCalls).toBe(1);
  });

  it("rejects a provider body declared beyond the bounded PNG response budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(12 * 1024 * 1024) },
    })));
    const response = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("oversized-provider")), durableEnv(bucket()));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "invalid_provider_response", retryable: false } });
  });

  it("allows attempts 2 and 3 only after durable retryable outcomes", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      if (providerCalls < 3) return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 });
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("retry-1", 1)), durable);
    const second = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("retry-1", 2)), durable);
    const third = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("retry-1", 3)), durable);
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(third.status).toBe(200);
    expect(providerCalls).toBe(3);
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("retry-1", 3)), durable);
    expect(replay.status).toBe(200);
    expect(providerCalls).toBe(3);
  });

  it.each([521, 523])("retries Cloudflare provider connection status %s", async status => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      if (providerCalls === 1) return new Response(JSON.stringify({ error: { message: "gateway timeout" } }), { status });
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const operationId = `cloudflare-timeout-${status}`;
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(operationId, 1)), durable);
    expect(first.status).toBe(status);
    expect(await first.json()).toEqual({ error: { code: "upstream_retryable", retryable: true } });
    const second = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(operationId, 2)), durable);
    expect(second.status).toBe(200);
    expect(providerCalls).toBe(2);
  });

  it.each([520, 522, 524])("holds ambiguous Cloudflare provider status %s without another provider call", async status => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ error: { message: "ambiguous gateway response" } }), { status });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const operationId = `cloudflare-ambiguous-${status}`;
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(operationId, 1)), durable);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: { code: "external_side_effect_unknown", retryable: false } });
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(operationId, 1)), durable);
    const nextAttempt = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(operationId, 2)), durable);
    expect(replay.status).toBe(503);
    expect(nextAttempt.status).toBe(503);
    const reconcileBody = `${imageBody(operationId, 1).slice(0, -1)},"reconcile_only":true}`;
    const reconciled = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", reconcileBody), durable);
    expect(reconciled.status).toBe(503);
    expect(results.objects.has(`visual-adapter/v3/operations/${operationId}/attempt-1/intent.json`)).toBe(true);
    expect(results.objects.has(`visual-adapter/v3/operations/${operationId}/attempt-1/result.json`)).toBe(false);
    expect(providerCalls).toBe(1);
  });

  it("does not skip a missing retryable attempt", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("skip-1", 1)), durable);
    const skipped = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("skip-1", 3)), durable);
    expect(first.status).toBe(503);
    expect(skipped.status).toBe(409);
    expect(providerCalls).toBe(1);
  });

  it("reconciles a result write response loss without regeneration", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { providerCalls += 1; return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 }); }));
    const results = bucket();
    results.failNextResultPut = true;
    const lost = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("lost-1")), durableEnv(results));
    expect(lost.status).toBe(200);
    const recovered = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("lost-1")), durableEnv(results));
    expect(recovered.status).toBe(200);
    expect(providerCalls).toBe(1);
  });

  it("repairs a successful R2 result when the durable terminal claim write is lost", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    (durable.VISUAL_OPERATION as FakeOperationNamespace).failNextTerminalPut("terminal-success");
    const lost = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("terminal-success")), durable);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ error: { code: "external_side_effect_unknown", retryable: false } });
    const recovered = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("terminal-success")), durable);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ operation_id: "terminal-success", attempt: 1, result: { b64_json: "synthetic-image" } });
    expect(providerCalls).toBe(1);
  });

  it("repairs a retryable R2 result before atomically claiming the next attempt", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      if (providerCalls === 1) return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 });
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    (durable.VISUAL_OPERATION as FakeOperationNamespace).failNextTerminalPut("terminal-retryable");
    const lost = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("terminal-retryable", 1)), durable);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ error: { code: "external_side_effect_unknown", retryable: false } });
    const second = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("terminal-retryable", 2)), durable);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ operation_id: "terminal-retryable", attempt: 2, result: { b64_json: "synthetic-image" } });
    expect(providerCalls).toBe(2);
  });

  it("keeps an ambiguous provider fetch as an unresolved intent and never advances the attempt", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      throw new Error("provider response unknown");
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("provider-unknown", 1)), durable);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: { code: "external_side_effect_unknown", retryable: false } });
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("provider-unknown", 1)), durable);
    const skipped = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("provider-unknown", 2)), durable);
    expect(replay.status).toBe(503);
    expect(skipped.status).toBe(503);
    expect(providerCalls).toBe(1);
    const reconcileBody = `${imageBody("provider-unknown", 1).slice(0, -1)},"reconcile_only":true}`;
    const reconciled = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", reconcileBody), durable);
    expect(reconciled.status).toBe(503);
    expect(providerCalls).toBe(1);
  });

  it("holds when the durable intent write outcome is unknown and does not call the provider", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    results.failNextPut = true;
    const response = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("intent-loss")), durableEnv(results));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "external_side_effect_unknown", retryable: false } });
    expect(providerCalls).toBe(0);
  });

  it("claims one provider operation under same-key concurrency and rejects payload conflicts", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const [first, second] = await Promise.all([
      adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("concurrent-1")), durable),
      adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("concurrent-1")), durable),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 503]);
    expect(providerCalls).toBe(1);
    const conflict = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", JSON.stringify({ operation_id: "concurrent-1", attempt: 1, prompt: "different", size: "1536x864" })), durable);
    expect(conflict.status).toBe(409);
    expect(providerCalls).toBe(1);
  });

  it("uses stable request hashes when equivalent JSON keys arrive in a different order", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const firstBody = JSON.stringify({ operation_id: "canonical-order", attempt: 1, plan: { mode: "normal", slots: [{ slot_id: "body_01", prompt_hash: "sha256:slot", binding: { style: "ink", order: 1 } }] } });
    const reorderedBody = JSON.stringify({ plan: { slots: [{ binding: { order: 1, style: "ink" }, prompt_hash: "sha256:slot", slot_id: "body_01" }], mode: "normal" }, attempt: 1, operation_id: "canonical-order" });
    const first = await adapter.fetch(request("/internal/v3/visual/plan", "visual-token", firstBody), durable);
    const replay = await adapter.fetch(request("/internal/v3/visual/plan", "visual-token", reorderedBody), durable);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(providerCalls).toBe(0);
    expect(results.objects.has("visual-adapter/v3/operations/canonical-order/attempt-1/intent.json")).toBe(true);
  });

  it("supports read-only result reconciliation and never writes an intent", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const body = imageBody("reconcile-only", 1);
    await expect(adapter.fetch(request("/internal/v3/visual/image", "visual-token", body), durable)).resolves.toHaveProperty("status", 200);
    const before = results.objects.size;
    const readOnly = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", `${body.slice(0, -1)},"reconcile_only":true}`), durable);
    expect(readOnly.status).toBe(200);
    expect(results.objects.size).toBe(before);
    expect(providerCalls).toBe(1);
    results.failReads = true;
    const unknown = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", `${body.slice(0, -1)},"reconcile_only":true}`), durable);
    expect(unknown.status).toBe(503);
    expect(providerCalls).toBe(1);
  });

  it("reconciles only the requested attempt and never returns a future attempt result", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      if (providerCalls === 1) return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 });
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    expect((await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("exact-reconcile", 1)), durable)).status).toBe(503);
    expect((await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("exact-reconcile", 2)), durable)).status).toBe(200);
    const attemptOne = imageBody("exact-reconcile", 1);
    const reconciledOne = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", `${attemptOne.slice(0, -1)},"reconcile_only":true}`), durable);
    expect(reconciledOne.status).toBe(503);
    expect(await reconciledOne.json()).toEqual({ error: { code: "upstream_retryable", retryable: true } });
    const attemptTwo = imageBody("exact-reconcile", 2);
    const reconciledTwo = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", `${attemptTwo.slice(0, -1)},"reconcile_only":true}`), durable);
    expect(reconciledTwo.status).toBe(200);
    expect(await reconciledTwo.json()).toMatchObject({ operation_id: "exact-reconcile", attempt: 2, result: { b64_json: "synthetic-image" } });
    expect(providerCalls).toBe(2);
  });

  it("rejects a fourth attempt and does not regenerate a completed operation", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { providerCalls += 1; return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 }); }));
    const results = bucket();
    const fourth = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("fourth", 4)), env(results));
    expect(fourth.status).toBe(400);
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("fourth", 1)), durable);
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("fourth", 3)), durable);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(providerCalls).toBe(1);
  });

  it("replays a prior successful attempt without claiming or calling the provider again", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("prior-success", 1)), durable);
    const later = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("prior-success", 2)), durable);
    expect(first.status).toBe(200);
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({ operation_id: "prior-success", attempt: 1, result: { b64_json: "synthetic-image" } });
    expect(providerCalls).toBe(1);
    expect(results.objects.has("visual-adapter/v3/operations/prior-success/attempt-2/intent.json")).toBe(false);
  });

  it("replays a prior terminal result even when a lower requested attempt is missing", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("low-attempt-terminal", 1)), durable);
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("low-attempt-terminal", 3)), durable);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ operation_id: "low-attempt-terminal", attempt: 1 });
    expect(providerCalls).toBe(1);
    expect(results.objects.has("visual-adapter/v3/operations/low-attempt-terminal/attempt-2/intent.json")).toBe(false);
  });

  it("fails closed when the durable result head metadata is tampered", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "synthetic-image" }] }), { status: 200 });
    }));
    const results = bucket();
    const durable = durableEnv(results);
    const first = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("head-tamper")), durable);
    expect(first.status).toBe(200);
    results.headMetadataOverride = { status: "failed" };
    const replay = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("head-tamper")), durable);
    expect(replay.status).toBe(503);
    expect(providerCalls).toBe(1);
  });

  it("fails closed for missing result storage, HTTP, invalid model, and invalid size", async () => {
    const noOperation = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("no-operation")), env());
    expect(noOperation.status).toBe(503);
    const noBucket = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody("no-store")), durableEnv(undefined));
    expect(noBucket.status).toBe(503);
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "unexpected" }] }), { status: 200 });
    }));
    const invalidUrls = [
      "http://gateway.example/v1/images/generations",
      "https://other.example/v1/images/generations",
      "https://gateway.example:8443/v1/images/generations",
      "https://gateway.example/v1/other",
      "https://gateway.example/v1/images/generations?x=1",
      "https://user:pass@gateway.example/v1/images/generations",
    ];
    for (const [index, IMAGE_PROVIDER_URL] of invalidUrls.entries()) {
      const invalid = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(`invalid-url-${index}`)), durableEnv(bucket(), { IMAGE_PROVIDER_URL }));
      expect(invalid.status).toBe(503);
    }
    expect(providerCalls).toBe(0);
    const model = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", JSON.stringify({ operation_id: "model", attempt: 1, model: "other", prompt: "x", size: "1536x864" })), durableEnv());
    expect(model.status).toBe(409);
    const size = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", JSON.stringify({ operation_id: "size", attempt: 1, prompt: "x", size: "1024x1024" })), durableEnv());
    expect(size.status).toBe(400);
  });

  it("allows only three image operations for the exact HTTPS canary scope", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: `canary-image-${providerCalls}` }] }), { status: 200 });
    }));
    const runtime = imageCanaryEnv();
    for (const character of ["a", "b", "c"]) {
      const response = await adapter.fetch(request(
        "/internal/v3/visual/image",
        "visual-token",
        imageBody(`visual_image_${character.repeat(24)}`, 1, CANARY_RUN_ID, CANARY_USER_ID, CANARY_WORKSPACE_ID),
      ), runtime);
      expect(response.status).toBe(200);
    }
    const exhausted = await adapter.fetch(request(
      "/internal/v3/visual/image",
      "visual-token",
      imageBody(`visual_image_${"d".repeat(24)}`, 1, CANARY_RUN_ID, CANARY_USER_ID, CANARY_WORKSPACE_ID),
    ), runtime);
    expect(exhausted.status).toBe(409);
    expect(await exhausted.json()).toEqual({ error: { code: "canary_operation_budget_exhausted", retryable: false } });
    expect(providerCalls).toBe(3);
  });

  it("rejects wrong, expired, or over-budget HTTPS canary configuration before provider access", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "must-not-be-returned" }] }), { status: 200 });
    }));
    const operationId = `visual_image_${"e".repeat(24)}`;
    const cases = [
      {
        name: "wrong run",
        body: imageBody(operationId, 1, `run_v3_${"7".repeat(64)}`, CANARY_USER_ID, CANARY_WORKSPACE_ID),
        overrides: {},
      },
      {
        name: "expired",
        body: imageBody(operationId, 1, CANARY_RUN_ID, CANARY_USER_ID, CANARY_WORKSPACE_ID),
        overrides: { IMAGE_PROVIDER_CANARY_EXPIRES_AT: new Date(Date.now() - 1).toISOString() },
      },
      {
        name: "four-operation config",
        body: imageBody(operationId, 1, CANARY_RUN_ID, CANARY_USER_ID, CANARY_WORKSPACE_ID),
        overrides: { IMAGE_PROVIDER_CANARY_MAX_OPERATIONS: "4" },
      },
      {
        name: "production environment",
        body: imageBody(operationId, 1, CANARY_RUN_ID, CANARY_USER_ID, CANARY_WORKSPACE_ID),
        overrides: { DEPLOY_ENVIRONMENT: "production" },
      },
    ];
    for (const item of cases) {
      const response = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", item.body), imageCanaryEnv(bucket(), item.overrides));
      expect(response.status, item.name).toBe(403);
    }
    expect(providerCalls).toBe(0);
  });

  it("rechecks HTTPS canary expiry after the operation budget claim", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-28T00:00:00.000Z");
    const expiresAt = new Date(startedAt.getTime() + 30_000);
    vi.setSystemTime(startedAt);
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "must-not-be-returned" }] }), { status: 200 });
    }));
    const runtime = imageCanaryEnv(bucket(), { IMAGE_PROVIDER_CANARY_EXPIRES_AT: expiresAt.toISOString() });
    const namespace = runtime.VISUAL_OPERATION as FakeOperationNamespace;
    runtime.VISUAL_OPERATION = {
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: string) => {
        const target = namespace.get(id);
        if (!id.startsWith("image-canary:")) return target;
        return { fetch: async (requestValue: Request) => {
          const response = await target.fetch(requestValue);
          vi.setSystemTime(new Date(expiresAt.getTime() + 1));
          return response;
        } };
      },
    };
    const response = await adapter.fetch(request(
      "/internal/v3/visual/image",
      "visual-token",
      imageBody(`visual_image_${"f".repeat(24)}`, 1, CANARY_RUN_ID, CANARY_USER_ID, CANARY_WORKSPACE_ID),
    ), runtime);
    expect(response.status).toBe(403);
    expect(providerCalls).toBe(0);
  });

  it("rejects the retired staging HTTP exception even when its old variables are injected", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: "must-not-be-returned" }] }), { status: 200 });
    }));
    const runtime = durableEnv(bucket(), {
      IMAGE_PROVIDER_URL: "http://23.105.194.173:8881/v1/images/generations",
      IMAGE_PROVIDER_HOST: "23.105.194.173",
      DEPLOY_ENVIRONMENT: "staging",
      IMAGE_PROVIDER_INSECURE_HTTP_MODE: "staging_single_run",
      IMAGE_PROVIDER_INSECURE_HTTP_RUN_ID: `run_v3_${"8".repeat(64)}`,
      IMAGE_PROVIDER_INSECURE_HTTP_USER_ID: "staging_user",
      IMAGE_PROVIDER_INSECURE_HTTP_WORKSPACE_ID: "staging_workspace",
      IMAGE_PROVIDER_INSECURE_HTTP_GRANT_ID: `staging_http_${"9".repeat(32)}`,
      IMAGE_PROVIDER_INSECURE_HTTP_MAX_OPERATIONS: "3",
      IMAGE_PROVIDER_INSECURE_HTTP_MAX_REQUESTS: "9",
      IMAGE_PROVIDER_INSECURE_HTTP_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    });
    const response = await adapter.fetch(request("/internal/v3/visual/image", "visual-token", imageBody(`visual_image_${"a".repeat(24)}`, 1, `run_v3_${"8".repeat(64)}`, "staging_user", "staging_workspace")), runtime);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "service_unconfigured", retryable: false } });
    expect(providerCalls).toBe(0);
  });
});
