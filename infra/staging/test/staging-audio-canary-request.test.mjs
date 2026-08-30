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
