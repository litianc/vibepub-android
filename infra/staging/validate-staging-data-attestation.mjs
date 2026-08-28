import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StagingManifestError, validateManifest } from "./render-staging-config.mjs";
import {
  ARTICLE_FEEDBACK_COUNT_TABLES as COUNT_KEYS,
  ARTICLE_FEEDBACK_MIGRATIONS as REHEARSAL_MIGRATIONS,
  ARTICLE_FEEDBACK_REHEARSAL_CHECKS as CHECK_KEYS,
  ARTICLE_FEEDBACK_REHEARSAL_SCHEMA_VERSION,
} from "./article-feedback-validation-contract.mjs";

export const STAGING_DATA_ATTESTATION = "staging_d1_backup_and_article_version_migrations_verified_v2";
const MAIN_MIGRATIONS = Array.from({ length: 13 }, (_, index) => `${String(index + 1).padStart(4, "0")}_${[
  "dedupe_recordings",
  "recording_experience_fields",
  "recording_processing_stage",
  "recording_duration_ms",
  "recording_cover_image_url",
  "recording_source_type",
  "recording_style_profiles",
  "multi_user_auth",
  "mining_input_claims",
  "editorial_visual_pipeline",
  "five_agent_publication_projection",
  "article_feedback",
  "article_revisions",
][index]}`);
const WRITING_MIGRATIONS = ["0001_style_profiles"];
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fail(code, message = code) {
  throw new StagingManifestError(code, message);
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("staging_data_evidence_invalid", `${field} must be an object`);
  return value;
}

function exactKeys(value, keys, field) {
  const actual = Object.keys(record(value, field)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("staging_data_evidence_invalid", `${field} has unsupported or missing fields`);
  }
}

function nonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) fail("staging_data_evidence_invalid", `${field} must be a bounded non-empty string`);
  return value;
}

function exactStringArray(value, expected, field, errorCode = "staging_data_evidence_invalid") {
  if (!Array.isArray(value) || value.length !== expected.length ||
      value.some((item, index) => item !== expected[index])) {
    fail(errorCode, `${field} must contain the exact required sequence`);
  }
}

function rehearsalCounts(value, field, allowMissing) {
  exactKeys(value, COUNT_KEYS, field);
  for (const key of COUNT_KEYS) {
    const count = value[key];
    if ((allowMissing && count === null) || (Number.isSafeInteger(count) && count >= 0)) continue;
    fail("staging_data_rehearsal_invalid", `${field}.${key} must be a non-negative integer${allowMissing ? " or null" : ""}`);
  }
}

function validateRehearsal(value, schemaEvidenceHash, backupCopySha256) {
  const field = "evidence.main.migration_rehearsal";
  exactKeys(value, [
    "schema_version", "candidate_commit", "migrations", "migration_bundle_sha256",
    "source_sha256", "schema_evidence_sha256", "preserved_rows_sha256",
    "before_counts", "after_counts", "checks",
  ], field);
  if (value.schema_version !== ARTICLE_FEEDBACK_REHEARSAL_SCHEMA_VERSION || !COMMIT.test(value.candidate_commit) ||
      !SHA256.test(value.migration_bundle_sha256) || !SHA256.test(value.source_sha256) ||
      !SHA256.test(value.schema_evidence_sha256) || !SHA256.test(value.preserved_rows_sha256) ||
      value.schema_evidence_sha256 !== schemaEvidenceHash || value.source_sha256 !== backupCopySha256) {
    fail("staging_data_rehearsal_invalid", `${field} identity or hashes are invalid`);
  }
  exactStringArray(value.migrations, REHEARSAL_MIGRATIONS, `${field}.migrations`, "staging_data_rehearsal_invalid");
  rehearsalCounts(record(value.before_counts, `${field}.before_counts`), `${field}.before_counts`, true);
  rehearsalCounts(record(value.after_counts, `${field}.after_counts`), `${field}.after_counts`, false);
  for (const key of COUNT_KEYS) {
    const before = value.before_counts[key];
    if (before !== null && value.after_counts[key] < before) {
      fail("staging_data_rehearsal_invalid", `${field} row counts decreased`);
    }
  }
  exactKeys(value.checks, CHECK_KEYS, `${field}.checks`);
  if (CHECK_KEYS.some(key => value.checks[key] !== true)) {
    fail("staging_data_rehearsal_invalid", `${field} checks must all pass`);
  }
}

function evidence(value, expectedDatabase, expectedMigrations, field, requireRehearsal = false) {
  exactKeys(value, [
    "database_name", "database_id", "backup_id", "applied_migrations", "schema_evidence_hash",
    ...(requireRehearsal ? ["backup_copy_sha256", "migration_rehearsal"] : []),
  ], field);
  if (nonEmpty(value.database_name, `${field}.database_name`) !== expectedDatabase.name ||
      nonEmpty(value.database_id, `${field}.database_id`) !== expectedDatabase.id) {
    fail("staging_data_database_mismatch", `${field} does not name the rendered isolated staging D1 database`);
  }
  nonEmpty(value.backup_id, `${field}.backup_id`);
  if (!SHA256.test(nonEmpty(value.schema_evidence_hash, `${field}.schema_evidence_hash`))) {
    fail("staging_data_evidence_invalid", `${field}.schema_evidence_hash must be a SHA-256 evidence hash`);
  }
  if (requireRehearsal && !SHA256.test(nonEmpty(value.backup_copy_sha256, `${field}.backup_copy_sha256`))) {
    fail("staging_data_rehearsal_invalid", `${field}.backup_copy_sha256 must be a SHA-256 hash`);
  }
  if (requireRehearsal && value.backup_id !== value.backup_copy_sha256) {
    fail("staging_data_rehearsal_invalid", `${field}.backup_id must be the content hash of the rehearsed backup copy`);
  }
  exactStringArray(value.applied_migrations, expectedMigrations, `${field}.applied_migrations`, "staging_data_migration_mismatch");
  if (requireRehearsal) validateRehearsal(
    record(value.migration_rehearsal, `${field}.migration_rehearsal`),
    value.schema_evidence_hash,
    value.backup_copy_sha256,
  );
}

export function validateStagingDataAttestation(manifestRaw, evidenceRaw, attestation) {
  const manifest = validateManifest(manifestRaw, "deploy");
  if (attestation !== STAGING_DATA_ATTESTATION) fail("staging_data_attestation_required", "the approved data-prepared attestation literal is required");
  exactKeys(evidenceRaw, ["schema_version", "main", "writing"], "evidence");
  if (evidenceRaw.schema_version !== "vibepub-staging-data-evidence.v2") fail("staging_data_evidence_invalid", "unsupported evidence schema");
  evidence(record(evidenceRaw.main, "evidence.main"), manifest.main.d1, MAIN_MIGRATIONS, "evidence.main", true);
  evidence(record(evidenceRaw.writing, "evidence.writing"), manifest.writing.d1, WRITING_MIGRATIONS, "evidence.writing");
  return {
    main_backup_id: evidenceRaw.main.backup_id,
    writing_backup_id: evidenceRaw.writing.backup_id,
    main_migrations: MAIN_MIGRATIONS,
    writing_migrations: WRITING_MIGRATIONS,
    main_schema_evidence_hash: evidenceRaw.main.schema_evidence_hash,
    main_backup_copy_sha256: evidenceRaw.main.backup_copy_sha256,
    main_rehearsal_candidate_commit: evidenceRaw.main.migration_rehearsal.candidate_commit,
    main_migration_bundle_sha256: evidenceRaw.main.migration_rehearsal.migration_bundle_sha256,
    main_rehearsal_schema_evidence_sha256: evidenceRaw.main.migration_rehearsal.schema_evidence_sha256,
    writing_schema_evidence_hash: evidenceRaw.writing.schema_evidence_hash,
  };
}

async function main() {
  const [manifestPath, evidencePath, attestation] = process.argv.slice(2);
  if (!manifestPath || !evidencePath || !attestation) throw new Error("usage: node infra/staging/validate-staging-data-attestation.mjs <manifest.json> <evidence.json> <attestation>");
  const [manifest, evidence] = await Promise.all([
    readFile(resolve(manifestPath), "utf8").then(JSON.parse),
    readFile(resolve(evidencePath), "utf8").then(JSON.parse),
  ]);
  process.stdout.write(`${JSON.stringify(validateStagingDataAttestation(manifest, evidence, attestation))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof StagingManifestError ? error.code : error.message}\n`);
    process.exitCode = 1;
  });
}
