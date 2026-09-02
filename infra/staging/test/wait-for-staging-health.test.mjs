import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForStagingHealth } from "../wait-for-staging-health.mjs";

const commit = "a".repeat(40);
const ref = "main";
const oldTime = "2026-09-02T03:40:22.000Z";
const mainTime = "2026-09-02T03:50:35.123Z";
const imageTime = "2026-09-02T03:50:36.456Z";
const wechatTime = "2026-09-02T03:50:37.789Z";
const oldOperatorRunHash = `sha256:${"1".repeat(64)}`;
const operatorRunHash = `sha256:${"2".repeat(64)}`;
const oldDeploymentMarker = `sha256:${"3".repeat(64)}`;
const deploymentMarker = `sha256:${"4".repeat(64)}`;

function health(mainDeployedAt, imageDeployedAt = imageTime, wechatDeployedAt = wechatTime, canaryMarker = operatorRunHash, marker = deploymentMarker) {
  const version = { commit, ref, deployed_at: mainDeployedAt };
  return {
    ok: true,
    service: "vibepub-api",
    version: { ...version, deployment_marker: marker },
    staging_feedback_canary: {
      configured: true,
      valid: true,
      operator_run_hash: canaryMarker,
      candidate_commit: commit,
      expires_at: "2026-09-02T04:30:00.000Z",
      cleanup_pending: false,
    },
    adapters: {
      writing: { service: "writing-agent", version },
      review: { service: "editorial-review-agent", version },
      image: { service: "image-generation-adapter", version: { ...version, deployed_at: imageDeployedAt, deployment_marker: marker } },
      wechat: { service: "wechat-publishing-adapter", version: { ...version, deployed_at: wechatDeployedAt, deployment_marker: marker } },
    },
  };
}

test("waits through stale health evidence and returns only after all canary markers converge", async () => {
  const responses = [
    Response.json(health(oldTime, oldTime, oldTime, oldOperatorRunHash, oldDeploymentMarker)),
    Response.json(health(mainTime, imageTime, wechatTime)),
  ];
  let calls = 0;
  const sleeps = [];
  const result = await waitForStagingHealth({
    url: "https://staging.example.test/health?adapters=1",
    sha: commit,
    ref,
    expectedMainDeployedAt: mainTime,
    expectedAdapters: { image: imageTime, wechat: wechatTime },
    expectedOperatorRunHash: operatorRunHash,
    expectedDeploymentMarkers: { main: deploymentMarker, adapters: { image: deploymentMarker, wechat: deploymentMarker } },
    attempts: 3,
    delayMs: 17,
    fetchImpl: async () => responses[calls++],
    sleep: async delay => sleeps.push(delay),
  });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [17]);
  assert.equal(result.main.deployed_at, mainTime);
  assert.equal(result.adapters.image.deployed_at, imageTime);
  assert.deepEqual(result.canary, {
    operator_run_hash: operatorRunHash,
    candidate_commit: commit,
    expires_at: "2026-09-02T04:30:00.000Z",
    cleanup_pending: false,
  });
});

test("transcribe mode accepts existing adapter releases while proving the new main release", async () => {
  const payload = health(mainTime);
  payload.adapters.writing.version = { ...payload.adapters.writing.version, commit: "b".repeat(40), ref: "old-main" };
  payload.adapters.review.version = { ...payload.adapters.review.version, commit: "c".repeat(40), ref: "old-main" };
  payload.adapters.image.version = { ...payload.adapters.image.version, commit: "d".repeat(40), ref: "old-main" };
  payload.adapters.wechat.version = { ...payload.adapters.wechat.version, commit: "e".repeat(40), ref: "old-main" };

  const result = await waitForStagingHealth({
    url: "https://staging.example.test/health?adapters=1",
    sha: commit,
    ref,
    expectedMainDeployedAt: mainTime,
    expectedOperatorRunHash: operatorRunHash,
    expectedDeploymentMarkers: { main: deploymentMarker },
    requiredAdapters: [],
    attempts: 1,
    fetchImpl: async () => Response.json(payload),
    sleep: async () => {},
  });

  assert.equal(result.main.commit, commit);
  assert.equal(result.adapters.image.commit, "d".repeat(40));
  assert.equal(result.canary.candidate_commit, commit);
});

test("stops after the bounded attempts when the old deployment never propagates", async () => {
  let calls = 0;
  await assert.rejects(
    () => waitForStagingHealth({
      url: "https://staging.example.test/health?adapters=1",
      sha: commit,
      ref,
      expectedMainDeployedAt: mainTime,
      expectedAdapters: { image: imageTime, wechat: wechatTime },
      expectedOperatorRunHash: operatorRunHash,
      expectedDeploymentMarkers: { main: deploymentMarker, adapters: { image: deploymentMarker, wechat: deploymentMarker } },
      attempts: 3,
      delayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return Response.json(health(mainTime, imageTime, wechatTime, oldOperatorRunHash, oldDeploymentMarker));
      },
      sleep: async () => {},
    }),
    /staging canary deployment evidence did not converge/,
  );
  assert.equal(calls, 3);
});

test("does not retry a terminal health response", async () => {
  let calls = 0;
  await assert.rejects(
    () => waitForStagingHealth({
      url: "https://staging.example.test/health?adapters=1",
      sha: commit,
      ref,
      expectedMainDeployedAt: mainTime,
      expectedDeploymentMarkers: { main: deploymentMarker },
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 403 });
      },
      sleep: async () => {},
    }),
    /staging canary health returned terminal HTTP 403/,
  );
  assert.equal(calls, 1);
});

test("refuses to wait without an exact main deployment marker", async () => {
  let calls = 0;
  await assert.rejects(
    () => waitForStagingHealth({
      url: "https://staging.example.test/health?adapters=1",
      sha: commit,
      ref,
      expectedMainDeployedAt: mainTime,
      fetchImpl: async () => {
        calls += 1;
        return Response.json(health(mainTime));
      },
      sleep: async () => {},
    }),
    /staging health wait options are invalid/,
  );
  assert.equal(calls, 0);
});

test("rejects an oversized health response before passing it to the verifier", async () => {
  let calls = 0;
  const oversized = new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) }), { status: 200 });
  await assert.rejects(
    () => waitForStagingHealth({
      url: "https://staging.example.test/health?adapters=1",
      sha: commit,
      ref,
      expectedMainDeployedAt: mainTime,
      expectedDeploymentMarkers: { main: deploymentMarker },
      attempts: 1,
      fetchImpl: async () => {
        calls += 1;
        return oversized;
      },
      sleep: async () => {},
    }),
    /staging canary deployment evidence did not converge/,
  );
  assert.equal(calls, 1);
});
