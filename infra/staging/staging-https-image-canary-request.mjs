import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUN_ID = /^run_v3_[a-f0-9]{64}$/;
const HANDOFF_ID = /^handoff_v3_[a-f0-9]{64}$/;

export class StagingHttpsCanaryRequestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new StagingHttpsCanaryRequestError(code);
}

function exactBaseUrl(value, attestedValue) {
  let parsed;
  let attested;
  try { parsed = new URL(value); } catch { fail("canary_base_url_invalid"); }
  try { attested = new URL(attestedValue); } catch { fail("canary_base_url_invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "") || !parsed.hostname.endsWith(".workers.dev") ||
      attested.protocol !== "https:" || attested.username || attested.password || attested.search || attested.hash ||
      (attested.pathname !== "/" && attested.pathname !== "") || !attested.hostname.endsWith(".workers.dev") ||
      attested.origin !== parsed.origin) {
    fail("canary_base_url_invalid");
  }
  return parsed.origin;
}

function exactCanary(raw) {
  const identity = raw?.identity;
  const grant = raw?.grant;
  if (!identity || typeof identity !== "object" || !grant || typeof grant !== "object" ||
      !RUN_ID.test(identity.run_id) || !HANDOFF_ID.test(identity.handoff_id) ||
      grant.scope?.run_id !== identity.run_id || grant.source?.handoff_id !== identity.handoff_id ||
      grant.source?.key !== identity.source_key) {
    fail("canary_identity_invalid");
  }
  return identity;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail("canary_response_invalid");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) fail("canary_response_invalid");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("canary_response_invalid");
    return value;
  } catch (error) {
    if (error instanceof StagingHttpsCanaryRequestError) throw error;
    fail("canary_response_invalid");
  }
}

async function postJson({ baseUrl, attestedBaseUrl, path, token, body, fetchImpl, timeoutMs }) {
  if (typeof token !== "string" || token.length < 16 || token.length > 4096) fail("canary_token_invalid");
  let response;
  try {
    response = await fetchImpl(`${exactBaseUrl(baseUrl, attestedBaseUrl)}${path}`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof StagingHttpsCanaryRequestError) throw error;
    fail("canary_request_failed");
  }
  return { status: response.status, body: await boundedJson(response) };
}

export async function startCanaryHandoff({ baseUrl, attestedBaseUrl, canary, token, fetchImpl = fetch }) {
  const identity = exactCanary(canary);
  const eligibility = await postJson({
    baseUrl,
    attestedBaseUrl,
    path: "/api/internal/v3/mining-handoffs/eligibility",
    token,
    body: { source_key: identity.source_key },
    fetchImpl,
    timeoutMs: 30_000,
  });
  if (eligibility.status !== 200 || eligibility.body.decision !== "v3" || eligibility.body.handoff_id !== identity.handoff_id) {
    fail("canary_eligibility_invalid");
  }
  const started = await postJson({
    baseUrl,
    attestedBaseUrl,
    path: "/api/internal/v3/mining-handoffs/start",
    token,
    body: { source_key: identity.source_key, handoff_id: identity.handoff_id },
    fetchImpl,
    timeoutMs: 45_000,
  });
  if (started.status !== 202 || started.body.decision !== "accepted" || started.body.run_id !== identity.run_id || started.body.replayed !== false) {
    fail("canary_start_replayed_or_invalid");
  }
  return { eligibility: eligibility.body, started: started.body };
}

export async function probeClosedCanary({ baseUrl, attestedBaseUrl, canary, token, fetchImpl = fetch }) {
  const identity = exactCanary(canary);
  const probe = await postJson({
    baseUrl,
    attestedBaseUrl,
    path: "/api/internal/v3/mining-handoffs/eligibility",
    token,
    body: { source_key: identity.source_key },
    fetchImpl,
    timeoutMs: 30_000,
  });
  if (probe.status !== 202 || probe.body.decision !== "v3_hold" || probe.body.reason !== "v3_disabled_after_marker") {
    fail("canary_cleanup_probe_invalid");
  }
  return probe.body;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const baseUrl = option(args, "--base-url");
  const canaryPath = option(args, "--canary");
  const token = process.env.MINING_V3_HANDOFF_TOKEN;
  const attestedBaseUrl = process.env.STAGING_ATTESTED_BASE_URL;
  if (!baseUrl || !canaryPath) fail("usage_invalid");
  const canary = JSON.parse(await readFile(resolve(canaryPath), "utf8"));
  if (command === "start") {
    const eligibilityOut = option(args, "--eligibility-out");
    const startOut = option(args, "--start-out");
    if (!eligibilityOut || !startOut) fail("usage_invalid");
    const result = await startCanaryHandoff({ baseUrl, attestedBaseUrl, canary, token });
    await writeFile(resolve(eligibilityOut), `${JSON.stringify(result.eligibility, null, 2)}\n`, "utf8");
    await writeFile(resolve(startOut), `${JSON.stringify(result.started, null, 2)}\n`, "utf8");
    return;
  }
  if (command === "probe") {
    const out = option(args, "--out");
    if (!out) fail("usage_invalid");
    const result = await probeClosedCanary({ baseUrl, attestedBaseUrl, canary, token });
    await writeFile(resolve(out), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return;
  }
  fail("usage_invalid");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingHttpsCanaryRequestError ? error.code : "canary_request_failed"}\n`);
    process.exitCode = 1;
  });
}
