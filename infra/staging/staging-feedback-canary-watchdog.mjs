import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HASH = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fail() {
  throw new Error("watchdog_health_invalid");
}

function canaryFromHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true || value.service !== "vibepub-api") fail();
  if (value.staging_feedback_canary === null) return null;
  const canary = value.staging_feedback_canary;
  if (!canary || typeof canary !== "object" || Array.isArray(canary) || canary.configured !== true || canary.valid !== true ||
      !HASH.test(String(canary.operator_run_hash || "")) || !COMMIT.test(String(canary.candidate_commit || "")) ||
      typeof canary.cleanup_pending !== "boolean") fail();
  if (canary.cleanup_pending === true) {
    if (canary.expires_at !== null) fail();
  } else if (typeof canary.expires_at !== "string" || !Number.isFinite(Date.parse(canary.expires_at)) ||
      new Date(Date.parse(canary.expires_at)).toISOString() !== canary.expires_at) fail();
  return { operator_run_hash: canary.operator_run_hash, candidate_commit: canary.candidate_commit,
    expires_at: canary.expires_at, cleanup_pending: canary.cleanup_pending };
}

function runHash(value) {
  if (!/^\d{1,20}$/.test(value)) throw new Error("watchdog_run_invalid");
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function evaluateCanaryCleanup(health, options) {
  const canary = canaryFromHealth(health);
  if (!canary) return { restore: false, marker_hash: null, candidate_commit: null };
  if (options.eventName === "workflow_run") {
    const expectedCommit = String(options.expectedCandidateCommit || "");
    if (canary.operator_run_hash !== runHash(String(options.expectedOperatorRunId || "")) ||
        !COMMIT.test(expectedCommit) || canary.candidate_commit !== expectedCommit) {
      return { restore: false, marker_hash: canary.operator_run_hash, candidate_commit: canary.candidate_commit };
    }
    return { restore: true, marker_hash: canary.operator_run_hash, candidate_commit: canary.candidate_commit };
  }
  if (options.eventName !== "schedule" && options.eventName !== "workflow_dispatch") throw new Error("watchdog_event_invalid");
  const now = options.now instanceof Date ? options.now : new Date();
  return { restore: canary.cleanup_pending || Date.parse(canary.expires_at) <= now.getTime(),
    marker_hash: canary.operator_run_hash, candidate_commit: canary.candidate_commit };
}

export function recheckCanaryCleanup(health, plan) {
  if (plan?.restore !== true || !HASH.test(String(plan.marker_hash || "")) || !COMMIT.test(String(plan.candidate_commit || ""))) throw new Error("watchdog_plan_invalid");
  const canary = canaryFromHealth(health);
  if (!canary || canary.operator_run_hash !== plan.marker_hash || canary.candidate_commit !== plan.candidate_commit) throw new Error("watchdog_canary_changed");
  return plan;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? "" : String(args[index + 1] || "");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const healthFile = option(args, "--health");
  const output = option(args, "--out");
  if (!healthFile || !output) throw new Error("watchdog_usage_invalid");
  const health = JSON.parse(await readFile(resolve(healthFile), "utf8"));
  if (command === "plan") {
    const plan = evaluateCanaryCleanup(health, {
      eventName: option(args, "--event"),
      expectedOperatorRunId: option(args, "--expected-run-id"),
      expectedCandidateCommit: option(args, "--expected-candidate-commit"),
    });
    await writeFile(resolve(output), JSON.stringify(plan, null, 2), "utf8");
    return;
  }
  if (command === "recheck") {
    const planFile = option(args, "--plan");
    if (!planFile) throw new Error("watchdog_usage_invalid");
    const plan = JSON.parse(await readFile(resolve(planFile), "utf8"));
    await writeFile(resolve(output), JSON.stringify(recheckCanaryCleanup(health, plan), null, 2), "utf8");
    return;
  }
  throw new Error("watchdog_usage_invalid");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "watchdog_failed"}\n`);
    process.exitCode = 1;
  });
}
