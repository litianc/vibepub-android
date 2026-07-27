import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../../../.github/workflows/wave2e-staging.yml", import.meta.url), "utf8");
const deploymentEvidenceScript = await readFile(new URL("../record-staging-deployment-evidence.mjs", import.meta.url), "utf8");

function job(name, next) {
  const start = workflow.indexOf(`  ${name}:`);
  const end = next ? workflow.indexOf(`  ${next}:`, start) : workflow.length;
  return workflow.slice(start, end);
}

function jobHeader(name) {
  const start = workflow.indexOf(`  ${name}:`);
  const steps = workflow.indexOf("    steps:", start);
  return workflow.slice(start, steps);
}

test("Wave 2E staging validation remains synthetic, credential-free, and includes Worker runtime plus Mining gates", () => {
  const validate = job("validate", "attest-staging-data");
  assert.match(validate, /Synthetic staging validation only/);
  assert.match(validate, /--intent dry-run/);
  assert.match(validate, /wrangler deploy --dry-run --config/);
  assert.match(validate, /npm run test:runtime --prefix infra\/worker/);
  assert.match(validate, /npm test --prefix infra\/mining/);
  assert.match(validate, /tsc --noEmit -p infra\/mining\/tsconfig\.json/);
  assert.doesNotMatch(validate, /secrets\.|CLOUDFLARE_API_TOKEN|wrangler secret put/);
});

test("manual staging deploy is evidence-gated, dynamically rendered, adapter-first, and never migrates D1", () => {
  const attestation = job("attest-staging-data", "attest-staging-origin");
  const origin = job("attest-staging-origin", "deploy-writing");
  assert.match(attestation, /environment: vibepub-staging/);
  assert.match(attestation, /manifest_sha256/);
  assert.match(attestation, /sha256sum/);
  assert.match(workflow, /staging_d1_backup_and_additive_migrations_verified_v1/);
  assert.match(attestation, /validate-staging-data-attestation/);
  assert.match(attestation, /No remote D1 migration is run/);
  assert.match(workflow, /capture-staging-deployment-baseline\.mjs/);
  assert.match(origin, /needs: attest-staging-data/);
  assert.match(origin, /STAGING_PUBLIC_BASE_URL: \$\{\{ vars\.STAGING_PUBLIC_BASE_URL \}\}/);
  assert.match(origin, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(origin, /workers\/subdomain/);
  assert.match(origin, /attest-staging-origin\.mjs --preflight/);
  assert.match(origin, /staging manifest changed after data attestation/);
  assert.doesNotMatch(origin, /MINING_SERVICE_TOKEN|MINING_V3_HANDOFF_TOKEN|GLM_API_KEY|GPT_IMAGE_API_KEY|CREDENTIAL_ENCRYPTION_KEY/);

  const writing = job("deploy-writing", "deploy-review");
  const review = job("deploy-review", "deploy-image");
  const image = job("deploy-image", "deploy-wechat");
  const wechat = job("deploy-wechat", "deploy-main");
  const main = job("deploy-main", "verify-staging-health");
  for (const [name, section] of [["deploy-writing", writing], ["deploy-review", review], ["deploy-image", image], ["deploy-wechat", wechat]]) {
    assert.match(section, /attest-staging-data/);
    assert.match(section, /attest-staging-origin/);
    assert.match(section, /verify-staging-config/);
    assert.match(section, /Bootstrap private/);
    assert.match(section, /wrangler deployments list --json/);
    assert.match(section, /wrangler secret put .*--config/);
    assert.match(section, /EXPECTED_MANIFEST_SHA256/);
    assert.match(section, /staging manifest changed after attestation/);
    assert.match(section, /CLOUDFLARE_ACCOUNT_ID is required/);
    assert.match(jobHeader(name), /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  }
  assert.match(main, /needs: \[attest-staging-data, attest-staging-origin, deploy-writing, deploy-review, deploy-image, deploy-wechat\]/);
  assert.match(main, /verify-staging-config/);
  assert.match(main, /MINING_SERVICE_TOKEN/);
  assert.match(main, /EXPECTED_MANIFEST_SHA256/);
  assert.match(main, /CLOUDFLARE_ACCOUNT_ID is required/);
  assert.match(jobHeader("deploy-main"), /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(main, /Bootstrap route-free, flag-off main Worker before secret sync/);
  assert.match(main, /wrangler deployments list --json/);
  assert.doesNotMatch(workflow, /wrangler d1 migrations apply/);
  assert.doesNotMatch(workflow, /service = "writing-agent-staging"/);
  assert.doesNotMatch(deploymentEvidenceScript, /appendFile|JSON\.stringify\(evidence\)/);
  assert.match(deploymentEvidenceScript, /process\.stdout\.write\(`\$\{line\}\\n`\)/);
});

test("adapter secret scopes are split by deployment job and main health proves the private service bindings", () => {
  const writing = job("deploy-writing", "deploy-review");
  const review = job("deploy-review", "deploy-image");
  const image = job("deploy-image", "deploy-wechat");
  const wechat = job("deploy-wechat", "deploy-main");
  assert.match(writing, /WRITING_AGENT_TOKEN/);
  assert.match(writing, /GLM_API_KEY/);
  assert.doesNotMatch(writing, /GPT_IMAGE_API_KEY|CREDENTIAL_ENCRYPTION_KEY|REVIEW_AGENT_TOKEN/);
  assert.match(review, /REVIEW_AGENT_TOKEN/);
  assert.doesNotMatch(review, /GLM_API_KEY|GPT_IMAGE_API_KEY|CREDENTIAL_ENCRYPTION_KEY/);
  assert.match(image, /VISUAL_PRODUCTION_TOKEN/);
  assert.match(image, /GPT_IMAGE_API_KEY/);
  assert.doesNotMatch(image, /GLM_API_KEY|CREDENTIAL_ENCRYPTION_KEY/);
  assert.match(wechat, /WECHAT_PUBLISHING_TOKEN/);
  assert.match(wechat, /CREDENTIAL_ENCRYPTION_KEY/);
  assert.doesNotMatch(wechat, /GLM_API_KEY|GPT_IMAGE_API_KEY/);
  for (const section of [writing, review, image, wechat]) {
    const install = section.indexOf("Install ");
    assert.ok(install >= 0);
    assert.doesNotMatch(section.slice(0, install), /WRITING_AGENT_TOKEN|REVIEW_AGENT_TOKEN|VISUAL_PRODUCTION_TOKEN|WECHAT_PUBLISHING_TOKEN|GLM_API_KEY|GPT_IMAGE_API_KEY|CREDENTIAL_ENCRYPTION_KEY/);
  }
  const health = job("verify-staging-health", "attest-staging-mining-readiness");
  assert.match(health, /health\?adapters=1/);
  assert.match(health, /verify-staging-health/);
  assert.match(health, /for attempt in 1 2 3 4 5/);
  assert.match(health, /--connect-timeout 5 --max-time 15/);
  assert.match(health, /Stale staging version evidence/);
  assert.match(health, /\[ "\$status" != "429" \]/);
});

test("staging Mining is an exact unscheduled readiness attestation, never a launch", () => {
  const mining = job("attest-staging-mining-readiness");
  assert.match(mining, /staging_mining_readiness_verified_v1/);
  assert.match(mining, /validate-staging-mining-readiness/);
  assert.match(mining, /MINING_SERVICE_TOKEN/);
  assert.match(mining, /MINING_V3_HANDOFF_TOKEN/);
  assert.match(mining, /health\?adapters=1/);
  assert.match(mining, /for attempt in 1 2 3 4 5/);
  assert.match(mining, /invalid_claim_target/);
  assert.match(mining, /mining_handoff_recording_not_found/);
  assert.match(mining, /api\/internal\/mining-claims/);
  assert.match(mining, /api\/internal\/v3\/mining-handoffs\/status/);
  assert.match(mining, /mining-handoffs\/eligibility/);
  assert.match(mining, /EXPECTED_MANIFEST_SHA256/);
  assert.match(mining, /Stale staging version evidence/);
  assert.match(mining, /does not start Mining/);
  assert.doesNotMatch(mining, /npm start|schedule:|mining-job\.yml/);
});

test("only approved remote staging deploys serialize and every downstream job pins the attested manifest", () => {
  assert.match(workflow, /group: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.deploy == 'true' && 'vibepub-staging-deploy'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(job("deploy-writing", "deploy-review"), /needs: \[attest-staging-data, attest-staging-origin\]/);
  assert.match(job("deploy-review", "deploy-image"), /needs: \[attest-staging-data, attest-staging-origin, deploy-writing\]/);
  assert.match(job("deploy-image", "deploy-wechat"), /needs: \[attest-staging-data, attest-staging-origin, deploy-review\]/);
  assert.match(job("deploy-wechat", "deploy-main"), /needs: \[attest-staging-data, attest-staging-origin, deploy-image\]/);
  assert.match(job("verify-staging-health", "attest-staging-mining-readiness"), /needs: \[deploy-main, attest-staging-origin\]/);
  assert.match(job("verify-staging-health", "attest-staging-mining-readiness"), /needs\.deploy-main\.outputs\.manifest_sha256/);
  assert.match(job("attest-staging-mining-readiness"), /needs\.attest-staging-data\.outputs\.manifest_sha256/);
  for (const label of ["Writing", "Review", "Image", "WeChat", "Main"]) {
    assert.match(workflow, new RegExp(`${label} active version.*--require-active`));
  }
});
