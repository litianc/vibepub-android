import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildArticleFeedbackBootstrapGrant,
  buildArticleFeedbackCanaryGrant,
  renderArticleFeedbackBootstrapConfigs,
  renderArticleFeedbackCanaryConfigs,
  StagingArticleFeedbackCanaryError,
  validateArticleFeedbackCanaryGrant,
  stagingManifestFingerprint,
} from "../staging-article-feedback-canary.mjs";

const manifest = JSON.parse(await readFile(new URL("../fixtures/staging-resource-manifest.synthetic.json", import.meta.url), "utf8"));
const identity = {
  candidate_commit: "a".repeat(40),
  manifest_hash: stagingManifestFingerprint(manifest),
  user_id: "canary_user",
  workspace_id: "canary_workspace",
  recording_id: 42,
  source_key: "users/canary_user/inbox/VibePub-canary.m4a",
  source_hash: `sha256:${"1".repeat(64)}`,
  transcript_hash: `sha256:${"2".repeat(64)}`,
  article_id: `article_v3_${"3".repeat(64)}`,
  handoff_id: `handoff_v3_${"4".repeat(64)}`,
  run_id: `run_v3_${"5".repeat(64)}`,
};

function grant(now = new Date()) {
  return buildArticleFeedbackCanaryGrant(identity, {
    now,
    canarySeed: "feedback-test",
    accountBindingId: `wab_${"6".repeat(64)}`,
    providerBaseUrl: "https://api.weixin.qq.com",
    mediaUrlHosts: ["mmbiz.qpic.cn", "mmbiz.qlogo.cn"],
  });
}

test("bootstraps only one audio source while visual and WeChat stay closed", () => {
  const bootstrap = buildArticleFeedbackBootstrapGrant({
    userId: identity.user_id,
    workspaceId: identity.workspace_id,
    sourceKey: identity.source_key,
    candidateCommit: identity.candidate_commit,
    manifestHash: identity.manifest_hash,
  }, { canarySeed: "audio-bootstrap" });
  const configs = renderArticleFeedbackBootstrapConfigs(manifest, bootstrap, "dry-run", "/tmp/vibepub-feedback-bootstrap");
  assert.match(configs["main.wrangler.toml"], /FIVE_AGENT_PUBLISHING_V3 = "true"/);
  assert.match(configs["main.wrangler.toml"], /STAGING_IMAGE_CANARY_SOURCE_KEY = "users\/canary_user\/inbox\/VibePub-canary\.m4a"/);
  assert.match(configs["main.wrangler.toml"], /STAGING_IMAGE_CANARY_RUN_ID = "run_v3_[a-f0-9]{64}"/);
  assert.match(configs["main.wrangler.toml"], /VISUAL_PRODUCTION_V3 = "false"/);
  assert.match(configs["main.wrangler.toml"], /WECHAT_DRAFT_SYNC_V3 = "false"/);
  assert.doesNotMatch(configs["image.wrangler.toml"], /IMAGE_PROVIDER_CANARY_MODE/);
  assert.doesNotMatch(configs["wechat.wrangler.toml"], /STAGING_FEEDBACK_CANARY/);
});

function errorCode(callback) {
  assert.throws(callback, error => error instanceof StagingArticleFeedbackCanaryError);
  try { callback(); } catch (error) { return error.code; }
  throw new Error("expected canary error");
}

test("renders one expiring article feedback canary across main, image, and WeChat", () => {
  const configs = renderArticleFeedbackCanaryConfigs(manifest, grant(), "dry-run", "/tmp/vibepub-feedback-canary");
  const main = configs["main.wrangler.toml"];
  const image = configs["image.wrangler.toml"];
  const wechat = configs["wechat.wrangler.toml"];
  assert.match(main, /FIVE_AGENT_PUBLISHING_V3 = "true"/);
  assert.match(main, /FIVE_AGENT_PUBLISHING_V3_ALLOWLIST = "canary_user:canary_workspace"/);
  assert.match(main, /WECHAT_DRAFT_SYNC_V3 = "true"/);
  assert.match(main, /WECHAT_DRAFT_SYNC_V3_ALLOWLIST = "canary_user:canary_workspace"/);
  assert.match(main, new RegExp(`STAGING_FEEDBACK_CANARY_USER_ID = "${identity.user_id}"`));
  assert.match(main, new RegExp(`STAGING_FEEDBACK_CANARY_ARTICLE_ID = "${identity.article_id}"`));
  assert.match(main, new RegExp(`STAGING_FEEDBACK_CANARY_RUN_ID = "${identity.run_id}"`));
  assert.match(main, /WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST = "wab_[a-f0-9]{64}"/);
  assert.match(image, /IMAGE_PROVIDER_CANARY_MODE = "staging_single_run"/);
  assert.match(wechat, /WECHAT_DRAFT_SYNC_V3 = "true"/);
  assert.match(wechat, new RegExp(`STAGING_FEEDBACK_CANARY_ARTICLE_ID = "${identity.article_id}"`));
  assert.match(wechat, /WECHAT_PROVIDER_BASE_URL_ALLOWLIST = "https:\/\/api\.weixin\.qq\.com\/"/);
  assert.match(wechat, /WECHAT_MEDIA_URL_HOST_ALLOWLIST = "mmbiz\.qlogo\.cn,mmbiz\.qpic\.cn"/);
  assert.doesNotMatch(JSON.stringify(configs), /V3_TENANT_SCOPE = "all"|password|secret|token/i);
});

test("rejects expired, cross-article, private-provider, wildcard-media, and extra-field grants", () => {
  const now = new Date();
  const valid = grant(now);
  assert.equal(errorCode(() => validateArticleFeedbackCanaryGrant({ ...valid, expires_at: new Date(now.getTime() - 1).toISOString() }, now)), "feedback_canary_expiry_invalid");
  assert.equal(errorCode(() => validateArticleFeedbackCanaryGrant({ ...valid, scope: { ...valid.scope, article_id: "article_other" } }, now)), "feedback_canary_article_invalid");
  assert.equal(errorCode(() => validateArticleFeedbackCanaryGrant({ ...valid, wechat: { ...valid.wechat, provider_base_url: "https://127.0.0.1" } }, now)), "feedback_canary_provider_invalid");
  assert.equal(errorCode(() => validateArticleFeedbackCanaryGrant({ ...valid, wechat: { ...valid.wechat, media_url_hosts: ["*.qpic.cn"] } }, now)), "feedback_canary_media_host_invalid");
  assert.equal(errorCode(() => validateArticleFeedbackCanaryGrant({ ...valid, unexpected: true }, now)), "feedback_canary_shape_invalid");
});

test("keeps the permanent staging baseline fully closed", () => {
  const configs = renderArticleFeedbackCanaryConfigs(manifest, grant(), "dry-run", "/tmp/vibepub-feedback-canary");
  assert.match(configs["main.wrangler.toml"], /STAGING_FEEDBACK_CANARY_EXPIRES_AT = "[^"]+"/);
  assert.match(configs["wechat.wrangler.toml"], /STAGING_FEEDBACK_CANARY_EXPIRES_AT = "[^"]+"/);
  assert.doesNotMatch(configs["writing.wrangler.toml"], /STAGING_FEEDBACK_CANARY/);
  assert.doesNotMatch(configs["review.wrangler.toml"], /STAGING_FEEDBACK_CANARY/);
});
