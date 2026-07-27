import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_VERSION = "vibepub-staging-resource-manifest.v1";
const COMPONENTS = ["main", "writing", "review", "image", "wechat"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PRODUCTION_VALUES = new Set([
  "vibepub-api",
  "writing-agent",
  "editorial-review-agent",
  "image-generation-adapter",
  "wechat-publishing-adapter",
  "vibepub-files",
  "vibepub-db",
  "writing-agent-db",
  "vibepub-visual-adapter-results",
  "vibepub-wechat-publishing-results",
  "editorial-workflow-v2",
  "five-agent-publishing-workflow",
  "0804a462-4413-4eaf-bfab-60531eef06be",
  "50047723-7c43-40f9-9a97-b61219cb6c19",
]);
const V3_FLAGS = ["five_agent", "visual", "wechat_draft"];
const ALLOWLISTS = ["five_agent", "visual", "wechat_draft", "wechat_account", "wechat_media"];

export class StagingManifestError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingManifestError(code, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("manifest_shape_invalid", `${field} must be an object`);
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) fail("manifest_field_invalid", `${field} must be a non-empty string`);
  return value;
}

function exactKeys(value, keys, field) {
  const present = Object.keys(object(value, field)).sort();
  const expected = [...keys].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) {
    fail("manifest_shape_invalid", `${field} has unsupported or missing fields`);
  }
}

function stagingName(value, field) {
  const name = text(value, field);
  if (!RESOURCE_NAME.test(name) || !name.endsWith("-staging") || PRODUCTION_VALUES.has(name)) {
    fail("staging_resource_name_invalid", `${field} must be an isolated -staging resource name`);
  }
  return name;
}

function resourceId(value, field) {
  const id = text(value, field);
  if (!UUID.test(id) || PRODUCTION_VALUES.has(id)) fail("staging_resource_id_invalid", `${field} must be a non-production UUID`);
  return id;
}

function database(value, field) {
  exactKeys(value, ["name", "id"], field);
  return { name: stagingName(value.name, `${field}.name`), id: resourceId(value.id, `${field}.id`) };
}

function assertNoSecretValues(value, path = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretValues(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/(secret|token|api[_-]?key|password|credential|private[_-]?key)/i.test(key)) {
      fail("manifest_secret_forbidden", `${path}.${key} must be a GitHub Environment secret, not manifest data`);
    }
    if (typeof item === "string" && (/^sk-[a-z0-9_-]{12,}/i.test(item) || /^bearer\s+/i.test(item))) {
      fail("manifest_secret_forbidden", `${path}.${key} contains a credential-like value`);
    }
    assertNoSecretValues(item, `${path}.${key}`);
  }
}

function privateLikeHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "metadata" || normalized.endsWith(".local") ||
    normalized.endsWith(".internal") || normalized.endsWith(".localhost") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized) || normalized.includes(":");
}

function safePublicBase(value, mainName, mode, intent) {
  const url = new URL(text(value, "main.public_base_url"));
  const hostname = url.hostname.toLowerCase();
  const syntheticFixture = mode === "synthetic" && intent === "dry-run" && hostname === "vibepub-staging.invalid";
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || hostname.endsWith(".") || privateLikeHostname(hostname) ||
      hostname === "vibepub.litianc.cn" || hostname.endsWith(".vibepub.litianc.cn")) {
    fail("staging_public_base_invalid", "main.public_base_url must be an isolated HTTPS workers.dev origin");
  }
  if (syntheticFixture) return url.origin;
  const labels = hostname.split(".");
  const accountLabel = labels[1] || "";
  if (labels.length !== 4 || labels[0] !== mainName || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[1]) ||
      privateLikeHostname(accountLabel) || accountLabel === "localhost" || accountLabel === "metadata" ||
      labels[2] !== "workers" || labels[3] !== "dev") {
    fail("staging_public_base_invalid", "main.public_base_url must exactly match the staging Worker workers.dev origin");
  }
  return url.origin;
}

function requireDistinct(values, code, message) {
  if (new Set(values).size !== values.length) fail(code, message);
}

function validateDatabaseRelationships(databases) {
  const byName = new Map();
  const byId = new Map();
  for (const [role, database] of databases) {
    const previousName = byName.get(database.name);
    const previousId = byId.get(database.id);
    if ((previousName && previousName.id !== database.id) || (previousId && previousId.name !== database.name)) {
      fail("staging_database_identity_conflict", "a staging D1 name and ID must remain a one-to-one pair");
    }
    byName.set(database.name, { role, id: database.id });
    byId.set(database.id, { role, name: database.name });
  }
}

function assertDeployValues(manifest) {
  if (manifest.mode !== "deploy") fail("synthetic_deploy_forbidden", "only deploy manifests may be used for deployment intent");
  const serialized = JSON.stringify(manifest).toLowerCase();
  if (/(synthetic|placeholder|example\.com|\.invalid)/.test(serialized)) {
    fail("placeholder_deploy_forbidden", "deploy manifests may not contain synthetic or placeholder resources");
  }
}

export function validateManifest(raw, intent = "dry-run") {
  const manifest = structuredClone(object(raw, "manifest"));
  assertNoSecretValues(manifest);
  exactKeys(manifest, ["schema_version", "mode", "environment", ...COMPONENTS], "manifest");
  if (manifest.schema_version !== MANIFEST_VERSION || manifest.environment !== "staging" || !["synthetic", "deploy"].includes(manifest.mode)) {
    fail("manifest_version_invalid", "manifest version, mode, or environment is invalid");
  }
  if (intent !== "dry-run" && intent !== "deploy") fail("render_intent_invalid");
  if (intent === "deploy") assertDeployValues(manifest);

  const main = object(manifest.main, "main");
  if (Object.hasOwn(main, "routes")) fail("production_route_forbidden", "staging main Worker must not declare a custom route");
  exactKeys(main, ["name", "files_bucket", "d1", "services", "workflows", "public_base_url", "v3_flags", "allowlists"], "main");
  main.name = stagingName(main.name, "main.name");
  main.files_bucket = stagingName(main.files_bucket, "main.files_bucket");
  main.d1 = database(main.d1, "main.d1");
  main.public_base_url = safePublicBase(main.public_base_url, main.name, manifest.mode, intent);
  exactKeys(main.services, ["writing", "review", "image", "wechat"], "main.services");
  exactKeys(main.workflows, ["editorial", "five_agent"], "main.workflows");
  exactKeys(main.v3_flags, V3_FLAGS, "main.v3_flags");
  exactKeys(main.allowlists, ALLOWLISTS, "main.allowlists");
  for (const flag of V3_FLAGS) if (main.v3_flags[flag] !== false) fail("staging_flags_must_be_off", `main.v3_flags.${flag} must be false`);
  for (const allowlist of ALLOWLISTS) if (main.allowlists[allowlist] !== "") fail("staging_allowlists_must_be_empty", `main.allowlists.${allowlist} must be empty`);
  for (const key of Object.keys(main.services)) main.services[key] = stagingName(main.services[key], `main.services.${key}`);
  for (const key of Object.keys(main.workflows)) main.workflows[key] = stagingName(main.workflows[key], `main.workflows.${key}`);

  exactKeys(manifest.writing, ["name", "d1"], "writing");
  manifest.writing.name = stagingName(manifest.writing.name, "writing.name");
  manifest.writing.d1 = database(manifest.writing.d1, "writing.d1");
  exactKeys(manifest.review, ["name"], "review");
  manifest.review.name = stagingName(manifest.review.name, "review.name");
  exactKeys(manifest.image, ["name", "results_bucket"], "image");
  manifest.image.name = stagingName(manifest.image.name, "image.name");
  manifest.image.results_bucket = stagingName(manifest.image.results_bucket, "image.results_bucket");
  exactKeys(manifest.wechat, ["name", "results_bucket", "d1"], "wechat");
  manifest.wechat.name = stagingName(manifest.wechat.name, "wechat.name");
  manifest.wechat.results_bucket = stagingName(manifest.wechat.results_bucket, "wechat.results_bucket");
  manifest.wechat.d1 = database(manifest.wechat.d1, "wechat.d1");

  if (manifest.main.services.writing !== manifest.writing.name || manifest.main.services.review !== manifest.review.name ||
      manifest.main.services.image !== manifest.image.name || manifest.main.services.wechat !== manifest.wechat.name) {
    fail("staging_service_binding_conflict", "main service bindings must name the rendered staging adapters");
  }
  if (manifest.main.d1.name !== manifest.wechat.d1.name || manifest.main.d1.id !== manifest.wechat.d1.id) {
    fail("staging_main_wechat_database_conflict", "main and WeChat adapter must share one isolated staging database");
  }
  if (manifest.main.d1.name === manifest.writing.d1.name || manifest.main.d1.id === manifest.writing.d1.id) {
    fail("staging_main_writing_database_conflict", "main and Writing must use separate staging D1 databases");
  }
  validateDatabaseRelationships([
    ["main", manifest.main.d1],
    ["writing", manifest.writing.d1],
    ["wechat", manifest.wechat.d1],
  ]);
  requireDistinct(
    [manifest.main.name, manifest.writing.name, manifest.review.name, manifest.image.name, manifest.wechat.name],
    "staging_worker_name_conflict",
    "all five staging Worker names must be unique",
  );
  requireDistinct(
    [manifest.main.files_bucket, manifest.image.results_bucket, manifest.wechat.results_bucket],
    "staging_bucket_name_conflict",
    "staging R2 bucket names must be unique",
  );
  requireDistinct(
    [manifest.main.workflows.editorial, manifest.main.workflows.five_agent],
    "staging_workflow_name_conflict",
    "staging Workflow names must be unique",
  );
  return manifest;
}

function quote(value) {
  return JSON.stringify(String(value));
}

function vars(entries) {
  return `[vars]\n${Object.entries(entries).map(([key, value]) => `${key} = ${quote(value)}`).join("\n")}\n`;
}

function d1(binding, database) {
  return `[[d1_databases]]\nbinding = ${quote(binding)}\ndatabase_name = ${quote(database.name)}\ndatabase_id = ${quote(database.id)}\n`;
}

function r2(binding, bucket) {
  return `[[r2_buckets]]\nbinding = ${quote(binding)}\nbucket_name = ${quote(bucket)}\n`;
}

function service(binding, name) {
  return `[[services]]\nbinding = ${quote(binding)}\nservice = ${quote(name)}\n`;
}

function durable(binding, className) {
  return `[[durable_objects.bindings]]\nname = ${quote(binding)}\nclass_name = ${quote(className)}\n`;
}

function workflow(binding, name, className) {
  return `[[workflows]]\nname = ${quote(name)}\nbinding = ${quote(binding)}\nclass_name = ${quote(className)}\n`;
}

function migration(tag, classes) {
  return `[[migrations]]\ntag = ${quote(tag)}\nnew_sqlite_classes = [${classes.map(quote).join(", ")}]\n`;
}

function metadataVars() {
  return { DEPLOY_COMMIT: "", DEPLOY_REF: "", DEPLOYED_AT: "" };
}

function sourcePath(outputDirectory, packagePath) {
  const path = relative(resolve(outputDirectory), resolve(ROOT, packagePath));
  return path || ".";
}

function renderMain(manifest, outputDirectory) {
  const main = manifest.main;
  return [
    `name = ${quote(main.name)}\nmain = ${quote(sourcePath(outputDirectory, "infra/worker/src/index.ts"))}\ncompatibility_date = "2026-06-24"\ncompatibility_flags = ["nodejs_compat"]\nworkers_dev = true\npreview_urls = false\n`,
    "send_email = [{ name = \"EMAIL\" }]\n",
    r2("FILES_BUCKET", main.files_bucket),
    vars({
      ...metadataVars(),
      PUBLIC_BASE_URL: main.public_base_url,
      GITHUB_WORKFLOW_REF: "",
      WRITING_AGENT_BASE_URL: "",
      EMAIL_FROM: "VibePub Staging <no-reply@invalid>",
      INVITE_BASE_URL: "vibepub-staging://auth",
      EDITORIAL_WORKFLOW_V2: "false",
      EDITORIAL_WORKFLOW_V2_ALLOWLIST: "",
      FIVE_AGENT_PUBLISHING_V3: "false",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "",
      VISUAL_PRODUCTION_V3: "false",
      VISUAL_PRODUCTION_V3_ALLOWLIST: "",
      WECHAT_DRAFT_SYNC_V3: "false",
      WECHAT_DRAFT_SYNC_V3_ALLOWLIST: "",
      WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST: "",
      WECHAT_MEDIA_URL_HOST_ALLOWLIST: "",
    }),
    service("WRITING_AGENT", main.services.writing),
    service("REVIEW_AGENT", main.services.review),
    service("IMAGE_GENERATION_ADAPTER", main.services.image),
    service("WECHAT_PUBLISHING_ADAPTER", main.services.wechat),
    d1("DB", main.d1),
    durable("EDITORIAL_COORDINATOR", "EditorialCoordinatorAgent"),
    durable("EDITORIAL_WRITING", "EditorialWritingAgent"),
    durable("EDITORIAL_REVIEW", "EditorialReviewAgent"),
    durable("EDITORIAL_VISUAL_PRODUCTION", "EditorialVisualProductionAgent"),
    durable("EDITORIAL_WECHAT_PUBLISHING", "EditorialWechatPublishingAgent"),
    durable("EDITORIAL_ILLUSTRATION", "EditorialIllustrationAgent"),
    durable("EDITORIAL_COVER", "EditorialCoverAgent"),
    workflow("EDITORIAL_WORKFLOW", main.workflows.editorial, "EditorialWorkflow"),
    workflow("FIVE_AGENT_PUBLISHING_WORKFLOW", main.workflows.five_agent, "FiveAgentPublishingWorkflow"),
    migration("v2-editorial-agents", ["EditorialCoordinatorAgent", "EditorialWritingAgent", "EditorialReviewAgent", "EditorialIllustrationAgent", "EditorialCoverAgent"]),
    migration("v3-five-agent-publishing", ["EditorialVisualProductionAgent", "EditorialWechatPublishingAgent"]),
  ].join("\n");
}

function renderWriting(manifest, outputDirectory) {
  return [
    `name = ${quote(manifest.writing.name)}\nmain = ${quote(sourcePath(outputDirectory, "infra/writing-agent/src/index.ts"))}\ncompatibility_date = "2026-07-05"\nworkers_dev = false\npreview_urls = false\n`,
    vars({ ...metadataVars(), GLM_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4/", GLM_MODEL: "glm-5.2" }),
    d1("DB", manifest.writing.d1),
  ].join("\n");
}

function renderReview(manifest, outputDirectory) {
  return [
    `name = ${quote(manifest.review.name)}\nmain = ${quote(sourcePath(outputDirectory, "infra/review-agent/src/index.ts"))}\ncompatibility_date = "2026-07-19"\nworkers_dev = false\npreview_urls = false\n`,
    vars(metadataVars()),
  ].join("\n");
}

function renderImage(manifest, outputDirectory) {
  return [
    `name = ${quote(manifest.image.name)}\nmain = ${quote(sourcePath(outputDirectory, "infra/image-generation-adapter/src/index.ts"))}\ncompatibility_date = "2026-06-24"\nworkers_dev = false\npreview_urls = false\n`,
    vars({ ...metadataVars(), IMAGE_PROVIDER_HOST: "", IMAGE_PROVIDER_URL: "" }),
    r2("VISUAL_RESULTS_BUCKET", manifest.image.results_bucket),
    durable("VISUAL_OPERATION", "VisualOperationAgent"),
    migration("v1-visual-operation", ["VisualOperationAgent"]),
  ].join("\n");
}

function renderWechat(manifest, outputDirectory) {
  return [
    `name = ${quote(manifest.wechat.name)}\nmain = ${quote(sourcePath(outputDirectory, "infra/wechat-publishing-adapter/src/index.ts"))}\ncompatibility_date = "2026-06-24"\nworkers_dev = false\npreview_urls = false\n`,
    vars({
      ...metadataVars(),
      WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST: "",
      WECHAT_DRAFT_SYNC_V3: "false",
      WECHAT_DRAFT_SYNC_V3_ALLOWLIST: "",
      WECHAT_PROVIDER_BASE_URL_ALLOWLIST: "",
      WECHAT_MEDIA_URL_HOST_ALLOWLIST: "",
    }),
    r2("WECHAT_RESULTS_BUCKET", manifest.wechat.results_bucket),
    d1("DB", manifest.wechat.d1),
    durable("WECHAT_OPERATION", "WechatOperationAgent"),
    migration("v1-wechat-operation", ["WechatOperationAgent"]),
  ].join("\n");
}

export function renderConfigs(raw, intent = "dry-run", outputDirectory = resolve(ROOT, "infra/staging/generated")) {
  const manifest = validateManifest(raw, intent);
  return {
    "main.wrangler.toml": renderMain(manifest, outputDirectory),
    "writing.wrangler.toml": renderWriting(manifest, outputDirectory),
    "review.wrangler.toml": renderReview(manifest, outputDirectory),
    "image.wrangler.toml": renderImage(manifest, outputDirectory),
    "wechat.wrangler.toml": renderWechat(manifest, outputDirectory),
  };
}

export async function writeRenderedConfigs(raw, outputDirectory, intent = "dry-run") {
  const files = renderConfigs(raw, intent, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(resolve(outputDirectory, name), content, "utf8")));
  return Object.keys(files).map(name => resolve(outputDirectory, name));
}

export async function verifyRenderedConfigs(raw, outputDirectory, intent = "dry-run") {
  const expected = renderConfigs(raw, intent, outputDirectory);
  for (const [name, content] of Object.entries(expected)) {
    let actual;
    try {
      actual = await readFile(resolve(outputDirectory, name), "utf8");
    } catch {
      fail("staging_rendered_config_missing", `${name} is missing from the rendered staging target directory`);
    }
    if (actual !== content) fail("staging_rendered_config_conflict", `${name} does not match the approved manifest render`);
  }
  return Object.keys(expected).map(name => resolve(outputDirectory, name));
}

function usage() {
  return "usage: node infra/staging/render-staging-config.mjs --manifest <path> --out-dir <path> --intent <dry-run|deploy>";
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const manifestPath = option("--manifest");
  const outDir = option("--out-dir");
  const intent = option("--intent") || "dry-run";
  if (!manifestPath || !outDir) throw new Error(usage());
  const raw = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const paths = await writeRenderedConfigs(raw, resolve(outDir), intent);
  process.stdout.write(`${paths.join("\n")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingManifestError ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}
