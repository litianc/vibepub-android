import { InternalServiceError } from "./serviceClients";
import { MAX_PROVIDER_BASE64_CHARS } from "./binaryImageStore";

export type VisualImageServiceEnv = {
  IMAGE_GENERATION_ADAPTER?: Fetcher;
  VISUAL_PRODUCTION_TOKEN?: string;
};

export type VisualAdapterResponse = {
  operation: "plan" | "image";
  operation_id: string;
  attempt: number;
  result: Record<string, unknown>;
};

async function invokeVisual(env: VisualImageServiceEnv, operation: "plan" | "image", payload: unknown, reconcileOnly = false): Promise<VisualAdapterResponse> {
  const token = env.VISUAL_PRODUCTION_TOKEN?.trim();
  if (!token || !env.IMAGE_GENERATION_ADAPTER) throw new InternalServiceError("service_unconfigured", 503, false);
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
  const path = operation === "plan" ? "/internal/v3/visual/plan" : "/internal/v3/visual/image";
  const requestBody = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), ...(reconcileOnly ? { reconcile_only: true } : {}) }
    : payload;
  const request = new Request(`https://internal.visual${path}`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  let response: Response;
  try { response = await env.IMAGE_GENERATION_ADAPTER.fetch(request); }
  catch { throw new InternalServiceError("external_side_effect_unknown", 503, false, "external_side_effect_unknown"); }
  if (!response.ok) {
    let code: string | undefined;
    let declaredRetryable = false;
    try { const value = await response.clone().json() as { error?: { code?: unknown; retryable?: unknown } }; code = typeof value.error?.code === "string" ? value.error.code : undefined; declaredRetryable = value.error?.retryable === true; } catch { /* redact upstream body */ }
    const controlled = [502, 503, 504, 521, 523].includes(response.status) && declaredRetryable && ["upstream_retryable", "upstream_timeout", "service_temporarily_unavailable"].includes(code || "");
    throw new InternalServiceError("service_unavailable", response.status, response.status === 408 || response.status === 429 || controlled, code);
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new InternalServiceError("service_invalid_response", 502, false); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InternalServiceError("service_invalid_response", 502, false);
  const body = value as Record<string, unknown>;
  const requestRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const attempt = requestRecord.attempt;
  if (body.protocol_version !== "vibepub.visual.v3" || body.operation !== operation || body.operation_id !== requestRecord.operation_id || body.attempt !== attempt || !Number.isInteger(attempt) || Number(attempt) < 1 || Number(attempt) > 3 || !body.result || typeof body.result !== "object" || Array.isArray(body.result)) throw new InternalServiceError("service_invalid_response", 502, false);
  const result = body.result as Record<string, unknown>;
  if (result.model_version !== "gpt-image-2" || result.adapter_version !== "visual-generation.adapter.1.0.0") throw new InternalServiceError("service_invalid_response", 502, false);
  if (typeof requestRecord.prompt === "string") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestRecord.prompt));
    const expectedPromptHash = `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    if (result.prompt_hash !== expectedPromptHash) throw new InternalServiceError("service_invalid_response", 502, false);
  }
  if (operation === "plan") {
    const plan = requestRecord.plan && typeof requestRecord.plan === "object" && !Array.isArray(requestRecord.plan) ? requestRecord.plan as Record<string, unknown> : null;
    const slots = plan && Array.isArray(plan.slots) ? (plan.slots as Array<Record<string, unknown>>).map(slot => slot.prompt_hash) : null;
    if (!slots || slots.some(value => typeof value !== "string")) throw new InternalServiceError("service_invalid_response", 502, false);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(slots)));
    const expectedPromptHash = `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    if (result.prompt_hash !== expectedPromptHash) throw new InternalServiceError("service_invalid_response", 502, false);
  } else if (typeof result.b64_json !== "string" || result.b64_json.length === 0 || result.b64_json.length > MAX_PROVIDER_BASE64_CHARS) {
    throw new InternalServiceError("service_invalid_response", 502, false);
  }
  return { operation, operation_id: body.operation_id as string, attempt: Number(body.attempt), result };
}

export function callVisualPlanService(env: VisualImageServiceEnv, payload: unknown): Promise<VisualAdapterResponse> {
  return invokeVisual(env, "plan", payload);
}

export function callVisualImageService(env: VisualImageServiceEnv, payload: unknown): Promise<VisualAdapterResponse> {
  return invokeVisual(env, "image", payload);
}

export function reconcileVisualPlanService(env: VisualImageServiceEnv, payload: unknown): Promise<VisualAdapterResponse> {
  return invokeVisual(env, "plan", payload, true);
}

export function reconcileVisualImageService(env: VisualImageServiceEnv, payload: unknown): Promise<VisualAdapterResponse> {
  return invokeVisual(env, "image", payload, true);
}
