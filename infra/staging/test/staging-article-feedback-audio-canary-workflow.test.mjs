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
  assert.match(workflow, /source_hash/);
  assert.match(workflow, /recording_id/);
  assert.match(workflow, /candidate_commit=process\.env\.GITHUB_SHA/);
  assert.match(workflow, /manifest_hash=process\.env\.STAGING_MANIFEST_HASH/);
  assert.match(workflow, /STAGING_CANARY_EXPECTED_PARENT_VERSION_ID/);
});
