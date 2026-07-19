export type InternalServiceEnv = {
  WRITING_AGENT?: Fetcher;
  REVIEW_AGENT?: Fetcher;
  WRITING_AGENT_BASE_URL?: string;
  REVIEW_AGENT_BASE_URL?: string;
  WRITING_AGENT_TOKEN?: string;
  REVIEW_AGENT_TOKEN?: string;
};

export class InternalServiceError extends Error {
  constructor(
    public readonly code: "service_unconfigured" | "service_unavailable" | "service_invalid_response",
    public readonly status = 503,
    public readonly retryable = false,
    public readonly upstreamCode?: string,
  ) {
    super(code);
    this.name = "InternalServiceError";
  }
}

async function invoke(
  service: Fetcher | undefined,
  baseUrl: string | undefined,
  token: string | undefined,
  path: string,
  payload: unknown,
  expectedProtocol: string,
): Promise<Record<string, unknown>> {
  if (!token) throw new InternalServiceError("service_unconfigured");
  if (!service && !baseUrl) throw new InternalServiceError("service_unconfigured");
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("authorization", `Bearer ${token}`);
  let request: Request;
  if (service) {
    request = new Request(`https://internal.service${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } else {
    request = new Request(`${baseUrl!.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }
  let response: Response;
  try {
    response = service ? await service.fetch(request) : await fetch(request);
  } catch {
    throw new InternalServiceError("service_unavailable", 503, true);
  }
  if (!response.ok) {
    let upstreamCode: string | undefined;
    let upstreamRetryable = false;
    try {
      const errorBody = await response.clone().json() as { error?: { code?: unknown; retryable?: unknown } };
      upstreamCode = typeof errorBody.error?.code === "string" ? errorBody.error.code : undefined;
      upstreamRetryable = errorBody.error?.retryable === true;
    } catch {
      // Keep the stable status classification; never echo an upstream body.
    }
    const retryableStatus = response.status === 408 || response.status === 429;
    const controlledFiveOh = response.status >= 500 && response.status <= 599
      && upstreamRetryable
      && (upstreamCode === "upstream_retryable" || upstreamCode === "upstream_timeout" || upstreamCode === "service_temporarily_unavailable");
    const retryable = retryableStatus || controlledFiveOh;
    throw new InternalServiceError("service_unavailable", response.status, retryable, upstreamCode);
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new InternalServiceError("service_invalid_response", 502);
  }
  if (!result || typeof result !== "object" || Array.isArray(result) || !("result" in result) || (result as Record<string, unknown>).protocol_version !== expectedProtocol || !(result as Record<string, unknown>).result || typeof (result as Record<string, unknown>).result !== "object" || Array.isArray((result as Record<string, unknown>).result)) throw new InternalServiceError("service_invalid_response", 502);
  return result as Record<string, unknown>;
}

export async function callWritingAgentV3(env: InternalServiceEnv, payload: unknown): Promise<Record<string, unknown>> {
  return invoke(env.WRITING_AGENT, env.WRITING_AGENT_BASE_URL, env.WRITING_AGENT_TOKEN, "/internal/v3/write", payload, "vibepub.editorial.v3");
}

export async function callReviewAgentV3(env: InternalServiceEnv, payload: unknown): Promise<Record<string, unknown>> {
  return invoke(env.REVIEW_AGENT, env.REVIEW_AGENT_BASE_URL, env.REVIEW_AGENT_TOKEN, "/internal/v3/review", payload, "vibepub.editorial.review.v1");
}
