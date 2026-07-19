import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrangler = await readFile(resolve(root, "wrangler.toml"), "utf8");

test("phase 2 runtime configuration is fresh-safe and feature-gated", async () => {
  assert.match(wrangler, /compatibility_flags\s*=\s*\[[^\]]*nodejs_compat/);
  assert.match(wrangler, /EDITORIAL_WORKFLOW_V2\s*=\s*"false"/);
  assert.match(wrangler, /EDITORIAL_WORKFLOW_V2_ALLOWLIST\s*=\s*""/);

  for (const [binding, className] of [
    ["EDITORIAL_COORDINATOR", "EditorialCoordinatorAgent"],
    ["EDITORIAL_WRITING", "EditorialWritingAgent"],
    ["EDITORIAL_REVIEW", "EditorialReviewAgent"],
    ["EDITORIAL_VISUAL_PRODUCTION", "EditorialVisualProductionAgent"],
    ["EDITORIAL_WECHAT_PUBLISHING", "EditorialWechatPublishingAgent"],
  ]) {
    assert.match(
      wrangler,
      new RegExp(`name = "${binding}"[\\s\\S]*?class_name = "${className}"`),
    );
  }

  for (const [binding, className] of [
    ["EDITORIAL_ILLUSTRATION", "EditorialIllustrationAgent"],
    ["EDITORIAL_COVER", "EditorialCoverAgent"],
  ]) {
    assert.match(
      wrangler,
      new RegExp(`name = "${binding}"[\\s\\S]*?class_name = "${className}"`),
    );
  }

  assert.match(
    wrangler,
    /name\s*=\s*"editorial-workflow-v2"[\s\S]*?binding\s*=\s*"EDITORIAL_WORKFLOW"[\s\S]*?class_name\s*=\s*"EditorialWorkflow"/,
  );
  assert.match(wrangler, /tag\s*=\s*"v2-editorial-agents"/);
  assert.match(wrangler, /tag\s*=\s*"v3-five-agent-publishing"[\s\S]*?EditorialVisualProductionAgent[\s\S]*?EditorialWechatPublishingAgent/);
  const v3Migration = wrangler.match(/tag\s*=\s*"v3-five-agent-publishing"[\s\S]*?(?=\[\[migrations\]\]|$)/)?.[0] || "";
  assert.doesNotMatch(v3Migration, /EditorialIllustrationAgent|EditorialCoverAgent/);

  const migrationFiles = await readdir(resolve(root, "migrations"));
  assert.equal(migrationFiles.some((file) => file === "0011_five_agent_publication_projection.sql"), true);
});
