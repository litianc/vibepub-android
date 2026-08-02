import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptMiningV3Handoff,
  decideMiningV3Route,
  MiningV3HandoffClientError,
  readMiningV3Status,
  miningV3HandoffEnabled,
} from "../src/v3Handoff.js";

const originalEnv = { ...process.env };
const sourceKey = "users/u_1/inbox/source.mp3";
const handoffId = `handoff_v3_${"a".repeat(64)}`;
const acceptedRunId = `run_v3_${"b".repeat(64)}`;
const acceptedTranscriptHash = `sha256:${"c".repeat(64)}`;

function accepted(handoff = handoffId, run = acceptedRunId) {
  return {
    decision: "accepted",
    handoff_id: handoff,
    run_id: run,
    transcript_ref: "editorial/v3/0123456789abcdef01234567/mining-handoffs/handoff_v3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/transcripts/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.v1.txt",
    transcript_hash: acceptedTranscriptHash,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Mining V3 handoff client", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PUBLIC_BASE_URL: "https://vibepub.example.test/",
      MINING_V3_HANDOFF_TOKEN: "handoff-token",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sends only the dedicated bearer token and returns an explicit legacy decision", async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://vibepub.example.test/api/internal/v3/mining-handoffs/eligibility");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer handoff-token");
      expect(JSON.parse(String(init?.body))).toEqual({ source_key: sourceKey });
      return json({ decision: "legacy" });
    };
    await expect(decideMiningV3Route(sourceKey, fetcher as typeof fetch)).resolves.toEqual({ decision: "legacy" });
  });

  it("uses an explicit exact-true client gate", () => {
    expect(miningV3HandoffEnabled({})).toBe(false);
    expect(miningV3HandoffEnabled({ MINING_V3_HANDOFF_ENABLED: "false" })).toBe(false);
    expect(miningV3HandoffEnabled({ MINING_V3_HANDOFF_ENABLED: "TRUE" })).toBe(false);
    expect(miningV3HandoffEnabled({ MINING_V3_HANDOFF_ENABLED: "true" })).toBe(true);
  });

  it("fails closed when eligibility transport is unknown and status proves no marker", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network dropped");
      return json({ decision: "legacy" });
    };
    await expect(decideMiningV3Route(sourceKey, fetcher as typeof fetch)).resolves.toEqual({ decision: "v3_hold" });
    expect(calls).toBe(2);
  });

  it("reconciles a lost start response through status without a second ASR payload", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      bodies.push(JSON.parse(String(init?.body)));
      if (call === 1) throw new Error("response lost after start");
      return json(accepted());
    };
    const result = await acceptMiningV3Handoff(sourceKey, { decision: "v3_pending_asr", handoff_id: handoffId }, "hello", fetcher as typeof fetch);
    expect(result.decision).toBe("accepted");
    expect(bodies).toEqual([
      { source_key: sourceKey, handoff_id: handoffId, transcript_text: "hello" },
      { source_key: sourceKey, handoff_id: handoffId },
    ]);
  });

  it("does not start an audio marker without a transcript and validates statuses", async () => {
    await expect(acceptMiningV3Handoff(sourceKey, { decision: "v3_pending_asr", handoff_id: handoffId }, undefined, async () => json({ decision: "accepted" }) as any)).resolves.toMatchObject({ decision: "v3_pending_asr" });
    await expect(readMiningV3Status(sourceKey, async () => json({ anything: "else" }) as any)).rejects.toBeInstanceOf(MiningV3HandoffClientError);
    await expect(readMiningV3Status(sourceKey, async () => json({ decision: "accepted", handoff_id: handoffId, run_id: acceptedRunId }) as any)).rejects.toBeInstanceOf(MiningV3HandoffClientError);
  });

  it("stops after three controlled start outcomes", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return json({ error: "unavailable" }, 503);
    };
    const result = await acceptMiningV3Handoff(sourceKey, { decision: "v3_pending_start", handoff_id: handoffId }, undefined, fetcher as typeof fetch);
    expect(result).toMatchObject({ decision: "v3_hold", reason: "unavailable" });
    // Each failed start gets exactly one status reconciliation; no unbounded replay.
    expect(calls).toBe(6);
  });

  it("rejects an unbounded diagnostic reason from the trusted status boundary", async () => {
    await expect(readMiningV3Status(sourceKey, async () => json({
      decision: "v3_hold",
      reason: "x".repeat(161),
    }) as any)).rejects.toMatchObject({ code: "mining_v3_handoff_malformed" });
  });
});
