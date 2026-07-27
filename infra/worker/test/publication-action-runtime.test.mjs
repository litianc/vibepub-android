import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const contractsPath = resolve("src/editorialContracts.ts");
const projectionPath = resolve("src/publicationProjection.ts");
const contractsSource = transpile(await readFile(contractsPath, "utf8"), contractsPath);
const contractsUrl = moduleDataUrl(contractsSource);
const contracts = await import(contractsUrl);
const projectionSource = transpile(await readFile(projectionPath, "utf8"), projectionPath)
  .replaceAll('from "./editorialContracts"', `from ${JSON.stringify(contractsUrl)}`);
const projection = await import(moduleDataUrl(projectionSource));

const auth = { userId: "usr_projection", workspaceId: "ws_projection" };

test("human action same-key concurrent requests replay one intent", async () => {
  const source = sourceRow();
  const current = projectionRow({ state: "needs_action", run_status: "needs_action", next_action: "confirm", state_revision: 5 });
  current.source_manifest_hash = await sourceHash(source);
  const db = actionDb({ source, current, barrier: true });
  const results = await Promise.all([
    projection.recordPublicationActionIntent(db, auth, "run-v3", "confirm", "human-1", "sha256:human", 5),
    projection.recordPublicationActionIntent(db, auth, "run-v3", "confirm", "human-1", "sha256:human", 5),
  ]);
  assert.equal(results.filter((result) => result.replayed === true).length, 1);
  assert.equal(db.actions.size, 1);
});

test("human action same key with another payload conflicts, and different keys cannot share a revision", async () => {
  const source = sourceRow();
  const current = projectionRow({ state: "needs_action", run_status: "needs_action", next_action: "confirm", state_revision: 5 });
  current.source_manifest_hash = await sourceHash(source);
  const sameKeyDb = actionDb({ source, current: structuredClone(current), barrier: true });
  const sameKey = await Promise.allSettled([
    projection.recordPublicationActionIntent(sameKeyDb, auth, "run-v3", "confirm", "human-1", "sha256:one", 5),
    projection.recordPublicationActionIntent(sameKeyDb, auth, "run-v3", "confirm", "human-1", "sha256:two", 5),
  ]);
  assert.equal(sameKey.filter((result) => result.status === "rejected" && result.reason.code === "idempotency_conflict").length, 1);
  assert.equal(sameKeyDb.actions.size, 1);

  const differentKeyDb = actionDb({ source, current: structuredClone(current), barrier: true });
  const differentKeys = await Promise.allSettled([
    projection.recordPublicationActionIntent(differentKeyDb, auth, "run-v3", "confirm", "human-a", "sha256:one", 5),
    projection.recordPublicationActionIntent(differentKeyDb, auth, "run-v3", "confirm", "human-b", "sha256:two", 5),
  ]);
  assert.equal(differentKeys.filter((result) => result.status === "rejected" && result.reason.code === "publication_human_action_conflict").length, 1);
  assert.equal(differentKeyDb.actions.size, 1);
});

test("human action stale CAS returns conflict without an intent", async () => {
  const source = sourceRow();
  const current = projectionRow({ state: "needs_action", run_status: "needs_action", next_action: "confirm", state_revision: 5 });
  current.source_manifest_hash = await sourceHash(source);
  const db = actionDb({ source, current, mutateBeforeInsert: true });
  await assert.rejects(
    projection.recordPublicationActionIntent(db, auth, "run-v3", "confirm", "stale-1", "sha256:stale", 5),
    (error) => error.code === "publication_revision_conflict",
  );
  assert.equal(db.actions.size, 0);
});

test("system retry concurrent requests replay same key and stale competitors return 409", async () => {
  const source = sourceRow();
  const current = projectionRow({ state: "failed", run_status: "failed", next_action: "retry", state_revision: 4 });
  current.source_manifest_hash = await sourceHash(source);
  const sameKeyDb = actionDb({ source, current: structuredClone(current), barrier: true });
  const sameKey = await Promise.all([
    projection.assertPublicationAction(sameKeyDb, auth, "run-v3", "retry", "retry-1", "sha256:retry", 4),
    projection.assertPublicationAction(sameKeyDb, auth, "run-v3", "retry", "retry-1", "sha256:retry", 4),
  ]);
  assert.equal(sameKey.filter((result) => result.replayed === true).length, 1);

  const differentKeyDb = actionDb({ source, current: structuredClone(current), barrier: true });
  const differentKeys = await Promise.allSettled([
    projection.assertPublicationAction(differentKeyDb, auth, "run-v3", "retry", "retry-a", "sha256:a", 4),
    projection.assertPublicationAction(differentKeyDb, auth, "run-v3", "retry", "retry-b", "sha256:b", 4),
  ]);
  assert.equal(differentKeys.filter((result) => result.status === "rejected" && result.reason.code === "publication_revision_conflict").length, 1);
});

test("system retry and cancel fail closed while external side effects need reconciliation", async () => {
  const source = sourceRow();
  for (const hold of [
    { next_action: "reconcile_external_side_effect", error_code: null },
    { next_action: "retry", error_code: "external_side_effect_unknown" },
  ]) {
    const current = projectionRow({
      state: "needs_action",
      run_status: "needs_action",
      ...hold,
      state_revision: 5,
    });
    current.source_manifest_hash = await sourceHash(source);
    for (const action of ["retry", "cancel"]) {
      const db = actionDb({ source, current: structuredClone(current) });
      await assert.rejects(
        projection.applyPublicationAction(db, auth, "run-v3", action, "reconcile-" + action, "sha256:" + action, 5),
        (error) => error.code === "reconciliation_required",
      );
      assert.equal(db.actions.size, 0);
    }
  }
});

test("unknown database failures are not normalized as publication conflicts", async () => {
  const source = sourceRow();
  const current = projectionRow({ state: "failed", run_status: "failed", next_action: "retry", state_revision: 4 });
  current.source_manifest_hash = await sourceHash(source);
  const db = actionDb({ source, current });
  db.batch = async () => {
    throw new Error("D1_ERROR: storage unavailable");
  };

  await assert.rejects(
    projection.applyPublicationAction(db, auth, "run-v3", "retry", "outage-1", "sha256:outage", 4),
    (error) => error.message === "D1_ERROR: storage unavailable",
  );
  assert.equal(db.actions.size, 0);
  assert.equal(db.events.length, 0);
});

test("retrying cancel is durable, idempotent, and competes with internal resume by revision", async () => {
  const source = sourceRow();
  const current = projectionRow({
    state: "retrying",
    run_status: "retrying",
    resume_state: "writing",
    last_successful_state: "writing",
    last_successful_progress_percent: 28,
    progress_percent: 28,
    state_revision: 5,
    next_action: null,
    error_code: null,
  });
  current.source_manifest_hash = await sourceHash(source);

  const replayDb = actionDb({ source, current: structuredClone(current), barrier: true });
  const replayResults = await Promise.all([
    projection.applyPublicationAction(replayDb, auth, "run-v3", "cancel", "cancel-1", "sha256:cancel", 5),
    projection.applyPublicationAction(replayDb, auth, "run-v3", "cancel", "cancel-1", "sha256:cancel", 5),
  ]);
  assert.equal(replayResults.filter((result) => result.replayed === true).length, 1);
  assert.equal(replayResults[0].run.state, "cancelled");
  assert.equal(replayDb.actions.size, 1);
  assert.equal(replayDb.events.length, 1);

  const raceDb = actionDb({ source, current: structuredClone(current), barrier: true });
  const raceResults = await Promise.allSettled([
    projection.resumePublicationRun(raceDb, auth, "run-v3", "resume-1", "sha256:resume", 5),
    projection.applyPublicationAction(raceDb, auth, "run-v3", "cancel", "cancel-2", "sha256:cancel-2", 5),
  ]);
  assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(raceResults.filter((result) => result.status === "rejected" && result.reason.code === "publication_revision_conflict").length, 1);
  assert.equal(raceDb.actions.size, 1);
  assert.equal(raceDb.events.length, 1);
});

function sourceRow() {
  return {
    run_id: "run-v3",
    schema_version: "editorial-orchestration.v3",
    workflow_version: "editorial-workflow.v3",
    policy_version: "editorial-policy.v3",
    agent_versions_json: JSON.stringify(projection.publicationAgentVersions()),
    skill_pins_json: JSON.stringify(projection.publicationSkillPins()),
    status: "running",
    idempotency_key: "source-v3",
    payload_hash: "sha256:source-v3",
    created_at: "2026-07-19T00:00:01Z",
  };
}

function projectionRow(overrides = {}) {
  return {
    run_id: "run-v3",
    source_run_id: "run-v3",
    user_id: auth.userId,
    workspace_id: auth.workspaceId,
    article_id: "article-v3",
    recording_id: 101,
    source_manifest_hash: "sha256:manifest",
    source_state: "writing",
    source_state_revision: 0,
    schema_version: "publication-projection.v1",
    workflow_version: "publishing-workflow.v1",
    policy_version: "publishing-policy.v1",
    agent_versions_json: JSON.stringify(projection.publicationAgentVersions()),
    skill_pins_json: JSON.stringify(projection.publicationSkillPins()),
    state: "failed",
    run_status: "failed",
    state_revision: 4,
    progress_percent: 28,
    resume_state: null,
    last_successful_state: "writing",
    last_successful_progress_percent: 28,
    retry_count: 0,
    next_action: "retry",
    error_code: "synthetic_failure",
    idempotency_key: "run-v3",
    payload_hash: "sha256:run-v3",
    created_at: "2026-07-19T00:00:02Z",
    updated_at: "2026-07-19T00:00:02Z",
    last_event_id: "run-v3:event:4",
    last_event_type: "projection",
    last_event_idempotency_key: "run-v3:event:4",
    last_event_payload_hash: "sha256:event-4",
    last_event_created_at: "2026-07-19T00:00:02Z",
    ...overrides,
  };
}

function actionDb({ source, current, barrier = false, mutateBeforeInsert = false }) {
  const actions = new Map();
  const events = [];
  let initialActionReads = 0;
  let releaseActionReads;
  const actionReadsReleased = new Promise((resolve) => { releaseActionReads = resolve; });
  let initialCurrentReads = 0;
  let releaseCurrentReads;
  const currentReadsReleased = new Promise((resolve) => { releaseCurrentReads = resolve; });
  const db = {
    actions,
    events,
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            sql,
            values,
            first: async () => {
              if (sql.includes("FROM publication_run_actions")) {
                if (barrier && initialActionReads < 2) {
                  initialActionReads += 1;
                  if (initialActionReads === 2) releaseActionReads();
                  else await actionReadsReleased;
                }
                return actions.get(values[3]) || null;
              }
              if (sql.includes("FROM publication_runs")) {
                const snapshot = structuredClone(current);
                if (barrier && initialCurrentReads < 2) {
                  initialCurrentReads += 1;
                  if (initialCurrentReads === 2) releaseCurrentReads();
                  else await currentReadsReleased;
                  return snapshot;
                }
                return current;
              }
              if (sql.includes("FROM editorial_runs")) {
                if (mutateBeforeInsert) current.state_revision += 1;
                return source;
              }
              throw new Error(`unexpected first SQL: ${sql}`);
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (!sql.includes("INSERT INTO publication_run_actions")) return { meta: { changes: 0 } };
              const key = values[4];
              const payload = values[5];
              const expectedRevision = values[13];
              if (current.state_revision !== expectedRevision) return { meta: { changes: 0 } };
              if (actions.size > 0 || actions.has(key)) {
                throw new Error("UNIQUE constraint failed: publication_run_actions");
              }
              actions.set(key, { payload_hash: payload, result_json: values[7] });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      const actionStatement = statements[2];
      const expectedRevision = actionStatement.values[3];
      const key = actionStatement.values[4];
      const payload = actionStatement.values[5];
      if (current.state_revision !== expectedRevision) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }];
      if (actions.has(key)) throw new Error("UNIQUE constraint failed: publication_run_actions");
      actions.set(key, {
        payload_hash: payload,
        result_json: actionStatement.values[6],
      });
      events.push({ action: actionStatement.values[1], revision: expectedRevision + 1 });
      current.state_revision = expectedRevision + 1;
      if (actionStatement.values[1] === "retry") {
        current.state = "retrying";
        current.run_status = "retrying";
      } else if (actionStatement.values[1] === "cancel") {
        current.state = "cancelled";
        current.run_status = "cancelled";
        current.resume_state = null;
      } else {
        current.state = current.resume_state || current.last_successful_state;
        current.run_status = "active";
        current.resume_state = null;
      }
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
  return db;
}

async function sourceHash(source) {
  const manifest = contracts.canonicalJson({
    schema_version: source.schema_version,
    run_id: source.run_id,
    article_id: "article-v3",
    recording_id: 101,
    user_id: auth.userId,
    workspace_id: auth.workspaceId,
    workflow_version: source.workflow_version,
    policy_version: source.policy_version,
    agent_versions: JSON.parse(source.agent_versions_json),
    skill_pins: JSON.parse(source.skill_pins_json),
    idempotency_key: source.idempotency_key,
    payload_hash: source.payload_hash,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName,
  }).outputText;
}

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
