import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function deploymentRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.deployments)) return value.deployments;
    if (Array.isArray(value.items)) return value.items;
  }
  throw new Error("wrangler deployments list returned an unsupported JSON shape");
}

export function deploymentEvidence(value) {
  const rows = deploymentRows(value);
  if (rows.length === 0) return { active_deployment_id: null, created_on: null, active_versions: [] };
  const normalized = rows.map(row => {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim() || typeof row.created_on !== "string" ||
        Number.isNaN(Date.parse(row.created_on)) || !Array.isArray(row.versions) || row.versions.length === 0) {
      throw new Error("wrangler deployment evidence is missing id, created_on, or non-empty versions");
    }
    const versions = row.versions.map(version => {
      if (!version || typeof version !== "object" || typeof version.version_id !== "string" || !version.version_id.trim() ||
          typeof version.percentage !== "number" || version.percentage < 0 || version.percentage > 100) {
        throw new Error("wrangler deployment evidence has an invalid active version");
      }
      return { version_id: version.version_id, percentage: version.percentage };
    });
    return { id: row.id, created_on: row.created_on, versions };
  });
  normalized.sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
  if (normalized.length > 1 && normalized[0].created_on === normalized[1].created_on) {
    throw new Error("wrangler deployment evidence has an ambiguous latest created_on timestamp");
  }
  const active = normalized[0];
  return { active_deployment_id: active.id, created_on: active.created_on, active_versions: active.versions };
}

export function requireActiveDeploymentEvidence(evidence) {
  if (!evidence.active_deployment_id || !evidence.created_on || evidence.active_versions.length !== 1 ||
      evidence.active_versions[0]?.percentage !== 100) {
    throw new Error("wrangler deployment evidence requires exactly one active version at 100 percent");
  }
  return evidence;
}

async function main() {
  const [path, label, mode] = process.argv.slice(2);
  if (!path || !label || (mode !== undefined && mode !== "--require-active")) {
    throw new Error("usage: node infra/staging/record-staging-deployment-evidence.mjs <deployments.json> <label> [--require-active]");
  }
  const parsed = deploymentEvidence(JSON.parse(await readFile(path, "utf8")));
  const evidence = mode === "--require-active" ? requireActiveDeploymentEvidence(parsed) : parsed;
  const versions = evidence.active_versions.map(version => `${version.version_id}@${version.percentage}%`).join(", ") || "none";
  const line = `- ${label}: deployment=${evidence.active_deployment_id ?? "none"}, created_on=${evidence.created_on ?? "none"}, versions=${versions}`;
  // Callers choose where the Markdown evidence is written. Do not append here:
  // GitHub workflows already redirect stdout to GITHUB_STEP_SUMMARY.
  process.stdout.write(`${line}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
