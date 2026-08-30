import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readStagingAudioCanaryStatus,
  StagingAudioCanaryRequestError,
} from "../staging-audio-canary-request.mjs";

const base = {
  baseUrl: "https://vibepub-api-staging.example.workers.dev",
  attestedBaseUrl: "https://vibepub-api-staging.example.workers.dev",
  sourceKey: "users/user-1/inbox/VibePub-canary.m4a",
  userId: "user-1",
  workspaceId: "workspace-1",
  token: "synthetic-handoff-token",
};
const status = {
  decision: "v3_pending_start",
  handoff_id: `handoff_v3_${"1".repeat(64)}`,
  run_id: `run_v3_${"2".repeat(64)}`,
  article_id: `article_v3_${"3".repeat(64)}`,
  user_id: base.userId,
  workspace_id: base.workspaceId,
  source_key: base.sourceKey,
  source_hash: `sha256:${"5".repeat(64)}`,
  recording_id: 42,
  transcript_ref: "editorial/v3/redacted/transcript.txt",
  transcript_hash: `sha256:${"4".repeat(64)}`,
  transcript_created_at: "2026-08-29T13:00:00.000Z",
};

test("reads one exact post-ASR staging identity without exposing the token", async () => {
  let observed;
  const result = await readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return Response.json(status);
    },
  });
  assert.deepEqual(result, status);
  assert.equal(observed.url, `${base.baseUrl}/api/internal/v3/mining-handoffs/status`);
  assert.equal(observed.init.headers.authorization, `Bearer ${base.token}`);
  assert.deepEqual(JSON.parse(observed.init.body), { source_key: base.sourceKey });
  assert.doesNotMatch(JSON.stringify(result), /token/i);
});

test("retries a transient status while the deployed Worker is propagating", async () => {
  let calls = 0;
  const result = await readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 503 }) : Response.json(status);
    },
  });
  assert.deepEqual(result, status);
  assert.equal(calls, 2);
});

test("reports a safe HTTP status without retrying a permanent rejection", async () => {
  let calls = 0;
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 401 });
    },
  }), error => error instanceof StagingAudioCanaryRequestError && error.code === "audio_canary_status_http_401");
  assert.equal(calls, 1);
});

test("reports an allowlisted handoff error code without exposing the response body", async () => {
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => Response.json({
      error: "mining_handoff_source_conflict",
      private_detail: "must-not-appear",
    }, { status: 409 }),
  }), error => {
    assert.ok(error instanceof StagingAudioCanaryRequestError);
    assert.equal(error.code, "audio_canary_status_http_409_mining_handoff_source_conflict");
    assert.doesNotMatch(error.message, /must-not-appear/);
    return true;
  });
});

test("reports the owner-conflict code returned by the status route", async () => {
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => Response.json({ error: "mining_handoff_owner_conflict" }, { status: 409 }),
  }), error => error instanceof StagingAudioCanaryRequestError &&
    error.code === "audio_canary_status_http_409_mining_handoff_owner_conflict");
});

test("hides an unknown namespaced error code", async () => {
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => Response.json({
      error: "mining_handoff_private_detail_must_not_appear",
    }, { status: 409 }),
  }), error => error instanceof StagingAudioCanaryRequestError &&
    error.code === "audio_canary_status_http_409");
});

test("stops reading a chunked 409 response after the safe byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(400)));
      controller.enqueue(new TextEncoder().encode("y".repeat(400)));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => new Response(body, { status: 409 }),
  }), error => error instanceof StagingAudioCanaryRequestError &&
    error.code === "audio_canary_status_http_409");
  assert.equal(cancelled, true);
});

test("does not read a permanent response body unless the status is 409", async () => {
  const response = {
    status: 403,
    get body() { throw new Error("must not read"); },
  };
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    retryDelayMs: 0,
    fetchImpl: async () => response,
  }), error => error instanceof StagingAudioCanaryRequestError &&
    error.code === "audio_canary_status_http_403");
});

test("keeps transient retries bounded even when a caller requests more", async () => {
  let calls = 0;
  await assert.rejects(() => readStagingAudioCanaryStatus({
    ...base,
    expectedDecision: "v3_pending_start",
    maxAttempts: 999,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  }), error => error instanceof StagingAudioCanaryRequestError && error.code === "audio_canary_status_http_503");
  assert.equal(calls, 6);
});

test("rejects another origin, source, decision, or malformed identity before it can be used", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json(status); };
  for (const override of [
    { attestedBaseUrl: "https://other.example.workers.dev" },
    { sourceKey: "users/user-1/inbox/../other.m4a" },
    { userId: "other-user" },
  ]) await assert.rejects(() => readStagingAudioCanaryStatus({ ...base, ...override, expectedDecision: "v3_pending_start", fetchImpl }), error => error instanceof StagingAudioCanaryRequestError);
  assert.equal(calls, 0);
  await assert.rejects(() => readStagingAudioCanaryStatus({ ...base, expectedDecision: "accepted", fetchImpl }), error => error instanceof StagingAudioCanaryRequestError);
  await assert.rejects(() => readStagingAudioCanaryStatus({ ...base, expectedDecision: "v3_pending_start", fetchImpl: async () => Response.json({ ...status, run_id: "bad" }) }), error => error instanceof StagingAudioCanaryRequestError);
  await assert.rejects(() => readStagingAudioCanaryStatus({ ...base, expectedDecision: "v3_pending_start", fetchImpl: async () => Response.json({ ...status, workspace_id: "other-workspace" }) }), error => error instanceof StagingAudioCanaryRequestError);
  await assert.rejects(() => readStagingAudioCanaryStatus({ ...base, expectedDecision: "v3_pending_start", minimumTranscriptCreatedAt: "2026-08-29T13:01:00.000Z", fetchImpl }), error => error instanceof StagingAudioCanaryRequestError);
});
