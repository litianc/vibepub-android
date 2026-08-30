import { describe, expect, it } from "vitest";
import { stagingFeedbackCanaryHealth, type Env } from "../src/index";

describe("Staging feedback canary health marker", () => {
  it("returns no marker for the permanent baseline", async () => {
    await expect(stagingFeedbackCanaryHealth({} as Env)).resolves.toBeNull();
  });

  it("publishes only a hashed operator identity and expiry for a valid Staging canary", async () => {
    const marker = await stagingFeedbackCanaryHealth({
      DEPLOY_ENVIRONMENT: "staging",
      DEPLOY_COMMIT: "a".repeat(40),
      STAGING_FEEDBACK_CANARY_MODE: "staging_article_feedback",
      STAGING_FEEDBACK_CANARY_RUN_ID: `run_v3_${"a".repeat(64)}`,
      STAGING_FEEDBACK_CANARY_OPERATOR_RUN_ID: "123456789",
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: "2026-08-29T13:45:00.000Z",
      STAGING_FEEDBACK_CANARY_USER_ID: "private-user",
      STAGING_FEEDBACK_CANARY_WORKSPACE_ID: "private-workspace",
    } as Env);
    expect(marker).toEqual({
      configured: true,
      valid: true,
      operator_run_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      candidate_commit: "a".repeat(40),
      expires_at: "2026-08-29T13:45:00.000Z",
      cleanup_pending: false,
    });
    expect(JSON.stringify(marker)).not.toContain("private-user");
    expect(JSON.stringify(marker)).not.toContain("private-workspace");
    expect(JSON.stringify(marker)).not.toContain("123456789");
  });

  it("reports malformed canary configuration without echoing its values", async () => {
    await expect(stagingFeedbackCanaryHealth({
      DEPLOY_ENVIRONMENT: "production",
      STAGING_FEEDBACK_CANARY_MODE: "staging_article_feedback",
      STAGING_FEEDBACK_CANARY_OPERATOR_RUN_ID: "bad-value",
      STAGING_FEEDBACK_CANARY_EXPIRES_AT: "bad-date",
    } as Env)).resolves.toEqual({ configured: true, valid: false });
  });

  it("keeps a safe cleanup marker after the user gates are already off", async () => {
    const hash = `sha256:${"b".repeat(64)}`;
    await expect(stagingFeedbackCanaryHealth({
      DEPLOY_ENVIRONMENT: "staging",
      DEPLOY_COMMIT: "b".repeat(40),
      STAGING_FEEDBACK_CANARY_CLEANUP_MARKER_HASH: hash,
    } as Env)).resolves.toEqual({
      configured: true, valid: true, operator_run_hash: hash, candidate_commit: "b".repeat(40), expires_at: null, cleanup_pending: true,
    });
  });
});
