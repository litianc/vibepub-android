import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateManifest } from "./render-staging-config.mjs";

const MAX_SQL_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class StagingD1QueryError extends Error {
  constructor(code, message = code, diagnostic = undefined, retryable = false) {
    super(message);
    this.name = "StagingD1QueryError";
    this.code = code;
    this.diagnostic = diagnostic;
    this.retryable = retryable;
  }
}

function fail(code, message = code) {
  throw new StagingD1QueryError(code, message);
}

export function validateReadOnlySql(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > MAX_SQL_BYTES) {
    fail("staging_d1_sql_size_invalid");
  }
  const trimmed = value.trim();
  if (trimmed.includes("--") || trimmed.includes("/*") || trimmed.includes("*/")) {
    fail("staging_d1_sql_comment_forbidden");
  }
  const statement = trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed;
  if (!statement || statement.includes(";") || !/^SELECT\b/i.test(statement)) {
    fail("staging_d1_sql_not_single_select");
  }
  if (/\b(?:ATTACH|ALTER|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REINDEX|REPLACE|UPDATE|VACUUM)\b/i.test(statement)) {
    fail("staging_d1_sql_mutation_forbidden");
  }
  return statement;
}

export function stagingD1Target(manifest) {
  let validated;
  try {
    validated = validateManifest(manifest, "deploy");
  } catch {
    fail("staging_d1_manifest_invalid");
  }
  const database = validated.main.d1;
  return { name: database.name, id: database.id };
}

async function boundedJson(response) {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    fail("staging_d1_response_oversized");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) fail("staging_d1_response_oversized");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail("staging_d1_response_invalid");
  }
}

export async function queryStagingD1({ manifest, sql, accountId, apiToken, fetchImpl = fetch }) {
  const database = stagingD1Target(manifest);
  const statement = validateReadOnlySql(sql);
  if (!/^[a-f0-9]{32}$/i.test(accountId || "")) fail("staging_d1_account_invalid");
  if (typeof apiToken !== "string" || apiToken.length < 16) fail("staging_d1_token_missing");

  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${database.id}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql: statement }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new StagingD1QueryError("staging_d1_query_unavailable", "staging_d1_query_unavailable", {
      http_status: null,
      error_codes: [],
      statement_success: false,
    }, true);
  }
  const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
  let body;
  try {
    body = await boundedJson(response);
  } catch (error) {
    if (error instanceof StagingD1QueryError && error.code === "staging_d1_response_oversized") throw error;
    throw new StagingD1QueryError("staging_d1_response_unavailable", "staging_d1_response_unavailable", {
      http_status: response.status,
      error_codes: [],
      statement_success: false,
    }, retryableStatus || response.status === 200);
  }
  if (response.status !== 200 || body?.success !== true || !Array.isArray(body?.result) ||
      body.result.length !== 1 || body.result[0]?.success === false || !Array.isArray(body.result[0]?.results)) {
    const errorCodes = Array.isArray(body?.errors)
      ? body.errors.map(error => error?.code).filter(code => Number.isSafeInteger(code)).slice(0, 8)
      : [];
    throw new StagingD1QueryError("staging_d1_query_failed", "staging_d1_query_failed", {
      http_status: response.status,
      error_codes: errorCodes,
      statement_success: body?.result?.[0]?.success === true,
    }, retryableStatus);
  }
  return body.result;
}

function parseArgs(argv) {
  const allowed = new Set(["--manifest", "--sql-file", "--out"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || result[key]) fail("staging_d1_arguments_invalid");
    result[key] = value;
  }
  if (Object.keys(result).length !== allowed.size) fail("staging_d1_arguments_invalid");
  return result;
}

export async function runStagingD1Query(argv, env = process.env) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(await readFile(args["--manifest"], "utf8"));
  const sql = await readFile(args["--sql-file"], "utf8");
  const result = await queryStagingD1({
    manifest,
    sql,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  });
  await writeFile(args["--out"], `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`D1 read-only query returned ${result.length} statement result.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStagingD1Query(process.argv.slice(2)).catch(error => {
    const code = error instanceof StagingD1QueryError ? error.code : "staging_d1_query_unexpected";
    console.error(JSON.stringify({ error: code, ...(error instanceof StagingD1QueryError && error.diagnostic
      ? { diagnostic: error.diagnostic }
      : {}) }));
    process.exit(error instanceof StagingD1QueryError && error.retryable ? 75 : 1);
  });
}
