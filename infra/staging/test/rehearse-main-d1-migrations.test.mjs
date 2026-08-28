import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("infra/staging/rehearse-main-d1-migrations.mjs");
const fixture = resolve("infra/staging/fixtures/main-d1-before-article-feedback.sql");
const migrationPaths = [
  "infra/worker/migrations/0012_article_feedback.sql",
  "infra/worker/migrations/0013_article_revisions.sql",
];

test("public CLI rehearses 0012 and 0013 twice without changing or disclosing the old D1 copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-rehearsal-"));
  const source = join(directory, "private-source.sqlite");
  const output = join(directory, "evidence.json");
  execFileSync("sqlite3", [source], { input: await readFile(fixture), stdio: ["pipe", "pipe", "pipe"] });
  const sourceBefore = await sha256(source);

  const result = spawnSync(process.execPath, [script, source, output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await sha256(source), sourceBefore);

  const raw = await readFile(output, "utf8");
  const evidence = JSON.parse(raw);
  assert.deepEqual(Object.keys(evidence), [
    "schema_version", "candidate_commit", "migrations", "migration_bundle_sha256",
    "source_sha256", "schema_evidence_sha256", "preserved_rows_sha256",
    "before_counts", "after_counts", "checks",
  ]);
  assert.equal(evidence.schema_version, "vibepub-main-d1-migration-rehearsal.v2");
  assert.match(evidence.candidate_commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(evidence.migrations, ["0012_article_feedback", "0013_article_revisions"]);
  assert.match(evidence.migration_bundle_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evidence.source_sha256, `sha256:${sourceBefore}`);
  assert.match(evidence.schema_evidence_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(evidence.preserved_rows_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.before_counts, {
    users: 1,
    recordings: 1,
    article_versions: 1,
    article_feedback_events: null,
    article_revision_requests: null,
  });
  assert.deepEqual(evidence.after_counts, {
    users: 1,
    recordings: 1,
    article_versions: 1,
    article_feedback_events: 0,
    article_revision_requests: 0,
  });
  assert.deepEqual(evidence.checks, {
    source_unchanged: true,
    first_apply_passed: true,
    second_apply_passed: true,
    old_rows_preserved: true,
    old_rows_identical: true,
    schema_contract_passed: true,
    foreign_keys_passed: true,
    duplicate_feedback_rejected: true,
    duplicate_revision_rejected: true,
    valid_feedback_inserted: true,
    valid_revision_inserted: true,
    invalid_feedback_action_rejected: true,
    invalid_revision_status_rejected: true,
    feedback_update_rejected: true,
    feedback_delete_rejected: true,
  });

  for (const forbidden of [
    source,
    "private-person@example.test",
    "private-recording.m4a",
    "Private article title",
    "Private article body",
    "usr_rehearsal",
  ]) {
    assert.equal(raw.includes(forbidden), false, `evidence disclosed ${forbidden}`);
  }
});

test("public CLI binds migration bytes to one candidate commit and ignores uncommitted migration edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-bundle-"));
  const source = join(directory, "source.sqlite");
  const output = join(directory, "evidence.json");
  execFileSync("sqlite3", [source], { input: await readFile(fixture), stdio: ["pipe", "pipe", "pipe"] });
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const committedMigrations = migrationPaths.map(path => execFileSync("git", ["show", `${candidate}:${path}`]));
  const expectedBundle = hashBytes(Buffer.concat([
    committedMigrations[0],
    Buffer.from("\n"),
    committedMigrations[1],
  ]));
  const migration = resolve(migrationPaths[0]);
  const workingBytes = await readFile(migration);

  try {
    await writeFile(migration, Buffer.concat([workingBytes, Buffer.from("\nTHIS IS UNCOMMITTED INVALID SQL;\n")]));
    const result = spawnSync(process.execPath, [script, source, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await writeFile(migration, workingBytes);
  }

  const evidence = JSON.parse(await readFile(output, "utf8"));
  assert.equal(evidence.candidate_commit, candidate);
  assert.equal(evidence.migration_bundle_sha256, `sha256:${expectedBundle}`);
});

test("preserved row fingerprint is deterministic and changes when an old value changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-rows-"));
  const fixtureSql = await readFile(fixture, "utf8");
  const first = await rehearseFixture(directory, "first", fixtureSql);
  const replay = await rehearseFixture(directory, "replay", fixtureSql);
  const changed = await rehearseFixture(
    directory,
    "changed",
    fixtureSql.replace("Private article body", "Changed private body"),
  );
  const changedScope = await rehearseFixture(
    directory,
    "changed-scope",
    `${fixtureSql}\nINSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id) VALUES (999, 'scope-only', 'scope-only');\n`,
  );

  assert.equal(first.preserved_rows_sha256, replay.preserved_rows_sha256);
  assert.notEqual(first.preserved_rows_sha256, changed.preserved_rows_sha256);
  assert.notEqual(first.preserved_rows_sha256, changedScope.preserved_rows_sha256);
  assert.equal(first.checks.old_rows_identical, true);
  assert.equal(changed.checks.old_rows_identical, true);
  assert.deepEqual(first.before_counts, changed.before_counts);
  assert.deepEqual(first.after_counts, changed.after_counts);
  assert.deepEqual(first.before_counts, changedScope.before_counts);
});

test("public CLI validates constraints when the old database has no Article Versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-empty-versions-"));
  const fixtureSql = await readFile(fixture, "utf8");
  const withoutVersion = fixtureSql
    .replace(
      "parent_version_id TEXT,\n  title TEXT NOT NULL,",
      "parent_version_id TEXT,\n  source TEXT NOT NULL CHECK (source IN ('initial', 'revision', 'human_final', 'legacy_snapshot')),\n  generation_status TEXT NOT NULL CHECK (generation_status IN ('generated', 'review_pending', 'reviewed', 'frozen')),\n  title TEXT NOT NULL,",
    )
    .replace(/INSERT INTO article_versions[\s\S]*?;\s*$/, "");
  const evidence = await rehearseFixture(directory, "empty-versions", withoutVersion);

  assert.equal(evidence.before_counts.article_versions, 0);
  assert.equal(evidence.after_counts.article_versions, 0);
  assert.equal(evidence.checks.valid_feedback_inserted, true);
  assert.equal(evidence.checks.valid_revision_inserted, true);
  assert.equal(evidence.checks.duplicate_feedback_rejected, true);
  assert.equal(evidence.checks.duplicate_revision_rejected, true);
});

test("public CLI validates constraints when the old database has no users or articles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-empty-"));
  const fixtureSql = (await readFile(fixture, "utf8"))
    .replace(/INSERT INTO (?:users|recordings|editorial_recording_scopes|article_versions)[\s\S]*?;\s*/g, "");
  const evidence = await rehearseFixture(directory, "empty", fixtureSql);

  assert.equal(evidence.before_counts.users, 0);
  assert.equal(evidence.before_counts.recordings, 0);
  assert.equal(evidence.before_counts.article_versions, 0);
  assert.equal(evidence.after_counts.users, 0);
  assert.equal(evidence.after_counts.recordings, 0);
  assert.equal(evidence.after_counts.article_versions, 0);
  assert.equal(evidence.checks.valid_feedback_inserted, true);
  assert.equal(evidence.checks.valid_revision_inserted, true);
});

test("public CLI fails closed and removes stale success evidence for malformed or constraint-free copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-main-d1-rehearsal-failure-"));
  const output = join(directory, "evidence.json");
  const malformed = join(directory, "malformed.sqlite");
  await writeFile(malformed, "not a sqlite database");
  await writeFile(output, '{"schema_version":"stale-success"}\n');

  const malformedResult = spawnSync(process.execPath, [script, malformed, output], { encoding: "utf8" });
  assert.notEqual(malformedResult.status, 0);
  await assert.rejects(readFile(output), error => error.code === "ENOENT");

  const unconstrained = join(directory, "unconstrained.sqlite");
  const unconstrainedTables = `
    CREATE TABLE article_feedback_events (
      server_sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, user_id TEXT, workspace_id TEXT,
      article_id TEXT, recording_id INTEGER, version_id TEXT, action TEXT, client_event_id TEXT,
      payload_hash TEXT, occurred_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE article_revision_requests (
      id TEXT, user_id TEXT, workspace_id TEXT, article_id TEXT, recording_id INTEGER,
      parent_version_id TEXT, feedback_id TEXT, client_request_id TEXT, payload_hash TEXT,
      audio_sha256 TEXT, audio_key TEXT, request_key TEXT, transcript_key TEXT, status TEXT,
      child_version_id TEXT, error_message TEXT, created_at TEXT, updated_at TEXT
    );`;
  execFileSync("sqlite3", [unconstrained], {
    input: `${await readFile(fixture, "utf8")}\n${unconstrainedTables}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await writeFile(output, '{"schema_version":"stale-success"}\n');

  const assertionResult = spawnSync(process.execPath, [script, unconstrained, output], { encoding: "utf8" });
  assert.notEqual(assertionResult.status, 0);
  assert.match(assertionResult.stderr, /^rehearsal_assertion_failed\n$/);
  await assert.rejects(readFile(output), error => error.code === "ENOENT");

  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const extraRevisionStatus = join(directory, "extra-revision-status.sqlite");
  const committedFeedback = execFileSync("git", ["show", `${candidate}:infra/worker/migrations/0012_article_feedback.sql`], { encoding: "utf8" });
  const committedRevision = execFileSync("git", ["show", `${candidate}:infra/worker/migrations/0013_article_revisions.sql`], { encoding: "utf8" })
    .replace("'wechat_failed', 'failed'", "'wechat_failed', 'failed/*', 'bogus', 'x*/'");
  execFileSync("sqlite3", [extraRevisionStatus], {
    input: `${await readFile(fixture, "utf8")}\n${committedFeedback}\n${committedRevision}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await writeFile(output, '{"schema_version":"stale-success"}\n');
  const extraRevisionStatusResult = spawnSync(process.execPath, [script, extraRevisionStatus, output], { encoding: "utf8" });
  assert.notEqual(extraRevisionStatusResult.status, 0);
  assert.match(extraRevisionStatusResult.stderr, /^rehearsal_assertion_failed\n$/);
  await assert.rejects(readFile(output), error => error.code === "ENOENT");

  const uppercaseRevisionStatus = join(directory, "uppercase-revision-status.sqlite");
  const uppercaseCommittedRevision = execFileSync("git", ["show", `${candidate}:infra/worker/migrations/0013_article_revisions.sql`], { encoding: "utf8" })
    .replace("'wechat_failed', 'failed'", "'wechat_failed', 'FAILED'");
  execFileSync("sqlite3", [uppercaseRevisionStatus], {
    input: `${await readFile(fixture, "utf8")}\n${committedFeedback}\n${uppercaseCommittedRevision}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await writeFile(output, '{"schema_version":"stale-success"}\n');
  const uppercaseRevisionStatusResult = spawnSync(process.execPath, [script, uppercaseRevisionStatus, output], { encoding: "utf8" });
  assert.notEqual(uppercaseRevisionStatusResult.status, 0);
  assert.match(uppercaseRevisionStatusResult.stderr, /^rehearsal_assertion_failed\n$/);
  await assert.rejects(readFile(output), error => error.code === "ENOENT");

  const conditionalTriggers = join(directory, "conditional-triggers.sqlite");
  const conditionalFeedback = execFileSync("git", ["show", `${candidate}:infra/worker/migrations/0012_article_feedback.sql`], { encoding: "utf8" })
    .replace("BEFORE UPDATE ON article_feedback_events\nBEGIN", "BEFORE UPDATE ON article_feedback_events\nWHEN OLD.id LIKE 'rehearsal_%'\nBEGIN")
    .replace("BEFORE DELETE ON article_feedback_events\nBEGIN", "BEFORE DELETE ON article_feedback_events\nWHEN OLD.id LIKE 'rehearsal_%'\nBEGIN");
  execFileSync("sqlite3", [conditionalTriggers], {
    input: `${await readFile(fixture, "utf8")}\n${conditionalFeedback}\n${execFileSync("git", ["show", `${candidate}:infra/worker/migrations/0013_article_revisions.sql`], { encoding: "utf8" })}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const conditionalTriggersResult = spawnSync(process.execPath, [script, conditionalTriggers, output], { encoding: "utf8" });
  assert.notEqual(conditionalTriggersResult.status, 0);
  assert.match(conditionalTriggersResult.stderr, /^rehearsal_assertion_failed\n$/);

  const wrongPartialIndex = join(directory, "wrong-partial-index.sqlite");
  const wrongIndexRevision = execFileSync("git", ["show", `${candidate}:infra/worker/migrations/0013_article_revisions.sql`], { encoding: "utf8" })
    .replace("WHERE parent_version_id IS NOT NULL", "WHERE parent_version_id IS NULL");
  execFileSync("sqlite3", [wrongPartialIndex], {
    input: `${await readFile(fixture, "utf8")}\n${committedFeedback}\n${wrongIndexRevision}`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const wrongPartialIndexResult = spawnSync(process.execPath, [script, wrongPartialIndex, output], { encoding: "utf8" });
  assert.notEqual(wrongPartialIndexResult.status, 0);
  assert.match(wrongPartialIndexResult.stderr, /^rehearsal_assertion_failed\n$/);

  const rejectsEveryInsert = join(directory, "rejects-every-insert.sqlite");
  const migrations = migrationPaths
    .map(path => execFileSync("git", ["show", `${candidate}:${path}`], { encoding: "utf8" }))
    .join("\n");
  execFileSync("sqlite3", [rejectsEveryInsert], {
    input: `${await readFile(fixture, "utf8")}\n${migrations}\n
      CREATE TRIGGER reject_every_feedback_insert BEFORE INSERT ON article_feedback_events BEGIN SELECT RAISE(ABORT, 'blocked'); END;
      CREATE TRIGGER reject_every_revision_insert BEFORE INSERT ON article_revision_requests BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await writeFile(output, '{"schema_version":"stale-success"}\n');
  const rejectsEveryInsertResult = spawnSync(process.execPath, [script, rejectsEveryInsert, output], { encoding: "utf8" });
  assert.notEqual(rejectsEveryInsertResult.status, 0);
  assert.match(rejectsEveryInsertResult.stderr, /^rehearsal_assertion_failed\n$/);
  await assert.rejects(readFile(output), error => error.code === "ENOENT");
});

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rehearseFixture(directory, name, sql) {
  const source = join(directory, `${name}.sqlite`);
  const output = join(directory, `${name}.json`);
  execFileSync("sqlite3", [source], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  const result = spawnSync(process.execPath, [script, source, output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(await readFile(output, "utf8"));
}
