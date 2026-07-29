import { describe, expect, it } from "vitest";
import { visualProductionFeatureEnabled } from "../src/fiveAgentPublishing";
import { publicationTenantFeatureEnabled, v3TenantAllowed } from "../src/publicationProjection";
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
});
