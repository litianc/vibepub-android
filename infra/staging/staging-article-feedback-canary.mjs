import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./render-staging-config.mjs";

const BOOTSTRAP_SCHEMA = "vibepub-staging-article-feedback-bootstrap.v1";
const FULL_SCHEMA = "vibepub-staging-article-feedback-canary.v1";
const FEEDBACK_MODE = "staging_article_feedback";
const IMAGE_MODE = "staging_single_run";
const IMAGE_PROVIDER_URL = "https://api.clawparty.cn/v1/images/generations";
const IMAGE_PROVIDER_HOST = "api.clawparty.cn";
const HASH = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RUN_ID = /^run_v3_[a-f0-9]{64}$/;
const HANDOFF_ID = /^handoff_v3_[a-f0-9]{64}$/;
const ARTICLE_ID = /^article_v3_[a-f0-9]{64}$/;
const CANARY_ID = /^staging_feedback_[a-f0-9]{32}$/;
const ACCOUNT_BINDING_ID = /^wab_[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DNS_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_TTL_MS = 60 * 60 * 1000;

export class StagingArticleFeedbackCanaryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "StagingArticleFeedbackCanaryError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new StagingArticleFeedbackCanaryError(code, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("feedback_canary_shape_invalid", `${field} must be an object`);
  return value;
}

function exactKeys(value, keys, field) {
  const actual = Object.keys(object(value, field)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("feedback_canary_shape_invalid", `${field} has unsupported or missing fields`);
  }
}

function opaque(value, field) {
  if (typeof value !== "string" || !OPAQUE.test(value)) fail("feedback_canary_scope_invalid", `${field} is invalid`);
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export function stagingManifestFingerprint(manifest) {
  return sha256(JSON.stringify(manifest));
}

function assertReleaseBinding(manifest, grant) {
  if (!COMMIT.test(grant.candidate_commit) || grant.manifest_hash !== stagingManifestFingerprint(manifest)) {
    fail("feedback_canary_release_conflict");
  }
}

function expiry(value, now) {
  const parsed = Date.parse(value);
  const current = now.getTime();
  if (typeof value !== "string" || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value ||
      parsed <= current || parsed > current + MAX_TTL_MS) fail("feedback_canary_expiry_invalid");
  return value;
}

function audioSourceKey(value, userId) {
  if (typeof value !== "string" || value.includes("..") || value !== `users/${userId}/inbox/${value.split("/").at(-1)}` ||
      !/\.(?:m4a|mp3|wav|aac|ogg|webm)$/i.test(value)) fail("feedback_canary_source_invalid");
  return value;
}

function providerBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { fail("feedback_canary_provider_invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password ||
      url.search || url.hash || !DNS_HOST.test(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    fail("feedback_canary_provider_invalid");
  }
  url.hostname = host;
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function mediaHosts(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) fail("feedback_canary_media_host_invalid");
  const normalized = values.map(value => String(value).trim().toLowerCase());
  if (normalized.some(value => !DNS_HOST.test(value) || value.endsWith(".local") || value.endsWith(".internal")) ||
      new Set(normalized).size !== normalized.length) fail("feedback_canary_media_host_invalid");
  return normalized.sort();
}

export function buildArticleFeedbackBootstrapGrant(input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const userId = opaque(input?.userId, "user_id");
  const workspaceId = opaque(input?.workspaceId, "workspace_id");
  const sourceKey = audioSourceKey(input?.sourceKey, userId);
  const seed = String(options.canarySeed || "");
  if (!seed || seed.length > 256) fail("feedback_canary_identity_invalid");
  return validateArticleFeedbackBootstrapGrant({
    schema_version: BOOTSTRAP_SCHEMA,
    environment: "staging",
    candidate_commit: input?.candidateCommit,
    manifest_hash: input?.manifestHash,
    scope: {
      user_id: userId,
      workspace_id: workspaceId,
      source_key: sourceKey,
      bootstrap_run_id: `run_v3_${sha256(`${seed}:${sourceKey}`).slice(7)}`,
    },
    expires_at: options.expiresAt || new Date(now.getTime() + 45 * 60 * 1000).toISOString(),
  }, now);
}

export function validateArticleFeedbackBootstrapGrant(raw, now = new Date()) {
  const grant = structuredClone(object(raw, "grant"));
  exactKeys(grant, ["schema_version", "environment", "candidate_commit", "manifest_hash", "scope", "expires_at"], "grant");
  exactKeys(grant.scope, ["user_id", "workspace_id", "source_key", "bootstrap_run_id"], "grant.scope");
  if (grant.schema_version !== BOOTSTRAP_SCHEMA || grant.environment !== "staging") fail("feedback_canary_policy_invalid");
  if (!COMMIT.test(grant.candidate_commit) || !HASH.test(grant.manifest_hash)) fail("feedback_canary_release_invalid");
  opaque(grant.scope.user_id, "scope.user_id");
  opaque(grant.scope.workspace_id, "scope.workspace_id");
  audioSourceKey(grant.scope.source_key, grant.scope.user_id);
  if (!RUN_ID.test(grant.scope.bootstrap_run_id)) fail("feedback_canary_scope_invalid");
  expiry(grant.expires_at, now);
  return grant;
}

export function buildArticleFeedbackCanaryGrant(identity, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const seed = String(options.canarySeed || "");
  if (!seed || seed.length > 256) fail("feedback_canary_identity_invalid");
  return validateArticleFeedbackCanaryGrant({
    schema_version: FULL_SCHEMA,
    environment: "staging",
    candidate_commit: identity?.candidate_commit,
    manifest_hash: identity?.manifest_hash,
    expires_at: options.expiresAt || new Date(now.getTime() + 45 * 60 * 1000).toISOString(),
    scope: {
      user_id: identity?.user_id,
      workspace_id: identity?.workspace_id,
      source_key: identity?.source_key,
      source_hash: identity?.source_hash,
      recording_id: identity?.recording_id,
      handoff_id: identity?.handoff_id,
      run_id: identity?.run_id,
      article_id: identity?.article_id,
      canary_id: `staging_feedback_${sha256(`${seed}:${identity?.run_id}`).slice(7, 39)}`,
    },
    image: { provider_url: IMAGE_PROVIDER_URL, provider_host: IMAGE_PROVIDER_HOST, max_operations: 3 },
    wechat: {
      account_binding_id: String(options.accountBindingId || ""),
      provider_base_url: String(options.providerBaseUrl || ""),
      media_url_hosts: options.mediaUrlHosts,
    },
  }, now);
}

export function validateArticleFeedbackCanaryGrant(raw, now = new Date()) {
  const grant = structuredClone(object(raw, "grant"));
  exactKeys(grant, ["schema_version", "environment", "candidate_commit", "manifest_hash", "expires_at", "scope", "image", "wechat"], "grant");
  exactKeys(grant.scope, ["user_id", "workspace_id", "source_key", "source_hash", "recording_id", "handoff_id", "run_id", "article_id", "canary_id"], "grant.scope");
  exactKeys(grant.image, ["provider_url", "provider_host", "max_operations"], "grant.image");
  exactKeys(grant.wechat, ["account_binding_id", "provider_base_url", "media_url_hosts"], "grant.wechat");
  if (grant.schema_version !== FULL_SCHEMA || grant.environment !== "staging") fail("feedback_canary_policy_invalid");
  if (!COMMIT.test(grant.candidate_commit) || !HASH.test(grant.manifest_hash)) fail("feedback_canary_release_invalid");
  opaque(grant.scope.user_id, "scope.user_id");
  opaque(grant.scope.workspace_id, "scope.workspace_id");
  audioSourceKey(grant.scope.source_key, grant.scope.user_id);
  if (!HASH.test(grant.scope.source_hash) || !Number.isSafeInteger(grant.scope.recording_id) || grant.scope.recording_id < 1 ||
      !HANDOFF_ID.test(grant.scope.handoff_id) || !RUN_ID.test(grant.scope.run_id) || !ARTICLE_ID.test(grant.scope.article_id) ||
      !CANARY_ID.test(grant.scope.canary_id)) fail("feedback_canary_article_invalid");
  expiry(grant.expires_at, now);
  if (grant.image.provider_url !== IMAGE_PROVIDER_URL || grant.image.provider_host !== IMAGE_PROVIDER_HOST) fail("feedback_canary_image_grant_invalid");
  if (grant.image.max_operations !== 3) fail("feedback_canary_image_budget_invalid");
  if (!ACCOUNT_BINDING_ID.test(grant.wechat.account_binding_id)) fail("feedback_canary_account_invalid");
  grant.wechat.provider_base_url = providerBaseUrl(grant.wechat.provider_base_url);
  grant.wechat.media_url_hosts = mediaHosts(grant.wechat.media_url_hosts);
  return grant;
}

function replaceVar(config, name, value) {
  const matches = config.match(new RegExp(`^${name} = .*?$`, "gm")) || [];
  if (matches.length !== 1) fail("feedback_canary_render_invalid", `${name} is not an exact rendered variable`);
  return config.replace(new RegExp(`^${name} = .*?$`, "m"), `${name} = ${JSON.stringify(String(value))}`);
}

function prependVars(config, entries) {
  const marker = "[vars]\n";
  if (config.split(marker).length !== 2) fail("feedback_canary_render_invalid", "config must contain exactly one vars section");
  const rendered = Object.entries(entries).map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`).join("\n");
  return config.replace(marker, `${marker}${rendered}\n`);
}

function mainScopeVars(scope, expiresAt) {
  return {
    DEPLOY_ENVIRONMENT: "staging",
    STAGING_IMAGE_CANARY_MODE: IMAGE_MODE,
    STAGING_IMAGE_CANARY_RUN_ID: scope.run_id || scope.bootstrap_run_id,
    STAGING_IMAGE_CANARY_USER_ID: scope.user_id,
    STAGING_IMAGE_CANARY_WORKSPACE_ID: scope.workspace_id,
    STAGING_IMAGE_CANARY_SOURCE_KEY: scope.source_key,
    STAGING_IMAGE_CANARY_EXPIRES_AT: expiresAt,
    STAGING_FEEDBACK_CANARY_MODE: FEEDBACK_MODE,
    STAGING_FEEDBACK_CANARY_USER_ID: scope.user_id,
    STAGING_FEEDBACK_CANARY_WORKSPACE_ID: scope.workspace_id,
    STAGING_FEEDBACK_CANARY_RUN_ID: scope.run_id || scope.bootstrap_run_id,
    ...(scope.article_id ? { STAGING_FEEDBACK_CANARY_ARTICLE_ID: scope.article_id } : {}),
    STAGING_FEEDBACK_CANARY_EXPIRES_AT: expiresAt,
  };
}

export function renderArticleFeedbackBootstrapConfigs(manifest, rawGrant, intent = "deploy", outputDirectory) {
  const grant = validateArticleFeedbackBootstrapGrant(rawGrant);
  assertReleaseBinding(manifest, grant);
  const configs = renderConfigs(manifest, intent, outputDirectory);
  const tenant = `${grant.scope.user_id}:${grant.scope.workspace_id}`;
  let main = configs["main.wrangler.toml"];
  main = replaceVar(main, "FIVE_AGENT_PUBLISHING_V3", "true");
  main = replaceVar(main, "FIVE_AGENT_PUBLISHING_V3_ALLOWLIST", tenant);
  main = prependVars(main, mainScopeVars(grant.scope, grant.expires_at));
  return { ...configs, "main.wrangler.toml": main };
}

export function renderArticleFeedbackCanaryConfigs(manifest, rawGrant, intent = "deploy", outputDirectory) {
  const grant = validateArticleFeedbackCanaryGrant(rawGrant);
  assertReleaseBinding(manifest, grant);
  const configs = renderConfigs(manifest, intent, outputDirectory);
  const tenant = `${grant.scope.user_id}:${grant.scope.workspace_id}`;
  let main = configs["main.wrangler.toml"];
  for (const [name, value] of [
    ["FIVE_AGENT_PUBLISHING_V3", "true"], ["FIVE_AGENT_PUBLISHING_V3_ALLOWLIST", tenant],
    ["VISUAL_PRODUCTION_V3", "true"], ["VISUAL_PRODUCTION_V3_ALLOWLIST", tenant],
    ["WECHAT_DRAFT_SYNC_V3", "true"], ["WECHAT_DRAFT_SYNC_V3_ALLOWLIST", tenant],
    ["WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST", grant.wechat.account_binding_id],
    ["WECHAT_MEDIA_URL_HOST_ALLOWLIST", grant.wechat.media_url_hosts.join(",")],
  ]) main = replaceVar(main, name, value);
  main = prependVars(main, mainScopeVars(grant.scope, grant.expires_at));

  let image = configs["image.wrangler.toml"];
  image = replaceVar(image, "IMAGE_PROVIDER_URL", grant.image.provider_url);
  image = replaceVar(image, "IMAGE_PROVIDER_HOST", grant.image.provider_host);
  image = prependVars(image, {
    DEPLOY_ENVIRONMENT: "staging",
    IMAGE_PROVIDER_CANARY_MODE: IMAGE_MODE,
    IMAGE_PROVIDER_CANARY_RUN_ID: grant.scope.run_id,
    IMAGE_PROVIDER_CANARY_USER_ID: grant.scope.user_id,
    IMAGE_PROVIDER_CANARY_WORKSPACE_ID: grant.scope.workspace_id,
    IMAGE_PROVIDER_CANARY_ID: grant.scope.canary_id,
    IMAGE_PROVIDER_CANARY_MAX_OPERATIONS: grant.image.max_operations,
    IMAGE_PROVIDER_CANARY_EXPIRES_AT: grant.expires_at,
  });

  let wechat = configs["wechat.wrangler.toml"];
  for (const [name, value] of [
    ["WECHAT_DRAFT_SYNC_V3", "true"], ["WECHAT_DRAFT_SYNC_V3_ALLOWLIST", tenant],
    ["WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST", grant.wechat.account_binding_id],
    ["WECHAT_PROVIDER_BASE_URL_ALLOWLIST", grant.wechat.provider_base_url],
    ["WECHAT_MEDIA_URL_HOST_ALLOWLIST", grant.wechat.media_url_hosts.join(",")],
  ]) wechat = replaceVar(wechat, name, value);
  wechat = prependVars(wechat, {
    DEPLOY_ENVIRONMENT: "staging",
    STAGING_FEEDBACK_CANARY_MODE: FEEDBACK_MODE,
    STAGING_FEEDBACK_CANARY_USER_ID: grant.scope.user_id,
    STAGING_FEEDBACK_CANARY_WORKSPACE_ID: grant.scope.workspace_id,
    STAGING_FEEDBACK_CANARY_ARTICLE_ID: grant.scope.article_id,
    STAGING_FEEDBACK_CANARY_EXPIRES_AT: grant.expires_at,
  });
  return { ...configs, "main.wrangler.toml": main, "image.wrangler.toml": image, "wechat.wrangler.toml": wechat };
}

function renderForGrant(manifest, grant, intent, outputDirectory) {
  return grant.schema_version === BOOTSTRAP_SCHEMA
    ? renderArticleFeedbackBootstrapConfigs(manifest, grant, intent, outputDirectory)
    : renderArticleFeedbackCanaryConfigs(manifest, grant, intent, outputDirectory);
}

export async function writeArticleFeedbackCanaryConfigs(manifest, grant, outputDirectory, intent = "deploy") {
  const configs = renderForGrant(manifest, grant, intent, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.entries(configs).map(([name, content]) => writeFile(resolve(outputDirectory, name), content, "utf8")));
  return Object.keys(configs).map(name => resolve(outputDirectory, name));
}

export async function verifyArticleFeedbackCanaryConfigs(manifest, grant, outputDirectory, intent = "deploy") {
  const expected = renderForGrant(manifest, grant, intent, outputDirectory);
  for (const [name, content] of Object.entries(expected)) {
    if (await readFile(resolve(outputDirectory, name), "utf8").catch(() => null) !== content) {
      fail("feedback_canary_render_conflict", `${name} does not match the approved feedback canary grant`);
    }
  }
  return Object.keys(expected).map(name => resolve(outputDirectory, name));
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build-bootstrap") {
    const built = buildArticleFeedbackBootstrapGrant({
      userId: option(args, "--user-id"), workspaceId: option(args, "--workspace-id"), sourceKey: option(args, "--source-key"),
      candidateCommit: option(args, "--candidate-commit"), manifestHash: option(args, "--manifest-hash"),
    }, { canarySeed: option(args, "--canary-seed") });
    const outFile = option(args, "--out");
    if (!outFile) fail("usage_invalid");
    await writeFile(resolve(outFile), JSON.stringify(built, null, 2), "utf8");
    return;
  }
  if (command === "build") {
    const identityFile = option(args, "--identity");
    const outFile = option(args, "--out");
    if (!identityFile || !outFile) fail("usage_invalid");
    const source = JSON.parse(await readFile(resolve(identityFile), "utf8"));
    const built = buildArticleFeedbackCanaryGrant(source.identity || source, {
      canarySeed: option(args, "--canary-seed"), accountBindingId: option(args, "--account-binding-id"),
      providerBaseUrl: option(args, "--provider-base-url"),
      mediaUrlHosts: String(option(args, "--media-url-hosts") || "").split(",").filter(Boolean),
    });
    await writeFile(resolve(outFile), JSON.stringify(built, null, 2), "utf8");
    return;
  }
  const manifestFile = option(args, "--manifest");
  const grantFile = option(args, "--grant");
  const outputDirectory = option(args, "--out-dir");
  const intent = option(args, "--intent") || "deploy";
  if (!manifestFile || !grantFile || !outputDirectory) fail("usage_invalid");
  const manifest = JSON.parse(await readFile(resolve(manifestFile), "utf8"));
  const grant = JSON.parse(await readFile(resolve(grantFile), "utf8"));
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (grant.candidate_commit !== currentCommit) fail("feedback_canary_release_conflict");
  if (command === "render") await writeArticleFeedbackCanaryConfigs(manifest, grant, outputDirectory, intent);
  else if (command === "verify") await verifyArticleFeedbackCanaryConfigs(manifest, grant, outputDirectory, intent);
  else fail("usage_invalid");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof StagingArticleFeedbackCanaryError ? error.code : "feedback_canary_failed");
    process.exit(1);
  });
}
