import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StagingManifestError, validateManifest } from "./render-staging-config.mjs";

function fail(code, message = code) {
  throw new StagingManifestError(code, message);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("staging_mining_config_invalid");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("staging_mining_config_invalid");
}

export function validateStagingMiningReadiness(manifestRaw, miningRaw) {
  const manifest = validateManifest(manifestRaw, "deploy");
  exactKeys(miningRaw, ["schema_version", "environment", "public_base_url", "r2_bucket_name", "handoff_enabled", "unscheduled"]);
  if (miningRaw.schema_version !== "vibepub-staging-mining-readiness.v1" || miningRaw.environment !== "staging" ||
      miningRaw.handoff_enabled !== true || miningRaw.unscheduled !== true ||
      miningRaw.public_base_url !== manifest.main.public_base_url || miningRaw.r2_bucket_name !== manifest.main.files_bucket) {
    fail("staging_mining_config_invalid", "Mining readiness config must exactly bind the approved staging main origin and R2 bucket");
  }
  return { public_base_url: manifest.main.public_base_url, r2_bucket_name: manifest.main.files_bucket };
}

async function main() {
  const [manifestPath, miningPath] = process.argv.slice(2);
  if (!manifestPath || !miningPath) throw new Error("usage: node infra/staging/validate-staging-mining-readiness.mjs <manifest.json> <mining.json>");
  const [manifest, mining] = await Promise.all([
    readFile(resolve(manifestPath), "utf8").then(JSON.parse),
    readFile(resolve(miningPath), "utf8").then(JSON.parse),
  ]);
  process.stdout.write(`${JSON.stringify(validateStagingMiningReadiness(manifest, mining))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingManifestError ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}
