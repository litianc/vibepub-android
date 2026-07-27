type Operation = "plan" | "image";
type OperationStatus = "intent" | "success" | "failed";

type R2StoredRecord = {
  operation_id: string;
  operation: Operation;
  attempt: number;
  request_hash: string;
  logical_request_hash: string;
  status: OperationStatus;
  status_code?: number;
  error_code?: string;
  retryable?: boolean;
  result?: {
    model_version: "gpt-image-2";
    adapter_version: "visual-generation.adapter.1.0.0";
    prompt_hash?: string;
    b64_json?: string;
  };
};

type Env = {
  VISUAL_PRODUCTION_TOKEN?: string;
  GPT_IMAGE_API_KEY?: string;
  IMAGE_PROVIDER_URL?: string;
  IMAGE_PROVIDER_HOST?: string;
  DEPLOY_COMMIT?: string;
  DEPLOY_REF?: string;
  DEPLOYED_AT?: string;
  VISUAL_RESULTS_BUCKET?: R2Bucket;
  VISUAL_OPERATION?: DurableObjectNamespace;
};

const MODEL = "gpt-image-2" as const;
const ADAPTER_VERSION = "visual-generation.adapter.1.0.0" as const;
const PROTOCOL = "vibepub.visual.v3" as const;
const RESULT_PREFIX = "visual-adapter/v3/operations/";

class KnownAdapterError extends Error {
  constructor(public readonly detail: { code: string; status: number; retryable: boolean }) {
    super(detail.code);
    this.name = "KnownAdapterError";
  }
}

class ReconciliationRequiredError extends Error {
  constructor() {
    super("external_side_effect_unknown");
    this.name = "ReconciliationRequiredError";
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("unsupported canonical JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${canonicalJson(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function deploymentVersion(env: Pick<Env, "DEPLOY_COMMIT" | "DEPLOY_REF" | "DEPLOYED_AT">) {
  const value = (input: string | undefined) => input?.trim() || null;
  return { commit: value(env.DEPLOY_COMMIT), ref: value(env.DEPLOY_REF), deployed_at: value(env.DEPLOYED_AT) };
}

function authorized(request: Request, env: Env): boolean {
  const configured = env.VISUAL_PRODUCTION_TOKEN?.trim();
  const presented = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1] || "";
  return Boolean(configured && presented && configured === presented);
}

function providerUrl(env: Env): string {
  const value = env.IMAGE_PROVIDER_URL?.trim();
  if (!value || !env.GPT_IMAGE_API_KEY) throw new KnownAdapterError({ code: "service_unconfigured", status: 503, retryable: false });
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new KnownAdapterError({ code: "service_unconfigured", status: 503, retryable: false }); }
  const expectedHost = env.IMAGE_PROVIDER_HOST?.trim().toLowerCase();
  if (!expectedHost || parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443") || parsed.hostname.toLowerCase() !== expectedHost || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/v1/images/generations") {
    throw new KnownAdapterError({ code: "service_unconfigured", status: 503, retryable: false });
  }
  return parsed.toString();
}

function opaque(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new KnownAdapterError({ code: `${field}_invalid`, status: 400, retryable: false });
  return value;
}

function requestShape(operation: Operation, payload: Record<string, unknown>): {
  operationId: string;
  attempt: number;
  request: Record<string, unknown>;
  logicalRequest: Record<string, unknown>;
} {
  const operationId = opaque(payload.operation_id, "operation_id");
  const attempt = payload.attempt;
  if (!Number.isInteger(attempt) || Number(attempt) < 1 || Number(attempt) > 3) throw new KnownAdapterError({ code: "attempt_invalid", status: 400, retryable: false });
  if (payload.model !== undefined && payload.model !== MODEL) throw new KnownAdapterError({ code: "model_version_conflict", status: 409, retryable: false });
  if (operation === "image") {
    if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0 || payload.prompt.length > 20_000) throw new KnownAdapterError({ code: "prompt_invalid", status: 400, retryable: false });
    if (payload.size !== "2256x960" && payload.size !== "1536x864") throw new KnownAdapterError({ code: "image_size_invalid", status: 400, retryable: false });
  } else if (!payload.plan || typeof payload.plan !== "object" || Array.isArray(payload.plan)) {
    throw new KnownAdapterError({ code: "plan_invalid", status: 400, retryable: false });
  }
  const logicalRequest = { operation_id: operationId, operation, model: MODEL, ...(operation === "image" ? { prompt: payload.prompt, size: payload.size } : { plan: payload.plan }) };
  return { operationId, attempt: Number(attempt), request: { ...logicalRequest, attempt: Number(attempt) }, logicalRequest };
}

function operationKeys(operationId: string, attempt: number): { intent: string; result: string } {
  return { intent: `${RESULT_PREFIX}${operationId}/attempt-${attempt}/intent.json`, result: `${RESULT_PREFIX}${operationId}/attempt-${attempt}/result.json` };
}

function validRecord(value: unknown): value is R2StoredRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as R2StoredRecord).operation_id === "string" &&
    ((value as R2StoredRecord).operation === "plan" || (value as R2StoredRecord).operation === "image") &&
    Number.isInteger((value as R2StoredRecord).attempt) &&
    typeof (value as R2StoredRecord).request_hash === "string" &&
    typeof (value as R2StoredRecord).logical_request_hash === "string" &&
    ["intent", "success", "failed"].includes((value as R2StoredRecord).status));
}

async function readRecord(bucket: R2Bucket, key: string): Promise<R2StoredRecord | null> {
  let object: R2ObjectBody | null;
  try { object = await bucket.get(key); } catch { throw new ReconciliationRequiredError(); }
  if (!object) return null;
  let head: R2Object | null;
  try { head = await bucket.head(key); } catch { throw new ReconciliationRequiredError(); }
  if (!head) throw new ReconciliationRequiredError();
  let raw: string;
  try { raw = await object.text(); } catch { throw new ReconciliationRequiredError(); }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!validRecord(parsed)) throw new Error("invalid record");
    const canonical = canonicalJson(parsed);
    if (raw !== canonical) throw new Error("record bytes are not canonical");
    const recordHash = await sha256(raw);
    const recordLength = new TextEncoder().encode(raw).byteLength;
    const expectedMetadata = {
      operation_id: parsed.operation_id,
      operation: parsed.operation,
      attempt: String(parsed.attempt),
      request_hash: parsed.request_hash,
      logical_request_hash: parsed.logical_request_hash,
      status: parsed.status,
      record_hash: recordHash,
      record_length: String(recordLength),
    };
    const metadataMatches = (candidate: Record<string, string>) => Object.keys(candidate).length === 8 && Object.entries(expectedMetadata).every(([field, expected]) => candidate[field] === expected);
    if (!metadataMatches(object.customMetadata || {}) || !metadataMatches(head.customMetadata || {}) || object.size !== recordLength || head.size !== recordLength) throw new Error("metadata mismatch");
    return parsed;
  } catch { throw new ReconciliationRequiredError(); }
}

async function putImmutableRecord(bucket: R2Bucket, key: string, record: R2StoredRecord): Promise<"created" | "replayed"> {
  const bytes = canonicalJson(record);
  const recordHash = await sha256(bytes);
  const recordLength = new TextEncoder().encode(bytes).byteLength;
  const existing = await readRecord(bucket, key);
  if (existing) {
    if (canonicalJson(existing) !== bytes) throw new KnownAdapterError({ code: "operation_conflict", status: 409, retryable: false });
    return "replayed";
  }
  try {
    const written = await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        operation_id: record.operation_id,
        operation: record.operation,
        attempt: String(record.attempt),
        request_hash: record.request_hash,
        logical_request_hash: record.logical_request_hash,
        status: record.status,
        record_hash: recordHash,
        record_length: String(recordLength),
      },
    });
    if (!written) {
      const raced = await readRecord(bucket, key);
      if (raced && canonicalJson(raced) === bytes) return "replayed";
      if (raced) throw new KnownAdapterError({ code: "operation_conflict", status: 409, retryable: false });
      throw new ReconciliationRequiredError();
    }
  } catch (error) {
    if (error instanceof KnownAdapterError || error instanceof ReconciliationRequiredError) throw error;
    let raced: R2StoredRecord | null;
    try { raced = await readRecord(bucket, key); } catch { throw new ReconciliationRequiredError(); }
    if (raced && canonicalJson(raced) === bytes) return "replayed";
    if (raced) throw new KnownAdapterError({ code: "operation_conflict", status: 409, retryable: false });
    throw new ReconciliationRequiredError();
  }
  let readback: R2StoredRecord | null;
  try { readback = await readRecord(bucket, key); } catch { throw new ReconciliationRequiredError(); }
  if (!readback || canonicalJson(readback) !== bytes) throw new ReconciliationRequiredError();
  return "created";
}

async function readAttemptResult(bucket: R2Bucket, operationId: string, operation: Operation, attempt: number, logicalRequestHash: string): Promise<R2StoredRecord | null> {
  const result = await readRecord(bucket, operationKeys(operationId, attempt).result);
  if (!result) return null;
  if (result.operation_id !== operationId || result.operation !== operation || result.attempt !== attempt || result.logical_request_hash !== logicalRequestHash) throw new KnownAdapterError({ code: "operation_conflict", status: 409, retryable: false });
  return result;
}

async function resultEvidence(bucket: R2Bucket, operationId: string, operation: Operation, attempt: number, logicalRequestHash: string): Promise<{ result_ref: string; result_hash: string; record: R2StoredRecord } | null> {
  const record = await readAttemptResult(bucket, operationId, operation, attempt, logicalRequestHash);
  if (!record) return null;
  return {
    result_ref: operationKeys(operationId, attempt).result,
    result_hash: await sha256(canonicalJson(record)),
    record,
  };
}

async function readPriorTerminalResult(bucket: R2Bucket, operationId: string, operation: Operation, attempt: number, logicalRequestHash: string): Promise<R2StoredRecord | null> {
  for (let prior = 1; prior < attempt; prior += 1) {
    const record = await readAttemptResult(bucket, operationId, operation, prior, logicalRequestHash);
    if (record && (record.status === "success" || record.retryable !== true)) return record;
  }
  return null;
}

function resultResponse(operation: Operation, operationId: string, _requestedAttempt: number, record: R2StoredRecord): Response {
  if (record.status === "success" && record.result) return json({ protocol_version: PROTOCOL, operation, operation_id: operationId, attempt: record.attempt, result: record.result });
  return json({ error: { code: record.error_code || "adapter_failed", retryable: record.retryable === true } }, record.status_code || 500);
}

type ShapedOperation = ReturnType<typeof requestShape>;

async function processOperation(env: Env, operation: Operation, shaped: ShapedOperation): Promise<Response> {
  const bucket = env.VISUAL_RESULTS_BUCKET;
  if (!bucket) return json({ error: { code: "service_unconfigured", retryable: false } }, 503);
  const requestHash = await sha256(canonicalJson(shaped.request));
  const logicalRequestHash = await sha256(canonicalJson(shaped.logicalRequest));
  const currentKeys = operationKeys(shaped.operationId, shaped.attempt);
  try {
    const currentResult = await readAttemptResult(bucket, shaped.operationId, operation, shaped.attempt, logicalRequestHash);
    if (currentResult) return resultResponse(operation, shaped.operationId, shaped.attempt, currentResult);
    const priorSuccessOrTerminal = await readPriorTerminalResult(bucket, shaped.operationId, operation, shaped.attempt, logicalRequestHash);
    if (priorSuccessOrTerminal) return resultResponse(operation, shaped.operationId, shaped.attempt, priorSuccessOrTerminal);
    const currentIntent = await readRecord(bucket, currentKeys.intent);
    if (currentIntent) {
      if (currentIntent.request_hash !== requestHash || currentIntent.logical_request_hash !== logicalRequestHash) return json({ error: { code: "operation_conflict", retryable: false } }, 409);
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
    const intentStatus = await putImmutableRecord(bucket, currentKeys.intent, { operation_id: shaped.operationId, operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "intent" });
    if (intentStatus === "replayed") {
      const racedResult = await readAttemptResult(bucket, shaped.operationId, operation, shaped.attempt, logicalRequestHash);
      if (racedResult) return resultResponse(operation, shaped.operationId, shaped.attempt, racedResult);
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
  } catch (error) {
    if (error instanceof KnownAdapterError) return json({ error: { code: error.detail.code, retryable: error.detail.retryable } }, error.detail.status);
    return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
  }

  try {
    let record: R2StoredRecord;
    if (operation === "plan") {
      const slots = ((shaped.logicalRequest.plan as Record<string, unknown>).slots || []) as Array<Record<string, unknown>>;
      record = { operation_id: shaped.operationId, operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "success", result: { model_version: MODEL, adapter_version: ADAPTER_VERSION, prompt_hash: await sha256(canonicalJson(slots.map(slot => slot.prompt_hash))) } };
      await putImmutableRecord(bucket, currentKeys.result, record);
      return resultResponse(operation, shaped.operationId, shaped.attempt, record);
    }
    const url = providerUrl(env);
    let providerResponse: Response;
    try {
      providerResponse = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { authorization: `Bearer ${env.GPT_IMAGE_API_KEY}`, "content-type": "application/json" },
        body: canonicalJson({ model: MODEL, prompt: shaped.logicalRequest.prompt, size: shaped.logicalRequest.size }),
      });
    } catch {
      // A transport exception does not prove that the provider rejected the
      // request. Keep the durable intent unresolved so recovery can only query
      // this exact operation/attempt instead of issuing a blind retry.
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
    if (!providerResponse.ok) {
      const controlled = providerResponse.status === 408 || providerResponse.status === 429 || providerResponse.status === 502 || providerResponse.status === 503 || providerResponse.status === 504;
      record = { operation_id: shaped.operationId, operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "failed", status_code: providerResponse.status, error_code: controlled ? "upstream_retryable" : "provider_error", retryable: controlled };
      await putImmutableRecord(bucket, currentKeys.result, record);
      return resultResponse(operation, shaped.operationId, shaped.attempt, record);
    }
    let providerBody: { data?: Array<{ b64_json?: unknown }> };
    try { providerBody = await providerResponse.json() as { data?: Array<{ b64_json?: unknown }> }; } catch {
      record = { operation_id: shaped.operationId, operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "failed", status_code: 502, error_code: "invalid_provider_response", retryable: false };
      await putImmutableRecord(bucket, currentKeys.result, record);
      return resultResponse(operation, shaped.operationId, shaped.attempt, record);
    }
    const encoded = providerBody.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length === 0) {
      record = { operation_id: shaped.operationId, operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "failed", status_code: 502, error_code: "invalid_provider_response", retryable: false };
      await putImmutableRecord(bucket, currentKeys.result, record);
      return resultResponse(operation, shaped.operationId, shaped.attempt, record);
    }
    record = { operation_id: shaped.operationId, operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "success", result: { model_version: MODEL, adapter_version: ADAPTER_VERSION, prompt_hash: await sha256(String(shaped.logicalRequest.prompt)), b64_json: encoded } };
    await putImmutableRecord(bucket, currentKeys.result, record);
    return resultResponse(operation, shaped.operationId, shaped.attempt, record);
  } catch (error) {
    if (error instanceof KnownAdapterError) {
      if (error.detail.code === "operation_conflict") return json({ error: { code: error.detail.code, retryable: false } }, error.detail.status);
      const failed: R2StoredRecord = {
        operation_id: shaped.operationId,
        operation,
        attempt: shaped.attempt,
        request_hash: requestHash,
        logical_request_hash: logicalRequestHash,
        status: "failed",
        status_code: error.detail.status,
        error_code: error.detail.code,
        retryable: error.detail.retryable,
      };
      try {
        await putImmutableRecord(bucket, currentKeys.result, failed);
      } catch {
        return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
      }
      return resultResponse(operation, shaped.operationId, shaped.attempt, failed);
    }
    return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
  }
}

async function reconcileOperation(env: Env, operation: Operation, shaped: ShapedOperation): Promise<Response> {
  const bucket = env.VISUAL_RESULTS_BUCKET;
  if (!bucket) return json({ error: { code: "service_unconfigured", retryable: false } }, 503);
  const logicalRequestHash = await sha256(canonicalJson(shaped.logicalRequest));
  try {
    const current = await readAttemptResult(bucket, shaped.operationId, operation, shaped.attempt, logicalRequestHash);
    if (current) return resultResponse(operation, shaped.operationId, shaped.attempt, current);
    return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
  } catch (error) {
    if (error instanceof KnownAdapterError) return json({ error: { code: error.detail.code, retryable: false } }, error.detail.status);
    return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
  }
}

type DurableClaim = {
  operation_id: string;
  operation: Operation;
  attempt: number;
  request_hash: string;
  logical_request_hash: string;
  status: "intent" | "failed" | "completed";
  retryable?: boolean;
  result_ref?: string;
  result_hash?: string;
};

export class VisualOperationAgent {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    let input: { operation?: Operation; shaped?: ShapedOperation; mode?: "execute" | "reconcile" };
    try { input = await request.json() as { operation?: Operation; shaped?: ShapedOperation }; } catch { return json({ error: { code: "invalid_request", retryable: false } }, 400); }
    if ((input.operation !== "plan" && input.operation !== "image") || !input.shaped) return json({ error: { code: "invalid_request", retryable: false } }, 400);
    const shaped = input.shaped;
    if (input.mode === "reconcile") return reconcileOperation(this.env, input.operation, shaped);
    const storageKey = `attempt:${shaped.attempt}`;
    const requestHash = await sha256(canonicalJson(shaped.request));
    const logicalRequestHash = await sha256(canonicalJson(shaped.logicalRequest));
    const repairEvidence = new Map<number, Awaited<ReturnType<typeof resultEvidence>>>();
    try {
      const bucket = this.env.VISUAL_RESULTS_BUCKET;
      if (!bucket) return json({ error: { code: "service_unconfigured", retryable: false } }, 503);
      for (let attempt = 1; attempt <= shaped.attempt; attempt += 1) {
        const stored = await this.state.storage.get<DurableClaim>(`attempt:${attempt}`);
        if (stored?.status !== "intent") continue;
        const evidence = await resultEvidence(bucket, shaped.operationId, input.operation, attempt, logicalRequestHash);
        if (!evidence) continue;
        if (stored.operation_id !== shaped.operationId || stored.operation !== input.operation ||
            stored.attempt !== attempt || stored.request_hash !== evidence.record.request_hash ||
            stored.logical_request_hash !== evidence.record.logical_request_hash) {
          return json({ error: { code: "operation_conflict", retryable: false } }, 409);
        }
        repairEvidence.set(attempt, evidence);
      }
    } catch (error) {
      if (error instanceof KnownAdapterError) return json({ error: { code: error.detail.code, retryable: false } }, error.detail.status);
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
    let decision: string = "claim";
    let existing: DurableClaim | undefined;
    let terminalAttempt: number | undefined;
    const claim: DurableClaim = { operation_id: shaped.operationId, operation: input.operation, attempt: shaped.attempt, request_hash: requestHash, logical_request_hash: logicalRequestHash, status: "intent" };
    await this.state.storage.transaction(async transaction => {
      const prior = [] as DurableClaim[];
      for (let attempt = 1; attempt <= shaped.attempt; attempt += 1) {
        let priorClaim = await transaction.get<DurableClaim>(`attempt:${attempt}`);
        const evidence = repairEvidence.get(attempt);
        if (priorClaim?.status === "intent" && evidence) {
          priorClaim = {
            ...priorClaim,
            status: evidence.record.status === "success" ? "completed" : "failed",
            retryable: evidence.record.retryable,
            result_ref: evidence.result_ref,
            result_hash: evidence.result_hash,
          };
          await transaction.put(`attempt:${attempt}`, priorClaim);
        }
        if (attempt === shaped.attempt) continue;
        if (priorClaim) prior.push(priorClaim);
      }
      if (prior.some(item => item.logical_request_hash !== logicalRequestHash || item.operation !== input.operation)) { decision = "conflict"; return; }
      if (prior.some(item => item.status === "intent")) { decision = "unknown"; return; }
      const terminal = prior.find(item => item.status === "completed" || (item.status === "failed" && item.retryable !== true));
      if (terminal) {
        terminalAttempt = terminal.attempt;
        decision = "terminal";
        return;
      }
      if (shaped.attempt > 1) {
        const previous = await transaction.get<DurableClaim>(`attempt:${shaped.attempt - 1}`);
        if (!previous) { decision = "attempt_order_invalid"; return; }
        if (previous.status === "completed" || (previous.status === "failed" && previous.retryable !== true)) {
          terminalAttempt = previous.attempt;
          decision = "terminal";
          return;
        }
        if (previous.status !== "failed" || previous.retryable !== true) { decision = "unknown"; return; }
      }
      existing = await transaction.get<DurableClaim>(storageKey);
      if (existing) {
        if (existing.request_hash !== requestHash || existing.logical_request_hash !== logicalRequestHash || existing.operation !== input.operation) {
          decision = "conflict";
        } else if (existing.status === "intent") {
          decision = "unknown";
        } else if (existing.status === "completed" || existing.retryable !== true) {
          terminalAttempt = existing.attempt;
          decision = "terminal";
        } else {
          decision = "existing";
        }
        return;
      }
      await transaction.put(storageKey, claim);
      decision = "claim";
    });
    if (decision === "conflict") return json({ error: { code: "operation_conflict", retryable: false } }, 409);
    if (decision === "unknown") return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    if (decision === "attempt_order_invalid") return json({ error: { code: "attempt_order_invalid", retryable: false } }, 409);
    if (decision === "terminal") {
      const bucket = this.env.VISUAL_RESULTS_BUCKET;
      if (!bucket || terminalAttempt === undefined) return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
      try {
        const evidence = await resultEvidence(bucket, shaped.operationId, input.operation, terminalAttempt, logicalRequestHash);
        return evidence ? resultResponse(input.operation, shaped.operationId, shaped.attempt, evidence.record) : json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
      } catch (error) {
        if (error instanceof KnownAdapterError) return json({ error: { code: error.detail.code, retryable: false } }, error.detail.status);
        return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
      }
    }
    const result = await processOperation(this.env, input.operation, shaped);
    let evidence: Awaited<ReturnType<typeof resultEvidence>>;
    try {
      evidence = await resultEvidence(this.env.VISUAL_RESULTS_BUCKET as R2Bucket, shaped.operationId, input.operation, shaped.attempt, logicalRequestHash);
    } catch {
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
    if (!evidence) return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    try {
      await this.state.storage.put(storageKey, {
        ...(existing || claim),
        status: evidence.record.status === "success" ? "completed" : "failed",
        retryable: evidence.record.retryable,
        result_ref: evidence.result_ref,
        result_hash: evidence.result_hash,
      });
    } catch {
      return json({ error: { code: "external_side_effect_unknown", retryable: false } }, 503);
    }
    return result;
  }
}

async function invoke(request: Request, env: Env, operation: Operation): Promise<Response> {
  if (!authorized(request, env)) return json({ error: { code: "unauthorized" } }, 401);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: { code: "invalid_json" } }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: { code: "invalid_request" } }, 400);
  let shaped: ReturnType<typeof requestShape>;
  try { shaped = requestShape(operation, body as Record<string, unknown>); } catch (error) {
    if (error instanceof KnownAdapterError) return json({ error: { code: error.detail.code, retryable: error.detail.retryable } }, error.detail.status);
    return json({ error: { code: "invalid_request", retryable: false } }, 400);
  }
  if (!env.VISUAL_OPERATION) return json({ error: { code: "service_unconfigured", retryable: false } }, 503);
  const id = env.VISUAL_OPERATION.idFromName(shaped.operationId);
  return env.VISUAL_OPERATION.get(id).fetch(new Request("https://visual-operation.internal/", {
    method: "POST",
    body: canonicalJson({ operation, shaped, mode: body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).reconcile_only === true ? "reconcile" : "execute" }),
  }));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Promise.resolve(json({ ok: true, service: "image-generation-adapter", version: deploymentVersion(env) }));
    }
    if (url.pathname === "/internal/v3/visual/plan" && request.method === "POST") return invoke(request, env, "plan");
    if (url.pathname === "/internal/v3/visual/image" && request.method === "POST") return invoke(request, env, "image");
    return Promise.resolve(json({ error: { code: "not_found" } }, 404));
  },
};
