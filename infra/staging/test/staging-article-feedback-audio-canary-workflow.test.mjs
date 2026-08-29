import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../../../.github/workflows/staging-article-feedback-audio-canary.yml", import.meta.url), "utf8");

test("staging audio mining can run only by manual default-branch dispatch", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /Require the repository default branch/);
  assert.match(workflow, /environment: vibepub-staging/);
  assert.match(workflow, /vibepub-staging-deploy/);
  assert.match(workflow, /phase:[\s\S]*transcribe[\s\S]*start[\s\S]*revision/);
});

test("staging audio mining binds exact isolated resources and never receives Production WeChat credentials", () => {
  assert.match(workflow, /STAGING_RESOURCE_MANIFEST_JSON/);
  assert.match(workflow, /STAGING_PUBLIC_BASE_URL/);
  assert.match(workflow, /attest-staging-origin\.mjs --preflight/);
  assert.match(workflow, /attest-staging-origin\.mjs --fetch/);
  assert.match(workflow, /R2_BUCKET_NAME/);
  assert.match(workflow, /MINING_V3_HANDOFF_ENABLED: "true"/);
  assert.match(workflow, /CLEANUP_PERMANENT_AUDIO_FAILURES: "false"/);
  assert.match(workflow, /users\/\$\{USER_ID\}\/inbox\//);
  assert.doesNotMatch(workflow, /vibepub\.litianc\.cn|WECHAT_APP_ID|WECHAT_APP_SECRET|WECHAT_PROXY|GITHUB_PAT|FILES_TOKEN/);
});

test("transcribe and start phases require an exact safe handoff status", () => {
  assert.match(workflow, /set \+e[\s\S]*MINING_EXIT=\$\?[\s\S]*set -e/);
  assert.match(workflow, /if \[ "\$PHASE" != "transcribe" \]; then[\s\S]*exit "\$MINING_EXIT"/);
  assert.match(workflow, /staging-audio-canary-request\.mjs status/);
  assert.match(workflow, /EXPECTED_DECISION/);
  assert.match(workflow, /v3_pending_start/);
  assert.match(workflow, /accepted/);
  assert.match(workflow, /article_id/);
  assert.match(workflow, /run_id/);
  assert.match(workflow, /--workspace-id "\$WORKSPACE_ID"/);
  assert.match(workflow, /--minimum-transcript-created-at "\$CANARY_DEPLOYED_AT"/);
  assert.match(workflow, /if \[ "\$PHASE" = "transcribe" \]; then[\s\S]*FRESHNESS_ARGS/);
  assert.match(workflow, /source_hash/);
  assert.match(workflow, /recording_id/);
  assert.match(workflow, /candidate_commit=process\.env\.GITHUB_SHA/);
  assert.match(workflow, /manifest_hash=process\.env\.STAGING_MANIFEST_HASH/);
  assert.match(workflow, /STAGING_CANARY_EXPECTED_PARENT_VERSION_ID/);
  assert.match(workflow, /Wait for start to reach verified draft_ready/);
  assert.match(workflow, /editorial_status/);
  assert.match(workflow, /completed_agent_count/);
  assert.match(workflow, /v1_count/);
  assert.match(workflow, /wechat_draft_count/);
  assert.match(workflow, /CANARY_DEPLOYED_AT/);
  assert.match(workflow, /candidate_fresh/);
  assert.match(workflow, /Verify revision produced v2 and completed WeChat update/);
  assert.match(workflow, /revision_completed_count/);
  assert.match(workflow, /v2_count/);
  assert.match(workflow, /verify:revision-readback/);
  assert.match(workflow, /revision-readback-evidence\.json/);
  assert.match(workflow, /state\.wechat_readback=readback/);
});

test("every audio phase deploys one bounded grant and always restores the flag-off baseline", () => {
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /Render the permanent flag-off rollback baseline first/);
  assert.match(workflow, /staging-article-feedback-canary\.mjs build-bootstrap/);
  assert.match(workflow, /staging-article-feedback-canary\.mjs build/);
  assert.match(workflow, /staging-article-feedback-canary\.mjs render/);
  assert.match(workflow, /staging-article-feedback-canary\.mjs verify/);
  const dryRun = workflow.indexOf('wrangler deploy --dry-run --config "$RUNNER_TEMP/canary-config/main.wrangler.toml"');
  const refresh = workflow.indexOf("Refresh the expiring grant after dry-run");
  const deploy = workflow.indexOf("Deploy the exact image canary configuration");
  assert.ok(dryRun > 0 && refresh > dryRun && deploy > refresh);
  assert.match(workflow, /wrangler deploy --dry-run --config "\$RUNNER_TEMP\/canary-config\/main\.wrangler\.toml"/);
  assert.match(workflow, /wrangler deploy --config "\$RUNNER_TEMP\/canary-config\/image\.wrangler\.toml"/);
  assert.match(workflow, /wrangler deploy --config "\$RUNNER_TEMP\/canary-config\/wechat\.wrangler\.toml"/);
  assert.match(workflow, /Close the exact-user main gate[\s\S]*if: always\(\)/);
  assert.match(workflow, /Remove the image canary configuration[\s\S]*if: always\(\)/);
  assert.match(workflow, /Remove the WeChat canary configuration[\s\S]*if: always\(\)/);
  assert.match(workflow, /Require all temporary grants to be closed[\s\S]*main-cleanup-deployed[\s\S]*image-cleanup-deployed[\s\S]*wechat-cleanup-deployed/);
  assert.match(workflow, /STAGING_FEEDBACK_CANARY_OPERATOR_RUN_ID:\$\{GITHUB_RUN_ID\}/);
  const mainDeploy = workflow.indexOf("Deploy the exact-user main canary gate");
  const imageDeploy = workflow.indexOf("Deploy the exact image canary configuration");
  assert.ok(mainDeploy > 0 && mainDeploy < imageDeploy);
  const closeMain = workflow.indexOf("Close the exact-user main gate");
  const removeImage = workflow.indexOf("Remove the image canary configuration");
  const removeWechat = workflow.indexOf("Remove the WeChat canary configuration");
  const removeMarker = workflow.indexOf("Remove the main cleanup marker");
  assert.ok(closeMain > 0 && closeMain < removeImage && removeImage < removeWechat && removeWechat < removeMarker);
  assert.match(workflow, /STAGING_FEEDBACK_CANARY_CLEANUP_MARKER_HASH/);
});

test("masks exact inputs and generated grant identities before Wrangler can log variables", () => {
  const inputMask = workflow.indexOf("Mask the exact synthetic inputs before any deployment");
  const grantMask = workflow.indexOf("Mask generated canary identities before rendering");
  const firstDryRun = workflow.indexOf('wrangler deploy --dry-run --config "$RUNNER_TEMP/canary-config/main.wrangler.toml"');
  assert.ok(inputMask > 0 && grantMask > inputMask && firstDryRun > grantMask);
  assert.match(workflow, /::add-mask::\$\{escape\(value\)\}/);
  assert.match(workflow, /feedback-canary-grant\.json[\s\S]*::add-mask::/);
  assert.match(workflow, /replace\(\/%\/g,"%25"\)/);
  assert.match(workflow, /replace\(\/\\r\/g,"%0D"\)/);
  assert.match(workflow, /replace\(\/\\n\/g,"%0A"\)/);
  assert.match(workflow, /> "\$RUNNER_TEMP\/mining-private\.log" 2>&1/);
  assert.doesNotMatch(workflow, /cat "\$RUNNER_TEMP\/mining-private\.log"/);
});

test("bounds Mining time and gives protected D1 checks both Cloudflare credentials", () => {
  assert.match(workflow, /timeout 1200s env PUBLIC_BASE_URL=/);
  assert.match(workflow, /timeout 300s env PUBLIC_BASE_URL=/);
  assert.match(workflow, /timeout 300s npm ci --prefix infra\/mining/);
  assert.match(workflow, /for attempt in \$\(seq 1 40\)/);
  assert.match(workflow, /for attempt in \$\(seq 1 20\)/);
  assert.match(workflow, /timeout 25s node infra\/staging\/query-staging-d1\.mjs/);
  const startCheck = workflow.match(/- name: Wait for start to reach verified draft_ready[\s\S]*?- name: Verify revision produced v2/)?.[0] || "";
  const revisionCheck = workflow.match(/- name: Verify revision produced v2[\s\S]*?- name: Close the exact-user main gate/)?.[0] || "";
  for (const block of [startCheck, revisionCheck]) {
    assert.match(block, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    assert.match(block, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  }
});

test("full feedback grants are release-bound and use protected Staging WeChat policy values", () => {
  assert.match(workflow, /candidate_commit=process\.env\.GITHUB_SHA/);
  assert.match(workflow, /manifest_hash=process\.env\.STAGING_MANIFEST_HASH/);
  assert.match(workflow, /STAGING_WECHAT_ACCOUNT_BINDING_ID/);
  assert.match(workflow, /STAGING_WECHAT_PROVIDER_BASE_URL/);
  assert.match(workflow, /STAGING_WECHAT_MEDIA_URL_HOSTS/);
  assert.match(workflow, /--account-binding-id "\$STAGING_WECHAT_ACCOUNT_BINDING_ID"/);
  assert.match(workflow, /--provider-base-url "\$STAGING_WECHAT_PROVIDER_BASE_URL"/);
  assert.match(workflow, /--media-url-hosts "\$STAGING_WECHAT_MEDIA_URL_HOSTS"/);
  assert.doesNotMatch(workflow, /WECHAT_APP_ID|WECHAT_APP_SECRET|GITHUB_PAT|FILES_TOKEN/);
});

test("shared phase evidence is redacted and cannot be mistaken for final Issue acceptance", () => {
  assert.match(workflow, /Build redacted phase evidence/);
  assert.match(workflow, /phase_only_not_issue_acceptance/);
  assert.match(workflow, /staging-feedback-audio-canary-\$\{\{ github\.run_id \}\}/);
  const upload = workflow.match(/- name: Upload redacted phase evidence[\s\S]*?- name: Require all temporary grants to be closed/)?.[0] || "";
  assert.ok(upload);
  assert.doesNotMatch(upload, /staging-audio-identity\.json/);
  assert.doesNotMatch(upload, /feedback-canary-grant\.json/);
  assert.doesNotMatch(workflow, /article_content|raw_text|transcript_ref/);
});
