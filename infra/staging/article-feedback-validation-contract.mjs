import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const ARTICLE_FEEDBACK_REHEARSAL_SCHEMA_VERSION = "vibepub-main-d1-migration-rehearsal.v2";
export const ARTICLE_FEEDBACK_MIGRATIONS = ["0012_article_feedback", "0013_article_revisions"];
export const ARTICLE_FEEDBACK_COUNT_TABLES = [
  "users",
  "recordings",
  "article_versions",
  "article_feedback_events",
  "article_revision_requests",
];
export const ARTICLE_FEEDBACK_REHEARSAL_CHECKS = [
  "source_unchanged",
  "first_apply_passed",
  "second_apply_passed",
  "old_rows_preserved",
  "old_rows_identical",
  "schema_contract_passed",
  "foreign_keys_passed",
  "duplicate_feedback_rejected",
  "duplicate_revision_rejected",
  "valid_feedback_inserted",
  "valid_revision_inserted",
  "invalid_feedback_action_rejected",
  "invalid_revision_status_rejected",
  "feedback_update_rejected",
  "feedback_delete_rejected",
];

export function sha256Fingerprint(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function committedArticleFeedbackMigrationBundle(repositoryRoot, candidate) {
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error("candidate_commit_invalid");
  const bytes = ARTICLE_FEEDBACK_MIGRATIONS.map(name => execFileSync(
    "git",
    ["-C", repositoryRoot, "show", `${candidate}:infra/worker/migrations/${name}.sql`],
    { maxBuffer: 4 * 1024 * 1024 },
  ));
  const bundle = Buffer.concat([bytes[0], Buffer.from("\n"), bytes[1]]);
  return { sql: bundle.toString("utf8"), sha256: sha256Fingerprint(bundle) };
}
