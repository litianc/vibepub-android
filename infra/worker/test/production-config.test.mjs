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
  const retainedBackup = productionWorkflow.indexOf("wrangler r2 object get \"$PRODUCTION_BACKUP_OBJECT\"");
  const retainedBackupCheck = productionWorkflow.indexOf("sha256sum -c -");
  const migration = productionWorkflow.indexOf("wrangler d1 migrations apply vibepub-db --remote");
  const writingDeploy = productionWorkflow.indexOf("Deploy private Writing Agent");
  const reviewDeploy = productionWorkflow.indexOf("Deploy private Review Agent");
  const mainDeploy = productionWorkflow.indexOf("Deploy all-tenant five-Agent main Worker");
  assert.ok(backup >= 0 && migration > backup && writingDeploy > migration && reviewDeploy > writingDeploy && mainDeploy > reviewDeploy);
  assert.ok(retainedBackup >= 0 && retainedBackupCheck > retainedBackup && migration > retainedBackupCheck);
  assert.match(productionWorkflow, /preexisting_backup_sha256:\s*\n\s*description:/);
  assert.match(productionWorkflow, /PRODUCTION_BACKUP_OBJECT: vibepub-production-backups\/d1\/vibepub-db\/2026-07-29T2129CST-before-five-agent-96aefad6\.sql/);
  assert.match(productionWorkflow, /PRODUCTION_BACKUP_SHA256: 96aefad69c8a18ee05ef4b757a2a02eb5ff53fb7a305f94704e6387dc41bc391/);
  assert.match(productionWorkflow, /preapplied_migrations_sha256:\s*\n\s*description:/);
  assert.match(productionWorkflow, /PRODUCTION_MIGRATION_0010_SHA256: 1afaadd72a255021380504cef24d038cb8a83168451b38ed13a98920b72cbe4c/);
  assert.match(productionWorkflow, /PRODUCTION_MIGRATION_0011_SHA256: 7fa3d7b375682a97b9c55c9bdc8bc373b8f7c1fb81162dea13680ee07ff95b6f/);
  assert.match(productionWorkflow, /Verify pre-applied Production D1 migrations[\s\S]*sha256sum -c -[\s\S]*sha256sum -c -/);
  for (const config of ["infra/worker", "infra/image-generation-adapter", "infra/wechat-publishing-adapter"]) {
    assert.match(productionWorkflow, new RegExp(`${config.replaceAll("/", "\\/")}.*wrangler\\.production\\.toml`, "s"));
  }
  assert.match(productionWorkflow, /npm test --prefix infra\/writing-agent/);
  assert.match(productionWorkflow, /wrangler deploy --dry-run --config infra\/writing-agent\/wrangler\.toml/);
  assert.match(productionWorkflow, /Require Production credentials[\s\S]*WRITING_AGENT_TOKEN:\s*\$\{\{ secrets\.WRITING_AGENT_TOKEN \}\}[\s\S]*GLM_API_KEY:\s*\$\{\{ secrets\.GLM_API_KEY \}\}/);
  assert.match(productionWorkflow, /Deploy private Writing Agent[\s\S]*secret put WRITING_AGENT_TOKEN[\s\S]*secret put GLM_API_KEY/);
  assert.match(productionWorkflow, /Sync main Worker five-Agent secrets[\s\S]*WRITING_AGENT_TOKEN:\s*\$\{\{ secrets\.WRITING_AGENT_TOKEN \}\}[\s\S]*secret put WRITING_AGENT_TOKEN/);
});
