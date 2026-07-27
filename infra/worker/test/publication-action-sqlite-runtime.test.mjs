import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import ts from "typescript";

const schema = await readFile(resolve("schema.sql"), "utf8");
const migration = await readFile(resolve("migrations/0011_five_agent_publication_projection.sql"), "utf8");
const contractsPath = resolve("src/editorialContracts.ts");
const projectionPath = resolve("src/publicationProjection.ts");
const contractsUrl = moduleDataUrl(transpile(await readFile(contractsPath, "utf8"), contractsPath));
const projectionSource = transpile(await readFile(projectionPath, "utf8"), projectionPath)
  .replaceAll('from "./editorialContracts"', "from " + JSON.stringify(contractsUrl));
const projection = await import(moduleDataUrl(projectionSource));
const contracts = await import(contractsUrl);

const auth = { userId: "usr_sqlite", workspaceId: "ws_sqlite" };

test("sqlite-backed D1 interleaving reaches event trigger and normalizes loser to revision conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-publication-"));
  const databasePath = join(directory, "projection.sqlite");
  try {
    const source = sourceRow();
    runScript(databasePath, await buildSetup(source));
    const db = new SqliteD1(databasePath);
    const results = await Promise.allSettled([
      projection.resumePublicationRun(db, auth, "run-sqlite", "resume-sqlite", "sha256:resume-sqlite", 2),
      projection.applyPublicationAction(db, auth, "run-sqlite", "cancel", "cancel-sqlite", "sha256:cancel-sqlite", 2),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      results.filter((result) => result.status === "rejected" && result.reason.code === "publication_revision_conflict").length,
      1,
    );
    assert.equal(db.triggerErrors.some((message) => message.includes("publication_run_event_projection_mismatch")), true);

    const final = db.query(
      "SELECT state, state_revision, " +
        "(SELECT count(*) FROM publication_run_events WHERE run_id = 'run-sqlite' AND revision = 3) AS event_count, " +
        "(SELECT count(*) FROM publication_run_actions WHERE run_id = 'run-sqlite' AND expected_state_revision = 2) AS action_count " +
        "FROM publication_runs WHERE run_id = 'run-sqlite';",
    )[0];
    assert.equal(final.state_revision, 3);
    assert.ok(["writing", "cancelled"].includes(final.state));
    assert.equal(Number(final.event_count), 1);
    assert.equal(Number(final.action_count), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class SqliteD1 {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.currentReads = 0;
    this.releaseCurrentReads = null;
    this.currentReadsReleased = new Promise((resolve) => { this.releaseCurrentReads = resolve; });
    this.batchCalls = 0;
    this.releaseWinner = null;
    this.rejectWinner = null;
    this.winnerFinished = new Promise((resolve, reject) => {
      this.releaseWinner = resolve;
      this.rejectWinner = reject;
    });
    this.triggerErrors = [];
  }

  prepare(sql) {
    const self = this;
    return {
      bind(...values) {
        return {
          sql,
          values,
          async first() {
            if (sql.includes("FROM publication_runs") && self.currentReads < 2) {
              self.currentReads += 1;
              if (self.currentReads === 2) self.releaseCurrentReads();
              else await self.currentReadsReleased;
            }
            return self.query(sql, values)[0] || null;
          },
          async all() {
            return { results: self.query(sql, values) };
          },
          async run() {
            self.runStatement(sql, values);
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }

  async batch(statements) {
    this.batchCalls += 1;
    const call = this.batchCalls;
    if (call === 1) {
      try {
        const result = this.runTransaction(statements);
        this.releaseWinner();
        return result;
      } catch (error) {
        this.rejectWinner(error);
        throw error;
      }
    }
    await this.winnerFinished;
    try {
      return this.runTransaction(statements.slice(0, 2));
    } catch (error) {
      const message = String(error.message || error);
      this.triggerErrors.push(message);
      throw error;
    }
  }

  query(sql, values = []) {
    const output = execFileSync("sqlite3", [this.databasePath], {
      input: ".mode json\nPRAGMA foreign_keys=ON;\n" + interpolate(sql, values) + "\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output ? JSON.parse(output) : [];
  }

  runStatement(sql, values) {
    this.runTransaction([{ sql, values }]);
  }

  runTransaction(statements) {
    const sql = statements.map((statement) => interpolate(statement.sql, statement.values)).join(";\n") + ";";
    try {
      execFileSync("sqlite3", [this.databasePath], {
        input: ".bail on\nPRAGMA foreign_keys=ON;\nBEGIN IMMEDIATE;\n" + sql + "\nCOMMIT;\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const message = String(error.stderr || error.stdout || error.message || error);
      throw new Error(message);
    }
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

function sourceRow() {
  return {
    run_id: "run-sqlite",
    article_id: "article-sqlite",
    recording_id: 202,
    schema_version: "editorial-orchestration.v3",
    workflow_version: "editorial-workflow.v3",
    policy_version: "editorial-policy.v3",
    agent_versions_json: JSON.stringify(projection.publicationAgentVersions()),
    skill_pins_json: JSON.stringify(projection.publicationSkillPins()),
    idempotency_key: "source-sqlite",
    payload_hash: "sha256:source-sqlite",
    created_at: "2026-07-19T00:00:01Z",
  };
}

async function sourceManifestHash(source) {
  const manifest = contracts.canonicalJson({
    schema_version: source.schema_version,
    run_id: source.run_id,
    article_id: source.article_id,
    recording_id: source.recording_id,
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
  return "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildSetup(source) {
  const manifestHash = await sourceManifestHash(source);
  const sql = [
    schema,
    migration,
    "INSERT INTO users (id, email, password_hash, password_salt, password_iterations, workspace_id) VALUES (" +
      [auth.userId, "sqlite@example.test", "hash", "salt", 1, auth.workspaceId].map(sqlValue).join(",") + ");",
    "INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id) VALUES (" +
      [source.recording_id, auth.userId, auth.workspaceId].map(sqlValue).join(",") + ");",
    "INSERT INTO editorial_runs " +
      "(run_id, user_id, workspace_id, article_id, recording_id, schema_version, workflow_version, policy_version, " +
      "agent_versions_json, skill_pins_json, status, idempotency_key, payload_hash, created_at, updated_at) VALUES (" +
      [source.run_id, auth.userId, auth.workspaceId, source.article_id, source.recording_id, source.schema_version,
        source.workflow_version, source.policy_version, source.agent_versions_json, source.skill_pins_json, "running",
        source.idempotency_key, source.payload_hash, source.created_at, source.created_at].map(sqlValue).join(",") + ");",
    "INSERT INTO publication_runs " +
      "(run_id, source_run_id, user_id, workspace_id, article_id, recording_id, source_manifest_hash, source_state, " +
      "source_state_revision, schema_version, workflow_version, policy_version, agent_versions_json, skill_pins_json, " +
      "state, run_status, state_revision, progress_percent, resume_state, last_successful_state, " +
      "last_successful_progress_percent, retry_count, next_action, error_code, idempotency_key, payload_hash, created_at, " +
      "updated_at, last_event_id, last_event_type, last_event_idempotency_key, last_event_payload_hash, last_event_created_at) VALUES (" +
      [source.run_id, source.run_id, auth.userId, auth.workspaceId, source.article_id, source.recording_id, manifestHash,
        "writing", 0, "publication-projection.v1", "publishing-workflow.v1", "publishing-policy.v1",
        source.agent_versions_json, source.skill_pins_json, "queued", "active", 0, 0, null, "queued", 0, 0, null, null,
        "projection-sqlite", "sha256:projection-sqlite", source.created_at, source.created_at,
        "run-sqlite:event:0", "run_queued", "run-sqlite:event:0", "sha256:projection-sqlite", source.created_at].map(sqlValue).join(",") + ");",
    "INSERT INTO publication_run_events " +
      "(event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state, publication_stage, " +
      "progress_percent, retry_count, next_action, error_code, idempotency_key, payload_hash, created_at) VALUES (" +
      ["run-sqlite:event:0", source.run_id, auth.userId, auth.workspaceId, source.recording_id, 0, "run_queued",
        "queued", "upload", 0, 0, null, null, "run-sqlite:event:0", "sha256:projection-sqlite", source.created_at].map(sqlValue).join(",") + ");",
    "UPDATE publication_runs SET state = 'failed', run_status = 'failed', state_revision = 1, progress_percent = 0, " +
      "last_successful_state = 'queued', last_successful_progress_percent = 0, next_action = 'retry', " +
      "error_code = 'synthetic_failure', updated_at = '2026-07-19T00:00:02Z', last_event_id = 'run-sqlite:event:1', " +
      "last_event_type = 'projection', last_event_idempotency_key = 'run-sqlite:event:1', " +
      "last_event_payload_hash = 'sha256:event-1', last_event_created_at = '2026-07-19T00:00:02Z' " +
      "WHERE run_id = 'run-sqlite';",
    "UPDATE publication_runs SET state = 'retrying', run_status = 'retrying', state_revision = 2, progress_percent = 0, " +
      "resume_state = 'queued', last_successful_state = 'queued', last_successful_progress_percent = 0, retry_count = 1, " +
      "next_action = NULL, error_code = NULL, updated_at = '2026-07-19T00:00:03Z', last_event_id = 'run-sqlite:event:2', " +
      "last_event_type = 'projection', last_event_idempotency_key = 'run-sqlite:event:2', " +
      "last_event_payload_hash = 'sha256:event-2', last_event_created_at = '2026-07-19T00:00:03Z' " +
      "WHERE run_id = 'run-sqlite';",
  ].join("\n");
  return sql;
}

function interpolate(sql, values = []) {
  let index = 0;
  return sql.replaceAll("?", () => sqlValue(values[index++]));
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runScript(databasePath, sql) {
  execFileSync("sqlite3", [databasePath], {
    input: ".bail on\nPRAGMA foreign_keys=ON;\n" + sql + "\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName,
  }).outputText;
}

function moduleDataUrl(source) {
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}
