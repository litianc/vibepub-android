import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfigs, StagingManifestError } from "./render-staging-config.mjs";

const SCHEMA_VERSION = "vibepub-staging-http-image-canary.v1";
const ACKNOWLEDGEMENT = "plaintext_key_and_content_approved_for_single_staging_run";
const PROVIDER_URL = "http://23.105.194.173:8881/v1/images/generations";
const PROVIDER_HOST = "23.105.194.173";
const CONTENT_GOAL = "将原始内容整理为真实、理性、结构化的公众号文章。";
const STYLE_PIN = { id: "style_litianc_default", version: "2026-07-05" };
const FORMATTING_PIN = { id: "md_to_wechat", version: "1.0.0" };
const LAYOUT_PIN = { id: "wechat_clean_article", version: "2026-07-05" };
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^run_v3_[a-f0-9]{64}$/;
const HANDOFF_ID = /^handoff_v3_[a-f0-9]{64}$/;
const GRANT_ID = /^staging_http_[a-f0-9]{32}$/;
const MAX_TTL_MS = 60 * 60 * 1000;

export class StagingHttpCanaryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingHttpCanaryError(code, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("canary_shape_invalid", `${field} must be an object`);
  return value;
}

function exactKeys(value, keys, field) {
  const present = Object.keys(object(value, field)).sort();
  const expected = [...keys].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) {
    fail("canary_shape_invalid", `${field} has unsupported or missing fields`);
  }
}

function opaque(value, field) {
  if (typeof value !== "string" || !OPAQUE.test(value)) fail("canary_scope_invalid", `${field} is invalid`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  fail("canary_identity_invalid", "identity contains an unsupported value");
}

function sha256(value) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashJson(value) {
  return sha256(canonicalJson(value));
}

function prefixedId(prefix, hash) {
  return `${prefix}_${hash.slice("sha256:".length)}`;
}

function normalizeTranscript(value) {
  if (typeof value !== "string") fail("canary_source_invalid", "source text is missing");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) fail("canary_source_invalid", "source text is empty");
  return normalized;
}

function parseRecording(raw) {
  if (Array.isArray(raw) && raw.length === 1 && Array.isArray(raw[0]?.results)) raw = raw[0].results;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.results)) raw = raw.results;
  if (!Array.isArray(raw) || raw.length !== 1) fail("canary_recording_invalid", "recording query must resolve exactly one row");
  return object(raw[0], "recording");
}

export function deriveCanaryIdentity(input) {
  const sourceBytes = Buffer.isBuffer(input.sourceBytes) ? input.sourceBytes : Buffer.from(input.sourceBytes);
  const sourceHash = sha256(sourceBytes);
  if (input.expectedSourceHash !== undefined && input.expectedSourceHash !== sourceHash) fail("canary_source_hash_conflict", "source hash is not the approved sample hash");
  let payload;
  try { payload = JSON.parse(sourceBytes.toString("utf8")); } catch { fail("canary_source_invalid", "source must be the exact text-submission JSON object"); }
  payload = object(payload, "source");
  const recording = parseRecording(input.recording);
  const userId = opaque(input.userId, "user_id");
  const workspaceId = opaque(input.workspaceId, "workspace_id");
  const sourceKey = String(recording.r2_key || "");
  const recordingId = Number(recording.id);
  if (!Number.isSafeInteger(recordingId) || recordingId < 1 || recording.user_id !== userId || recording.workspace_id !== workspaceId ||
      recording.source_type !== "TEXT" || sourceKey !== input.sourceKey || !sourceKey.startsWith(`users/${userId}/text-submissions/`)) {
    fail("canary_recording_invalid", "recording identity is not the isolated text submission");
  }
  if (payload.userId !== userId || payload.workspaceId !== workspaceId || payload.filename !== recording.filename) {
    fail("canary_source_scope_conflict", "source payload scope does not match the recording");
  }
  const styleId = recording.style_profile_id || STYLE_PIN.id;
  const styleVersion = recording.style_profile_version || STYLE_PIN.version;
  const layoutId = recording.layout_profile_id || LAYOUT_PIN.id;
  const layoutVersion = recording.layout_profile_version || LAYOUT_PIN.version;
  if (styleId !== STYLE_PIN.id || styleVersion !== STYLE_PIN.version || layoutId !== LAYOUT_PIN.id || layoutVersion !== LAYOUT_PIN.version || payload.styleProfileBody) {
    fail("canary_profile_invalid", "the canary accepts only the registered default style and layout");
  }
  const transcriptText = normalizeTranscript(payload.text);
  const transcriptHash = sha256(transcriptText);
  const titleHint = typeof payload.titleHint === "string" && payload.titleHint.trim() ? payload.titleHint.trim() : typeof recording.article_title === "string" && recording.article_title.trim() ? recording.article_title.trim() : null;
  const profilePins = { style: STYLE_PIN, formatting: FORMATTING_PIN };
  const sourceScope = prefixedId("mhs", hashJson({ version: 1, user_id: userId, workspace_id: workspaceId, recording_id: recordingId, source_key: sourceKey }));
  const articleId = prefixedId("article_v3", hashJson({ version: 1, user_id: userId, workspace_id: workspaceId, recording_id: recordingId }));
  const handoffId = prefixedId("handoff_v3", hashJson({
    version: 1,
    source_scope: sourceScope,
    source_hash: sourceHash,
    article_id: articleId,
    source_type: "text",
    title_hint: titleHint,
    content_goal: CONTENT_GOAL,
    app_layout_mapping_version: "app-layout-to-v3-formatting.v1",
    profile_pins: profilePins,
    style_profile_body_hash: null,
  }));
  const runId = prefixedId("run_v3", hashJson({
    version: 1,
    user_id: userId,
    workspace_id: workspaceId,
    article_id: articleId,
    recording_id: recordingId,
    source_hash: sourceHash,
    transcript_hash: transcriptHash,
    source_type: "text",
    title_hint: titleHint,
    content_goal: CONTENT_GOAL,
    profile_pins: profilePins,
    style_profile_body_hash: null,
  }));
  return {
    user_id: userId,
    workspace_id: workspaceId,
    recording_id: recordingId,
    source_key: sourceKey,
    source_hash: sourceHash,
    transcript_hash: transcriptHash,
    article_id: articleId,
    handoff_id: handoffId,
    run_id: runId,
  };
}

export function buildCanaryGrant(identity, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const maxOperations = Number(options.maxOperations || 3);
  if (maxOperations !== 3 && maxOperations !== 6) fail("canary_budget_invalid", "max_operations must be 3 or 6");
  const expiresAt = options.expiresAt || new Date(now.getTime() + 45 * 60 * 1000).toISOString();
  const seed = String(options.grantSeed || "");
  if (!seed || seed.length > 256) fail("canary_grant_invalid", "grant seed is required");
  return validateCanaryGrant({
    schema_version: SCHEMA_VERSION,
    environment: "staging",
    acknowledgement: ACKNOWLEDGEMENT,
    provider: { url: PROVIDER_URL, host: PROVIDER_HOST },
    scope: { user_id: identity.user_id, workspace_id: identity.workspace_id, run_id: identity.run_id },
    source: { key: identity.source_key, hash: identity.source_hash, recording_id: identity.recording_id, handoff_id: identity.handoff_id },
    grant_id: `staging_http_${sha256(`${seed}:${identity.run_id}`).slice("sha256:".length, "sha256:".length + 32)}`,
    expires_at: expiresAt,
    max_operations: maxOperations,
    max_requests: maxOperations * 3,
    wechat_draft: false,
  }, now);
}

export function validateCanaryGrant(raw, now = new Date()) {
  const grant = structuredClone(object(raw, "grant"));
  exactKeys(grant, ["schema_version", "environment", "acknowledgement", "provider", "scope", "source", "grant_id", "expires_at", "max_operations", "max_requests", "wechat_draft"], "grant");
  exactKeys(grant.provider, ["url", "host"], "grant.provider");
  exactKeys(grant.scope, ["user_id", "workspace_id", "run_id"], "grant.scope");
  exactKeys(grant.source, ["key", "hash", "recording_id", "handoff_id"], "grant.source");
  if (grant.schema_version !== SCHEMA_VERSION || grant.environment !== "staging" || grant.acknowledgement !== ACKNOWLEDGEMENT || grant.wechat_draft !== false) fail("canary_policy_invalid");
  if (grant.provider.url !== PROVIDER_URL || grant.provider.host !== PROVIDER_HOST) fail("canary_provider_invalid");
  opaque(grant.scope.user_id, "scope.user_id");
  opaque(grant.scope.workspace_id, "scope.workspace_id");
  if (!RUN_ID.test(grant.scope.run_id) || !GRANT_ID.test(grant.grant_id) || !HASH.test(grant.source.hash) || !HANDOFF_ID.test(grant.source.handoff_id) ||
      !Number.isSafeInteger(grant.source.recording_id) || grant.source.recording_id < 1 || typeof grant.source.key !== "string" || grant.source.key.includes("..") ||
      grant.source.key !== `users/${grant.scope.user_id}/text-submissions/${grant.source.key.split("/").at(-1)}`) fail("canary_scope_invalid");
  if ((grant.max_operations !== 3 && grant.max_operations !== 6) || grant.max_requests !== grant.max_operations * 3) fail("canary_budget_invalid");
  const expires = Date.parse(grant.expires_at);
  const current = now.getTime();
  if (!Number.isFinite(expires) || expires <= current || expires > current + MAX_TTL_MS) fail("canary_expiry_invalid");
  return grant;
}

function replaceVar(config, name, value) {
  const pattern = new RegExp(`^${name} = .*?$`, "m");
  const matches = config.match(new RegExp(`^${name} = .*?$`, "gm")) || [];
  if (matches.length !== 1) fail("canary_render_invalid", `${name} is not an exact rendered variable`);
  return config.replace(pattern, `${name} = ${JSON.stringify(String(value))}`);
}

function prependVars(config, entries) {
  const marker = "[vars]\n";
  if (config.split(marker).length !== 2) fail("canary_render_invalid", "config must contain exactly one vars section");
  return config.replace(marker, `${marker}${Object.entries(entries).map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`).join("\n")}\n`);
}

export function renderCanaryConfigs(manifest, rawGrant, intent = "deploy", outputDirectory) {
  const grant = validateCanaryGrant(rawGrant);
  const configs = renderConfigs(manifest, intent, outputDirectory);
  const allowlist = `${grant.scope.user_id}:${grant.scope.workspace_id}`;
  let main = configs["main.wrangler.toml"];
  main = replaceVar(main, "FIVE_AGENT_PUBLISHING_V3", "true");
  main = replaceVar(main, "FIVE_AGENT_PUBLISHING_V3_ALLOWLIST", allowlist);
  main = replaceVar(main, "VISUAL_PRODUCTION_V3", "true");
  main = replaceVar(main, "VISUAL_PRODUCTION_V3_ALLOWLIST", allowlist);
  main = replaceVar(main, "WECHAT_DRAFT_SYNC_V3", "false");
  main = replaceVar(main, "WECHAT_DRAFT_SYNC_V3_ALLOWLIST", "");
  const mainCanaryVars = {
    DEPLOY_ENVIRONMENT: "staging",
    STAGING_HTTP_IMAGE_CANARY_MODE: "staging_single_run",
    STAGING_HTTP_IMAGE_CANARY_RUN_ID: grant.scope.run_id,
    STAGING_HTTP_IMAGE_CANARY_USER_ID: grant.scope.user_id,
    STAGING_HTTP_IMAGE_CANARY_WORKSPACE_ID: grant.scope.workspace_id,
    STAGING_HTTP_IMAGE_CANARY_EXPIRES_AT: grant.expires_at,
  };
  main = prependVars(main, mainCanaryVars);
  let image = configs["image.wrangler.toml"];
  image = replaceVar(image, "IMAGE_PROVIDER_HOST", grant.provider.host);
  image = replaceVar(image, "IMAGE_PROVIDER_URL", grant.provider.url);
  const imageVars = {
    DEPLOY_ENVIRONMENT: "staging",
    IMAGE_PROVIDER_INSECURE_HTTP_MODE: "staging_single_run",
    IMAGE_PROVIDER_INSECURE_HTTP_RUN_ID: grant.scope.run_id,
    IMAGE_PROVIDER_INSECURE_HTTP_USER_ID: grant.scope.user_id,
    IMAGE_PROVIDER_INSECURE_HTTP_WORKSPACE_ID: grant.scope.workspace_id,
    IMAGE_PROVIDER_INSECURE_HTTP_GRANT_ID: grant.grant_id,
    IMAGE_PROVIDER_INSECURE_HTTP_MAX_OPERATIONS: grant.max_operations,
    IMAGE_PROVIDER_INSECURE_HTTP_MAX_REQUESTS: grant.max_requests,
    IMAGE_PROVIDER_INSECURE_HTTP_EXPIRES_AT: grant.expires_at,
  };
  image = prependVars(image, imageVars);
  return { ...configs, "main.wrangler.toml": main, "image.wrangler.toml": image };
}

export async function writeCanaryConfigs(manifest, grant, outputDirectory, intent = "deploy") {
  const configs = renderCanaryConfigs(manifest, grant, intent, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.entries(configs).map(([name, content]) => writeFile(resolve(outputDirectory, name), content, "utf8")));
  return Object.keys(configs).map(name => resolve(outputDirectory, name));
}

export async function verifyCanaryConfigs(manifest, grant, outputDirectory, intent = "deploy") {
  const expected = renderCanaryConfigs(manifest, grant, intent, outputDirectory);
  for (const [name, content] of Object.entries(expected)) {
    if (await readFile(resolve(outputDirectory, name), "utf8").catch(() => null) !== content) fail("canary_render_conflict", `${name} does not match the approved canary grant`);
  }
  return Object.keys(expected).map(name => resolve(outputDirectory, name));
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "identity") {
    const sourceFile = option(args, "--source-file");
    const recordingFile = option(args, "--recording-file");
    const outFile = option(args, "--out");
    if (!sourceFile || !recordingFile || !outFile) fail("usage_invalid");
    const identity = deriveCanaryIdentity({
      sourceBytes: await readFile(resolve(sourceFile)),
      recording: JSON.parse(await readFile(resolve(recordingFile), "utf8")),
      sourceKey: option(args, "--source-key"),
      userId: option(args, "--user-id"),
      workspaceId: option(args, "--workspace-id"),
      expectedSourceHash: option(args, "--expected-source-hash"),
    });
    const grant = buildCanaryGrant(identity, { maxOperations: Number(option(args, "--max-operations") || 3), grantSeed: option(args, "--grant-seed") });
    await writeFile(resolve(outFile), `${JSON.stringify({ identity, grant }, null, 2)}\n`, "utf8");
    return;
  }
  if (command === "render" || command === "verify") {
    const manifestPath = option(args, "--manifest");
    const canaryPath = option(args, "--canary");
    const outDir = option(args, "--out-dir");
    const intent = option(args, "--intent") || "deploy";
    if (!manifestPath || !canaryPath || !outDir) fail("usage_invalid");
    const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
    const canary = JSON.parse(await readFile(resolve(canaryPath), "utf8"));
    const grant = canary.grant || canary;
    if (command === "render") await writeCanaryConfigs(manifest, grant, resolve(outDir), intent);
    else await verifyCanaryConfigs(manifest, grant, resolve(outDir), intent);
    return;
  }
  fail("usage_invalid", "usage: staging-http-image-canary.mjs <identity|render|verify> ...");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingHttpCanaryError || error instanceof StagingManifestError ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}
