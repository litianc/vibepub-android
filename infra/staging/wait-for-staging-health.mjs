import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { STAGING_HEALTH_ADAPTER_ROLES, verifyStagingHealth } from "./verify-staging-health.mjs";

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 60;
const MAX_DELAY_MS = 60_000;
const MAX_HEALTH_BYTES = 1024 * 1024;
const DEPLOYMENT_MARKER = /^sha256:[a-f0-9]{64}$/;
const ADAPTER_ROLE_SET = new Set(STAGING_HEALTH_ADAPTER_ROLES);

export class StagingHealthWaitError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "StagingHealthWaitError";
    this.code = code;
  }
}

function terminalStatus(status) {
  return status >= 400 && status < 500 && status !== 404 && status !== 429;
}

function requestInit() {
  const init = { redirect: "manual" };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    init.signal = AbortSignal.timeout(30_000);
  }
  return init;
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || !options.url || !options.sha || !options.ref ||
      typeof options.expectedDeploymentMarkers?.main !== "string" ||
      !DEPLOYMENT_MARKER.test(options.expectedDeploymentMarkers.main)) {
    throw new StagingHealthWaitError("staging_health_wait_invalid", "staging health wait options are invalid");
  }
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS ||
      !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new StagingHealthWaitError("staging_health_wait_invalid", "staging health wait bounds are invalid");
  }
  const requiredAdapters = options.requiredAdapters;
  if (requiredAdapters !== undefined &&
      (!Array.isArray(requiredAdapters) || requiredAdapters.some(role => typeof role !== "string" || !ADAPTER_ROLE_SET.has(role)) ||
       new Set(requiredAdapters).size !== requiredAdapters.length)) {
    throw new StagingHealthWaitError("staging_health_wait_invalid", "staging required adapter set is invalid");
  }
  return { attempts, delayMs, requiredAdapters };
}

export async function waitForStagingHealth(options) {
  const { attempts, delayMs, requiredAdapters } = validateOptions(options);
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
  const onRetry = options.onRetry || (() => {});

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    let validationError;
    try {
      response = await fetchImpl(options.url, requestInit());
    } catch {
      response = undefined;
    }
    const status = Number(response?.status || 0);

    if (status === 200) {
      const payload = await readHealthJson(response);
      if (payload) {
        try {
          return verifyStagingHealth(
            payload,
            options.sha,
            options.ref,
            options.expectedMainDeployedAt,
            options.expectedAdapters || {},
            options.expectedOperatorRunHash,
            options.expectedDeploymentMarkers || {},
            requiredAdapters,
          );
        } catch (error) {
          validationError = error;
        }
      } else {
        validationError = new Error("staging health response is not JSON");
      }
    } else if (terminalStatus(status)) {
      throw new StagingHealthWaitError(
        "staging_health_terminal",
        `staging canary health returned terminal HTTP ${status}`,
      );
    }

    if (attempt === attempts) {
      throw new StagingHealthWaitError(
        "staging_health_not_converged",
        "staging canary deployment evidence did not converge",
      );
    }
    onRetry({ attempt, attempts, status, error: validationError });
    await sleep(delayMs);
  }

  throw new StagingHealthWaitError("staging_health_not_converged", "staging canary deployment evidence did not converge");
}

async function readHealthJson(response) {
  try {
    const contentLength = response.headers?.get("content-length");
    if (contentLength && Number.isSafeInteger(Number(contentLength)) && Number(contentLength) > MAX_HEALTH_BYTES) return null;
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_HEALTH_BYTES) return null;
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HEALTH_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseRequiredAdapters(value) {
  if (value === undefined) return undefined;
  if (value === "none") return [];
  return value.split(",").filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  const url = option(args, "--url");
  const out = option(args, "--out");
  const sha = option(args, "--commit");
  const ref = option(args, "--ref");
  const expectedDeploymentMarker = option(args, "--expected-deployment-marker");
  const requiredAdaptersArg = option(args, "--required-adapters");
  if (!url || !out || !sha || !ref || !expectedDeploymentMarker) {
    throw new StagingHealthWaitError("usage_invalid", "usage: wait-for-staging-health.mjs --url <url> --out <file> --commit <sha> --ref <ref> --expected-deployment-marker <sha256:...> [--required-adapters none|writing,review,image,wechat]");
  }
  const expectedAdapters = {
    ...(option(args, "--expected-image-deployed-at") ? { image: option(args, "--expected-image-deployed-at") } : {}),
    ...(option(args, "--expected-wechat-deployed-at") ? { wechat: option(args, "--expected-wechat-deployed-at") } : {}),
  };
  const expectedDeploymentMarkers = {
    ...(option(args, "--expected-deployment-marker") ? { main: option(args, "--expected-deployment-marker") } : {}),
    adapters: {
      ...(option(args, "--expected-image-deployment-marker") ? { image: option(args, "--expected-image-deployment-marker") } : {}),
      ...(option(args, "--expected-wechat-deployment-marker") ? { wechat: option(args, "--expected-wechat-deployment-marker") } : {}),
    },
  };
  const evidence = await waitForStagingHealth({
    url,
    sha,
    ref,
    expectedMainDeployedAt: option(args, "--expected-main-deployed-at"),
    expectedOperatorRunHash: option(args, "--expected-operator-run-hash"),
    expectedDeploymentMarkers: { main: expectedDeploymentMarker, ...expectedDeploymentMarkers },
    requiredAdapters: parseRequiredAdapters(requiredAdaptersArg),
    expectedAdapters,
    attempts: Number(option(args, "--attempts") || DEFAULT_ATTEMPTS),
    delayMs: Number(option(args, "--delay-ms") || DEFAULT_DELAY_MS),
    onRetry: ({ attempt, attempts, status }) => {
      process.stdout.write(`Stale or unavailable Staging health evidence (attempt ${attempt}/${attempts}, HTTP ${status || "000"}); waiting for propagation\n`);
    },
  });
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
