import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const schema = await readFile(resolve("schema.sql"), "utf8");
const migration = await readFile(resolve("migrations/0012_article_feedback.sql"), "utf8");

test("feedback migration keeps server-ordered choice history and is re-applicable", () => {
  const output = runSql(`${schema}\n${migration}\n${migration}\n${feedbackFixture}\n
    INSERT INTO article_feedback_events
      (id, user_id, workspace_id, article_id, recording_id, version_id, action,
       client_event_id, payload_hash, occurred_at)
    VALUES
      ('feedback_1', 'usr_feedback', 'ws_feedback', 'article_feedback', 71, 'version_1',
       'adopted', 'client_1', 'sha256:1', '2026-08-29T00:00:01Z'),
      ('feedback_2', 'usr_feedback', 'ws_feedback', 'article_feedback', 71, 'version_1',
       'not_adopted', 'client_2', 'sha256:2', '2026-08-29T00:00:02Z'),
      ('feedback_3', 'usr_feedback', 'ws_feedback', 'article_feedback', 71, 'version_1',
       'adopted', 'client_3', 'sha256:3', '2026-08-29T00:00:03Z');
    SELECT group_concat(action, ',') FROM
      (SELECT action FROM article_feedback_events ORDER BY server_sequence);
    SELECT action FROM article_feedback_events ORDER BY server_sequence DESC LIMIT 1;`);

  assert.deepEqual(output.trim().split("\n"), [
    "adopted,not_adopted,adopted",
    "adopted",
  ]);
});

test("feedback events are owner-bound, idempotent by client id, and append-only", () => {
  const firstEvent = `
    INSERT INTO article_feedback_events
      (id, user_id, workspace_id, article_id, recording_id, version_id, action,
       client_event_id, payload_hash, occurred_at)
    VALUES ('feedback_1', 'usr_feedback', 'ws_feedback', 'article_feedback', 71, 'version_1',
      'adopted', 'client_1', 'sha256:1', '2026-08-29T00:00:01Z');`;

  assert.throws(() => runSql(`${schema}\n${migration}\n${feedbackFixture}\n${firstEvent}\n
    INSERT INTO article_feedback_events
      (id, user_id, workspace_id, article_id, recording_id, version_id, action,
       client_event_id, payload_hash, occurred_at)
    VALUES ('feedback_2', 'usr_feedback', 'ws_feedback', 'article_feedback', 71, 'version_1',
      'not_adopted', 'client_1', 'sha256:2', '2026-08-29T00:00:02Z');`));
  assert.throws(() => runSql(`${schema}\n${migration}\n${feedbackFixture}\n${firstEvent}\n
    UPDATE article_feedback_events SET action = 'not_adopted' WHERE id = 'feedback_1';`));
  assert.throws(() => runSql(`${schema}\n${migration}\n${feedbackFixture}\n${firstEvent}\n
    DELETE FROM article_feedback_events WHERE id = 'feedback_1';`));
  assert.throws(() => runSql(`${schema}\n${migration}\n${feedbackFixture}\n
    INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id)
    VALUES ('usr_other', 'other@example.test', 'hash', 'salt', 1, 'ws_other');
    INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
    VALUES (72, 'usr_other', 'ws_other');
    INSERT INTO article_feedback_events
      (id, user_id, workspace_id, article_id, recording_id, version_id, action,
       client_event_id, payload_hash, occurred_at)
    VALUES ('feedback_cross', 'usr_other', 'ws_other', 'article_feedback', 72, 'version_1',
      'adopted', 'client_cross', 'sha256:cross', '2026-08-29T00:00:01Z');`));
});

const feedbackFixture = `
  INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id)
  VALUES ('usr_feedback', 'feedback@example.test', 'hash', 'salt', 1, 'ws_feedback');
  INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
  VALUES (71, 'usr_feedback', 'ws_feedback');
  INSERT INTO article_versions
    (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id,
     source, source_job_id, source_hash, title, body, cover_json, blocks_json,
     title_candidates_json, selected_title, cover_title_json, claim_ledger_json,
     visual_plan_json, formatting_skill_id, formatting_skill_version, content_html_hash,
     html_warnings_json, generation_status, idempotency_key, payload_hash, created_at)
  VALUES ('version_1', 'usr_feedback', 'ws_feedback', 'article_feedback', 71, 1, NULL,
    'initial', 'run_feedback', 'sha256:source', 'Title', 'Body', '{}', '[]', '[]',
    'Title', '[]', '[]', '[]', NULL, NULL, NULL, '[]', 'frozen', 'version:1',
    'sha256:version', '2026-08-29T00:00:00Z');`;

function runSql(sql) {
  return execFileSync("sqlite3", [":memory:"], {
    input: `.bail on\nPRAGMA foreign_keys = ON;\n${sql}\n.mode list\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
