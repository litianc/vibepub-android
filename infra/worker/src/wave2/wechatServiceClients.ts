import { canonicalJson, sha256 } from "./artifactContracts";
import { v3AllTenantsEnabled, v3TenantAllowed } from "../publicationProjection";

export type WechatAdapterOperation = "resolve_account" | "upload_image" | "write_draft" | "get_draft" | "find_draft";

export class WechatPublishingServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) { super(code); }
}

export type WechatPublishingServiceEnv = {
  WECHAT_PUBLISHING_ADAPTER?: Fetcher;
  WECHAT_PUBLISHING_TOKEN?: string;
  WECHAT_MEDIA_URL_HOST_ALLOWLIST?: string;
};

type WechatDraftFeatureEnv = {
  V3_TENANT_SCOPE?: string;
  WECHAT_DRAFT_SYNC_V3?: string;
  WECHAT_DRAFT_SYNC_V3_ALLOWLIST?: string;
  DEPLOY_ENVIRONMENT?: string;
  STAGING_FEEDBACK_CANARY_MODE?: string;
  STAGING_FEEDBACK_CANARY_USER_ID?: string;
  STAGING_FEEDBACK_CANARY_WORKSPACE_ID?: string;
  STAGING_FEEDBACK_CANARY_ARTICLE_ID?: string;
  STAGING_FEEDBACK_CANARY_RUN_ID?: string;
  STAGING_FEEDBACK_CANARY_EXPIRES_AT?: string;
};

const STAGING_FEEDBACK_CANARY_MODE = "staging_article_feedback";
const STAGING_FEEDBACK_CANARY_MAX_TTL_MS = 60 * 60 * 1000;

function optionalStagingFeedbackConstraintAllows(env: WechatDraftFeatureEnv, userId: string, workspaceId: string, articleId?: string, runId?: string): boolean {
  const configured = [
    env.STAGING_FEEDBACK_CANARY_MODE,
    env.STAGING_FEEDBACK_CANARY_USER_ID,
    env.STAGING_FEEDBACK_CANARY_WORKSPACE_ID,
    env.STAGING_FEEDBACK_CANARY_ARTICLE_ID,
    env.STAGING_FEEDBACK_CANARY_RUN_ID,
    env.STAGING_FEEDBACK_CANARY_EXPIRES_AT,
  ].some(value => Boolean(value?.trim()));
  if (!configured) return true;
  const expiresAt = env.STAGING_FEEDBACK_CANARY_EXPIRES_AT?.trim() || "";
  const expiresAtMs = Date.parse(expiresAt);
  const now = Date.now();
  return env.DEPLOY_ENVIRONMENT?.trim() === "staging" &&
    env.STAGING_FEEDBACK_CANARY_MODE?.trim() === STAGING_FEEDBACK_CANARY_MODE &&
    env.STAGING_FEEDBACK_CANARY_USER_ID?.trim() === userId &&
    env.STAGING_FEEDBACK_CANARY_WORKSPACE_ID?.trim() === workspaceId &&
    env.STAGING_FEEDBACK_CANARY_ARTICLE_ID?.trim() === articleId &&
    env.STAGING_FEEDBACK_CANARY_RUN_ID?.trim() === runId &&
    Number.isFinite(expiresAtMs) && new Date(expiresAtMs).toISOString() === expiresAt &&
    expiresAtMs > now && expiresAtMs <= now + STAGING_FEEDBACK_CANARY_MAX_TTL_MS;
}

export function wechatDraftFeatureEnabled(env: WechatDraftFeatureEnv, userId: string, workspaceId: string, articleId?: string, runId?: string): boolean {
  if (env.WECHAT_DRAFT_SYNC_V3 !== "true") return false;
  return v3TenantAllowed(env, env.WECHAT_DRAFT_SYNC_V3_ALLOWLIST, userId, workspaceId) &&
    optionalStagingFeedbackConstraintAllows(env, userId, workspaceId, articleId, runId);
}

export function isWechatAccountAllowed(value: string | undefined, accountBindingId: string, env: { V3_TENANT_SCOPE?: string } = {}): boolean {
  if (v3AllTenantsEnabled(env)) return true;
  return (value || "").split(",").map(item => item.trim()).filter(Boolean).includes(accountBindingId);
}

/** Deployment-owned URL policy for provider media returned into a main R2 payload. */
export function isWechatMediaUrlAllowed(allowlist: string | undefined, value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || !host ||
      // A trailing DNS root label is semantically equivalent to the host
      // without it. Reject it before the deployment allowlist comparison so a
      // local/private alias can never become allowlisted by spelling.
      host.endsWith(".") || url.username || url.password || url.hash || host === "localhost" || host === "metadata" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(host) ||
      host.startsWith("[") || host === "::1") return false;
  const allowed = (allowlist || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  return allowed.length > 0 && allowed.includes(host);
}

export async function wechatOperationId(operation: WechatAdapterOperation, request: Record<string, unknown>): Promise<string> {
  return `wechat_${(await sha256(canonicalJson({ operation, request }))).slice(7, 31)}`;
}

function endpoint(operation: WechatAdapterOperation, reconcileOnly: boolean): string {
  const suffix = reconcileOnly ? "/reconcile" : "";
  switch (operation) {
    case "resolve_account": return `/internal/v3/wechat/resolve${suffix}`;
    case "upload_image": return `/internal/v3/wechat/upload${suffix}`;
    case "write_draft": return `/internal/v3/wechat/draft${suffix}`;
    case "get_draft": return `/internal/v3/wechat/get${suffix}`;
    case "find_draft": return `/internal/v3/wechat/find${suffix}`;
  }
}

export async function callWechatPublishingAdapter(
  env: WechatPublishingServiceEnv,
  operation: WechatAdapterOperation,
  body: Record<string, unknown>,
  options: { reconcileOnly?: boolean } = {},
): Promise<Record<string, unknown>> {
  const token = env.WECHAT_PUBLISHING_TOKEN?.trim();
  if (!env.WECHAT_PUBLISHING_ADAPTER || !token) throw new WechatPublishingServiceError("service_unconfigured", 503, false);
  let response: Response;
  try {
    response = await env.WECHAT_PUBLISHING_ADAPTER.fetch(new Request(`https://wechat-publishing-adapter${endpoint(operation, options.reconcileOnly === true)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: canonicalJson({ protocol_version: "vibepub.wechat.v3", operation, reconcile_only: options.reconcileOnly === true, ...body }),
    }));
  } catch {
    // A binding transport exception cannot establish that an external request did not start.
    throw new WechatPublishingServiceError("external_side_effect_unknown", 503, false);
  }
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new WechatPublishingServiceError("external_side_effect_unknown", 503, false); }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  if (!record) throw new WechatPublishingServiceError("external_side_effect_unknown", 503, false);
  if (!response.ok) {
    const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    const code = typeof error.code === "string" ? error.code : "wechat_service_failed";
    const readOnly = operation === "get_draft" || operation === "find_draft";
    // A read has no provider-side mutation to duplicate. Writes remain
    // retryable only with the adapter's explicit non-delivery proof.
    const retryable = error.retryable === true && [408, 429, 502, 503, 504].includes(response.status) &&
      (readOnly || error.delivery_status === "not_forwarded" || error.delivery_status === "rejected_before_commit");
    throw new WechatPublishingServiceError(code, response.status, retryable);
  }
  if (record.protocol_version !== "vibepub.wechat.v3" || record.operation !== operation ||
      record.operation_id !== body.operation_id || record.attempt !== body.attempt) {
    throw new WechatPublishingServiceError("wechat_adapter_protocol_invalid", 502, false);
  }
  return record;
}
