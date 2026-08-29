import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { evaluateCanaryCleanup, recheckCanaryCleanup } from "../staging-feedback-canary-watchdog.mjs";

const workflow = await readFile(new URL("../../../.github/workflows/staging-feedback-canary-watchdog.yml", import.meta.url), "utf8");
const runHash = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const candidateCommit = "a".repeat(40);
const health = (runId = "123", expiresAt = "2026-08-29T13:45:00.000Z") => ({
  ok: true,
  service: "vibepub-api",
  staging_feedback_canary: {
    configured: true,
    valid: true,
    operator_run_hash: runHash(runId),
    candidate_commit: candidateCommit,
    expires_at: expiresAt,
    cleanup_pending: false,
  },
});

test("workflow_run cleans only the exact completed canary run", () => {
  const plan = evaluateCanaryCleanup(health(), { eventName: "workflow_run", expectedOperatorRunId: "123", expectedCandidateCommit: candidateCommit, now: new Date("2026-08-29T13:10:00.000Z") });
  assert.equal(plan.restore, true);
  assert.equal(plan.candidate_commit, candidateCommit);
  assert.equal(evaluateCanaryCleanup(health("124"), { eventName: "workflow_run", expectedOperatorRunId: "123", now: new Date("2026-08-29T13:10:00.000Z") }).restore, false);
  assert.equal(evaluateCanaryCleanup(health(), { eventName: "workflow_run", expectedOperatorRunId: "123", expectedCandidateCommit: "b".repeat(40), now: new Date("2026-08-29T13:10:00.000Z") }).restore, false);
});

test("scheduled watchdog cleans expired canaries and leaves live or closed state alone", () => {
  assert.equal(evaluateCanaryCleanup(health(), { eventName: "schedule", now: new Date("2026-08-29T14:00:00.000Z") }).restore, true);
  assert.equal(evaluateCanaryCleanup(health(), { eventName: "schedule", now: new Date("2026-08-29T13:00:00.000Z") }).restore, false);
  assert.equal(evaluateCanaryCleanup({ ok: true, service: "vibepub-api", staging_feedback_canary: null }, { eventName: "schedule", now: new Date() }).restore, false);
  assert.equal(evaluateCanaryCleanup({
    ok: true, service: "vibepub-api", staging_feedback_canary: {
      configured: true, valid: true, operator_run_hash: runHash("123"), expires_at: null, cleanup_pending: true,
      candidate_commit: candidateCommit,
    },
  }, { eventName: "schedule", now: new Date("2026-08-29T13:00:00.000Z") }).restore, true);
});

test("unknown metadata fails closed and a changed marker aborts cleanup", () => {
  assert.throws(() => evaluateCanaryCleanup({ ...health(), staging_feedback_canary: { configured: true, valid: false } }, { eventName: "schedule", now: new Date() }), /watchdog_health_invalid/);
  const plan = evaluateCanaryCleanup(health(), { eventName: "workflow_run", expectedOperatorRunId: "123", expectedCandidateCommit: candidateCommit, now: new Date() });
  assert.throws(() => recheckCanaryCleanup(health("124"), plan), /watchdog_canary_changed/);
  assert.equal(recheckCanaryCleanup(health(), plan).restore, true);
});

test("independent watchdog is protected, serialized, and restores main before providers", () => {
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /workflows: \["Staging Article Feedback Audio Canary"\]/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(workflow, /environment: vibepub-staging/);
  assert.match(workflow, /group: vibepub-staging-deploy/);
  assert.match(workflow, /staging-feedback-canary-watchdog\.mjs plan/);
  assert.match(workflow, /staging-feedback-canary-watchdog\.mjs recheck/);
  assert.match(workflow, /ref: \$\{\{ steps\.plan\.outputs\.candidate_commit \}\}/);
  assert.match(workflow, /DEPLOY_COMMIT:\$\{CANDIDATE_COMMIT\}/);
  const main = workflow.indexOf("Restore the permanent main baseline");
  const image = workflow.indexOf("Restore the permanent image baseline");
  const wechat = workflow.indexOf("Restore the permanent WeChat baseline");
  const marker = workflow.indexOf("Remove the main cleanup marker");
  assert.ok(main > 0 && main < image && image < wechat && wechat < marker);
  assert.match(workflow, /STAGING_FEEDBACK_CANARY_CLEANUP_MARKER_HASH/);
  assert.doesNotMatch(workflow, /artifact|settings|versions view/);
});
