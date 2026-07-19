import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const schema = await readFile(resolve("schema.sql"), "utf8");
const migration0010 = await readFile(resolve("migrations/0010_editorial_visual_pipeline.sql"), "utf8");
const migration0011 = await readFile(resolve("migrations/0011_five_agent_publication_projection.sql"), "utf8");
const legacy = await readFile(resolve("test/fixtures/editorial/legacy-recordings-schema.sql"), "utf8");

const base = `
  INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id)
  VALUES ('usr_projection', 'projection@example.test', 'hash', 'salt', 1, 'ws_projection');
  INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
  VALUES (101, 'usr_projection', 'ws_projection');
  INSERT INTO editorial_runs
    (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
     workflow_version, policy_version, agent_versions_json, skill_pins_json,
     status, idempotency_key, payload_hash, created_at, updated_at)
  VALUES ('run_projection_a', 'usr_projection', 'ws_projection', 'article_projection', 101,
     'editorial-orchestration.v2', 'editorial-workflow.v2', 'editorial-policy.v2', '{}', '{}',
     'running', 'run-a', 'sha256:run-a', '2026-07-19T00:00:01Z', '2026-07-19T00:00:01Z');`;

function runSql(sql) {
  return execFileSync("sqlite3", [":memory:"], {
    input: `.bail on\nPRAGMA foreign_keys=ON;\n${sql}\n.mode list\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function publicationInsert({
  runId = "run_projection_a",
  sourceRunId = runId,
  recordingId = 101,
  userId = "usr_projection",
  workspaceId = "ws_projection",
  articleId = "article_projection",
  sourceCreatedAt = "2026-07-19T00:00:01Z",
  idempotencyKey = runId,
} = {}) {
  return `
    INSERT INTO publication_runs
      (run_id, source_run_id, user_id, workspace_id, article_id, recording_id,
       source_manifest_hash, source_state, source_state_revision, schema_version,
       workflow_version, policy_version, agent_versions_json, skill_pins_json,
       state, run_status, state_revision, progress_percent, resume_state,
       last_successful_state, last_successful_progress_percent, retry_count,
       next_action, error_code, idempotency_key, payload_hash, created_at, updated_at)
    VALUES ('${runId}', '${sourceRunId}', '${userId}', '${workspaceId}', '${articleId}', ${recordingId},
       'sha256:manifest-${runId}', 'writing', 0, 'publication-projection.v1',
       'publishing-workflow.v1', 'publishing-policy.v1', '{}', '{}',
       'queued', 'active', 0, 0, NULL, 'queued', 0, 0, NULL, NULL,
       '${idempotencyKey}', 'sha256:payload-${runId}', '${sourceCreatedAt}', '${sourceCreatedAt}');`;
}

function eventInsert({
  runId = "run_projection_a",
  userId = "usr_projection",
  workspaceId = "ws_projection",
  recordingId = 101,
  revision = 0,
  state = "queued",
  stage = "upload",
  progress = 0,
  idempotencyKey = `${runId}:event:${revision}`,
} = {}) {
  return `
    INSERT INTO publication_run_events
      (event_id, run_id, user_id, workspace_id, recording_id, revision, event_type,
       state, publication_stage, progress_percent, retry_count, next_action,
       error_code, idempotency_key, payload_hash, created_at)
    VALUES ('${idempotencyKey}', '${runId}', '${userId}', '${workspaceId}', ${recordingId}, ${revision},
       'projection', '${state}', '${stage}', ${progress}, 0, NULL, NULL,
       '${idempotencyKey}', 'sha256:event-${revision}', '2026-07-19T00:00:02Z');`;
}

test("publication projection schema is fresh-safe, migration-order tested, and binds one canonical run id", () => {
  const result = runSql(`${schema}\n${migration0011}\n${migration0011}\nPRAGMA table_info(publication_current_runs);\nSELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'publication_%' ORDER BY name;`);
  assert.match(result, /current_run_created_at/);
  assert.match(result, /publication_run_events_projection_insert/);
  assert.doesNotMatch(result, /wave1_legacy/);
  assert.doesNotMatch(migration0011, /Reapplying this migration.*no-op/i);
  assert.equal(runSql(`${schema}\n${migration0011}\n${base}\n${publicationInsert()}\n${eventInsert()}\nSELECT run_id || ':' || source_run_id FROM publication_runs;`).trim(), "run_projection_a:run_projection_a");
  assert.throws(() => runSql(`${schema}\n${migration0011}\n${base}\n${publicationInsert({ sourceRunId: "different-canonical-run" })}`));
});

test("publication child rows enforce composite ownership and append-only history", () => {
  const valid = `${schema}\n${migration0011}\n${base}\n${publicationInsert()}\n${eventInsert()}`;
  assert.throws(() => runSql(`${valid}\nINSERT INTO publication_run_events (event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state, publication_stage, progress_percent, idempotency_key, payload_hash) VALUES ('bad-owner', 'run_projection_a', 'other-user', 'ws_projection', 101, 0, 'projection', 'queued', 'upload', 0, 'bad-owner', 'sha256:bad');`));
  assert.throws(() => runSql(`${valid}\n${eventInsert({ idempotencyKey: "bad-stage", stage: "writing" })}`));
  assert.throws(() => runSql(`${valid}\nDELETE FROM publication_runs WHERE run_id = 'run_projection_a';`));
  assert.throws(() => runSql(`${valid}\nDELETE FROM publication_run_events WHERE event_id = 'run_projection_a:event:0';`));
  assert.throws(() => runSql(`${valid}\nINSERT INTO publication_current_runs (recording_id, user_id, workspace_id, current_run_id, current_run_created_at, updated_at) VALUES (101, 'other-user', 'ws_projection', 'run_projection_a', '2026-07-19T00:00:01Z', '2026-07-19T00:00:03Z');`));
});

test("publication INSERT and retry recovery are fail-closed", () => {
  const invalidInsert = `${schema}\n${migration0011}\n${base}\n${publicationInsert({ runId: "bad-insert" }).replace("'queued', 'active', 0, 0, NULL, 'queued'", "'retrying', 'retrying', 0, 0, 'reviewed', 'writing'")}`;
  assert.throws(() => runSql(invalidInsert));

  const retrySetup = `${schema}\n${migration0011}\n${base}\n${publicationInsert()}\n
    UPDATE publication_runs
      SET state = 'transcribing', run_status = 'active', state_revision = 1,
          progress_percent = 14, last_successful_state = 'transcribing',
          last_successful_progress_percent = 14, updated_at = '2026-07-19T00:00:03.000Z'
      WHERE run_id = 'run_projection_a';
    UPDATE publication_runs
      SET state = 'transcript_ready', run_status = 'active', state_revision = 2,
          progress_percent = 20, last_successful_state = 'transcript_ready',
          last_successful_progress_percent = 20, updated_at = '2026-07-19T00:00:03.250Z'
      WHERE run_id = 'run_projection_a';
    UPDATE publication_runs
      SET state = 'writing', run_status = 'active', state_revision = 3,
          progress_percent = 28, last_successful_state = 'writing',
          last_successful_progress_percent = 28, updated_at = '2026-07-19T00:00:03.500Z'
      WHERE run_id = 'run_projection_a';
    UPDATE publication_runs
      SET state = 'failed', run_status = 'failed', state_revision = 4,
          progress_percent = 28, last_successful_state = 'writing',
          last_successful_progress_percent = 28, updated_at = '2026-07-19T00:00:04Z'
      WHERE run_id = 'run_projection_a';
    UPDATE publication_runs
      SET state = 'retrying', run_status = 'retrying', state_revision = 5,
          progress_percent = 28, resume_state = 'writing',
          last_successful_state = 'writing', last_successful_progress_percent = 28,
          updated_at = '2026-07-19T00:00:05Z'
      WHERE run_id = 'run_projection_a';
`;
  const retryFlow = `${retrySetup}
    SELECT state || ':' || resume_state || ':' || progress_percent FROM publication_runs;`;
  assert.equal(runSql(retryFlow).trim(), "retrying:writing:28");
  assert.throws(() => runSql(`${retrySetup}
    UPDATE publication_runs SET state = 'queued', run_status = 'active', state_revision = 6,
      progress_percent = 0, resume_state = NULL, last_successful_state = 'queued',
      last_successful_progress_percent = 0, updated_at = '2026-07-19T00:00:06Z'
      WHERE run_id = 'run_projection_a';`));
  assert.equal(runSql(`${retrySetup}
    UPDATE publication_runs SET state = 'writing', run_status = 'active', state_revision = 6,
      progress_percent = 28, resume_state = NULL, last_successful_state = 'writing',
      last_successful_progress_percent = 28, updated_at = '2026-07-19T00:00:06Z'
      WHERE run_id = 'run_projection_a';
    SELECT state || ':' || COALESCE(resume_state, '') || ':' || progress_percent FROM publication_runs;`).trim(), "writing::28");
});

test("current run selector uses canonical creation order, not state revision", () => {
  const setup = `${schema}\n${migration0011}\n${base}\n${publicationInsert()}\n
    INSERT INTO editorial_runs
      (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
       workflow_version, policy_version, agent_versions_json, skill_pins_json,
       status, idempotency_key, payload_hash, created_at, updated_at)
    VALUES ('run_projection_b', 'usr_projection', 'ws_projection', 'article_projection', 101,
       'editorial-orchestration.v2', 'editorial-workflow.v2', 'editorial-policy.v2', '{}', '{}',
       'running', 'run-b', 'sha256:run-b', '2026-07-19T00:00:02Z', '2026-07-19T00:00:02Z');
    ${publicationInsert({ runId: "run_projection_b", sourceCreatedAt: "2026-07-19T00:00:02Z" })}
    INSERT INTO publication_current_runs
      (recording_id, user_id, workspace_id, current_run_id, current_run_created_at, updated_at)
    VALUES (101, 'usr_projection', 'ws_projection', 'run_projection_b', '2026-07-19T00:00:02Z', '2026-07-19T00:00:03Z');
    INSERT INTO publication_current_runs
      (recording_id, user_id, workspace_id, current_run_id, current_run_created_at, updated_at)
    VALUES (101, 'usr_projection', 'ws_projection', 'run_projection_a', '2026-07-19T00:00:01Z', '2026-07-19T00:00:04Z')
    ON CONFLICT(recording_id, user_id, workspace_id) DO UPDATE SET current_run_id = excluded.current_run_id,
      current_run_created_at = excluded.current_run_created_at, updated_at = excluded.updated_at
    WHERE excluded.current_run_created_at > publication_current_runs.current_run_created_at
       OR (excluded.current_run_created_at = publication_current_runs.current_run_created_at
           AND excluded.current_run_id > publication_current_runs.current_run_id);
    SELECT current_run_id FROM publication_current_runs;`;
  assert.equal(runSql(setup).trim(), "run_projection_b");
});

test("0011 preserves old artifact rows and enables only additive producer roles", () => {
  const oldRun = `
    INSERT INTO editorial_runs
      (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
       workflow_version, policy_version, agent_versions_json, skill_pins_json,
       status, idempotency_key, payload_hash, created_at, updated_at)
    VALUES ('legacy-run', 'usr_legacy', 'ws_legacy', 'legacy-article', 7,
       'editorial-orchestration.v2', 'editorial-workflow.v2', 'editorial-policy.v2', '{}', '{}',
       'running', 'legacy-run-key', 'sha256:legacy-run', '2026-07-19T00:00:01Z', '2026-07-19T00:00:01Z');
    INSERT INTO editorial_artifacts
      (artifact_id, run_id, user_id, workspace_id, article_id, recording_id, schema_version,
       kind, producer_agent_role, producer_agent_version, skill_id, skill_version,
       workflow_version, policy_version, input_artifact_ids_json, payload_hash, storage_ref, created_at)
    VALUES ('legacy-artifact', 'legacy-run', 'usr_legacy', 'ws_legacy', 'legacy-article', 7,
       'artifact.v2', 'cover', 'cover', 'cover.agent.v2', NULL, NULL,
       'editorial-workflow.v2', 'editorial-policy.v2', '[]', 'sha256:legacy-artifact', 'do://legacy-artifact', '2026-07-19T00:00:02Z');`;
  const output = runSql(`${legacy}\n${migration0010}\n${oldRun}\n${migration0011}\n${migration0011}\n
    INSERT INTO editorial_artifacts
      (artifact_id, run_id, user_id, workspace_id, article_id, recording_id, schema_version,
       kind, producer_agent_role, producer_agent_version, skill_id, skill_version,
       workflow_version, policy_version, input_artifact_ids_json, payload_hash, storage_ref)
    VALUES ('visual-artifact', 'legacy-run', 'usr_legacy', 'ws_legacy', 'legacy-article', 7,
       'artifact.v3', 'visual_plan', 'visual_production', 'visual-production.agent.v1', NULL, NULL,
       'publishing-workflow.v1', 'publishing-policy.v1', '[]', 'sha256:visual', 'do://visual');
    INSERT INTO editorial_artifacts
      (artifact_id, run_id, user_id, workspace_id, article_id, recording_id, schema_version,
       kind, producer_agent_role, producer_agent_version, skill_id, skill_version,
       workflow_version, policy_version, input_artifact_ids_json, payload_hash, storage_ref)
    VALUES ('wechat-artifact', 'legacy-run', 'usr_legacy', 'ws_legacy', 'legacy-article', 7,
       'artifact.v3', 'publication_plan', 'wechat_publishing', 'wechat-publishing.agent.v1', NULL, NULL,
       'publishing-workflow.v1', 'publishing-policy.v1', '[]', 'sha256:wechat', 'do://wechat');
    SELECT (SELECT producer_agent_role FROM editorial_artifacts WHERE artifact_id = 'legacy-artifact') || ':' ||
           (SELECT count(*) FROM editorial_artifacts) || ':' ||
           (SELECT count(*) FROM sqlite_master WHERE name = 'editorial_artifacts_wave1_legacy') || ':' ||
           (SELECT count(*) FROM pragma_foreign_key_list('editorial_artifacts') WHERE "table" = 'editorial_runs');`);
  assert.equal(output.trim(), "cover:3:0:5");
});
