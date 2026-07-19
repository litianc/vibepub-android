import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const schema = await readFile(resolve("schema.sql"), "utf8");
const migration = await readFile(resolve("migrations/0010_editorial_visual_pipeline.sql"), "utf8");
const legacy = await readFile(resolve("test/fixtures/editorial/legacy-recordings-schema.sql"), "utf8");

test("canonical schema plus migration is fresh-safe and re-applicable", () => {
  const output = runSql(`${schema}\n${migration}\n${migration}\nSELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('editorial_recording_scopes', 'editorial_version_states', 'editorial_runs', 'editorial_artifacts') ORDER BY name;`);
  assert.deepEqual(output.split("\n").filter(Boolean), [
    "editorial_artifacts",
    "editorial_recording_scopes",
    "editorial_runs",
    "editorial_version_states",
  ]);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+recordings\s+ADD\s+COLUMN\s+workspace_id/i);
});

test("legacy recordings get a deterministic workspace scope and migration can be retried", () => {
  const output = runSql(`${legacy}\n${migration}\n${migration}\nSELECT recording_id || ':' || user_id || ':' || workspace_id FROM editorial_recording_scopes;`);
  assert.equal(output.trim(), "7:usr_legacy:ws_legacy");
});

test("old schema without workspace_id remains upload-compatible by contract", () => {
  assert.match(migration, /workspace_id TEXT NOT NULL DEFAULT 'vibepub-dogfood'/);
  const indexSource = execFileSync("rg", ["-n", "insertUploadedRecording|workspace_id", "src/index.ts"], { encoding: "utf8" });
  assert.match(indexSource, /insertUploadedRecording/);
  assert.match(indexSource, /INSERT OR IGNORE INTO editorial_recording_scopes/);
});

test("SQLite composite ownership and append-only triggers reject cross-scope and snapshot mutation", () => {
  const valid = versionInsert({ id: "av_parent", userId: "usr_legacy", workspaceId: "ws_legacy", parentId: null });
  runSql(`${legacy}\n${migration}\n${valid}`);

  assert.throws(() => runSql(`${legacy}\n${migration}\n${valid}\n
    INSERT INTO users (id, email, workspace_id) VALUES ('usr_other', 'other@example.test', 'ws_other');
    INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id) VALUES (7, 'usr_other', 'ws_other');
    ${versionInsert({ id: "av_child", userId: "usr_other", workspaceId: "ws_other", parentId: "av_parent" })}`));
  assert.throws(() => runSql(`${legacy}\n${migration}\n${valid}\nUPDATE article_versions SET body = 'changed' WHERE id = 'av_parent';`));
});

function runSql(sql) {
  return execFileSync("sqlite3", [":memory:"], {
    input: `.bail on\n${sql}\n.mode list\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function versionInsert({ id, userId, workspaceId, parentId }) {
  const quote = value => value === null ? "NULL" : `'${value}'`;
  return `INSERT INTO article_versions
    (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id, source,
     source_job_id, source_hash, title, body, cover_json, blocks_json, title_candidates_json,
     selected_title, cover_title_json, claim_ledger_json, visual_plan_json, formatting_skill_id,
     formatting_skill_version, content_html_hash, html_warnings_json, generation_status,
     idempotency_key, payload_hash, created_at)
    VALUES (${quote(id)}, ${quote(userId)}, ${quote(workspaceId)}, 'article_1', 7, ${parentId ? 2 : 1},
      ${quote(parentId)}, 'initial', NULL, NULL, 'Synthetic', 'Synthetic body', '{}', '[]', '[]',
      'Synthetic', '[]', '[]', '[]', NULL, NULL, NULL, '[]', 'generated', ${quote(id + '_key')},
      'sha256:synthetic', '2026-07-19T00:00:00Z');`;
}
