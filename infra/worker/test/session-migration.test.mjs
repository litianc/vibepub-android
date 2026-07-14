import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const migrations = new URL("../migrations/", import.meta.url);

test("persistent session migration upgrades a populated legacy sessions table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-session-migration-"));
  const database = join(directory, "sessions.db");
  const script = join(directory, "migration.sql");

  try {
    const [legacy, persistent] = await Promise.all([
      readFile(new URL("0008_multi_user_auth.sql", migrations), "utf8"),
      readFile(new URL("0010_persistent_device_sessions.sql", migrations), "utf8"),
    ]);
    await writeFile(script, `${legacy}\n${legacySessionInsert()}\n${persistent}`);
    execFileSync("sqlite3", [database, `.read ${script}`], { stdio: "pipe" });

    const legacyRow = queryJson(database, `
      SELECT id, family_id, generation, last_used_at, idle_expires_at,
             previous_refresh_token_hash, revoked_at, revocation_reason
      FROM sessions WHERE id = 'ses_legacy'
    `)[0];
    assert.deepEqual(legacyRow, {
      id: "ses_legacy",
      family_id: "ses_legacy",
      generation: 0,
      last_used_at: "2026-07-01T00:00:00.000Z",
      idle_expires_at: "2026-07-31T00:00:00.000Z",
      previous_refresh_token_hash: null,
      revoked_at: null,
      revocation_reason: null,
    });

    const indexes = queryJson(database, "PRAGMA index_list('sessions')");
    assert.ok(indexes.some((index) => index.name === "idx_sessions_family_generation" && index.unique === 1));
    assert.ok(queryJson(database, "PRAGMA table_info('password_reset_tokens')")
      .some((column) => column.name === "consumed_request_id"));

    const auditColumns = queryJson(database, "PRAGMA table_info('session_revocation_audit')")
      .map((column) => column.name);
    assert.deepEqual(auditColumns, [
      "id", "session_id", "family_id", "user_id", "reason", "request_id_hash", "created_at",
    ]);

    const historyColumns = queryJson(database, "PRAGMA table_info('session_rotation_history')")
      .map((column) => column.name);
    assert.deepEqual(historyColumns, [
      "id", "session_id", "family_id", "generation", "refresh_token_hash", "request_id_hash",
      "valid_until", "retain_until", "rotation_ciphertext", "created_at",
    ]);
    const historyForeignKeys = queryJson(database, "PRAGMA foreign_key_list('session_rotation_history')");
    assert.ok(historyForeignKeys.some((key) => key.table === "sessions" && key.from === "session_id"));
    const historyIndexes = queryJson(database, "PRAGMA index_list('session_rotation_history')");
    assert.ok(historyIndexes.some((index) => index.name === "idx_session_rotation_history_token" && index.unique === 1));
    assert.ok(historyIndexes.some((index) => index.name === "idx_session_rotation_history_family_generation" && index.unique === 1));

    execFileSync("sqlite3", [database, freshSessionAndHistoryInsert()], { stdio: "pipe" });
    assert.deepEqual(queryJson(database, `
      SELECT h.session_id, h.family_id, h.generation, h.refresh_token_hash,
             h.request_id_hash, h.rotation_ciphertext
      FROM session_rotation_history h WHERE h.session_id = 'ses_fresh'
    `)[0], {
      session_id: "ses_fresh",
      family_id: "ses_fresh",
      generation: 0,
      refresh_token_hash: "fresh-refresh-zero",
      request_id_hash: "request-digest",
      rotation_ciphertext: "encrypted-response",
    });
    assert.throws(() => execFileSync("sqlite3", [database, `
      INSERT INTO session_rotation_history
        (id, session_id, family_id, generation, refresh_token_hash, valid_until, retain_until, created_at)
      VALUES ('srh_duplicate', 'ses_fresh', 'ses_fresh', 0, 'another-token-hash',
              '2026-07-14T00:01:00.000Z', '2027-01-10T00:00:00.000Z', CURRENT_TIMESTAMP);
    `], { stdio: "pipe" }));
    assert.throws(() => execFileSync("sqlite3", [database, `
      INSERT INTO session_rotation_history
        (id, session_id, family_id, generation, refresh_token_hash, request_id_hash,
         valid_until, retain_until, created_at)
      VALUES ('srh_wrong_family', 'ses_fresh', 'fam_wrong', 1, 'wrong-family-token', 'wrong-family-request',
              '2026-07-14T00:01:00.000Z', '2027-01-10T00:00:00.000Z', CURRENT_TIMESTAMP);
    `], { stdio: "pipe" }));
    assert.throws(() => execFileSync("sqlite3", [database, `
      INSERT INTO session_rotation_history
        (id, session_id, family_id, generation, refresh_token_hash, request_id_hash,
         valid_until, retain_until, created_at)
      VALUES ('srh_reused_request', 'ses_fresh', 'ses_fresh', 1, 'reused-request-token', 'request-digest',
              '2026-07-14T00:01:00.000Z', '2027-01-10T00:00:00.000Z', CURRENT_TIMESTAMP);
    `], { stdio: "pipe" }));

    assert.throws(() => execFileSync("sqlite3", [database, `
      INSERT INTO session_revocation_audit
        (id, session_id, family_id, user_id, reason, created_at)
      VALUES ('audit_wrong_family', 'ses_fresh', 'fam_wrong', 'usr_fresh', 'logout_current', CURRENT_TIMESTAMP);
    `], { stdio: "pipe" }));
    assert.throws(() => execFileSync("sqlite3", [database, `
      INSERT INTO session_revocation_audit
        (id, session_id, family_id, user_id, reason, created_at)
      VALUES ('audit_wrong_user', 'ses_fresh', 'ses_fresh', 'usr_legacy', 'logout_current', CURRENT_TIMESTAMP);
    `], { stdio: "pipe" }));

    execFileSync("sqlite3", [database, postMigrationLegacyNullFamilyInsert()], { stdio: "pipe" });
    assert.deepEqual(queryJson(database, `
      SELECT h.session_id, h.family_id, a.user_id
      FROM session_rotation_history h
      JOIN session_revocation_audit a ON a.session_id = h.session_id
      WHERE h.session_id = 'ses_post_migration_legacy'
    `)[0], {
      session_id: "ses_post_migration_legacy",
      family_id: "ses_post_migration_legacy",
      user_id: "usr_legacy",
    });

    assert.throws(() => execFileSync("sqlite3", [database, `
      UPDATE sessions SET revocation_reason = 'arbitrary_reason' WHERE id = 'ses_legacy';
    `], { stdio: "pipe" }));
    assert.throws(() => execFileSync("sqlite3", [database, `
      UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = NULL WHERE id = 'ses_legacy';
    `], { stdio: "pipe" }));
    assert.throws(() => execFileSync("sqlite3", [database, `
      INSERT INTO session_revocation_audit
        (id, session_id, family_id, user_id, reason, created_at)
      VALUES ('bad', 'ses_legacy', 'ses_legacy', 'usr_legacy', 'arbitrary_reason', CURRENT_TIMESTAMP);
    `], { stdio: "pipe" }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical schema creates the complete persistent-session model on a fresh database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibepub-fresh-schema-"));
  const database = join(directory, "fresh.db");
  const script = join(directory, "schema.sql");
  try {
    await writeFile(script, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    execFileSync("sqlite3", [database, `.read ${script}`], { stdio: "pipe" });

    const sessionColumns = queryJson(database, "PRAGMA table_info('sessions')").map((column) => column.name);
    for (const column of [
      "family_id", "generation", "last_used_at", "idle_expires_at", "previous_refresh_token_hash",
      "previous_generation", "previous_valid_until", "previous_request_id_hash",
      "previous_rotation_ciphertext", "revocation_reason",
    ]) {
      assert.ok(sessionColumns.includes(column), `missing sessions.${column}`);
    }
    assert.ok(queryJson(database, "PRAGMA table_info('password_reset_tokens')")
      .some((column) => column.name === "consumed_request_id"));
    assert.deepEqual(
      queryJson(database, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
        ('session_rotation_history', 'session_revocation_audit') ORDER BY name`).map((row) => row.name),
      ["session_revocation_audit", "session_rotation_history"],
    );
    const indexes = queryJson(database, `SELECT name FROM sqlite_master WHERE type = 'index'`).map((row) => row.name);
    assert.ok(indexes.includes("idx_session_rotation_history_family_request"));
    const triggers = queryJson(database, `SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((row) => row.name);
    assert.ok(triggers.includes("trg_session_rotation_history_identity_insert"));
    assert.ok(triggers.includes("trg_session_revocation_audit_identity_insert"));
    assert.ok(triggers.includes("trg_sessions_child_identity_update"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function queryJson(database, sql) {
  const output = execFileSync("sqlite3", ["-json", database, sql], { encoding: "utf8" });
  return JSON.parse(output || "[]");
}

function legacySessionInsert() {
  return `
    INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations, role, workspace_id, status, email_verified_at, created_at, updated_at)
    VALUES
      ('usr_legacy', 'legacy@example.test', 'hash', 'salt', 100000, 'user', 'ws_legacy', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO sessions
      (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at, updated_at)
    VALUES
      ('ses_legacy', 'usr_legacy', 'access-hash', 'refresh-hash', '2026-07-01T01:00:00.000Z',
       '2026-07-31T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
  `;
}

function freshSessionAndHistoryInsert() {
  return `
    INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations, role, workspace_id, status, email_verified_at, created_at, updated_at)
    VALUES
      ('usr_fresh', 'fresh@example.test', 'hash', 'salt', 100000, 'user', 'ws_fresh', 'active',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO sessions
      (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at,
       family_id, generation, last_used_at, idle_expires_at, created_at, updated_at)
    VALUES
      ('ses_fresh', 'usr_fresh', 'fresh-access', 'fresh-refresh-one', '2026-07-14T01:00:00.000Z',
       '2027-01-10T00:00:00.000Z', 'ses_fresh', 1, '2026-07-14T00:00:00.000Z',
       '2027-01-10T00:00:00.000Z', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
    INSERT INTO session_rotation_history
      (id, session_id, family_id, generation, refresh_token_hash, request_id_hash,
       valid_until, retain_until, rotation_ciphertext, created_at)
    VALUES
      ('srh_fresh', 'ses_fresh', 'ses_fresh', 0, 'fresh-refresh-zero', 'request-digest',
       '2026-07-14T00:01:00.000Z', '2027-01-10T00:00:00.000Z', 'encrypted-response',
       '2026-07-14T00:00:00.000Z');
  `;
}

function postMigrationLegacyNullFamilyInsert() {
  return `
    INSERT INTO sessions
      (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at,
       family_id, generation, created_at, updated_at)
    VALUES
      ('ses_post_migration_legacy', 'usr_legacy', 'legacy-late-access', 'legacy-late-refresh',
       '2026-07-14T01:00:00.000Z', '2026-08-14T00:00:00.000Z', NULL, 0,
       '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
    INSERT INTO session_rotation_history
      (id, session_id, family_id, generation, refresh_token_hash, request_id_hash,
       valid_until, retain_until, created_at)
    VALUES
      ('srh_post_migration_legacy', 'ses_post_migration_legacy', 'ses_post_migration_legacy', 0,
       'legacy-late-refresh', 'legacy-late-request', '2026-07-14T00:01:00.000Z',
       '2026-08-14T00:00:00.000Z', CURRENT_TIMESTAMP);
    INSERT INTO session_revocation_audit
      (id, session_id, family_id, user_id, reason, created_at)
    VALUES
      ('audit_post_migration_legacy', 'ses_post_migration_legacy', 'ses_post_migration_legacy',
       'usr_legacy', 'logout_current', CURRENT_TIMESTAMP);
  `;
}
