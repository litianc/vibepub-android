export type Env = {
  DB: D1Database;
  WECHAT_RESULTS_BUCKET: R2Bucket;
  WECHAT_OPERATION: DurableObjectNamespace;
  WECHAT_PUBLISHING_TOKEN?: string;
  V3_TENANT_SCOPE?: string;
  WECHAT_DRAFT_SYNC_V3?: string;
  WECHAT_DRAFT_SYNC_V3_ALLOWLIST?: string;
  WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST?: string;
  WECHAT_PROVIDER_BASE_URL_ALLOWLIST?: string;
  WECHAT_MEDIA_URL_HOST_ALLOWLIST?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  PUBLISHING_ACCOUNT_RESOLVER_URL?: string;
  PUBLISHING_ACCOUNT_RESOLVER_TOKEN?: string;
  DEPLOY_COMMIT?: string;
  DEPLOY_REF?: string;
  DEPLOYED_AT?: string;
};

type Operation = "resolve_account" | "upload_image" | "write_draft" | "get_draft" | "find_draft";
type Account = { user_id: string; app_id: string; app_secret_ciphertext: string; proxy_url: string | null; updated_at: string };
type AccountMaterial = { user_id: string; app_id: string; app_secret: string; proxy_url: string | null; updated_at: string };
type ResolvedAccount = {
  account: AccountMaterial;
  binding_id: string;
  operation_scope_hash: string;
  config_hash: string;
  receipt_hash: string;
  provider_base: URL;
  app_secret: string;
};
type Intent = {
  operation_id: string;
  operation: Operation;
  attempt: number;
  request_hash: string;
  state: "intent" | "completed" | "failed";
  result_ref?: string;
  result_hash?: string;
  retryable?: boolean;
};
type StoredResult = {
  operation_id: string;
  operation: Operation;
  attempt: number;
  request_hash: string;
  status: "success" | "failed";
  retryable: boolean;
  status_code: number;
  code?: string;
  delivery_status?: "not_forwarded" | "rejected_before_commit";
  result?: ProviderResult;
};
type ProviderResult = {
  media_id?: string;
  media_url?: string;
  mutation?: "add" | "update" | "noop";
  title?: string;
  canonical_html?: string;
  html_hash?: string;
  body_urls?: string[];
  thumb_media_id?: string;
  article_index?: 0;
  account_binding_id?: string;
  config_hash?: string;
  receipt_hash?: string;
  version?: "wechat-account-resolution.v1";
  not_found?: true;
};
type ParsedInput = {
  operation: Operation;
  operation_id: string;
  attempt: number;
  user_id: string;
  workspace_id: string;
  article_id: string;
  account_binding_id?: string;
  account_receipt_hash?: string;
  reconcile_only: boolean;
  payload: Record<string, unknown>;
};
type CachedToken = { access_token: string; expires_at: number; config_hash: string };
type TokenAttemptResult = {
  status: "success" | "failed";
  retryable: boolean;
  status_code: number;
  code?: string;
  token?: CachedToken;
};
type TokenIntent = {
  state: "intent" | "completed" | "failed";
  created_at_ms?: number;
  result_ref?: string;
  result_hash?: string;
  retryable?: boolean;
};

const MAX_UPLOAD_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_IMAGE_BASE64_CHARS = Math.ceil(MAX_UPLOAD_IMAGE_BYTES / 3) * 4;

const PROTOCOL = "vibepub.wechat.v3";
const OPS = new Set<Operation>(["resolve_account", "upload_image", "write_draft", "get_draft", "find_draft"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const WECHAT_RETRY_STATUS = new Set([408, 429, 502, 503, 504]);
const TOKEN_INTENT_STALE_MS = 30_000;
function isReadOperation(operation: Operation): boolean {
  return operation === "get_draft" || operation === "find_draft";
}

export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly deliveryStatus?: "not_forwarded" | "rejected_before_commit" | "unknown",
  ) { super(code); }
}

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }

function deploymentVersion(env: Pick<Env, "DEPLOY_COMMIT" | "DEPLOY_REF" | "DEPLOYED_AT">) {
  const value = (input: string | undefined) => input?.trim() || null;
  return { commit: value(env.DEPLOY_COMMIT), ref: value(env.DEPLOY_REF), deployed_at: value(env.DEPLOYED_AT) };
}
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(result)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function opaque(value: unknown, _field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new AdapterError("invalid_request", 400);
  return value;
}
function digestValue(value: unknown, _field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new AdapterError("invalid_request", 400);
  return value;
}
function attempt(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3) throw new AdapterError("invalid_attempt", 400);
  return Number(value);
}
function auth(request: Request, env: Env): boolean {
  const token = env.WECHAT_PUBLISHING_TOKEN?.trim();
  return Boolean(token && request.headers.get("authorization") === `Bearer ${token}`);
}
function errorResponse(error: unknown): Response {
  const value = error instanceof AdapterError ? error : new AdapterError("external_side_effect_unknown", 503, false, "unknown");
  return json({ error: { code: value.code, retryable: value.retryable, ...(value.deliveryStatus ? { delivery_status: value.deliveryStatus } : {}) } }, value.status);
}

function logWechatProviderFailure(input: {
  kind: "transport" | "invalid_json" | "http_error" | "api_error";
  operation: Operation;
  path: string;
  response_status?: number;
  provider_errcode?: number;
  delivery_status?: "not_forwarded" | "rejected_before_commit";
}): void {
  // Keep provider diagnostics useful without logging credentials, URLs with
  // access tokens, request bodies, article content, or provider messages.
  console.warn("wechat_provider_failure", canonical(input));
}
function operationKey(operationId: string, attemptNumber: number, suffix: "result" | "upload-cache"): string {
  return `wechat-adapter/v1/${suffix}/${operationId}/${attemptNumber}.json`;
}
function tokenResultKey(bindingId: string, configHash: string, operationScopeHash: string, generation: number, attemptNumber: number): string {
  return `wechat-adapter/v1/token-result/${bindingId}/${configHash.slice(7)}/${operationScopeHash.slice(7)}/${generation}/${attemptNumber}.json`;
}
function legacyTokenResultKey(bindingId: string, configHash: string, generation: number, attemptNumber: number): string {
  return `wechat-adapter/v1/token-result/${bindingId}/${configHash.slice(7)}/${generation}/${attemptNumber}.json`;
}
function uploadCacheKey(bindingId: string, kind: "thumb" | "body", byteHash: string): string {
  return `wechat-adapter/v1/upload-cache/${bindingId}/${kind}/${byteHash.slice(7)}.json`;
}
function parseBody(value: unknown): ParsedInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterError("invalid_request", 400);
  const record = value as Record<string, unknown>;
  if (record.protocol_version !== PROTOCOL || !OPS.has(record.operation as Operation)) throw new AdapterError("protocol_invalid", 400);
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : {};
  const operation = record.operation as Operation;
  const base: ParsedInput = {
    operation,
    operation_id: opaque(record.operation_id, "operation_id"),
    attempt: attempt(record.attempt),
    user_id: opaque(record.user_id, "user_id"),
    workspace_id: opaque(record.workspace_id, "workspace_id"),
    article_id: opaque(record.article_id, "article_id"),
    reconcile_only: record.reconcile_only === true,
    payload,
  };
  if (operation !== "resolve_account") {
    base.account_binding_id = opaque(record.account_binding_id, "account_binding_id");
    base.account_receipt_hash = digestValue(record.account_receipt_hash, "account_receipt_hash");
  }
  return base;
}

export async function deriveWechatAccountBindingId(userId: string, workspaceId: string, appId: string): Promise<string> {
  return `wab_${(await digest(`wechat-account-binding:v1\n${canonical({ user_id: userId, workspace_id: workspaceId, type: "wechat", app_id: appId })}`)).slice(7)}`;
}
function accountAllowed(env: Env, bindingId: string): boolean {
  if (env.V3_TENANT_SCOPE?.trim().toLowerCase() === "all") return true;
  return (env.WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST || "").split(",").map(value => value.trim()).filter(Boolean).includes(bindingId);
}
function tenantAllowed(env: Env, userId: string, workspaceId: string): boolean {
  if (env.WECHAT_DRAFT_SYNC_V3 !== "true") return false;
  const scope = env.V3_TENANT_SCOPE?.trim().toLowerCase() || "allowlist";
  if (scope === "all") return true;
  if (scope !== "allowlist") return false;
  return (env.WECHAT_DRAFT_SYNC_V3_ALLOWLIST || "").split(",").map(value => value.trim()).filter(Boolean).includes(`${userId}:${workspaceId}`);
}
function isPrivateLikeProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // Do this before allowlist matching. DNS trailing-root aliases must not let
  // localhost/private hostnames through a deployment-owned exact allowlist.
  if (host.endsWith(".")) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata" || host.endsWith(".internal")) return true;
  if (/^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host === "::1" || host === "[::1]" || host === "0:0:0:0:0:0:0:1" ||
    /^\d+(?:\.\d+){3}$/.test(host) || host.startsWith("[") || host.includes(":") || /^\d+$/.test(host);
}
function normalizedProviderBase(value: string): URL {
  if (!value) throw new AdapterError("wechat_publishing_account_unavailable", 409);
  let url: URL;
  try { url = new URL(value); } catch { throw new AdapterError("wechat_publishing_account_unavailable", 409); }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || !url.hostname ||
      isPrivateLikeProviderHost(url.hostname) || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith("/") || /%2f|%5c/i.test(url.pathname)) {
    throw new AdapterError("wechat_publishing_account_unavailable", 409);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}
function safeProviderBase(env: Env, value: string | null): URL {
  if (!value) throw new AdapterError("wechat_publishing_account_unavailable", 409);
  const candidate = normalizedProviderBase(value);
  const allowed = (env.WECHAT_PROVIDER_BASE_URL_ALLOWLIST || "").split(",").map(value => value.trim()).filter(Boolean)
    .map(value => {
      try { return normalizedProviderBase(value).toString(); }
      catch { return null; }
    }).filter((value): value is string => value !== null);
  if (allowed.length === 0 || !allowed.includes(candidate.toString())) {
    throw new AdapterError("wechat_publishing_account_unavailable", 409);
  }
  return candidate;
}
function assertTenantGate(env: Env, userId: string, workspaceId: string): void {
  if (!tenantAllowed(env, userId, workspaceId)) throw new AdapterError("wechat_publishing_account_not_allowed", 409);
}
function wechatUrl(base: URL, path: string, query: Record<string, string> = {}): URL {
  const url = new URL(base.toString());
  url.pathname = `${base.pathname === "/" ? "" : base.pathname}${path}`;
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}
function canonicalWechatHtml(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
function bodyUrls(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
}
function mediaHostAllowed(env: Env, value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || !url.hostname ||
      url.username || url.password || url.hash || isPrivateLikeProviderHost(url.hostname)) return false;
  const allowed = (env.WECHAT_MEDIA_URL_HOST_ALLOWLIST || "").split(",")
    .map(item => item.trim().toLowerCase()).filter(Boolean);
  return allowed.length > 0 && allowed.includes(url.hostname.toLowerCase());
}
function normalizeProviderMediaUrl(env: Env, value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol === "http:") {
    if (url.port && url.port !== "80") return null;
    url.protocol = "https:";
    url.port = "";
  }
  const normalized = url.toString();
  return mediaHostAllowed(env, normalized) ? normalized : null;
}
function decodeBase64(value: string): Uint8Array {
  try {
    if (value.length === 0 || value.length > MAX_UPLOAD_IMAGE_BASE64_CHARS) throw new AdapterError("invalid_request", 400);
    const constructor = Uint8Array as typeof Uint8Array & { fromBase64?: (encoded: string) => Uint8Array };
    const bytes = typeof constructor.fromBase64 === "function"
      ? constructor.fromBase64(value)
      : Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if (bytes.byteLength > MAX_UPLOAD_IMAGE_BYTES) throw new AdapterError("invalid_request", 400);
    return bytes;
  }
  catch { throw new AdapterError("invalid_request", 400); }
}
function assertOperationPayload(input: ParsedInput): void {
  const payload = input.payload;
  if (input.operation === "upload_image") {
    if (payload.operation_id !== input.operation_id || typeof payload.image_base64 !== "string" || payload.image_base64.length === 0 || payload.image_base64.length > MAX_UPLOAD_IMAGE_BASE64_CHARS ||
        !Number.isSafeInteger(payload.byte_length) || Number(payload.byte_length) < 1 || Number(payload.byte_length) > MAX_UPLOAD_IMAGE_BYTES || !HASH.test(String(payload.byte_hash || "")) ||
        payload.mime !== "image/png" || (payload.purpose !== "cover" && payload.purpose !== "body") || !ID.test(String(payload.slot_id || ""))) {
      throw new AdapterError("invalid_request", 400);
    }
  }
  if (input.operation === "write_draft") {
    if (payload.operation_id !== input.operation_id || !HASH.test(String(payload.draft_identity_hash || "")) ||
        typeof payload.title !== "string" || payload.title.length === 0 || payload.title.length > 256 ||
        typeof payload.canonical_html !== "string" || !HASH.test(String(payload.html_hash || "")) ||
        (payload.mutation !== "add" && payload.mutation !== "update") ||
        (payload.mutation === "update" && !ID.test(String(payload.media_id || ""))) || !ID.test(String(payload.thumb_media_id || ""))) {
      throw new AdapterError("invalid_request", 400);
    }
  }
  if (input.operation === "get_draft" && payload.media_id !== undefined && !ID.test(String(payload.media_id))) throw new AdapterError("invalid_request", 400);
  if (input.operation === "find_draft" && (!HASH.test(String(payload.draft_identity_hash || "")) || typeof payload.title !== "string" || typeof payload.canonical_html !== "string" || !ID.test(String(payload.thumb_media_id || "")))) throw new AdapterError("invalid_request", 400);
}

async function decrypt(env: Env, ciphertext: string): Promise<string> {
  if (ciphertext.startsWith("plain:")) return ciphertext.slice(6);
  const [version, ivEncoded, bodyEncoded] = ciphertext.split(":");
  if (version !== "v1" || !ivEncoded || !bodyEncoded || !env.CREDENTIAL_ENCRYPTION_KEY?.trim()) throw new AdapterError("wechat_publishing_account_unavailable", 409);
  const fromBase64 = (value: string): Uint8Array => {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const constructor = Uint8Array as typeof Uint8Array & { fromBase64?: (encoded: string) => Uint8Array };
    if (typeof constructor.fromBase64 === "function") return constructor.fromBase64(normalized);
    const binary = atob(normalized); return Uint8Array.from(binary, char => char.charCodeAt(0));
  };
  const secretHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CREDENTIAL_ENCRYPTION_KEY.trim()));
  const key = await crypto.subtle.importKey("raw", secretHash, { name: "AES-GCM" }, false, ["decrypt"]);
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ivEncoded) }, key, fromBase64(bodyEncoded))); }
  catch { throw new AdapterError("wechat_publishing_account_unavailable", 409); }
}

function publishingAccountResolver(env: Env): { url: URL; token: string } | null {
  const rawUrl = env.PUBLISHING_ACCOUNT_RESOLVER_URL?.trim() || "";
  const token = env.PUBLISHING_ACCOUNT_RESOLVER_TOKEN?.trim() || "";
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) throw new AdapterError("wechat_publishing_account_unavailable", 409);
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AdapterError("wechat_publishing_account_unavailable", 409); }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || !url.hostname ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" || isPrivateLikeProviderHost(url.hostname)) {
    throw new AdapterError("wechat_publishing_account_unavailable", 409);
  }
  url.pathname = "/api/internal/publishing-account";
  return { url, token };
}

async function resolveAccountMaterial(env: Env, userId: string): Promise<AccountMaterial> {
  const resolver = publishingAccountResolver(env);
  if (resolver) {
    let response: Response;
    try {
      response = await fetch(resolver.url, {
        method: "POST",
        headers: { authorization: `Bearer ${resolver.token}`, "content-type": "application/json" },
        body: canonical({ user_id: userId }),
      });
    } catch {
      throw new AdapterError("wechat_publishing_account_unavailable", 503, true, "not_forwarded");
    }
    if (!response.ok) {
      if (WECHAT_RETRY_STATUS.has(response.status)) throw new AdapterError("wechat_publishing_account_unavailable", response.status, true, "not_forwarded");
      throw new AdapterError("wechat_publishing_account_unavailable", 409);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new AdapterError("wechat_publishing_account_unavailable", 502, true, "not_forwarded"); }
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const value = record.publishing_account && typeof record.publishing_account === "object" && !Array.isArray(record.publishing_account)
      ? record.publishing_account as Record<string, unknown>
      : {};
    if (typeof value.app_id !== "string" || !value.app_id || typeof value.app_secret !== "string" || !value.app_secret ||
        (value.proxy_url !== null && typeof value.proxy_url !== "string") || typeof value.updated_at !== "string" || !value.updated_at) {
      throw new AdapterError("wechat_publishing_account_unavailable", 502, true, "not_forwarded");
    }
    return { user_id: userId, app_id: value.app_id, app_secret: value.app_secret, proxy_url: value.proxy_url, updated_at: value.updated_at };
  }

  const account = await env.DB.prepare(`SELECT user_id, app_id, app_secret_ciphertext, proxy_url, updated_at FROM publishing_accounts WHERE user_id = ? AND type = 'wechat' LIMIT 1`)
    .bind(userId).first<Account>();
  if (!account || !account.app_id || !account.app_secret_ciphertext) throw new AdapterError("wechat_publishing_account_unavailable", 409);
  const appSecret = await decrypt(env, account.app_secret_ciphertext);
  if (!appSecret) throw new AdapterError("wechat_publishing_account_unavailable", 409);
  return { user_id: account.user_id, app_id: account.app_id, app_secret: appSecret, proxy_url: account.proxy_url, updated_at: account.updated_at };
}

async function loadAccount(env: Env, userId: string, workspaceId: string, articleId: string): Promise<ResolvedAccount> {
  const account = await resolveAccountMaterial(env, userId);
  const providerBase = safeProviderBase(env, account.proxy_url);
  const bindingId = await deriveWechatAccountBindingId(userId, workspaceId, account.app_id);
  if (!accountAllowed(env, bindingId)) throw new AdapterError("wechat_publishing_account_not_allowed", 409);
  const [configHash, operationScopeHash] = await Promise.all([
    digest(canonical({ app_id: account.app_id, provider_base_url: providerBase.toString(), updated_at: account.updated_at })),
    digest(canonical({ user_id: userId, workspace_id: workspaceId, account_binding_id: bindingId, article_id: articleId })),
  ]);
  const receiptHash = await digest(canonical({ version: "wechat-account-resolution.v1", user_id: userId, workspace_id: workspaceId, article_id: articleId, account_binding_id: bindingId, config_hash: configHash }));
  return { account, binding_id: bindingId, operation_scope_hash: operationScopeHash, config_hash: configHash, receipt_hash: receiptHash, provider_base: providerBase, app_secret: account.app_secret };
}

function deliveryStatus(response: Response): "not_forwarded" | "rejected_before_commit" | null {
  const proof = response.headers.get("x-vibepub-delivery-status");
  return proof === "not_forwarded" || proof === "rejected_before_commit" ? proof : null;
}
function classifyWechatErrcode(errcode: number, operation: Operation): AdapterError {
  if ([40013, 40164, 48001].includes(errcode)) return new AdapterError("wechat_publishing_account_rejected", 409);
  if ([40006, 40007, 41005, 45001].includes(errcode)) {
    if (operation === "upload_image") return new AdapterError("wechat_image_upload_non_retryable", 422);
    if (operation === "find_draft") return new AdapterError("draft_identity_unresolved", 409);
    if (operation === "get_draft") return new AdapterError("draft_readback_unavailable", 409);
    return new AdapterError("wechat_draft_write_non_retryable", 422);
  }
  return new AdapterError("external_side_effect_unknown", 503, false, "unknown");
}

export class WechatOperationAgent {
  constructor(readonly state: DurableObjectState, readonly env: Env) {}

  private async row(operationId: string, attemptNumber: number): Promise<Intent | null> {
    return (await this.state.storage.get<Intent>(`wechat-claim:${operationId}:${attemptNumber}`)) || null;
  }

  private async readJsonResult(key: string): Promise<StoredResult | null> {
    let object: R2ObjectBody | null;
    let head: R2Object | null;
    try { [object, head] = await Promise.all([this.env.WECHAT_RESULTS_BUCKET.get(key), this.env.WECHAT_RESULTS_BUCKET.head(key)]); }
    catch { throw new AdapterError("external_side_effect_unknown", 503, false, "unknown"); }
    if (!object && !head) return null;
    if (!object || !head) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    let raw: string;
    try { raw = await object.text(); } catch { throw new AdapterError("external_side_effect_unknown", 503, false, "unknown"); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new AdapterError("external_side_effect_unknown", 503, false, "unknown"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    const rawHash = await digest(raw);
    if (head.customMetadata?.result_hash !== rawHash || head.size !== new TextEncoder().encode(raw).byteLength) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    return parsed as StoredResult;
  }

  private async readResult(operationId: string, attemptNumber: number): Promise<StoredResult | null> {
    const result = await this.readJsonResult(operationKey(operationId, attemptNumber, "result"));
    if (!result) return null;
    if (result.operation_id !== operationId || result.attempt !== attemptNumber) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    return result;
  }

  private async writeResult(result: StoredResult): Promise<{ ref: string; hash: string }> {
    const ref = operationKey(result.operation_id, result.attempt, "result");
    const raw = canonical(result); const resultHash = await digest(raw);
    const existing = await this.readResult(result.operation_id, result.attempt);
    if (existing) {
      if (canonical(existing) !== raw) throw new AdapterError("operation_conflict", 409);
      return { ref, hash: resultHash };
    }
    try {
      await this.env.WECHAT_RESULTS_BUCKET.put(ref, raw, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" }, customMetadata: { result_hash: resultHash } });
    } catch {
      const raced = await this.readResult(result.operation_id, result.attempt);
      if (raced && canonical(raced) === raw) return { ref, hash: resultHash };
      throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
    const readback = await this.readResult(result.operation_id, result.attempt);
    if (!readback || canonical(readback) !== raw) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    return { ref, hash: resultHash };
  }

  private async response(result: StoredResult, account: ResolvedAccount): Promise<Response> {
    if (result.status === "success") return json({
      protocol_version: PROTOCOL, operation: result.operation, operation_id: result.operation_id, attempt: result.attempt,
      account_binding_id: account.binding_id, account_receipt_hash: account.receipt_hash,
      // This is an opaque adapter-private evidence handle. The main worker
      // validates it before it writes a private receipt, but never mirrors it
      // into Coordinator or D1 metadata.
      result_ref: operationKey(result.operation_id, result.attempt, "result"),
      result_hash: await digest(canonical(result)),
      result: result.result || {},
    });
    return json({
      error: {
        code: result.code || "wechat_operation_failed",
        retryable: result.retryable,
        ...(result.retryable && result.delivery_status ? { delivery_status: result.delivery_status } : {}),
      },
    }, result.status_code);
  }

  private async token(account: ResolvedAccount, forceRefresh = false): Promise<string> {
    const cacheKey = `wechat-token:${account.binding_id}`;
    const cached = await this.state.storage.get<CachedToken>(cacheKey);
    if (!forceRefresh && cached && cached.config_hash === account.config_hash && cached.expires_at > Date.now() + 60_000) return cached.access_token;
    const generationKey = `wechat-token-generation:${account.binding_id}:${account.config_hash}`;
    const currentGeneration = Number(await this.state.storage.get<number>(generationKey) || 1);
    const generation = forceRefresh ? currentGeneration + 1 : currentGeneration;
    if (forceRefresh) await this.state.storage.put(generationKey, generation);
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const intentKey = `wechat-token-intent:${account.binding_id}:${account.config_hash}:${generation}:${attemptNumber}`;
      const resultRef = tokenResultKey(account.binding_id, account.config_hash, account.operation_scope_hash, generation, attemptNumber);
      const existing = await this.state.storage.get<TokenIntent>(intentKey);
      if (existing) {
        const legacyResultRef = legacyTokenResultKey(account.binding_id, account.config_hash, generation, attemptNumber);
        if (existing.result_ref && existing.result_ref !== resultRef && existing.result_ref !== legacyResultRef) {
          throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
        }
        let resolvedResultRef = existing.result_ref || resultRef;
        let result = await this.readTokenAttemptResult(resolvedResultRef, account.config_hash);
        if (!result && !existing.result_ref) {
          resolvedResultRef = legacyResultRef;
          result = await this.readTokenAttemptResult(resolvedResultRef, account.config_hash);
        }
        if (!result) {
          const createdAt = Number(existing.created_at_ms);
          const stillRunning = existing.state === "intent" && Number.isFinite(createdAt) &&
            Date.now() - createdAt < TOKEN_INTENT_STALE_MS;
          if (existing.state !== "intent" || stillRunning) {
            throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
          }
          // Access-token acquisition is read-only. Once its concurrency guard
          // is stale, record a bounded failed attempt under the article scope
          // and continue instead of preserving an unrecoverable legacy hold.
          const abandoned: TokenAttemptResult = {
            status: "failed",
            retryable: true,
            status_code: 503,
            code: "upstream_retryable",
          };
          const abandonedHash = await this.writeTokenAttemptResult(resultRef, abandoned, account.config_hash);
          await this.state.storage.put(intentKey, {
            ...existing,
            state: "failed",
            result_ref: resultRef,
            result_hash: abandonedHash,
            retryable: true,
          } satisfies TokenIntent);
          continue;
        }
        const resultHash = await digest(canonical(result));
        if (existing.result_hash && existing.result_hash !== resultHash) {
          throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
        }
        if (existing.result_ref !== resolvedResultRef || existing.result_hash !== resultHash) {
          await this.state.storage.put(intentKey, { ...existing, result_ref: resolvedResultRef, result_hash: resultHash });
        }
        if (result.status === "success" && result.token) {
          await this.state.storage.put(cacheKey, result.token);
          return result.token.access_token;
        }
        if (!result.retryable || attemptNumber === 3) {
          throw new AdapterError(result.retryable ? "wechat_operation_retry_exhausted" : (result.code || "wechat_access_token_rejected"), result.status_code, false);
        }
        continue;
      }
      await this.state.storage.put(intentKey, { state: "intent", created_at_ms: Date.now() } satisfies TokenIntent);
      let result: TokenAttemptResult;
      try {
        const response = await fetch(wechatUrl(account.provider_base, "/cgi-bin/token", {
          grant_type: "client_credential", appid: account.account.app_id, secret: account.app_secret,
        }), { method: "GET", redirect: "manual" });
        let body: Record<string, unknown>;
        try { body = await response.json() as Record<string, unknown>; }
        catch { throw new AdapterError("upstream_retryable", 503, true); }
        if (!response.ok) {
          if (WECHAT_RETRY_STATUS.has(response.status)) throw new AdapterError("upstream_retryable", response.status, true);
          throw new AdapterError("upstream_retryable", 503, true);
        }
        if (Number(body.errcode || 0) !== 0 || typeof body.access_token !== "string" || !Number.isFinite(Number(body.expires_in))) {
        // A token endpoint rejection proves that these credentials cannot be
        // used. It is not a draft-read error and must surface as account repair.
        if (typeof body.errcode === "number") throw new AdapterError("wechat_access_token_rejected", 409);
          throw new AdapterError("upstream_retryable", 503, true);
        }
        const token: CachedToken = {
          access_token: body.access_token,
          expires_at: Date.now() + Math.max(60, Number(body.expires_in) - 60) * 1_000,
          config_hash: account.config_hash,
        };
        result = { status: "success", retryable: false, status_code: 200, token };
      } catch (error) {
        // Token acquisition is a read-only operation. Explicit transport and
        // controlled HTTP failures are recorded as retryable attempts; a raw
        // fetch exception itself has no mutation to reconcile.
        const adapterError = error instanceof AdapterError ? error : new AdapterError("upstream_retryable", 503, true);
        result = {
          status: "failed",
          retryable: adapterError.retryable,
          status_code: adapterError.status,
          code: adapterError.code,
        };
      }
      const evidence = await this.writeTokenAttemptResult(resultRef, result, account.config_hash);
      await this.state.storage.put(intentKey, {
        state: result.status === "success" ? "completed" : "failed",
        result_ref: resultRef,
        result_hash: evidence,
        retryable: result.retryable,
      } satisfies TokenIntent);
      if (result.status === "success" && result.token) {
        await this.state.storage.put(cacheKey, result.token);
        return result.token.access_token;
      }
      if (!result.retryable || attemptNumber === 3) {
        throw new AdapterError(result.retryable ? "wechat_operation_retry_exhausted" : (result.code || "wechat_access_token_rejected"), result.status_code, false);
      }
    }
    throw new AdapterError("wechat_operation_retry_exhausted", 503, false);
  }

  private async readTokenAttemptResult(ref: string, configHash: string): Promise<TokenAttemptResult | null> {
    let object: R2ObjectBody | null;
    let head: R2Object | null;
    try { [object, head] = await Promise.all([this.env.WECHAT_RESULTS_BUCKET.get(ref), this.env.WECHAT_RESULTS_BUCKET.head(ref)]); }
    catch { throw new AdapterError("external_side_effect_unknown", 503, false, "unknown"); }
    if (!object && !head) return null;
    if (!object || !head) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    try {
      const raw = await object.text(); const parsed = JSON.parse(raw) as TokenAttemptResult;
      if ((parsed.status !== "success" && parsed.status !== "failed") || typeof parsed.retryable !== "boolean" ||
          !Number.isInteger(parsed.status_code) || head.customMetadata?.result_hash !== await digest(raw) ||
          head.size !== new TextEncoder().encode(raw).byteLength ||
          (parsed.status === "success" && (!parsed.token || typeof parsed.token.access_token !== "string" ||
            !Number.isFinite(parsed.token.expires_at) || parsed.token.config_hash !== configHash))) throw new Error("invalid");
      return parsed;
    } catch { throw new AdapterError("external_side_effect_unknown", 503, false, "unknown"); }
  }

  private async writeTokenAttemptResult(ref: string, result: TokenAttemptResult, configHash: string): Promise<string> {
    const raw = canonical(result);
    const resultHash = await digest(raw);
    const existing = await this.readTokenAttemptResult(ref, configHash);
    if (existing) {
      if (canonical(existing) !== raw) throw new AdapterError("operation_conflict", 409);
      return resultHash;
    }
    try {
      await this.env.WECHAT_RESULTS_BUCKET.put(ref, raw, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: { result_hash: resultHash },
      });
    } catch {
      const raced = await this.readTokenAttemptResult(ref, configHash);
      if (raced && canonical(raced) === raw) return resultHash;
      throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
    const readback = await this.readTokenAttemptResult(ref, configHash);
    if (!readback || canonical(readback) !== raw) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    return resultHash;
  }

  private async wechatRequest(
    account: ResolvedAccount,
    path: string,
    init: RequestInit,
    operation: Operation,
    refresh = true,
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const accessToken = await this.token(account);
    let response: Response;
    try {
      response = await fetch(wechatUrl(account.provider_base, path, { access_token: accessToken, ...query }), { ...init, redirect: "manual" });
    } catch {
      logWechatProviderFailure({ kind: "transport", operation, path });
      if (isReadOperation(operation)) throw new AdapterError("upstream_retryable", 503, true);
      throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; }
    catch {
      logWechatProviderFailure({ kind: "invalid_json", operation, path, response_status: response.status });
      throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
    if (!response.ok) {
      const proof = deliveryStatus(response);
      logWechatProviderFailure({
        kind: "http_error",
        operation,
        path,
        response_status: response.status,
        ...(proof ? { delivery_status: proof } : {}),
      });
      if (WECHAT_RETRY_STATUS.has(response.status) && (isReadOperation(operation) || proof)) {
        throw new AdapterError("upstream_retryable", response.status, true, proof || undefined);
      }
      throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
    const errcode = Number(body.errcode || 0);
    if (errcode === 0) return body;
    if ((errcode === 40014 || errcode === 42001) && refresh) {
      await this.token(account, true);
      return this.wechatRequest(account, path, init, operation, false, query);
    }
    if (errcode === 40014 || errcode === 42001) throw new AdapterError("wechat_access_token_rejected", 409);
    logWechatProviderFailure({ kind: "api_error", operation, path, response_status: response.status, provider_errcode: errcode });
    throw classifyWechatErrcode(errcode, operation);
  }

  private async cachedUpload(account: ResolvedAccount, kind: "thumb" | "body", byteHash: string): Promise<ProviderResult | null> {
    const result = await this.readJsonResult(uploadCacheKey(account.binding_id, kind, byteHash));
    if (!result || result.status !== "success" || !result.result) return null;
    if (!mediaHostAllowed(this.env, result.result.media_url) ||
        (kind === "thumb" && !ID.test(String(result.result.media_id || "")))) {
      throw new AdapterError("wechat_image_upload_non_retryable", 422);
    }
    return result.result;
  }

  private async storeUploadCache(account: ResolvedAccount, kind: "thumb" | "body", byteHash: string, result: ProviderResult): Promise<void> {
    const key = uploadCacheKey(account.binding_id, kind, byteHash);
    const cached: StoredResult = { operation_id: `upload-cache:${byteHash}`, operation: "upload_image", attempt: 1, request_hash: byteHash, status: "success", retryable: false, status_code: 200, result };
    const raw = canonical(cached); const resultHash = await digest(raw);
    try { await this.env.WECHAT_RESULTS_BUCKET.put(key, raw, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { result_hash: resultHash } }); }
    catch {
      const existing = await this.readJsonResult(key);
      if (!existing || canonical(existing.result) !== canonical(result)) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
  }

  private async executeProvider(input: ParsedInput, account: ResolvedAccount): Promise<ProviderResult> {
    if (input.operation === "upload_image") {
      const bytes = decodeBase64(String(input.payload.image_base64));
      if (bytes.byteLength !== Number(input.payload.byte_length) || await digest(bytes) !== input.payload.byte_hash) throw new AdapterError("invalid_request", 400);
      const kind = input.payload.purpose === "cover" ? "thumb" : "body";
      const cached = await this.cachedUpload(account, kind, String(input.payload.byte_hash));
      if (cached) return cached;
      const form = new FormData();
      form.set("media", new Blob([bytes], { type: "image/png" }), "image.png");
      const body = input.payload.purpose === "cover"
        ? await this.wechatRequest(account, "/cgi-bin/material/add_material", { method: "POST", body: form }, "upload_image", true, { type: "image" })
        : await this.wechatRequest(account, "/cgi-bin/media/uploadimg", { method: "POST", body: form }, "upload_image");
      const mediaUrl = normalizeProviderMediaUrl(this.env, body.url ?? body.media_url);
      const mediaId = body.media_id;
      if (!mediaUrl || (kind === "thumb" && !ID.test(String(mediaId || "")))) throw new AdapterError("wechat_image_upload_non_retryable", 422);
      const result: ProviderResult = { media_url: mediaUrl, ...(kind === "thumb" ? { media_id: String(mediaId) } : {}) };
      await this.storeUploadCache(account, kind, String(input.payload.byte_hash), result);
      return result;
    }
    if (input.operation === "write_draft") {
      const article = { title: input.payload.title, content: input.payload.canonical_html, thumb_media_id: input.payload.thumb_media_id, digest: "", content_source_url: "" };
      const body = input.payload.mutation === "add"
        ? await this.wechatRequest(account, "/cgi-bin/draft/add", { method: "POST", headers: { "content-type": "application/json" }, body: canonical({ articles: [article] }) }, "write_draft")
        : await this.wechatRequest(account, "/cgi-bin/draft/update", { method: "POST", headers: { "content-type": "application/json" }, body: canonical({ media_id: input.payload.media_id, index: 0, articles: article }) }, "write_draft");
      const mediaId = input.payload.mutation === "add" ? body.media_id : input.payload.media_id;
      if (!ID.test(String(mediaId || ""))) throw new AdapterError("wechat_draft_write_non_retryable", 422);
      // A write receipt establishes the stable account/article identity as
      // soon as WeChat returns a concrete media id. Later epochs still do a
      // read-only get before deciding update/noop, but must never add again.
      await this.state.storage.put(`wechat-draft-map:${String(input.payload.draft_identity_hash)}`, String(mediaId));
      return { media_id: String(mediaId), mutation: input.payload.mutation as "add" | "update" };
    }
    if (input.operation === "get_draft") {
      const mapKey = typeof input.payload.draft_identity_hash === "string" ? `wechat-draft-map:${input.payload.draft_identity_hash}` : null;
      const mapped = mapKey ? await this.state.storage.get<string>(mapKey) : null;
      const mediaId = input.payload.media_id || mapped;
      if (!ID.test(String(mediaId || ""))) return { not_found: true };
      const body = await this.wechatRequest(account, "/cgi-bin/draft/get", { method: "POST", headers: { "content-type": "application/json" }, body: canonical({ media_id: mediaId }) }, "get_draft");
      const result = await this.parseDraft(body, String(mediaId));
      if (mapKey && this.matchesFingerprint(result, input.payload)) await this.state.storage.put(mapKey, result.media_id);
      return result;
    }
    if (input.operation === "find_draft") {
      const candidates: ProviderResult[] = [];
      let skippedInvalidCandidates = 0;
      for (let page = 0; page < 3; page += 1) {
        const body = await this.wechatRequest(account, "/cgi-bin/draft/batchget", { method: "POST", headers: { "content-type": "application/json" }, body: canonical({ offset: page * 20, count: 20, no_content: 0 }) }, "find_draft");
        const items = Array.isArray(body.item) ? body.item : [];
        for (const item of items) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as Record<string, unknown>;
          let result: ProviderResult;
          try {
            result = await this.parseDraft({ news_item: record.content && typeof record.content === "object" ? (record.content as Record<string, unknown>).news_item : record.news_item }, String(record.media_id || ""));
          } catch (error) {
            if (!(error instanceof AdapterError) || error.code !== "external_side_effect_unknown") throw error;
            skippedInvalidCandidates += 1;
            continue;
          }
          if (this.matchesFingerprint(result, input.payload)) candidates.push(result);
        }
        if (items.length < 20) break;
      }
      if (skippedInvalidCandidates > 0) {
        console.warn("wechat_draft_candidates_skipped", canonical({ operation: "find_draft", count: skippedInvalidCandidates }));
      }
      if (candidates.length !== 1) throw new AdapterError("draft_identity_unresolved", 409);
      await this.state.storage.put(`wechat-draft-map:${String(input.payload.draft_identity_hash)}`, candidates[0].media_id!);
      return candidates[0];
    }
    throw new AdapterError("invalid_request", 400);
  }

  private async parseDraft(body: Record<string, unknown>, mediaId: string): Promise<ProviderResult> {
    const articles = Array.isArray(body.news_item) ? body.news_item : [];
    const first = articles[0];
    if (!ID.test(mediaId) || !first || typeof first !== "object" || Array.isArray(first)) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    const article = first as Record<string, unknown>;
    if (typeof article.title !== "string" || typeof article.content !== "string" || !ID.test(String(article.thumb_media_id || ""))) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    const canonicalHtml = canonicalWechatHtml(article.content);
    const urls = bodyUrls(canonicalHtml);
    if (urls.some(url => !mediaHostAllowed(this.env, url))) throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    return { media_id: mediaId, title: article.title, canonical_html: canonicalHtml, html_hash: await digest(canonicalHtml), body_urls: urls, thumb_media_id: String(article.thumb_media_id), article_index: 0 };
  }

  private matchesFingerprint(result: ProviderResult, fingerprint: Record<string, unknown>): boolean {
    return result.title === fingerprint.title && result.canonical_html === canonicalWechatHtml(String(fingerprint.canonical_html || "")) &&
      result.html_hash === fingerprint.html_hash && result.thumb_media_id === fingerprint.thumb_media_id;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: { code: "not_found" } }, 404);
    let input: ParsedInput;
    try { input = parseBody(await request.json()); } catch (error) { return errorResponse(error); }
    try { return input.operation === "resolve_account" ? await this.resolve(input) : await this.execute(input); }
    catch (error) { return errorResponse(error); }
  }

  private async resolve(input: ParsedInput): Promise<Response> {
    assertTenantGate(this.env, input.user_id, input.workspace_id);
    const account = await loadAccount(this.env, input.user_id, input.workspace_id, input.article_id);
    return json({ protocol_version: PROTOCOL, operation: "resolve_account", operation_id: input.operation_id, attempt: input.attempt, result: {
      account_binding_id: account.binding_id, config_hash: account.config_hash, receipt_hash: account.receipt_hash, version: "wechat-account-resolution.v1",
    } });
  }

  private async execute(input: ParsedInput): Promise<Response> {
    assertTenantGate(this.env, input.user_id, input.workspace_id);
    assertOperationPayload(input);
    // Account resolution and receipt verification intentionally happen before
    // intent/R2/provider access. A stale receipt can never claim an operation.
    const account = await loadAccount(this.env, input.user_id, input.workspace_id, input.article_id);
    if (input.account_binding_id !== account.binding_id) throw new AdapterError("wechat_publishing_account_not_allowed", 409);
    if (input.account_receipt_hash !== account.receipt_hash) throw new AdapterError("wechat_account_receipt_invalid", 409);
    const requestHash = await digest(canonical({ operation: input.operation, operation_id: input.operation_id, attempt: input.attempt, user_id: input.user_id, workspace_id: input.workspace_id, article_id: input.article_id, account_binding_id: input.account_binding_id, account_receipt_hash: input.account_receipt_hash, payload: input.payload }));
    const existing = await this.row(input.operation_id, input.attempt);
    if (existing) {
      if (existing.request_hash !== requestHash || existing.operation !== input.operation) throw new AdapterError("operation_conflict", 409);
      const result = await this.readResult(input.operation_id, input.attempt);
      if (result) return await this.response(result, account);
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
    if (input.reconcile_only) return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    for (let number = 1; number < input.attempt; number += 1) {
      const previous = await this.row(input.operation_id, number);
      const result = previous ? await this.readResult(input.operation_id, number) : null;
      if (!previous || !result || (result.status === "failed" && !result.retryable)) return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
      if (result.status === "success") return await this.response(result, account);
    }
    await this.state.storage.put(`wechat-claim:${input.operation_id}:${input.attempt}`, { operation_id: input.operation_id, operation: input.operation, attempt: input.attempt, request_hash: requestHash, state: "intent" } satisfies Intent);
    let result: StoredResult;
    try {
      result = { operation_id: input.operation_id, operation: input.operation, attempt: input.attempt, request_hash: requestHash, status: "success", retryable: false, status_code: 200, result: await this.executeProvider(input, account) };
    } catch (error) {
      if (error instanceof AdapterError && error.code === "external_side_effect_unknown") throw error;
      if (error instanceof AdapterError) result = {
        operation_id: input.operation_id,
        operation: input.operation,
        attempt: input.attempt,
        request_hash: requestHash,
        status: "failed",
        retryable: error.retryable,
        status_code: error.status,
        code: error.code,
        ...(error.deliveryStatus === "not_forwarded" || error.deliveryStatus === "rejected_before_commit"
          ? { delivery_status: error.deliveryStatus }
          : {}),
      };
      else throw new AdapterError("external_side_effect_unknown", 503, false, "unknown");
    }
    const evidence = await this.writeResult(result);
    await this.state.storage.put(`wechat-claim:${input.operation_id}:${input.attempt}`, { operation_id: input.operation_id, operation: input.operation, attempt: input.attempt, request_hash: requestHash, state: result.status === "success" ? "completed" : "failed", result_ref: evidence.ref, result_hash: evidence.hash, retryable: result.retryable } satisfies Intent);
    return await this.response(result, account);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return json({ ok: true, service: "wechat-publishing-adapter", version: deploymentVersion(env) });
    }
    // Auth is deliberately checked before parsing a client-controlled body.
    if (!auth(request, env)) return json({ error: { code: "unauthorized" } }, 401);
    let raw: Record<string, unknown>;
    try { raw = await request.clone().json() as Record<string, unknown>; } catch { return json({ error: { code: "invalid_json" } }, 400); }
    try {
      const input = parseBody(raw);
      assertTenantGate(env, input.user_id, input.workspace_id);
      // This gate deliberately runs before Durable Object selection. The DO
      // namespace is per verified account identity, never per caller-supplied
      // binding. The agent repeats the check before every intent as a second
      // boundary for direct stub calls and future routing changes.
      const account = await loadAccount(env, input.user_id, input.workspace_id, input.article_id);
      if (input.operation !== "resolve_account") {
        if (input.account_binding_id !== account.binding_id) throw new AdapterError("wechat_publishing_account_not_allowed", 409);
        if (input.account_receipt_hash !== account.receipt_hash) throw new AdapterError("wechat_account_receipt_invalid", 409);
      }
      const reconcileOnly = request.url.endsWith("/reconcile");
      return env.WECHAT_OPERATION.getByName(account.operation_scope_hash).fetch(new Request(request, { body: canonical({ ...raw, reconcile_only: reconcileOnly || input.reconcile_only }) }));
    } catch (error) { return errorResponse(error); }
  },
};
