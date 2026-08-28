import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTICLE_FEEDBACK_COUNT_TABLES as COUNT_TABLES,
  ARTICLE_FEEDBACK_MIGRATIONS as MIGRATIONS,
  ARTICLE_FEEDBACK_REHEARSAL_CHECKS as CHECK_KEYS,
  ARTICLE_FEEDBACK_REHEARSAL_SCHEMA_VERSION,
  committedArticleFeedbackMigrationBundle,
  sha256Fingerprint as sha256,
} from "./article-feedback-validation-contract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
class RehearsalError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new RehearsalError(code);
}

function sqlite(database, sql) {
  const result = spawnSync("sqlite3", ["-json", database], {
    input: `.bail on\nPRAGMA foreign_keys = ON;\n${sql}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) fail("rehearsal_sql_failed");
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : [];
  } catch {
    fail("rehearsal_sql_output_invalid");
  }
}

function applyMigrationSequence(database, migrationSql) {
  const result = spawnSync("sqlite3", [database], {
    input: `.bail on\nPRAGMA foreign_keys = ON;\n${migrationSql}\n`,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) fail("rehearsal_migration_failed");
}

function rejectsSql(database, sql) {
  const result = spawnSync("sqlite3", [database], {
    input: `.bail on\nPRAGMA foreign_keys = ON;\nBEGIN;\n${sql}\nROLLBACK;\n`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.status !== 0;
}

function acceptsSql(database, sql) {
  return !rejectsSql(database, sql);
}

function tableNames(database) {
  return new Set(sqlite(database, "SELECT name FROM sqlite_master WHERE type = 'table';").map(row => row.name));
}

function counts(database) {
  const existing = tableNames(database);
  return Object.fromEntries(COUNT_TABLES.map(name => {
    if (!existing.has(name)) return [name, null];
    const rows = sqlite(database, `SELECT COUNT(*) AS count FROM ${name};`);
    const count = rows[0]?.count;
    if (!Number.isSafeInteger(count) || count < 0) fail("rehearsal_count_invalid");
    return [name, count];
  }));
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function preservedRowsFingerprint(database, preservedTables) {
  const tables = [];
  const preservedUserTables = [...preservedTables]
    .filter(name => !name.startsWith("sqlite_"))
    .sort();
  for (const table of preservedUserTables) {
    const columns = sqlite(database, `PRAGMA table_info('${table}');`)
      .sort((left, right) => left.cid - right.cid)
      .map(row => row.name);
    if (columns.length === 0 || columns.some(column => typeof column !== "string")) {
      fail("rehearsal_row_fingerprint_failed");
    }
    const projection = columns.flatMap((column, index) => {
      const identifier = quoteIdentifier(column);
      return [
        `typeof(${identifier}) AS ${quoteIdentifier(`type_${index}`)}`,
        `CASE WHEN ${identifier} IS NULL THEN '' ELSE hex(CAST(${identifier} AS BLOB)) END AS ${quoteIdentifier(`value_${index}`)}`,
      ];
    }).join(", ");
    const rows = sqlite(database, `SELECT ${projection} FROM ${quoteIdentifier(table)};`)
      .map(row => JSON.stringify(columns.map((_, index) => {
        const type = row[`type_${index}`];
        const value = row[`value_${index}`];
        if (!["null", "integer", "real", "text", "blob"].includes(type) || typeof value !== "string") {
          fail("rehearsal_row_fingerprint_failed");
        }
        return [type, value];
      })))
      .sort();
    tables.push({ table, columns, rows });
  }
  return sha256(Buffer.from(JSON.stringify(tables)));
}

function requireBaseSchema(database) {
  const existing = tableNames(database);
  for (const name of ["users", "recordings", "article_versions"]) {
    if (!existing.has(name)) fail("rehearsal_source_schema_unsupported");
  }
  const requiredVersionColumns = new Set([
    "id", "user_id", "workspace_id", "article_id", "recording_id", "parent_version_id",
  ]);
  const columns = new Set(sqlite(database, "PRAGMA table_info('article_versions');").map(row => row.name));
  if ([...requiredVersionColumns].some(name => !columns.has(name))) fail("rehearsal_source_schema_unsupported");
  const integrity = sqlite(database, "PRAGMA integrity_check;");
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail("rehearsal_source_integrity_failed");
}

function indexContract(database, table, name, expectedColumns, { unique = false, partial = false } = {}) {
  const indexes = sqlite(database, `PRAGMA index_list('${table}');`);
  const index = indexes.find(row => row.name === name);
  if (!index || Boolean(index.unique) !== unique || Boolean(index.partial) !== partial) return false;
  const columns = sqlite(database, `PRAGMA index_info('${name}');`).map(row => row.name);
  return JSON.stringify(columns) === JSON.stringify(expectedColumns);
}

function schemaObjects(database) {
  return sqlite(database, `
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name IN (
      'article_feedback_events', 'article_revision_requests',
      'article_feedback_events_recording_order', 'article_revision_requests_recording',
      'article_versions_one_child_per_parent',
      'article_feedback_events_append_only_update', 'article_feedback_events_append_only_delete'
    ) ORDER BY type, name;
  `);
}

function normalizeSchemaSql(value) {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

function expectedSchemaContracts(database) {
  const rows = schemaObjects(database);
  if (rows.length !== 7 || rows.some(row => typeof row.sql !== "string")) {
    fail("rehearsal_canonical_schema_failed");
  }
  return rows.map(row => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: normalizeSchemaSql(row.sql),
  }));
}

function schemaContract(database, expectedObjects) {
  const objects = schemaObjects(database);
  const names = new Set(objects.map(row => row.name));
  const normalizedObjects = objects.map(row => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: normalizeSchemaSql(row.sql || ""),
  }));
  const requiredNames = [
    "article_feedback_events", "article_revision_requests",
    "article_feedback_events_recording_order", "article_revision_requests_recording",
    "article_versions_one_child_per_parent",
    "article_feedback_events_append_only_update", "article_feedback_events_append_only_delete",
  ];
  const passed = requiredNames.every(name => names.has(name)) &&
    JSON.stringify(normalizedObjects) === JSON.stringify(expectedObjects) &&
    indexContract(database, "article_feedback_events", "article_feedback_events_recording_order",
      ["user_id", "workspace_id", "recording_id", "server_sequence"]) &&
    indexContract(database, "article_revision_requests", "article_revision_requests_recording",
      ["user_id", "workspace_id", "recording_id", "created_at"]) &&
    indexContract(database, "article_versions", "article_versions_one_child_per_parent",
      ["parent_version_id"], { unique: true, partial: true });
  return { passed, objects };
}

function captureSchemaEvidence(database) {
  return {
    objects: schemaObjects(database),
    feedback_foreign_keys: sqlite(database, "PRAGMA foreign_key_list('article_feedback_events');"),
    revision_foreign_keys: sqlite(database, "PRAGMA foreign_key_list('article_revision_requests');"),
  };
}

function compositeForeignKey(database, table, fromColumns, toColumns) {
  const rows = sqlite(database, `PRAGMA foreign_key_list('${table}');`);
  const grouped = Map.groupBy(rows, row => row.id);
  return [...grouped.values()].some(group => {
    const ordered = [...group].sort((left, right) => left.seq - right.seq);
    return ordered[0]?.table === "article_versions" &&
      JSON.stringify(ordered.map(row => row.from)) === JSON.stringify(fromColumns) &&
      JSON.stringify(ordered.map(row => row.to)) === JSON.stringify(toColumns);
  });
}

function foreignKeyContract(database) {
  const scope = ["user_id", "workspace_id", "article_id", "recording_id"];
  return compositeForeignKey(database, "article_feedback_events", ["version_id", ...scope], ["id", ...scope]) &&
    compositeForeignKey(database, "article_revision_requests", ["parent_version_id", ...scope], ["id", ...scope]) &&
    compositeForeignKey(database, "article_revision_requests", ["child_version_id", ...scope], ["id", ...scope]);
}

const feedbackInsert = (id, clientId, versionId, action = "adopted") => `
  INSERT INTO article_feedback_events
    (id, user_id, workspace_id, article_id, recording_id, version_id, action,
     client_event_id, payload_hash, occurred_at)
  SELECT '${id}', user_id, workspace_id, article_id, recording_id, id, '${action}',
    '${clientId}', 'sha256:rehearsal', '2000-01-01T00:00:00Z'
  FROM article_versions WHERE id = '${versionId}' LIMIT 1;`;

const revisionInsert = (id, feedbackId, clientId, versionId, status = "queued") => `
  INSERT INTO article_revision_requests
    (id, user_id, workspace_id, article_id, recording_id, parent_version_id,
     feedback_id, client_request_id, payload_hash, audio_sha256, audio_key, request_key,
     transcript_key, status, created_at, updated_at)
  SELECT '${id}', user_id, workspace_id, article_id, recording_id, id,
    '${feedbackId}', '${clientId}', 'sha256:request', 'sha256:audio', 'rehearsal-audio',
    'rehearsal-request', 'rehearsal-transcript', '${status}',
    '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z'
  FROM article_versions WHERE id = '${versionId}' LIMIT 1;`;

function createBehaviorProbeVersion(database, probe) {
  const userId = `rehearsal_user_${probe}`;
  const workspaceId = `rehearsal_workspace_${probe}`;
  const versionId = `rehearsal_version_${probe}`;
  const articleId = `rehearsal_article_${probe}`;
  const recordingId = -Number.parseInt(probe.slice(0, 12), 16);
  const userColumnValues = new Map([
    ["id", `'${userId}'`],
    ["email", `'rehearsal-${probe}@example.invalid'`],
    ["password_hash", "'rehearsal'"],
    ["password_salt", "'rehearsal'"],
    ["password_iterations", "1"],
    ["role", "'user'"],
    ["workspace_id", `'${workspaceId}'`],
    ["status", "'active'"],
    ["email_verified_at", "NULL"],
  ]);
  const userColumns = sqlite(database, "PRAGMA table_info('users');")
    .sort((left, right) => left.cid - right.cid);
  if (userColumns.some(column => column.notnull === 1 && column.dflt_value === null && !userColumnValues.has(column.name))) {
    fail("rehearsal_source_schema_unsupported");
  }
  const selectedUserColumns = userColumns.filter(column => userColumnValues.has(column.name));
  const versionColumnValues = new Map([
    ["id", `'${versionId}'`],
    ["user_id", `'${userId}'`],
    ["workspace_id", `'${workspaceId}'`],
    ["article_id", `'${articleId}'`],
    ["recording_id", String(recordingId)],
    ["version_no", "1"],
    ["parent_version_id", "NULL"],
    ["source", "'initial'"],
    ["source_job_id", "NULL"],
    ["source_hash", "'sha256:rehearsal'"],
    ["title", "'Rehearsal title'"],
    ["body", "'Rehearsal body'"],
    ["cover_json", "'{}'"],
    ["blocks_json", "'[]'"],
    ["title_candidates_json", "'[]'"],
    ["selected_title", "'Rehearsal title'"],
    ["cover_title_json", "'{}'"],
    ["claim_ledger_json", "'{}'"],
    ["visual_plan_json", "'{}'"],
    ["formatting_skill_id", "NULL"],
    ["formatting_skill_version", "NULL"],
    ["content_html_hash", "NULL"],
    ["html_warnings_json", "'[]'"],
    ["generation_status", "'frozen'"],
    ["idempotency_key", `'rehearsal_idempotency_${probe}'`],
    ["payload_hash", "'sha256:rehearsal'"],
  ]);
  const tableColumns = sqlite(database, "PRAGMA table_info('article_versions');")
    .sort((left, right) => left.cid - right.cid);
  if (tableColumns.some(column => column.notnull === 1 && column.dflt_value === null && !versionColumnValues.has(column.name))) {
    fail("rehearsal_source_schema_unsupported");
  }
  const selectedColumns = tableColumns.filter(column => versionColumnValues.has(column.name));
  const inserted = sqlite(database, `
    INSERT INTO users (${selectedUserColumns.map(column => quoteIdentifier(column.name)).join(", ")})
    VALUES (${selectedUserColumns.map(column => userColumnValues.get(column.name)).join(", ")});
    INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
    VALUES (${recordingId}, '${userId}', '${workspaceId}');
    INSERT INTO article_versions (${selectedColumns.map(column => quoteIdentifier(column.name)).join(", ")})
    VALUES (${selectedColumns.map(column => versionColumnValues.get(column.name)).join(", ")});
    SELECT changes() AS count;
  `);
  if (inserted[0]?.count !== 1) fail("rehearsal_behavior_probe_unavailable");
  return versionId;
}

function behaviorChecks(database) {
  const probe = randomUUID().replaceAll("-", "");
  const versionId = createBehaviorProbeVersion(database, probe);
  const duplicateFeedback = rejectsSql(database, `
    ${feedbackInsert(`rehearsal_feedback_1_${probe}`, `rehearsal_feedback_client_${probe}`, versionId)}
    ${feedbackInsert(`rehearsal_feedback_2_${probe}`, `rehearsal_feedback_client_${probe}`, versionId)}`);
  const duplicateRevisionClient = rejectsSql(database, `
    ${revisionInsert(`rehearsal_revision_1_${probe}`, `rehearsal_revision_feedback_1_${probe}`, `rehearsal_revision_client_${probe}`, versionId)}
    ${revisionInsert(`rehearsal_revision_2_${probe}`, `rehearsal_revision_feedback_2_${probe}`, `rehearsal_revision_client_${probe}`, versionId)}`);
  const duplicateRevisionParent = rejectsSql(database, `
    ${revisionInsert(`rehearsal_revision_3_${probe}`, `rehearsal_revision_feedback_3_${probe}`, `rehearsal_revision_client_3_${probe}`, versionId)}
    ${revisionInsert(`rehearsal_revision_4_${probe}`, `rehearsal_revision_feedback_4_${probe}`, `rehearsal_revision_client_4_${probe}`, versionId)}`);
  const duplicateRevisionFeedback = rejectsSql(database, `
    ${revisionInsert(`rehearsal_revision_5_${probe}`, `rehearsal_revision_feedback_5_${probe}`, `rehearsal_revision_client_5_${probe}`, versionId)}
    ${revisionInsert(`rehearsal_revision_6_${probe}`, `rehearsal_revision_feedback_5_${probe}`, `rehearsal_revision_client_6_${probe}`, versionId)}`);
  const updateId = `rehearsal_feedback_update_${probe}`;
  const deleteId = `rehearsal_feedback_delete_${probe}`;
  return {
    duplicate_feedback_rejected: duplicateFeedback,
    duplicate_revision_rejected: duplicateRevisionClient && duplicateRevisionParent && duplicateRevisionFeedback,
    valid_feedback_inserted: acceptsSql(database,
      feedbackInsert(`rehearsal_feedback_valid_${probe}`, `rehearsal_feedback_valid_client_${probe}`, versionId)),
    valid_revision_inserted: acceptsSql(database,
      revisionInsert(`rehearsal_revision_valid_${probe}`, `rehearsal_revision_feedback_valid_${probe}`, `rehearsal_revision_valid_client_${probe}`, versionId)),
    invalid_feedback_action_rejected: rejectsSql(database,
      feedbackInsert(`rehearsal_feedback_invalid_${probe}`, `rehearsal_feedback_invalid_client_${probe}`, versionId, "invalid")),
    invalid_revision_status_rejected: rejectsSql(database,
      revisionInsert(`rehearsal_revision_invalid_${probe}`, `rehearsal_revision_feedback_invalid_${probe}`, `rehearsal_revision_invalid_client_${probe}`, versionId, "invalid")),
    feedback_update_rejected: rejectsSql(database, `
      ${feedbackInsert(updateId, `rehearsal_feedback_update_client_${probe}`, versionId)}
      UPDATE article_feedback_events SET action = 'not_adopted' WHERE id = '${updateId}';`),
    feedback_delete_rejected: rejectsSql(database, `
      ${feedbackInsert(deleteId, `rehearsal_feedback_delete_client_${probe}`, versionId)}
      DELETE FROM article_feedback_events WHERE id = '${deleteId}';`),
  };
}

function candidateCommit() {
  const value = execFileSync("git", ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(value)) fail("rehearsal_candidate_commit_invalid");
  return value;
}

function committedMigrationBundle(candidate) {
  try {
    return committedArticleFeedbackMigrationBundle(REPOSITORY_ROOT, candidate);
  } catch {
    fail("rehearsal_committed_migration_unavailable");
  }
}

async function run(sourcePath, outputPath) {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  if (source === output) fail("rehearsal_paths_conflict");
  const sourceStat = await lstat(source).catch(() => null);
  if (!sourceStat?.isFile()) fail("rehearsal_source_invalid");
  await rm(output, { force: true });

  const candidate = candidateCommit();
  const migrationBundle = committedMigrationBundle(candidate);
  const sourceBeforeBytes = await readFile(source);
  const sourceBeforeHash = sha256(sourceBeforeBytes);
  const tempDirectory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-rehearsal-"));
  const workingDatabase = join(tempDirectory, "working.sqlite");
  const canonicalDatabase = join(tempDirectory, "canonical.sqlite");
  let temporaryOutput;
  try {
    await copyFile(source, workingDatabase);
    requireBaseSchema(workingDatabase);
    applyMigrationSequence(canonicalDatabase, `
      CREATE TABLE article_versions (
        id TEXT, user_id TEXT, workspace_id TEXT, article_id TEXT,
        recording_id INTEGER, parent_version_id TEXT,
        UNIQUE(id, user_id, workspace_id, article_id, recording_id)
      );
      ${migrationBundle.sql}
    `);
    const expectedObjects = expectedSchemaContracts(canonicalDatabase);
    const preservedTables = tableNames(workingDatabase);
    const beforeCounts = counts(workingDatabase);
    const beforeRowsSha256 = preservedRowsFingerprint(workingDatabase, preservedTables);
    const beforeSchemaEvidence = captureSchemaEvidence(workingDatabase);

    applyMigrationSequence(workingDatabase, migrationBundle.sql);
    const firstApplyPassed = true;
    applyMigrationSequence(workingDatabase, migrationBundle.sql);
    const secondApplyPassed = true;

    const afterCounts = counts(workingDatabase);
    const afterRowsSha256 = preservedRowsFingerprint(workingDatabase, preservedTables);
    const oldRowsPreserved = COUNT_TABLES.every(name =>
      beforeCounts[name] === null || afterCounts[name] >= beforeCounts[name]);
    const oldRowsIdentical = beforeRowsSha256 === afterRowsSha256;
    const schema = schemaContract(workingDatabase, expectedObjects);
    const foreignKeysPassed = foreignKeyContract(workingDatabase);
    const behavior = behaviorChecks(workingDatabase);
    const sourceUnchanged = sha256(await readFile(source)) === sourceBeforeHash;
    const checks = {
      source_unchanged: sourceUnchanged,
      first_apply_passed: firstApplyPassed,
      second_apply_passed: secondApplyPassed,
      old_rows_preserved: oldRowsPreserved,
      old_rows_identical: oldRowsIdentical,
      schema_contract_passed: schema.passed,
      foreign_keys_passed: foreignKeysPassed,
      ...behavior,
    };
    if (CHECK_KEYS.some(key => checks[key] !== true)) fail("rehearsal_assertion_failed");

    const afterSchemaEvidence = captureSchemaEvidence(workingDatabase);
    const schemaEvidenceSha256 = sha256(Buffer.from(JSON.stringify({
      before: beforeSchemaEvidence,
      after: afterSchemaEvidence,
    })));
    const evidence = {
      schema_version: ARTICLE_FEEDBACK_REHEARSAL_SCHEMA_VERSION,
      candidate_commit: candidate,
      migrations: MIGRATIONS,
      migration_bundle_sha256: migrationBundle.sha256,
      source_sha256: sourceBeforeHash,
      schema_evidence_sha256: schemaEvidenceSha256,
      preserved_rows_sha256: beforeRowsSha256,
      before_counts: beforeCounts,
      after_counts: afterCounts,
      checks,
    };
    temporaryOutput = join(dirname(output), `.${randomUUID()}.tmp`);
    await writeFile(temporaryOutput, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryOutput, output);
    process.stdout.write("Main D1 migration rehearsal passed.\n");
  } finally {
    await Promise.all([
      rm(tempDirectory, { recursive: true, force: true }),
      temporaryOutput ? rm(temporaryOutput, { force: true }) : Promise.resolve(),
    ]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, outputPath, ...extra] = process.argv.slice(2);
  if (!sourcePath || !outputPath || extra.length) {
    process.stderr.write("rehearsal_arguments_invalid\n");
    process.exitCode = 1;
  } else {
    run(sourcePath, outputPath).catch(error => {
      process.stderr.write(`${error instanceof RehearsalError ? error.code : "rehearsal_failed"}\n`);
      process.exitCode = 1;
    });
  }
}
