import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workerDefault = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const workerProduction = await readFile(new URL("../wrangler.production.toml", import.meta.url), "utf8");
const imageProduction = await readFile(new URL("../../image-generation-adapter/wrangler.production.toml", import.meta.url), "utf8");
const wechatProduction = await readFile(new URL("../../wechat-publishing-adapter/wrangler.production.toml", import.meta.url), "utf8");
const reviewDefault = await readFile(new URL("../../review-agent/wrangler.toml", import.meta.url), "utf8");
const miningWorkflow = await readFile(new URL("../../../.github/workflows/mining-job.yml", import.meta.url), "utf8");
const productionWorkflow = await readFile(new URL("../../../.github/workflows/wave2e-production.yml", import.meta.url), "utf8");

test("keeps default Worker targets fail-closed while Production is explicitly all-tenant", () => {
  assert.match(workerDefault, /FIVE_AGENT_PUBLISHING_V3\s*=\s*"false"/);
  assert.doesNotMatch(workerDefault, /V3_TENANT_SCOPE\s*=\s*"all"/);
  assert.match(workerProduction, /V3_TENANT_SCOPE\s*=\s*"all"/);
  assert.match(workerProduction, /FIVE_AGENT_PUBLISHING_V3\s*=\s*"true"/);
  assert.match(workerProduction, /VISUAL_PRODUCTION_V3\s*=\s*"true"/);
  assert.match(workerProduction, /WECHAT_DRAFT_SYNC_V3\s*=\s*"true"/);
  assert.doesNotMatch(workerProduction, /STAGING_IMAGE_CANARY_/);
});

test("pins Production adapters to private Workers and exact HTTPS providers", () => {
  assert.match(reviewDefault, /workers_dev\s*=\s*false/);
  assert.match(imageProduction, /workers_dev\s*=\s*false/);
  assert.match(imageProduction, /IMAGE_PROVIDER_URL\s*=\s*"https:\/\/api\.clawparty\.cn\/v1\/images\/generations"/);
  assert.match(wechatProduction, /V3_TENANT_SCOPE\s*=\s*"all"/);
  assert.match(wechatProduction, /WECHAT_PROVIDER_BASE_URL_ALLOWLIST\s*=\s*"https:\/\/api\.clawparty\.cn\/wechat"/);
  assert.match(wechatProduction, /PUBLISHING_ACCOUNT_RESOLVER_URL\s*=\s*"https:\/\/vibepub\.litianc\.cn\/"/);
});

test("enables Mining only with the dedicated handoff secret and a backup-first release workflow", () => {
  assert.match(miningWorkflow, /MINING_V3_HANDOFF_TOKEN:\s*\$\{\{ secrets\.MINING_V3_HANDOFF_TOKEN \}\}/);
  assert.match(miningWorkflow, /MINING_V3_HANDOFF_ENABLED:\s*"true"/);
  const backup = productionWorkflow.indexOf("wrangler d1 export vibepub-db --remote");
  const migration = productionWorkflow.indexOf("wrangler d1 migrations apply vibepub-db --remote");
  const mainDeploy = productionWorkflow.indexOf("Deploy all-tenant five-Agent main Worker");
  assert.ok(backup >= 0 && migration > backup && mainDeploy > migration);
  for (const config of ["infra/worker", "infra/image-generation-adapter", "infra/wechat-publishing-adapter"]) {
    assert.match(productionWorkflow, new RegExp(`${config.replaceAll("/", "\\/")}.*wrangler\\.production\\.toml`, "s"));
  }
});
