export type MiningV3Decision =
  | "legacy"
  | "v3"
  | "v3_pending_asr"
  | "v3_pending_start"
  | "accepted"
  | "v3_hold";

export type MiningV3Status = {
  decision: MiningV3Decision;
  handoff_id?: string;
  run_id?: string;
  transcript_ref?: string;
  transcript_hash?: string;
  reason?: string;
};

export class MiningV3HandoffClientError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
  }
}

type FetchLike = typeof fetch;

export function miningV3HandoffEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.MINING_V3_HANDOFF_ENABLED?.trim() === "true";
}

function configuration(): { baseUrl: string; token: string } {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MINING_V3_HANDOFF_TOKEN?.trim();
  if (!baseUrl || !token) throw new MiningV3HandoffClientError("mining_v3_handoff_unconfigured");
  return { baseUrl, token };
}

function controlledRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function isStatus(value: unknown): value is MiningV3Status {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const decision = String(record.decision);
  if (!["legacy", "v3", "v3_pending_asr", "v3_pending_start", "accepted", "v3_hold"].includes(decision)) return false;
  if (record.reason !== undefined && (typeof record.reason !== "string" || record.reason.length > 160)) return false;
  if (decision !== "accepted") return true;
  return typeof record.handoff_id === "string" && /^handoff_v3_[a-f0-9]{64}$/.test(record.handoff_id) &&
    typeof record.run_id === "string" && /^run_v3_[a-f0-9]{64}$/.test(record.run_id) &&
    typeof record.transcript_ref === "string" && record.transcript_ref.length > 0 &&
    typeof record.transcript_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(record.transcript_hash);
}

async function request(
  action: "eligibility" | "status" | "start",
  body: Record<string, unknown>,
  fetcher: FetchLike = fetch,
): Promise<MiningV3Status> {
  const { baseUrl, token } = configuration();
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/api/internal/v3/mining-handoffs/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new MiningV3HandoffClientError("mining_v3_handoff_transport_unknown", true);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
      ? (payload as Record<string, unknown>).error as string
      : "mining_v3_handoff_unavailable";
    throw new MiningV3HandoffClientError(code, controlledRetryableStatus(response.status));
  }
  if (!isStatus(payload)) throw new MiningV3HandoffClientError("mining_v3_handoff_malformed", false);
  return payload;
}

function mustHandoffId(status: MiningV3Status): string {
  if (typeof status.handoff_id !== "string" || !/^handoff_v3_[a-f0-9]{64}$/.test(status.handoff_id)) {
    throw new MiningV3HandoffClientError("mining_v3_handoff_malformed", false);
  }
  return status.handoff_id;
}

async function reconcileStatus(sourceKey: string, handoffId?: string, fetcher?: FetchLike): Promise<MiningV3Status> {
  return request("status", {
    source_key: sourceKey,
    ...(handoffId ? { handoff_id: handoffId } : {}),
  }, fetcher);
}

/**
 * Eligibility is deliberately fail-closed. A transport failure may be followed
 * by a status read, but a status `legacy` result cannot prove the initial
 * eligibility request was absent and is therefore returned as a hold.
 */
export async function decideMiningV3Route(sourceKey: string, fetcher?: FetchLike): Promise<MiningV3Status> {
  try {
    return await request("eligibility", { source_key: sourceKey }, fetcher);
  } catch (error) {
    if (!(error instanceof MiningV3HandoffClientError) || !error.retryable) throw error;
    try {
      const reconciled = await reconcileStatus(sourceKey, undefined, fetcher);
      return reconciled.decision === "legacy" ? { decision: "v3_hold" } : reconciled;
    } catch {
      return { decision: "v3_hold" };
    }
  }
}

/**
 * Starts only a pre-authorized marker. Each transient response is reconciled
 * before another exact replay, so Mining cannot cause a second V3 run.
 */
export async function acceptMiningV3Handoff(
  sourceKey: string,
  initial: MiningV3Status,
  transcriptText?: string,
  fetcher?: FetchLike,
  allowServerTranscript = false,
): Promise<MiningV3Status> {
  if (initial.decision === "accepted" || initial.decision === "v3_hold" || initial.decision === "legacy") return initial;
  const handoffId = mustHandoffId(initial);
  let candidate = initial;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (candidate.decision === "accepted" || candidate.decision === "v3_hold") return candidate;
    if (candidate.decision === "v3_pending_asr" && transcriptText === undefined && !allowServerTranscript) return candidate;
    try {
      const started = await request("start", {
        source_key: sourceKey,
        handoff_id: handoffId,
        ...(transcriptText === undefined ? {} : { transcript_text: transcriptText }),
      }, fetcher);
      if (started.decision === "accepted" || started.decision === "v3_hold") return started;
      candidate = started;
    } catch (error) {
      if (!(error instanceof MiningV3HandoffClientError) || !error.retryable) throw error;
      console.warn("Mining V3 start requires reconciliation", { attempt, code: error.code });
    }
    try {
      const reconciled = await reconcileStatus(sourceKey, handoffId, fetcher);
      if (reconciled.decision === "accepted" || reconciled.decision === "v3_hold") return reconciled;
      candidate = reconciled;
    } catch (error) {
      if (!(error instanceof MiningV3HandoffClientError) || !error.retryable) return { decision: "v3_hold", handoff_id: handoffId };
      console.warn("Mining V3 status requires reconciliation", { attempt, code: error.code });
      if (attempt === 3) return { decision: "v3_hold", handoff_id: handoffId, reason: error.code };
    }
  }
  return { decision: "v3_hold", handoff_id: handoffId, reason: "mining_v3_handoff_retry_budget_exhausted" };
}

export async function readMiningV3Status(sourceKey: string, fetcher?: FetchLike): Promise<MiningV3Status> {
  return reconcileStatus(sourceKey, undefined, fetcher);
}
