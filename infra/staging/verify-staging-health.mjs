import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ADAPTERS = {
  writing: "writing-agent",
  review: "editorial-review-agent",
  image: "image-generation-adapter",
  wechat: "wechat-publishing-adapter",
};

function validVersion(value, sha, ref) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    value.commit === sha && value.ref === ref &&
    typeof value.deployed_at === "string" && !Number.isNaN(Date.parse(value.deployed_at)));
}

export function verifyStagingHealth(payload, sha, ref) {
  if (!payload || typeof payload !== "object" || payload.ok !== true || payload.service !== "vibepub-api" || !validVersion(payload.version, sha, ref)) {
    throw new Error("staging main health version evidence is invalid");
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
    if (!adapter || adapter.service !== service || !validVersion(adapter.version, sha, ref)) {
      throw new Error(`staging ${role} adapter health version evidence is invalid`);
    }
  }
  return {
    main: payload.version,
    adapters: Object.fromEntries(Object.entries(payload.adapters).map(([role, adapter]) => [role, adapter.version])),
  };
}

async function main() {
  const [path, sha, ref] = process.argv.slice(2);
  if (!path || !sha || !ref) throw new Error("usage: node infra/staging/verify-staging-health.mjs <health.json> <commit-sha> <ref>");
  const evidence = verifyStagingHealth(JSON.parse(await readFile(path, "utf8")), sha, ref);
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
