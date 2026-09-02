import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ADAPTERS = {
  writing: "writing-agent",
  review: "editorial-review-agent",
  image: "image-generation-adapter",
  wechat: "wechat-publishing-adapter",
};
export const STAGING_HEALTH_ADAPTER_ROLES = Object.freeze(Object.keys(ADAPTERS));
const ADAPTER_ROLE_SET = new Set(STAGING_HEALTH_ADAPTER_ROLES);

function validVersion(value, sha, ref, requireRelease) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.commit === "string" && typeof value.ref === "string" &&
    (!requireRelease || (value.commit === sha && value.ref === ref)) &&
    typeof value.deployed_at === "string" && !Number.isNaN(Date.parse(value.deployed_at)));
}

function normalizeRequiredAdapters(requiredAdapters) {
  const roles = requiredAdapters ?? STAGING_HEALTH_ADAPTER_ROLES;
  if (!Array.isArray(roles) || roles.some(role => typeof role !== "string" || !ADAPTER_ROLE_SET.has(role)) ||
      new Set(roles).size !== roles.length) {
    throw new Error("staging required adapter set is invalid");
  }
  return new Set(roles);
}

function safeVersion(value) {
  const result = {
    commit: value.commit,
    ref: value.ref,
    deployed_at: value.deployed_at,
  };
  if (typeof value.deployment_marker === "string" && value.deployment_marker.trim()) {
    result.deployment_marker = value.deployment_marker;
  }
  return result;
}

export function verifyStagingHealth(
  payload,
  sha,
  ref,
  expectedMainDeployedAt,
  expectedAdapters = {},
  expectedOperatorRunHash,
  expectedDeploymentMarkers = {},
  requiredAdapters,
) {
  const requiredAdapterSet = normalizeRequiredAdapters(requiredAdapters);
  if (!payload || typeof payload !== "object" || payload.ok !== true || payload.service !== "vibepub-api" || !validVersion(payload.version, sha, ref, true)) {
    throw new Error("staging main health version evidence is invalid");
  }
  if (expectedMainDeployedAt) {
    if (payload.version.deployed_at !== expectedMainDeployedAt) {
      throw new Error("staging main deployment marker is stale");
    }
  }
  if (expectedOperatorRunHash) {
    const canary = payload.staging_feedback_canary;
    if (!canary || typeof canary !== "object" || Array.isArray(canary) ||
        canary.configured !== true || canary.valid !== true ||
        canary.operator_run_hash !== expectedOperatorRunHash ||
        canary.candidate_commit !== sha || typeof canary.expires_at !== "string" ||
        Number.isNaN(Date.parse(canary.expires_at)) || canary.cleanup_pending !== false) {
      throw new Error("staging main canary marker is stale");
    }
  }
  if (expectedDeploymentMarkers?.main && payload.version.deployment_marker !== expectedDeploymentMarkers.main) {
    throw new Error("staging main deployment marker is stale");
  }
  if (!payload.adapters || typeof payload.adapters !== "object" || Array.isArray(payload.adapters)) {
    throw new Error("staging private adapter health evidence is missing");
  }
  const keys = Object.keys(payload.adapters).sort();
  if (keys.length !== 4 || keys.some((key, index) => key !== Object.keys(ADAPTERS).sort()[index])) {
    throw new Error("staging private adapter health evidence has an invalid component set");
  }
  for (const [role, service] of Object.entries(ADAPTERS)) {
    const adapter = payload.adapters[role];
    if (!adapter || adapter.service !== service || !validVersion(adapter.version, sha, ref, requiredAdapterSet.has(role))) {
      throw new Error(`staging ${role} adapter health version evidence is invalid`);
    }
    const expectedDeployedAt = expectedAdapters?.[role];
    if (expectedDeployedAt && adapter.version.deployed_at !== expectedDeployedAt) {
      throw new Error(`staging ${role} adapter deployment marker is stale`);
    }
    const expectedDeploymentMarker = expectedDeploymentMarkers?.adapters?.[role];
    if (expectedDeploymentMarker && adapter.version.deployment_marker !== expectedDeploymentMarker) {
      throw new Error(`staging ${role} adapter deployment marker is stale`);
    }
  }
  return {
    main: safeVersion(payload.version),
    adapters: Object.fromEntries(Object.entries(payload.adapters).map(([role, adapter]) => [role, safeVersion(adapter.version)])),
    ...(expectedOperatorRunHash ? {
      canary: {
        operator_run_hash: payload.staging_feedback_canary.operator_run_hash,
        candidate_commit: payload.staging_feedback_canary.candidate_commit,
        expires_at: payload.staging_feedback_canary.expires_at,
        cleanup_pending: payload.staging_feedback_canary.cleanup_pending,
      },
    } : {}),
  };
}

async function main() {
  const [path, sha, ref, expectedMainDeployedAt, expectedImageDeployedAt, expectedWechatDeployedAt, expectedOperatorRunHash, expectedDeploymentMarker, expectedImageDeploymentMarker, expectedWechatDeploymentMarker, requiredAdaptersArg] = process.argv.slice(2);
  if (!path || !sha || !ref) throw new Error("usage: node infra/staging/verify-staging-health.mjs <health.json> <commit-sha> <ref> [main-deployed-at] [image-deployed-at] [wechat-deployed-at] [operator-run-hash] [deployment-marker] [image-marker] [wechat-marker] [required-adapters]");
  const expectedAdapters = {
    ...(expectedImageDeployedAt ? { image: expectedImageDeployedAt } : {}),
    ...(expectedWechatDeployedAt ? { wechat: expectedWechatDeployedAt } : {}),
  };
  const expectedDeploymentMarkers = {
    ...(expectedDeploymentMarker ? { main: expectedDeploymentMarker } : {}),
    adapters: {
      ...(expectedImageDeploymentMarker ? { image: expectedImageDeploymentMarker } : {}),
      ...(expectedWechatDeploymentMarker ? { wechat: expectedWechatDeploymentMarker } : {}),
    },
  };
  const requiredAdapters = requiredAdaptersArg === undefined ? undefined : requiredAdaptersArg === "none" ? [] : requiredAdaptersArg.split(",").filter(Boolean);
  const evidence = verifyStagingHealth(JSON.parse(await readFile(path, "utf8")), sha, ref, expectedMainDeployedAt, expectedAdapters, expectedOperatorRunHash, expectedDeploymentMarkers, requiredAdapters);
  const lines = [
    `- main: commit=${evidence.main.commit}, ref=${evidence.main.ref}, deployed_at=${evidence.main.deployed_at}`,
    ...Object.entries(evidence.adapters).map(([role, version]) => `- ${role}: commit=${version.commit}, ref=${version.ref}, deployed_at=${version.deployed_at}`),
  ];
  if (process.env.GITHUB_STEP_SUMMARY) await import("node:fs/promises").then(({ appendFile }) => appendFile(process.env.GITHUB_STEP_SUMMARY, `## Staging health/version evidence\n${lines.join("\n")}\n`));
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
