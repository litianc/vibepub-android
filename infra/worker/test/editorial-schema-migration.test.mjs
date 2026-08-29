import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const schema = await readFile(resolve("schema.sql"), "utf8");
const migration = await readFile(resolve("migrations/0010_editorial_visual_pipeline.sql"), "utf8");
const legacy = await readFile(resolve("test/fixtures/editorial/legacy-recordings-schema.sql"), "utf8");
const workerIndex = await readFile(resolve("src/index.ts"), "utf8");
const miningV3Handoff = await readFile(resolve("src/miningV3Handoff.ts"), "utf8");
const recordingLookupMatch = miningV3Handoff.match(/async function recordingForSource[\s\S]*?env\.DB\.prepare\(`([\s\S]*?)`\)\.bind\(key\)/);
assert.ok(recordingLookupMatch, "recordingForSource D1 lookup must remain extractable for legacy-schema verification");
const recordingLookup = recordingLookupMatch[1];

test("canonical schema plus migration is fresh-safe and re-applicable", () => {
  const output = runSql(`${schema}\n${migration}\n${migration}\nSELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('editorial_recording_scopes', 'editorial_version_states', 'editorial_runs', 'editorial_artifacts') ORDER BY name;`);
  assert.deepEqual(output.split("\n").filter(Boolean), [
    "editorial_artifacts",
    "editorial_recording_scopes",
    "editorial_runs",
    "editorial_version_states",
  ]);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+recordings\s+ADD\s+COLUMN\s+workspace_id/i);
  assert.deepEqual(triggerNames(`${schema}\n${migration}\n${migration}`), expectedEditorialTriggers);
});

test("legacy recordings get a deterministic workspace scope and migration can be retried", () => {
  const output = runSql(`${legacy}\n${migration}\n${migration}\nSELECT recording_id || ':' || user_id || ':' || workspace_id FROM editorial_recording_scopes;`);
  assert.equal(output.trim(), "7:usr_legacy:ws_legacy");
});

test("legacy recordings are not backfilled into article versions", () => {
  const output = runSql(`${legacy}\n${migration}\n${migration}\n
    SELECT (SELECT count(*) FROM recordings) || ':' ||
           (SELECT count(*) FROM article_versions);`);
  assert.equal(output.trim(), "1:0");
});

test("legacy recordings whose owner no longer exists do not block migration", () => {
  const orphan = `
    INSERT INTO recordings (id, user_id, filename, r2_key)
    VALUES (8, 'usr_removed', 'orphan.m4a', 'audio/orphan.m4a');`;
  const output = runSql(`${legacy}\n${orphan}\n${migration}\n${migration}\n
    SELECT (SELECT count(*) FROM recordings) || ':' ||
           (SELECT count(*) FROM editorial_recording_scopes) || ':' ||
           (SELECT count(*) FROM editorial_recording_scopes WHERE recording_id = 8);`);
  assert.equal(output.trim(), "2:1:0");
});

test("Mining V3 source lookup reads workspace scope when legacy recordings has no workspace_id", () => {
  const legacyHandoffSchema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, workspace_id TEXT NOT NULL);
    CREATE TABLE recordings (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      source_type TEXT DEFAULT 'RECORDING',
      article_title TEXT,
      style_profile_id TEXT,
      style_profile_version TEXT,
      layout_profile_id TEXT,
      layout_profile_version TEXT
    );
    INSERT INTO users (id, email, workspace_id) VALUES ('usr_handoff', 'handoff@example.test', 'ws_handoff');
    INSERT INTO recordings (id, user_id, filename, r2_key) VALUES (8, 'usr_handoff', 'handoff.m4a', 'audio/handoff.m4a');`;
  const lookup = recordingLookup.replace("WHERE r.r2_key = ?", "WHERE r.r2_key = 'audio/handoff.m4a'");
  const output = runSql(`${legacyHandoffSchema}\n${migration}\nWITH lookup AS (${lookup})
    SELECT id || ':' || user_id || ':' || workspace_id || ':' || r2_key FROM lookup;`);
  assert.equal(output.trim(), "8:usr_handoff:ws_handoff:audio/handoff.m4a");
});

test("text submission scope backfill supports canonical fresh and legacy existing schemas", () => {
  const canonical = `
    INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id)
    VALUES ('usr_text', 'text@example.test', 'hash', 'salt', 1, 'ws_text');
    INSERT INTO recordings (id, user_id, workspace_id, filename, r2_key, source_type, status, processing_stage, raw_text)
    VALUES (42, 'usr_text', 'ws_text', 'text-submit.txt', 'users/usr_text/text-submissions/text-submit.txt', 'TEXT', 'PROCESSING', 'REWRITING', 'Synthetic text');
    INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
    SELECT id, 'usr_text', 'ws_text' FROM recordings WHERE user_id = 'usr_text' AND filename = 'text-submit.txt';
    ${versionInsert({ id: "av_text_canonical", userId: "usr_text", workspaceId: "ws_text", recordingId: 42, parentId: null })}
    SELECT recording_id || ':' || user_id || ':' || workspace_id || ':' ||
           (SELECT count(*) FROM article_versions WHERE id = 'av_text_canonical')
    FROM editorial_recording_scopes WHERE recording_id = 42;`;
  assert.equal(runSql(`${schema}\n${migration}\n${canonical}`).trim(), "42:usr_text:ws_text:1");

  const legacyExisting = `
    INSERT INTO recordings (id, user_id, filename, r2_key, status)
    VALUES (8, 'usr_legacy', 'text-submit.txt', 'text/legacy.txt', 'PROCESSING');
    INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
    SELECT id, 'usr_legacy', 'ws_legacy' FROM recordings WHERE user_id = 'usr_legacy' AND filename = 'text-submit.txt';
    ${versionInsert({ id: "av_text_legacy", userId: "usr_legacy", workspaceId: "ws_legacy", recordingId: 8, parentId: null })}
    SELECT recording_id || ':' || user_id || ':' || workspace_id || ':' ||
           (SELECT count(*) FROM article_versions WHERE id = 'av_text_legacy')
    FROM editorial_recording_scopes WHERE recording_id = 8;`;
  assert.equal(runSql(`${legacy}\n${migration}\n${legacyExisting}`).trim(), "8:usr_legacy:ws_legacy:1");
});

test("old schema without workspace_id remains upload-compatible by contract", () => {
  assert.match(migration, /workspace_id TEXT NOT NULL DEFAULT 'vibepub-dogfood'/);
  assert.match(workerIndex, /insertUploadedRecording/);
  assert.match(workerIndex, /INSERT OR IGNORE INTO editorial_recording_scopes/);
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

test("recording deletion keeps the editorial audit tombstone and immutable history", () => {
  const version = versionInsert({ id: "av_delete", userId: "usr_legacy", workspaceId: "ws_legacy", parentId: null });
  const auditRows = `
    INSERT INTO editorial_reviews
      (id, user_id, workspace_id, article_id, recording_id, input_version_id, findings_json, decision,
       producer_role, producer_version, idempotency_key, payload_hash)
    VALUES ('review_delete', 'usr_legacy', 'ws_legacy', 'article_1', 7, 'av_delete', '[]', 'pass',
            'editorial_review', 'editorial-review.worker.v1', 'review_delete_key', 'sha256:review');
    INSERT INTO visual_plans
      (id, user_id, workspace_id, article_id, recording_id, version_id, items_json, idempotency_key, payload_hash)
    VALUES ('visual_delete', 'usr_legacy', 'ws_legacy', 'article_1', 7, 'av_delete', '[]', 'visual_delete_key', 'sha256:visual');
    INSERT INTO editorial_version_states
      (version_id, user_id, workspace_id, article_id, recording_id, state, state_revision)
    VALUES ('av_delete', 'usr_legacy', 'ws_legacy', 'article_1', 7, 'draft_generated', 0);
    INSERT INTO editorial_state_transition_requests
      (id, version_id, user_id, workspace_id, article_id, recording_id, from_state, to_state,
       expected_revision, result_revision, idempotency_key, payload_hash)
    VALUES ('transition_delete', 'av_delete', 'usr_legacy', 'ws_legacy', 'article_1', 7,
            'draft_generated', 'review_pending', 0, 1, 'transition_delete_key', 'sha256:transition');
    DELETE FROM recordings WHERE id = 7;
    SELECT (SELECT count(*) FROM recordings) || ':' ||
           (SELECT count(*) FROM editorial_recording_scopes WHERE recording_id = 7) || ':' ||
           (SELECT count(*) FROM article_versions WHERE id = 'av_delete') || ':' ||
           (SELECT count(*) FROM editorial_reviews WHERE id = 'review_delete') || ':' ||
           (SELECT count(*) FROM visual_plans WHERE id = 'visual_delete') || ':' ||
           (SELECT count(*) FROM editorial_state_transition_requests WHERE id = 'transition_delete');`;
  assert.equal(runSql(`${legacy}\n${migration}\n${version}\n${auditRows}`).trim(), "0:1:1:1:1:1");
});

test("legacy migration has the same append-only trigger contract", () => {
  assert.deepEqual(triggerNames(`${legacy}\n${migration}\n${migration}`), expectedEditorialTriggers);
});

test("editorial run projection permits only CAS terminal updates and forward-fixes the old trigger", () => {
  const setup = `
    INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id)
    VALUES ('usr_run', 'run@example.test', 'hash', 'salt', 1, 'ws_run');
    INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
    VALUES (77, 'usr_run', 'ws_run');
    INSERT INTO editorial_runs
      (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
       workflow_version, policy_version, agent_versions_json, skill_pins_json,
       status, idempotency_key, payload_hash, created_at, updated_at)
    VALUES ('run_projection', 'usr_run', 'ws_run', 'article_run', 77, 'editorial-orchestration.v2',
       'editorial-workflow.v2', 'editorial-policy.v2', '{}', '{}', 'running',
       'run:run_projection', 'sha256:run', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');`;
  const oldTrigger = `
    DROP TRIGGER editorial_runs_append_only_update;
    CREATE TRIGGER editorial_runs_append_only_update
    BEFORE UPDATE ON editorial_runs
    BEGIN SELECT RAISE(ABORT, 'old_append_only_trigger'); END;`;
  const completed = `${schema}\n${oldTrigger}\n${migration}\n${setup}
    UPDATE editorial_runs SET status = 'completed', updated_at = '2026-07-19T00:00:01.000Z' WHERE run_id = 'run_projection';
    SELECT status || ':' || updated_at FROM editorial_runs WHERE run_id = 'run_projection';`;
  assert.equal(runSql(completed).trim(), "completed:2026-07-19T00:00:01.000Z");

  assert.throws(() => runSql(`${schema}\n${migration}\n${setup}
    UPDATE editorial_runs SET status = 'completed', updated_at = '2026-07-19T00:00:01.000Z' WHERE run_id = 'run_projection';
    UPDATE editorial_runs SET status = 'failed', updated_at = '2026-07-19T00:00:02.000Z' WHERE run_id = 'run_projection';`));
  assert.throws(() => runSql(`${schema}\n${migration}\n${setup}
    UPDATE editorial_runs SET agent_versions_json = '{"changed":true}', updated_at = '2026-07-19T00:00:01.000Z' WHERE run_id = 'run_projection';`));
});

const expectedEditorialTriggers = [
  "article_versions_append_only_delete",
  "article_versions_append_only_update",
  "editorial_artifacts_append_only_delete",
  "editorial_artifacts_append_only_update",
  "editorial_reviews_append_only_delete",
  "editorial_reviews_append_only_update",
  "editorial_runs_append_only_delete",
  "editorial_runs_append_only_update",
  "editorial_state_transition_requests_append_only_delete",
  "editorial_state_transition_requests_append_only_update",
  "editorial_version_states_immutable_snapshot",
  "visual_plans_append_only_delete",
  "visual_plans_append_only_update",
];

function triggerNames(sql) {
  return runSql(`${sql}\nSELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'article_versions_%' OR name LIKE 'editorial_%' OR name LIKE 'visual_plans_%') ORDER BY name;`).split("\n").filter(Boolean);
}

function runSql(sql) {
  return execFileSync("sqlite3", [":memory:"], {
    input: `.bail on\n${sql}\n.mode list\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function versionInsert({ id, userId, workspaceId, recordingId = 7, parentId }) {
  const quote = value => value === null ? "NULL" : `'${value}'`;
  return `INSERT INTO article_versions
    (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id, source,
     source_job_id, source_hash, title, body, cover_json, blocks_json, title_candidates_json,
     selected_title, cover_title_json, claim_ledger_json, visual_plan_json, formatting_skill_id,
     formatting_skill_version, content_html_hash, html_warnings_json, generation_status,
     idempotency_key, payload_hash, created_at)
    VALUES (${quote(id)}, ${quote(userId)}, ${quote(workspaceId)}, 'article_1', ${recordingId}, ${parentId ? 2 : 1},
      ${quote(parentId)}, 'initial', NULL, NULL, 'Synthetic', 'Synthetic body', '{}', '[]', '[]',
      'Synthetic', '[]', '[]', '[]', NULL, NULL, NULL, '[]', 'generated', ${quote(id + '_key')},
      'sha256:synthetic', '2026-07-19T00:00:00Z');`;
}
