import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deploymentEvidence } from "./record-staging-deployment-evidence.mjs";

const FIRST_WORKER_ABSENCE = /\b(?:error\s+)?code\s*(?:[:=]\s*|\s+)10007\b|\[\s*code\s*:\s*10007\s*\]/i;
const WORKER_NOT_FOUND = /\b(?:worker|script)\b[^\n]{0,120}\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\n]{0,120}\b(?:worker|script)\b|\bworkers\.api\.error\.script_not_found\b/i;

export function captureDeploymentBaseline(exitCode, stdout, stderr) {
  if (exitCode === 0) return deploymentEvidence(JSON.parse(stdout));
  if (FIRST_WORKER_ABSENCE.test(stderr) && WORKER_NOT_FOUND.test(stderr)) {
    return { active_deployment_id: null, created_on: null, active_versions: [], first_deployment: true };
  }
  throw new Error(`wrangler deployments list failed before bootstrap (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`);
}

async function main() {
  const [exitCodeRaw, stdoutPath, stderrPath, outputPath] = process.argv.slice(2);
  if (!exitCodeRaw || !stdoutPath || !stderrPath || !outputPath) {
    throw new Error("usage: node infra/staging/capture-staging-deployment-baseline.mjs <exit-code> <stdout.json> <stderr.txt> <output.json>");
  }
  const [stdout, stderr] = await Promise.all([readFile(stdoutPath, "utf8"), readFile(stderrPath, "utf8")]);
  const evidence = captureDeploymentBaseline(Number(exitCodeRaw), stdout, stderr);
  await writeFile(outputPath, JSON.stringify(evidence), "utf8");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
