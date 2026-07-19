import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const contractsPath = resolve("src/editorialContracts.ts");
const projectionPath = resolve("src/publicationProjection.ts");
const contracts = transpile(await readFile(contractsPath, "utf8"), contractsPath);
const contractsUrl = moduleDataUrl(contracts);
const projection = transpile(await readFile(projectionPath, "utf8"), projectionPath)
  .replaceAll('from "./editorialContracts"', `from ${JSON.stringify(contractsUrl)}`);
const projectionModule = await import(moduleDataUrl(projection));

test("publication creation rejects v2 or legacy source masquerading as v3", async () => {
  const v2 = sourceRow({
    schema_version: "editorial-orchestration.v2",
    workflow_version: "editorial-workflow.v2",
    policy_version: "editorial-policy.v2",
    agent_versions_json: "{}",
    skill_pins_json: "{}",
  });
  const db = mockDb(v2);
  await assert.rejects(
    projectionModule.createPublicationRun(db, input()),
    (error) => error.code === "publication_source_not_v3" && error.status === 409,
  );
  assert.equal(db.batchCalled, false);
});

test("publication creation accepts only the strict five-agent v3 source contract", async () => {
  const v3 = sourceRow({
    schema_version: projectionModule.CANONICAL_EDITORIAL_SCHEMA_VERSION,
    workflow_version: projectionModule.CANONICAL_EDITORIAL_WORKFLOW_VERSION,
    policy_version: projectionModule.CANONICAL_EDITORIAL_POLICY_VERSION,
    agent_versions_json: JSON.stringify(projectionModule.publicationAgentVersions()),
    skill_pins_json: JSON.stringify(projectionModule.publicationSkillPins()),
  });
  const created = publicationRow();
  const db = mockDb(v3, created);
  const result = await projectionModule.createPublicationRun(db, input());
  assert.equal(result.replayed, false);
  assert.equal(db.batchCalled, true);
});

test("projection helper keeps revision progress in the review step", () => {
  const current = {
    ...publicationRow(),
    state: "reviewing",
    run_status: "active",
    state_revision: 8,
    progress_percent: 50,
    last_successful_state: "reviewing",
    last_successful_progress_percent: 50,
  };
  const revising = projectionModule.projectPublicationTransition(current, "revising", event("revision-9"));
  assert.equal(revising.progress_percent, 50);
  const reviewing = projectionModule.projectPublicationTransition(revising, "reviewing", event("revision-10"));
  assert.equal(reviewing.progress_percent, 50);
  assert.throws(
    () => projectionModule.projectPublicationTransition(reviewing, "draft_generated", event("invalid")),
    (error) => error.code === "publication_transition_invalid",
  );
});

function input() {
  return {
    runId: "run-v3",
    articleId: "article-v3",
    recordingId: 101,
    userId: "usr_projection",
    workspaceId: "ws_projection",
    idempotencyKey: "projection-v3",
    payloadHash: "sha256:projection-v3",
  };
}

function event(id) {
  return {
    eventId: `run-v3:event:${id}`,
    eventType: "projection",
    eventIdempotencyKey: `run-v3:${id}`,
    eventPayloadHash: `sha256:${id}`,
    eventCreatedAt: `2026-07-19T00:00:${String(Number(id.split("-").pop()) || 11).padStart(2, "0")}Z`,
  };
}

function sourceRow(overrides) {
  return {
    run_id: "run-v3",
    status: "planned",
    idempotency_key: "source-v3",
    payload_hash: "sha256:source-v3",
    created_at: "2026-07-19T00:00:01Z",
    ...overrides,
  };
}

function publicationRow() {
  return {
    ...input(),
    source_run_id: "run-v3",
    source_manifest_hash: "sha256:manifest",
    source_state: "queued",
    source_state_revision: 0,
    schema_version: "publication-projection.v1",
    workflow_version: "publishing-workflow.v1",
    policy_version: "publishing-policy.v1",
    agent_versions_json: JSON.stringify(projectionModule.publicationAgentVersions()),
    skill_pins_json: JSON.stringify(projectionModule.publicationSkillPins()),
    state: "queued",
    run_status: "active",
    state_revision: 0,
    progress_percent: 0,
    resume_state: null,
    last_successful_state: "queued",
    last_successful_progress_percent: 0,
    retry_count: 0,
    next_action: null,
    error_code: null,
    created_at: "2026-07-19T00:00:02Z",
    updated_at: "2026-07-19T00:00:02Z",
    last_event_id: "run-v3:event:0",
    last_event_type: "run_queued",
    last_event_idempotency_key: "run-v3:event:0",
    last_event_payload_hash: "sha256:projection-v3",
    last_event_created_at: "2026-07-19T00:00:02Z",
  };
}

function mockDb(source, created = null) {
  const db = {
    batchCalled: false,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => {
              if (sql.includes("FROM editorial_runs")) return source;
              if (sql.includes("FROM publication_runs")) return db.batchCalled ? created : null;
              throw new Error(`unexpected first SQL: ${sql}`);
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
    async batch() {
      db.batchCalled = true;
      return [];
    },
  };
  return db;
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
