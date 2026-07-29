import { afterEach, describe, expect, it, vi } from "vitest";
import adapter, { canonical, deriveWechatAccountBindingId, WechatOperationAgent, type Env } from "../src/index";

class Bucket {
  values = new Map<string, string>();
  puts = 0;
  async get(key: string) { const value = this.values.get(key); return value === undefined ? null : { text: async () => value }; }
  async head(key: string) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return { size: new TextEncoder().encode(value).byteLength, customMetadata: { result_hash: `sha256:${Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}` } };
  }
  async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.values.has(key)) throw new Error("exists");
    this.puts += 1; this.values.set(key, value); return {} as R2Object;
  }
}

function state(): DurableObjectState {
  const values = new Map<string, unknown>();
  return { storage: { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } } } as unknown as DurableObjectState;
}

function env(bucket = new Bucket(), providerUrl = "https://gateway.example/wechat"): Env {
  return {
    WECHAT_PUBLISHING_TOKEN: "wechat-token",
    CREDENTIAL_ENCRYPTION_KEY: "ignored-for-plain",
    WECHAT_RESULTS_BUCKET: bucket as unknown as R2Bucket,
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ user_id: "user-1", app_id: "app-1", app_secret_ciphertext: "plain:provider-secret", proxy_url: providerUrl, updated_at: "2026-07-21T00:00:00.000Z" }) }) }) } as unknown as D1Database,
    WECHAT_OPERATION: {} as DurableObjectNamespace,
  };
}

async function configuredEnv(bucket = new Bucket(), providerUrl?: string): Promise<Env> {
  const value = env(bucket, providerUrl);
  value.WECHAT_DRAFT_SYNC_V3 = "true";
  value.WECHAT_DRAFT_SYNC_V3_ALLOWLIST = "user-1:workspace-1";
  value.WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST = await deriveWechatAccountBindingId("user-1", "workspace-1", "app-1");
  value.WECHAT_PROVIDER_BASE_URL_ALLOWLIST = providerUrl || "https://gateway.example/wechat";
  value.WECHAT_MEDIA_URL_HOST_ALLOWLIST = "wechat.example";
  return value;
}

type Receipt = { account_binding_id: string; receipt_hash: string };
function requestBody(operation: string, operationId: string, attempt = 1, receipt?: Receipt, payload?: Record<string, unknown>) {
  return JSON.stringify({
    protocol_version: "vibepub.wechat.v3", operation, operation_id: operationId, attempt,
    user_id: "user-1", workspace_id: "workspace-1", article_id: "article-1",
    ...(receipt ? { account_binding_id: receipt.account_binding_id, account_receipt_hash: receipt.receipt_hash } : {}),
    payload: payload || (operation === "upload_image" ? {
      operation_id: operationId, image_base64: "iVBORw0KGgo=", byte_length: 8,
      byte_hash: `sha256:${"a".repeat(64)}`, mime: "image/png", slot_id: "cover_01", purpose: "cover",
    } : {}),
  });
}

async function resolve(instance: WechatOperationAgent): Promise<Receipt> {
  const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("resolve_account", "resolve-1") }));
  expect(response.status).toBe(200);
  const body = await response.json() as { result: Receipt };
  return body.result;
}

function providerMock(options: { readHtml?: string; mediaUrl?: string; batch?: Array<{ media_id: string; title: string; content: string; thumb_media_id: string }>; failure?: Response } = {}) {
  const calls: Array<{ url: URL; method: string; contentType: string | null }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url); calls.push({ url, method: request.method, contentType: request.headers.get("content-type") });
    if (options.failure) return options.failure;
    if (url.pathname.endsWith("/cgi-bin/token")) return Response.json({ access_token: "token-1", expires_in: 7200 });
    if (url.pathname.endsWith("/cgi-bin/material/add_material")) return Response.json({ media_id: "cover-media-1", url: options.mediaUrl || "https://wechat.example/cover.png" });
    if (url.pathname.endsWith("/cgi-bin/media/uploadimg")) return Response.json({ url: options.mediaUrl || "https://wechat.example/body.png" });
    if (url.pathname.endsWith("/cgi-bin/draft/add")) return Response.json({ media_id: "draft-media-1" });
    if (url.pathname.endsWith("/cgi-bin/draft/update")) return Response.json({ errcode: 0 });
    if (url.pathname.endsWith("/cgi-bin/draft/get")) return Response.json({ news_item: [{ title: "Title", content: options.readHtml || "<p>Body</p><img src=\"https://wechat.example/body.png\"/>", thumb_media_id: "cover-media-1" }] });
    if (url.pathname.endsWith("/cgi-bin/draft/batchget")) return Response.json({ item: (options.batch || []).map(item => ({ media_id: item.media_id, content: { news_item: [item] } })) });
    return Response.json({ errcode: 48001 });
  });
  return { calls, fetcher };
}

describe("wechat publishing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns only non-secret deployment evidence from health", async () => {
    const response = await adapter.fetch(new Request("https://adapter.test/health"), {
      DEPLOY_COMMIT: "abc123",
      DEPLOY_REF: "codex/staging",
      DEPLOYED_AT: "2026-07-22T00:00:00.000Z",
      WECHAT_PUBLISHING_TOKEN: "synthetic-secret",
    } as Env);
    expect(await response.json()).toEqual({
      ok: true,
      service: "wechat-publishing-adapter",
      version: { commit: "abc123", ref: "codex/staging", deployed_at: "2026-07-22T00:00:00.000Z" },
    });
  });

  it("rejects legacy tokens before parsing JSON", async () => {
    const response = await adapter.fetch(new Request("https://adapter.test/internal/v3/wechat/upload", { method: "POST", headers: { authorization: "Bearer files-token" }, body: "not-json" }), env());
    expect(response.status).toBe(401);
  });

  it("uses the private resolver without requiring the shared encryption key", async () => {
    const configured = await configuredEnv();
    configured.V3_TENANT_SCOPE = "all";
    configured.WECHAT_DRAFT_SYNC_V3_ALLOWLIST = "";
    configured.WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST = "";
    configured.PUBLISHING_ACCOUNT_RESOLVER_URL = "https://vibepub.example/";
    configured.PUBLISHING_ACCOUNT_RESOLVER_TOKEN = "resolver-token";
    configured.CREDENTIAL_ENCRYPTION_KEY = undefined;
    const resolver = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe("https://vibepub.example/api/internal/publishing-account");
      expect(request.headers.get("authorization")).toBe("Bearer resolver-token");
      expect(await request.json()).toEqual({ user_id: "user-1" });
      return Response.json({ publishing_account: {
        app_id: "app-1",
        app_secret: "provider-secret",
        proxy_url: "https://gateway.example/wechat",
        updated_at: "2026-07-21T00:00:00.000Z",
      } });
    });
    vi.stubGlobal("fetch", resolver);

    const receipt = await resolve(new WechatOperationAgent(state(), configured));
    expect(receipt.account_binding_id).toMatch(/^wab_/);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("fails closed when only half of the private resolver is configured", async () => {
    const configured = await configuredEnv();
    configured.PUBLISHING_ACCOUNT_RESOLVER_URL = "https://vibepub.example/";
    const response = await new WechatOperationAgent(state(), configured).fetch(new Request("https://internal", {
      method: "POST",
      body: requestBody("resolve_account", "resolve-partial"),
    }));
    expect(response.status).toBe(409);
  });

  it("resolves and validates the account receipt before any durable operation", async () => {
    const bucket = new Bucket(); const instance = new WechatOperationAgent(state(), await configuredEnv(bucket));
    const fetcher = providerMock(); vi.stubGlobal("fetch", fetcher.fetcher);
    const receipt = await resolve(instance);
    expect(receipt.account_binding_id).toMatch(/^wab_/);
    expect(receipt.receipt_hash).toMatch(/^sha256:/);
    const denied = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "op-denied", 1, { account_binding_id: receipt.account_binding_id, receipt_hash: `sha256:${"b".repeat(64)}` }) }));
    expect(denied.status).toBe(409);
    expect(bucket.puts).toBe(0);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("derives the resolve-account DO shard from the resolved opaque binding", async () => {
    const configured = await configuredEnv();
    const names: string[] = [];
    configured.WECHAT_OPERATION = {
      getByName(name: string) {
        names.push(name);
        return {
          fetch: async () => Response.json({ protocol_version: "vibepub.wechat.v3", operation: "resolve_account", operation_id: "resolve-shard", attempt: 1, result: {} }),
        };
      },
    } as unknown as DurableObjectNamespace;
    const response = await adapter.fetch(new Request("https://adapter.test/internal/v3/wechat/resolve", {
      method: "POST",
      headers: { authorization: "Bearer wechat-token", "content-type": "application/json" },
      body: requestBody("resolve_account", "resolve-shard"),
    }), configured);
    const binding = await deriveWechatAccountBindingId("user-1", "workspace-1", "app-1");
    const bytes = new TextEncoder().encode(canonical({ user_id: "user-1", workspace_id: "workspace-1", account_binding_id: binding, article_id: "article-1" }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const expected = `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    expect(response.status).toBe(200);
    expect(names).toEqual([expected]);
  });

  it("rejects a stale account receipt before selecting a durable operation shard", async () => {
    const configured = await configuredEnv();
    let selected = 0;
    configured.WECHAT_OPERATION = {
      getByName() {
        selected += 1;
        return { fetch: async () => Response.json({}) };
      },
    } as unknown as DurableObjectNamespace;
    const binding = await deriveWechatAccountBindingId("user-1", "workspace-1", "app-1");
    const response = await adapter.fetch(new Request("https://adapter.test/internal/v3/wechat/get", {
      method: "POST",
      headers: { authorization: "Bearer wechat-token", "content-type": "application/json" },
      body: requestBody("get_draft", "stale-receipt", 1, {
        account_binding_id: binding,
        receipt_hash: `sha256:${"0".repeat(64)}`,
      }, { operation_id: "stale-receipt", media_id: "draft-media-1" }),
    }), configured);
    expect(response.status).toBe(409);
    expect(selected).toBe(0);
  });

  it("uses fixed token and multipart image endpoints, then replays without another provider call", async () => {
    const bucket = new Bucket(); const instance = new WechatOperationAgent(state(), await configuredEnv(bucket));
    const mock = providerMock(); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const payload = { operation_id: "upload-cover", image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: await (async () => { const raw = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0)); const digest = await crypto.subtle.digest("SHA-256", raw); return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`; })(), mime: "image/png", slot_id: "cover_01", purpose: "cover" };
    const first = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "upload-cover", 1, receipt, payload) }));
    const replay = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "upload-cover", 1, receipt, payload) }));
    expect(first.status).toBe(200); expect(replay.status).toBe(200);
    const firstEvidence = await first.clone().json() as { result_ref: string; result_hash: string };
    const replayEvidence = await replay.clone().json() as { result_ref: string; result_hash: string };
    expect(firstEvidence.result_ref).toBe("wechat-adapter/v1/result/upload-cover/1.json");
    expect(firstEvidence.result_hash).toMatch(/^sha256:/);
    expect(replayEvidence).toEqual(firstEvidence);
    expect(mock.calls.map(call => call.url.pathname)).toEqual(["/wechat/cgi-bin/token", "/wechat/cgi-bin/material/add_material"]);
    expect(mock.calls[1].method).toBe("POST");
    expect(mock.calls[1].contentType).toMatch(/^multipart\/form-data/);
    expect(mock.calls[0].url.searchParams).toMatchObject({ get: expect.any(Function) });
    expect(mock.calls[0].url.searchParams.get("grant_type")).toBe("client_credential");
    expect(mock.calls[0].url.searchParams.get("appid")).toBe("app-1");
    expect(mock.calls[1].url.searchParams.get("type")).toBe("image");
  });

  it("reuses the account/kind/byte upload cache across distinct operations", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const mock = providerMock(); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const bytes = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0));
    const rawHash = await crypto.subtle.digest("SHA-256", bytes);
    const byteHash = `sha256:${Array.from(new Uint8Array(rawHash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const payload = (operation_id: string) => ({ operation_id, image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: byteHash, mime: "image/png", slot_id: "body_01", purpose: "body" });
    const first = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "cache-1", 1, receipt, payload("cache-1")) }));
    const second = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "cache-2", 1, receipt, payload("cache-2")) }));
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(mock.calls.filter(call => call.url.pathname.endsWith("/media/uploadimg"))).toHaveLength(1);
  });

  it.each(["https://evil.example/image.png", "https://wechat.example.evil/image.png", "https://127.0.0.1/image.png", "https://localhost/image.png", "https://[fd00::1]/image.png"])("rejects a non-allowlisted upload media URL %s before caching it", async (mediaUrl) => {
    const bucket = new Bucket(); const instance = new WechatOperationAgent(state(), await configuredEnv(bucket));
    const mock = providerMock({ mediaUrl }); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const bytes = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0));
    const rawHash = await crypto.subtle.digest("SHA-256", bytes);
    const byteHash = `sha256:${Array.from(new Uint8Array(rawHash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "host-reject", 1, receipt, {
      operation_id: "host-reject", image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: byteHash, mime: "image/png", slot_id: "body_01", purpose: "body",
    }) }));
    expect(response.status).toBe(422);
    expect([...bucket.values.keys()].some(key => key.startsWith("wechat-adapter/v1/upload-cache/"))).toBe(false);
  });

  it("fails closed when the deployment media host allowlist is empty", async () => {
    const configured = await configuredEnv(); configured.WECHAT_MEDIA_URL_HOST_ALLOWLIST = "";
    const instance = new WechatOperationAgent(state(), configured);
    const mock = providerMock(); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const bytes = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0));
    const rawHash = await crypto.subtle.digest("SHA-256", bytes);
    const byteHash = `sha256:${Array.from(new Uint8Array(rawHash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "host-empty", 1, receipt, {
      operation_id: "host-empty", image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: byteHash, mime: "image/png", slot_id: "body_01", purpose: "body",
    }) }));
    expect(response.status).toBe(422);
  });

  it("maps an explicit token credential rejection to account repair semantics", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const receipt = await resolve(instance);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ errcode: 40013, errmsg: "invalid appid" })));
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "token-rejected", 1, receipt, {
      operation_id: "token-rejected", media_id: "draft-media-1",
    }) }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "wechat_access_token_rejected", retryable: false } });
  });

  it("rejects an HTTP provider base during read-only account resolution", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv(new Bucket(), "http://gateway.example/wechat"));
    let calls = 0; vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; return Response.json({}); }));
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("resolve_account", "resolve-http") }));
    expect(response.status).toBe(409); expect(calls).toBe(0);
  });

  it.each([
    "https://evil.example/wechat",
    "https://gateway.example.evil/wechat",
    "https://gateway.example/wechat-extra",
    "https://gateway.example/wechat/extra",
    "https://user:pass@gateway.example/wechat",
    "https://127.0.0.1/wechat",
    "https://[fd00::1]/wechat",
  ])("rejects an unallowlisted provider base before Durable Object, R2, or provider access: %s", async (providerUrl) => {
    const bucket = new Bucket(); const configured = await configuredEnv(bucket, providerUrl);
    configured.WECHAT_PROVIDER_BASE_URL_ALLOWLIST = "https://gateway.example/wechat";
    let selected = 0; let provider = 0;
    configured.WECHAT_OPERATION = { getByName: () => { selected += 1; return { fetch: async () => Response.json({}) }; } } as unknown as DurableObjectNamespace;
    vi.stubGlobal("fetch", vi.fn(async () => { provider += 1; return Response.json({}); }));
    const response = await adapter.fetch(new Request("https://adapter.test/internal/v3/wechat/resolve", {
      method: "POST", headers: { authorization: "Bearer wechat-token" }, body: requestBody("resolve_account", "blocked-base"),
    }), configured);
    expect(response.status).toBe(409);
    expect(selected).toBe(0); expect(bucket.puts).toBe(0); expect(provider).toBe(0);
  });

  it.each([
    "https://localhost./wechat",
    "https://foo.local./wechat",
    "https://foo.internal./wechat",
    "https://metadata./wechat",
  ])("rejects a trailing-dot private provider base even when the allowlist repeats it: %s", async (providerUrl) => {
    const bucket = new Bucket(); const configured = await configuredEnv(bucket, providerUrl);
    configured.WECHAT_PROVIDER_BASE_URL_ALLOWLIST = providerUrl;
    let selected = 0; let provider = 0;
    configured.WECHAT_OPERATION = { getByName: () => { selected += 1; return { fetch: async () => Response.json({}) }; } } as unknown as DurableObjectNamespace;
    vi.stubGlobal("fetch", vi.fn(async () => { provider += 1; return Response.json({}); }));
    const response = await adapter.fetch(new Request("https://adapter.test/internal/v3/wechat/resolve", {
      method: "POST", headers: { authorization: "Bearer wechat-token" }, body: requestBody("resolve_account", "trailing-dot-base"),
    }), configured);
    expect(response.status).toBe(409);
    expect(selected).toBe(0); expect(bucket.puts).toBe(0); expect(provider).toBe(0);
  });

  it.each(["localhost.", "foo.local.", "foo.internal.", "metadata."])("rejects a trailing-dot private media host even when the allowlist repeats it: %s", async (host) => {
    const bucket = new Bucket(); const configured = await configuredEnv(bucket);
    configured.WECHAT_MEDIA_URL_HOST_ALLOWLIST = host;
    const instance = new WechatOperationAgent(state(), configured);
    const mock = providerMock({ mediaUrl: `https://${host}/image.png` }); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const bytes = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0));
    const rawHash = await crypto.subtle.digest("SHA-256", bytes);
    const byteHash = `sha256:${Array.from(new Uint8Array(rawHash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", `trailing-${host}`, 1, receipt, {
      operation_id: `trailing-${host}`, image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: byteHash, mime: "image/png", slot_id: "body_01", purpose: "body",
    }) }));
    expect(response.status).toBe(422);
    expect([...bucket.values.keys()].some(key => key.startsWith("wechat-adapter/v1/upload-cache/"))).toBe(false);
  });

  it("rejects bare metadata media even when the allowlist repeats it", async () => {
    const bucket = new Bucket(); const configured = await configuredEnv(bucket);
    configured.WECHAT_MEDIA_URL_HOST_ALLOWLIST = "metadata";
    const instance = new WechatOperationAgent(state(), configured);
    const mock = providerMock({ mediaUrl: "https://metadata/image.png" }); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const bytes = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0));
    const rawHash = await crypto.subtle.digest("SHA-256", bytes);
    const byteHash = `sha256:${Array.from(new Uint8Array(rawHash)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("upload_image", "metadata-host", 1, receipt, {
      operation_id: "metadata-host", image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: byteHash, mime: "image/png", slot_id: "body_01", purpose: "body",
    }) }));
    expect(response.status).toBe(422);
    expect([...bucket.values.keys()].some(key => key.startsWith("wechat-adapter/v1/upload-cache/"))).toBe(false);
  });

  it("rejects an adapter tenant miss before account, Durable Object, R2, or provider access", async () => {
    const bucket = new Bucket(); const configured = await configuredEnv(bucket);
    configured.WECHAT_DRAFT_SYNC_V3_ALLOWLIST = "another:workspace";
    let selected = 0; let provider = 0;
    configured.WECHAT_OPERATION = { getByName: () => { selected += 1; return { fetch: async () => Response.json({}) }; } } as unknown as DurableObjectNamespace;
    vi.stubGlobal("fetch", vi.fn(async () => { provider += 1; return Response.json({}); }));
    const response = await adapter.fetch(new Request("https://adapter.test/internal/v3/wechat/resolve", {
      method: "POST", headers: { authorization: "Bearer wechat-token" }, body: requestBody("resolve_account", "blocked-owner"),
    }), configured);
    expect(response.status).toBe(409);
    expect(selected).toBe(0); expect(bucket.puts).toBe(0); expect(provider).toBe(0);
  });

  it("parses article index zero readback and never trusts a provider supplied hash", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const mock = providerMock({ readHtml: "\r\n<p>Body</p><img src=\"https://wechat.example/body.png\"/>\r\n" }); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const result = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "get-1", 1, receipt, { operation_id: "get-1", media_id: "draft-media-1" }) }));
    const value = await result.json() as { result: { article_index: number; canonical_html: string; html_hash: string; body_urls: string[] } };
    expect(result.status).toBe(200); expect(value.result.article_index).toBe(0);
    expect(value.result.canonical_html).toBe("<p>Body</p><img src=\"https://wechat.example/body.png\"/>");
    expect(value.result.html_hash).toMatch(/^sha256:/); expect(value.result.body_urls).toEqual(["https://wechat.example/body.png"]);
  });

  it("reconciles exact durable result without claiming a missing operation", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv()); const mock = providerMock(); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const payload = { operation_id: "get-reconcile", media_id: "draft-media-1" };
    await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "get-reconcile", 1, receipt, payload) }));
    const replay = await instance.fetch(new Request("https://internal", { method: "POST", body: JSON.stringify({ ...JSON.parse(requestBody("get_draft", "get-reconcile", 1, receipt, payload)), reconcile_only: true }) }));
    const unknown = await instance.fetch(new Request("https://internal", { method: "POST", body: JSON.stringify({ ...JSON.parse(requestBody("get_draft", "get-missing", 1, receipt, { operation_id: "get-missing", media_id: "draft-media-1" })), reconcile_only: true }) }));
    expect(replay.status).toBe(200); expect(unknown.status).toBe(503);
    expect(mock.calls.filter(call => call.url.pathname.endsWith("/draft/get"))).toHaveLength(1);
  });

  it("requires every earlier retryable attempt before a later attempt and does not skip", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url); calls.push(url);
      if (url.pathname.endsWith("/cgi-bin/token")) return Response.json({ access_token: "token-1", expires_in: 7200 });
      return new Response("{}", { status: 503, headers: { "x-vibepub-delivery-status": "rejected_before_commit" } });
    }));
    const receipt = await resolve(instance); const payload = { operation_id: "get-attempt", media_id: "draft-media-1" };
    const first = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "get-attempt", 1, receipt, payload) }));
    const second = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "get-attempt", 2, receipt, payload) }));
    const skipped = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "get-skipped", 2, receipt, { operation_id: "get-skipped", media_id: "draft-media-1" }) }));
    expect(first.status).toBe(503); expect(second.status).toBe(503); expect(skipped.status).toBe(503);
    expect((await first.json() as { error: { delivery_status: string } }).error.delivery_status).toBe("rejected_before_commit");
    expect(calls.filter(call => call.pathname.endsWith("/draft/get"))).toHaveLength(2);
  });

  it("records controlled token read retries before completing the dependent read", async () => {
    const bucket = new Bucket();
    const instance = new WechatOperationAgent(state(), await configuredEnv(bucket));
    let tokenCalls = 0;
    let draftReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/cgi-bin/token")) {
        tokenCalls += 1;
        if (tokenCalls < 3) return new Response("{}", { status: 503 });
        return Response.json({ access_token: "token-3", expires_in: 7200 });
      }
      if (url.pathname.endsWith("/cgi-bin/draft/get")) {
        draftReads += 1;
        return Response.json({ news_item: [{ title: "Title", content: "<p>Body</p><img src=\"https://wechat.example/body.png\"/>", thumb_media_id: "cover-media-1" }] });
      }
      return Response.json({ errcode: 48001 });
    }));
    const receipt = await resolve(instance);
    const response = await instance.fetch(new Request("https://internal", {
      method: "POST",
      body: requestBody("get_draft", "token-retry-read", 1, receipt, { operation_id: "token-retry-read", media_id: "draft-media-1" }),
    }));
    expect(response.status).toBe(200);
    expect(tokenCalls).toBe(3);
    expect(draftReads).toBe(1);
    expect([...bucket.values.keys()].filter(key => key.includes("/token-result/")).sort()).toHaveLength(3);
  });

  it("refreshes a rejected access token exactly once before surfacing the readback", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    let tokenCalls = 0; let draftCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/cgi-bin/token")) return Response.json({ access_token: `token-${++tokenCalls}`, expires_in: 7200 });
      if (url.pathname.endsWith("/cgi-bin/draft/get")) {
        draftCalls += 1;
        return draftCalls === 1 ? Response.json({ errcode: 40014 }) : Response.json({ news_item: [{ title: "Title", content: "<p>Body</p>", thumb_media_id: "cover-media-1" }] });
      }
      return Response.json({ errcode: 48001 });
    }));
    const receipt = await resolve(instance);
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "refresh-1", 1, receipt, { operation_id: "refresh-1", media_id: "draft-media-1" }) }));
    expect(response.status).toBe(200); expect(tokenCalls).toBe(2); expect(draftCalls).toBe(2);
  });

  it("maps explicit account and image rejections without treating them as unknown writes", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url); calls.push(url);
      if (url.pathname.endsWith("/cgi-bin/token")) return Response.json({ access_token: "token-1", expires_in: 7200 });
      if (url.pathname.endsWith("/cgi-bin/draft/get")) return Response.json({ errcode: 40013 });
      if (url.pathname.endsWith("/cgi-bin/media/uploadimg")) return Response.json({ errcode: 40006 });
      return Response.json({ errcode: 48001 });
    }));
    const receipt = await resolve(instance);
    const accountRejected = await instance.fetch(new Request("https://internal", {
      method: "POST",
      body: requestBody("get_draft", "account-rejected", 1, receipt, { operation_id: "account-rejected", media_id: "draft-media-1" }),
    }));
    const bytes = Uint8Array.from(atob("iVBORw0KGgo="), char => char.charCodeAt(0));
    const byteDigest = await crypto.subtle.digest("SHA-256", bytes);
    const byteHash = `sha256:${Array.from(new Uint8Array(byteDigest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const imageRejected = await instance.fetch(new Request("https://internal", {
      method: "POST",
      body: requestBody("upload_image", "image-rejected", 1, receipt, {
        operation_id: "image-rejected", image_base64: "iVBORw0KGgo=", byte_length: 8, byte_hash: byteHash,
        mime: "image/png", slot_id: "body_01", purpose: "body",
      }),
    }));
    expect(accountRejected.status).toBe(409);
    expect((await accountRejected.json() as { error: { code: string } }).error.code).toBe("wechat_publishing_account_rejected");
    expect(imageRejected.status).toBe(422);
    expect((await imageRejected.json() as { error: { code: string } }).error.code).toBe("wechat_image_upload_non_retryable");
    expect(calls.filter(call => call.pathname.endsWith("/draft/get"))).toHaveLength(1);
    expect(calls.filter(call => call.pathname.endsWith("/media/uploadimg"))).toHaveLength(1);
  });

  it("uses bounded batchget identity recovery and accepts exactly one fingerprint", async () => {
    const html = "<p>Body</p>";
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const mock = providerMock({ batch: [{ media_id: "draft-a", title: "Title", content: html, thumb_media_id: "cover-media-1" }] }); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance);
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("find_draft", "find-1", 1, receipt, { operation_id: "find-1", draft_identity_hash: `sha256:${"d".repeat(64)}`, title: "Title", canonical_html: html, html_hash: await (async () => { const bytes = new TextEncoder().encode(html); const value = await crypto.subtle.digest("SHA-256", bytes); return `sha256:${Array.from(new Uint8Array(value)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`; })(), thumb_media_id: "cover-media-1" }) }));
    expect(response.status).toBe(200); expect(mock.calls.filter(call => call.url.pathname.endsWith("/draft/batchget"))).toHaveLength(1);
  });

  it("retries a read transport interruption through three durable attempts but keeps a write ambiguous", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    let reads = 0; let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/cgi-bin/token")) return Response.json({ access_token: "token-1", expires_in: 7200 });
      if (url.pathname.endsWith("/cgi-bin/draft/get")) {
        reads += 1;
        if (reads < 3) throw new Error("synthetic read transport interruption");
        return Response.json({ news_item: [{ title: "Title", content: "<p>Body</p>", thumb_media_id: "cover-media-1" }] });
      }
      if (url.pathname.endsWith("/cgi-bin/draft/add")) { writes += 1; return new Response("", { status: 503 }); }
      return Response.json({ errcode: 48001 });
    }));
    const receipt = await resolve(instance);
    const get = (attempt: number) => instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "read-transport", attempt, receipt, { operation_id: "read-transport", media_id: "draft-media-1" }) }));
    expect((await get(1)).status).toBe(503); expect((await get(2)).status).toBe(503); expect((await get(3)).status).toBe(200);
    const write = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("write_draft", "write-ambiguous", 1, receipt, {
      operation_id: "write-ambiguous", draft_identity_hash: `sha256:${"d".repeat(64)}`, mutation: "add", title: "Title", canonical_html: "<p>Body</p>", html_hash: `sha256:${"e".repeat(64)}`, thumb_media_id: "cover-media-1",
    }) }));
    expect(reads).toBe(3); expect(write.status).toBe(503); expect(writes).toBe(1);
  });

  it("classifies known read errors for reconciliation instead of as draft writes", async () => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/cgi-bin/token")) return Response.json({ access_token: "token-1", expires_in: 7200 });
      return Response.json({ errcode: 40006 });
    }));
    const receipt = await resolve(instance);
    const get = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("get_draft", "known-read", 1, receipt, { operation_id: "known-read", media_id: "draft-media-1" }) }));
    const find = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("find_draft", "known-find", 1, receipt, { operation_id: "known-find", draft_identity_hash: `sha256:${"d".repeat(64)}`, title: "Title", canonical_html: "<p>Body</p>", thumb_media_id: "cover-media-1" }) }));
    expect((await get.json() as { error: { code: string } }).error.code).toBe("draft_readback_unavailable");
    expect((await find.json() as { error: { code: string } }).error.code).toBe("draft_identity_unresolved");
  });

  it.each([
    ["zero", []],
    ["multiple", [
      { media_id: "draft-a", title: "Title", content: "<p>Body</p>", thumb_media_id: "cover-media-1" },
      { media_id: "draft-b", title: "Title", content: "<p>Body</p>", thumb_media_id: "cover-media-1" },
    ]],
  ])("holds unresolved %s draft identity without a write", async (_label, batch) => {
    const instance = new WechatOperationAgent(state(), await configuredEnv());
    const mock = providerMock({ batch }); vi.stubGlobal("fetch", mock.fetcher);
    const receipt = await resolve(instance); const html = "<p>Body</p>";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
    const response = await instance.fetch(new Request("https://internal", { method: "POST", body: requestBody("find_draft", `find-${_label}`, 1, receipt, { operation_id: `find-${_label}`, draft_identity_hash: `sha256:${"d".repeat(64)}`, title: "Title", canonical_html: html, html_hash: `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`, thumb_media_id: "cover-media-1" }) }));
    expect(response.status).toBe(409);
    expect(mock.calls.filter(call => call.url.pathname.includes("/draft/add") || call.url.pathname.includes("/draft/update"))).toHaveLength(0);
  });
});
