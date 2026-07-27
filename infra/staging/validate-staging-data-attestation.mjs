import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StagingManifestError, validateManifest } from "./render-staging-config.mjs";

export const STAGING_DATA_ATTESTATION = "staging_d1_backup_and_additive_migrations_verified_v1";
const MAIN_MIGRATIONS = Array.from({ length: 11 }, (_, index) => `${String(index + 1).padStart(4, "0")}_${[
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
][index]}`);
const WRITING_MIGRATIONS = ["0001_style_profiles"];
const SHA256 = /^sha256:[a-f0-9]{64}$/;

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

function evidence(value, expectedDatabase, expectedMigrations, field) {
  exactKeys(value, ["database_name", "database_id", "backup_id", "applied_migrations", "schema_evidence_hash"], field);
  if (nonEmpty(value.database_name, `${field}.database_name`) !== expectedDatabase.name ||
      nonEmpty(value.database_id, `${field}.database_id`) !== expectedDatabase.id) {
    fail("staging_data_database_mismatch", `${field} does not name the rendered isolated staging D1 database`);
  }
  nonEmpty(value.backup_id, `${field}.backup_id`);
  if (!SHA256.test(nonEmpty(value.schema_evidence_hash, `${field}.schema_evidence_hash`))) {
    fail("staging_data_evidence_invalid", `${field}.schema_evidence_hash must be a SHA-256 evidence hash`);
  }
  if (!Array.isArray(value.applied_migrations) || value.applied_migrations.length !== expectedMigrations.length ||
      value.applied_migrations.some((item, index) => item !== expectedMigrations[index])) {
    fail("staging_data_migration_mismatch", `${field} must prove the exact additive migration sequence`);
  }
}

export function validateStagingDataAttestation(manifestRaw, evidenceRaw, attestation) {
  const manifest = validateManifest(manifestRaw, "deploy");
  if (attestation !== STAGING_DATA_ATTESTATION) fail("staging_data_attestation_required", "the approved data-prepared attestation literal is required");
  exactKeys(evidenceRaw, ["schema_version", "main", "writing"], "evidence");
  if (evidenceRaw.schema_version !== "vibepub-staging-data-evidence.v1") fail("staging_data_evidence_invalid", "unsupported evidence schema");
  evidence(record(evidenceRaw.main, "evidence.main"), manifest.main.d1, MAIN_MIGRATIONS, "evidence.main");
  evidence(record(evidenceRaw.writing, "evidence.writing"), manifest.writing.d1, WRITING_MIGRATIONS, "evidence.writing");
  return {
    main_backup_id: evidenceRaw.main.backup_id,
    writing_backup_id: evidenceRaw.writing.backup_id,
    main_migrations: MAIN_MIGRATIONS,
    writing_migrations: WRITING_MIGRATIONS,
    main_schema_evidence_hash: evidenceRaw.main.schema_evidence_hash,
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
