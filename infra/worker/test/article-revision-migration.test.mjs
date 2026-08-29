import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const schema = await readFile(resolve("schema.sql"), "utf8");
const migration = await readFile(resolve("migrations/0013_article_revisions.sql"), "utf8");

test("revision requests are idempotent and each parent owns one request and one child", () => {
  const fixture = `${schema}\n${migration}\n${migration}\n${articleFixture}`;

  assert.throws(() => runSql(`${fixture}\n${requestInsert("revision_2", "client_1", "sha256:other")}`));
  assert.throws(() => runSql(`${fixture}\n${requestInsert("revision_2", "client_2", "sha256:request")}`));
  assert.throws(() => runSql(`${fixture}\n${childInsert("version_3")}`));
});

test("revision status can record WeChat failure without changing the current Article Version", () => {
  const output = runSql(`${schema}\n${migration}\n${articleFixture}\n
    UPDATE article_revision_requests
    SET status = 'wechat_failed', child_version_id = 'version_2', error_message = 'wechat timeout'
    WHERE id = 'revision_1';
    SELECT status || ':' || child_version_id || ':' || error_message
    FROM article_revision_requests WHERE id = 'revision_1';
    SELECT id FROM article_versions ORDER BY version_no DESC LIMIT 1;`);

  assert.deepEqual(output.trim().split("\n"), [
    "wechat_failed:version_2:wechat timeout",
    "version_2",
  ]);
});

const articleFixture = `
  INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id)
  VALUES ('usr_revision', 'revision@example.test', 'hash', 'salt', 1, 'ws_revision');
  INSERT INTO recordings (id, user_id, workspace_id, filename, r2_key)
  VALUES (81, 'usr_revision', 'ws_revision', 'recording.m4a', 'users/usr_revision/inbox/recording.m4a');
  INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
  VALUES (81, 'usr_revision', 'ws_revision');
  ${versionInsert("version_1", 1, null)}
  ${requestInsert("revision_1", "client_1", "sha256:request")}
  ${versionInsert("version_2", 2, "version_1")}`;

function requestInsert(id, clientRequestId, payloadHash) {
  return `INSERT INTO article_revision_requests
    (id, user_id, workspace_id, article_id, recording_id, parent_version_id,
     feedback_id, client_request_id, payload_hash, audio_sha256, audio_key, request_key, transcript_key,
     status, created_at, updated_at)
   VALUES ('${id}', 'usr_revision', 'ws_revision', 'article_revision', 81, 'version_1',
     'feedback_${clientRequestId}', '${clientRequestId}', '${payloadHash}', 'sha256:audio', 'audio-key', 'request-key',
     'transcript-key', 'queued', '2026-08-29T00:00:01Z', '2026-08-29T00:00:01Z');`;
}

function versionInsert(id, versionNo, parentId) {
  return `INSERT INTO article_versions
    (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id,
     source, source_job_id, source_hash, title, body, cover_json, blocks_json,
     title_candidates_json, selected_title, cover_title_json, claim_ledger_json,
     visual_plan_json, formatting_skill_id, formatting_skill_version, content_html_hash,
     html_warnings_json, generation_status, idempotency_key, payload_hash, created_at)
   VALUES ('${id}', 'usr_revision', 'ws_revision', 'article_revision', 81, ${versionNo},
     ${parentId ? `'${parentId}'` : "NULL"}, '${versionNo === 1 ? "initial" : "revision"}',
     'job_${versionNo}', 'sha256:source_${versionNo}', 'Title ${versionNo}', 'Body ${versionNo}',
     '{}', '[]', '[]', 'Title ${versionNo}', '[]', '[]', '[]', NULL, NULL, NULL, '[]',
     'frozen', 'version:${versionNo}', 'sha256:version_${versionNo}', '2026-08-29T00:00:0${versionNo}Z');`;
}

function childInsert(id) {
  return versionInsert(id, 3, "version_1");
}

function runSql(sql) {
  return execFileSync("sqlite3", [":memory:"], {
    input: `.bail on\nPRAGMA foreign_keys = ON;\n${sql}\n.mode list\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
