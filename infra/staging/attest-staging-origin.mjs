import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StagingManifestError, validateManifest } from "./render-staging-config.mjs";

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

function fail(code, message = code) {
  throw new StagingManifestError(code, message);
}

function workersDevAccountLabel(origin) {
  const hostname = new URL(origin).hostname;
  const labels = hostname.split(".");
  // validateManifest has already proven the complete workers.dev origin shape.
  return labels[1];
}

export function validateStagingOriginInputs(manifestRaw, expectedOrigin, accountId) {
  const manifest = validateManifest(manifestRaw, "deploy");
  if (typeof expectedOrigin !== "string" || expectedOrigin !== manifest.main.public_base_url) {
    fail("staging_origin_mismatch", "STAGING_PUBLIC_BASE_URL must exactly match the approved manifest origin");
  }
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
    fail("staging_account_id_invalid", "CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters");
  }
  return { manifest, accountLabel: workersDevAccountLabel(manifest.main.public_base_url) };
}

export function validateStagingOriginAttestation(manifestRaw, expectedOrigin, accountId, subdomainResponse) {
  const { accountLabel } = validateStagingOriginInputs(manifestRaw, expectedOrigin, accountId);
  if (!subdomainResponse || typeof subdomainResponse !== "object" || Array.isArray(subdomainResponse) ||
      subdomainResponse.success !== true || !subdomainResponse.result || typeof subdomainResponse.result !== "object" ||
      Array.isArray(subdomainResponse.result) || typeof subdomainResponse.result.subdomain !== "string" ||
      subdomainResponse.result.subdomain !== accountLabel) {
    fail("staging_workers_subdomain_mismatch", "the account-scoped Workers subdomain does not prove the approved staging origin");
  }
  return { manifest_sha_bound: true, origin_attested: true };
}

async function main() {
  const args = process.argv.slice(2);
  const preflight = args[0] === "--preflight";
  const [manifestPath, expectedOrigin, accountId, subdomainPath] = preflight ? args.slice(1) : args;
  if (preflight) {
    if (!manifestPath || !expectedOrigin || !accountId || subdomainPath) {
      throw new Error("usage: node infra/staging/attest-staging-origin.mjs --preflight <manifest.json> <expected-origin> <account-id>");
    }
    const manifest = await readFile(manifestPath, "utf8").then(JSON.parse);
    validateStagingOriginInputs(manifest, expectedOrigin, accountId);
    process.stdout.write("staging origin inputs validated\n");
    return;
  }
  if (!manifestPath || !expectedOrigin || !accountId || !subdomainPath) {
    throw new Error("usage: node infra/staging/attest-staging-origin.mjs <manifest.json> <expected-origin> <account-id> <workers-subdomain.json>");
  }
  const manifest = await readFile(manifestPath, "utf8").then(JSON.parse);
  const response = await readFile(subdomainPath, "utf8").then(JSON.parse);
  validateStagingOriginAttestation(manifest, expectedOrigin, accountId, response);
  process.stdout.write("staging origin attested\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingManifestError ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}
