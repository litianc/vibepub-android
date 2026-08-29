import { describe, expect, it } from "vitest";
import { visualProductionFeatureEnabled } from "../src/fiveAgentPublishing";
import { publicationSourceFeatureEnabled, publicationTenantFeatureEnabled, v3TenantAllowed } from "../src/publicationProjection";
import { isWechatAccountAllowed, wechatDraftFeatureEnabled } from "../src/wave2/wechatServiceClients";

describe("Production V3 tenant scope", () => {
  it("enables every tenant only through the explicit all scope", () => {
    const all = { V3_TENANT_SCOPE: "all" };
    expect(v3TenantAllowed(all, "", "future-user", "future-workspace")).toBe(true);
    expect(publicationTenantFeatureEnabled({ ...all, FIVE_AGENT_PUBLISHING_V3: "true" }, "future-user", "future-workspace")).toBe(true);
    expect(visualProductionFeatureEnabled({ ...all, VISUAL_PRODUCTION_V3: "true" } as any, "future-user", "future-workspace")).toBe(true);
    expect(wechatDraftFeatureEnabled({ ...all, WECHAT_DRAFT_SYNC_V3: "true" }, "future-user", "future-workspace")).toBe(true);
    expect(isWechatAccountAllowed("", "wab_future", all)).toBe(true);
  });

  it("fails closed for unknown scopes and preserves exact allowlists by default", () => {
    expect(v3TenantAllowed({ V3_TENANT_SCOPE: "unknown" }, "user-1:workspace-1", "user-1", "workspace-1")).toBe(false);
    expect(v3TenantAllowed({}, "user-1:workspace-1", "user-1", "workspace-1")).toBe(true);
    expect(v3TenantAllowed({}, "", "user-1", "workspace-1")).toBe(false);
    expect(isWechatAccountAllowed("wab_allowed", "wab_denied", {})).toBe(false);
  });

  it("expires the isolated staging feedback canary even when the tenant allowlist is still present", () => {
    const base = {
      DEPLOY_ENVIRONMENT: "staging",
      WECHAT_DRAFT_SYNC_V3: "true",
      WECHAT_DRAFT_SYNC_V3_ALLOWLIST: "user-1:workspace-1",
      STAGING_FEEDBACK_CANARY_MODE: "staging_article_feedback",
      STAGING_FEEDBACK_CANARY_USER_ID: "user-1",
      STAGING_FEEDBACK_CANARY_WORKSPACE_ID: "workspace-1",
      STAGING_FEEDBACK_CANARY_ARTICLE_ID: "article-1",
      STAGING_FEEDBACK_CANARY_RUN_ID: "run-1",
    };
    expect(wechatDraftFeatureEnabled({
      ...base,
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, "user-1", "workspace-1", "article-1", "run-1")).toBe(true);
    expect(wechatDraftFeatureEnabled({
      ...base,
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: new Date(Date.now() - 1).toISOString(),
    }, "user-1", "workspace-1", "article-1", "run-1")).toBe(false);
    expect(wechatDraftFeatureEnabled({
      ...base,
      STAGING_FEEDBACK_CANARY_USER_ID: "other-user",
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, "user-1", "workspace-1", "article-1", "run-1")).toBe(false);
    expect(wechatDraftFeatureEnabled({
      ...base,
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, "user-1", "workspace-1", "other-article", "run-1")).toBe(false);
  });

  it("opens only the exact audio source during an expiring staging bootstrap", () => {
    const source = "users/user-1/inbox/VibePub-canary.m4a";
    const env = {
      DEPLOY_ENVIRONMENT: "staging",
      FIVE_AGENT_PUBLISHING_V3: "true",
      FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "user-1:workspace-1",
      STAGING_IMAGE_CANARY_MODE: "staging_single_run",
      STAGING_IMAGE_CANARY_RUN_ID: `run_v3_${"1".repeat(64)}`,
      STAGING_IMAGE_CANARY_USER_ID: "user-1",
      STAGING_IMAGE_CANARY_WORKSPACE_ID: "workspace-1",
      STAGING_IMAGE_CANARY_SOURCE_KEY: source,
      STAGING_IMAGE_CANARY_EXPIRES_AT: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      STAGING_FEEDBACK_CANARY_MODE: "staging_article_feedback",
      STAGING_FEEDBACK_CANARY_USER_ID: "user-1",
      STAGING_FEEDBACK_CANARY_WORKSPACE_ID: "workspace-1",
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    expect(publicationSourceFeatureEnabled(env, "user-1", "workspace-1", source)).toBe(true);
    expect(publicationSourceFeatureEnabled(env, "user-1", "workspace-1", "users/user-1/inbox/other.m4a")).toBe(false);
    expect(publicationSourceFeatureEnabled(env, "user-1", "workspace-1", "users/user-1/inbox/../other.m4a")).toBe(false);
  });
});
