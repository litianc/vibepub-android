import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./render-staging-config.mjs";

const SCHEMA_VERSION = "vibepub-article-feedback-loop-evidence.v1";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const FORBIDDEN_KEY = /(?:password|passwd|token|secret|serial|email|filename|transcript|screenshot|logs?|body|content|article_text|d1_id|r2_id)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SECRET_VALUE = /(?:\bBearer\s+|\b(?:sk|pk|ghp|github_pat)-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.)/;
const REDACTED_IDS = new Set([
  "version_adopted_v1", "version_adopted_v2", "version_not_adopted",
  "revision_adopted", "feedback_continue", "feedback_adopted", "feedback_not_adopted",
]);

export class ArticleFeedbackLoopEvidenceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ArticleFeedbackLoopEvidenceError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new ArticleFeedbackLoopEvidenceError(code, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("evidence_shape_invalid", `${field} must be an object`);
  return value;
}

function exactKeys(value, keys, field) {
  const actual = Object.keys(object(value, field)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("evidence_shape_invalid", `${field} has unsupported or missing fields`);
  }
}

function scanPrivacy(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPrivacy(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail("evidence_privacy_violation", `${path} contains a forbidden field`);
      scanPrivacy(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (EMAIL.test(value) || SECRET_VALUE.test(value))) {
    fail("evidence_privacy_violation", `${path} contains forbidden data`);
  }
}

function exact(value, expected, code, field) {
  if (value !== expected) fail(code, `${field} must be ${JSON.stringify(expected)}`);
}

function count(value, expected, field, code = "evidence_count_invalid") {
  if (!Number.isSafeInteger(value) || value !== expected) fail(code, `${field} must be ${expected}`);
}

function hash(value, field) {
  if (typeof value !== "string" || !SHA256.test(value)) fail("evidence_fingerprint_invalid", `${field} must be a SHA-256 fingerprint`);
  return value;
}

function domainFingerprint(kind, value) {
  return `sha256:${createHash("sha256").update(`${kind}:${value}`).digest("hex")}`;
}

function expectedIsolationFingerprints(manifest) {
  const accountLabel = new URL(manifest.main.public_base_url).hostname.split(".")[1];
  return {
    account_fingerprint: domainFingerprint("account", accountLabel),
    resource_fingerprints: {
      main_d1: domainFingerprint("main_d1", manifest.main.d1.id),
      writing_d1: domainFingerprint("writing_d1", manifest.writing.d1.id),
      audio_r2: domainFingerprint("audio_r2", manifest.main.files_bucket),
      image_r2: domainFingerprint("image_r2", manifest.image.results_bucket),
    },
  };
}

function commit(value, field) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) fail("evidence_commit_invalid", `${field} must be a full lowercase commit SHA`);
  return value;
}

function id(value, prefix, field) {
  if (typeof value !== "string" || !value.startsWith(`${prefix}_`) || !REDACTED_IDS.has(value)) {
    fail("evidence_identifier_invalid", `${field} must use an approved redacted alias`);
  }
  return value;
}

function stagingOrigin(value, field) {
  if (typeof value !== "string" || value.length > 200) fail("evidence_origin_invalid", `${field} must be an HTTPS origin`);
  let parsed;
  try { parsed = new URL(value); } catch { fail("evidence_origin_invalid", `${field} must be an HTTPS origin`); }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username || parsed.password ||
      parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") || parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".invalid")) {
    fail("evidence_origin_invalid", `${field} must be an isolated HTTPS Staging origin`);
  }
  return parsed.origin;
}

function apkEvidence(value, field, expectedCommit, expectedOrigin) {
  exactKeys(value, ["commit_sha", "staging_origin", "apk_fingerprint", "completion_fingerprint", "completion_count", "completed_journey_fingerprints"], field);
  exact(commit(value.commit_sha, `${field}.commit_sha`), expectedCommit, "evidence_commit_mismatch", `${field}.commit_sha`);
  exact(stagingOrigin(value.staging_origin, `${field}.staging_origin`), expectedOrigin, "evidence_origin_mismatch", `${field}.staging_origin`);
  const apkFingerprint = hash(value.apk_fingerprint, `${field}.apk_fingerprint`);
  const completionFingerprint = hash(value.completion_fingerprint, `${field}.completion_fingerprint`);
  count(value.completion_count, 2, `${field}.completion_count`);
  if (!Array.isArray(value.completed_journey_fingerprints) || value.completed_journey_fingerprints.length !== 2) {
    fail("evidence_completion_missing", `${field} must attest both journeys exactly once`);
  }
  const journeyFingerprints = value.completed_journey_fingerprints.map((item, index) =>
    hash(item, `${field}.completed_journey_fingerprints[${index}]`));
  if (journeyFingerprints[0] === journeyFingerprints[1]) {
    fail("evidence_completion_missing", `${field} must attest two distinct journeys`);
  }
  return { apkFingerprint, completionFingerprint, journeyFingerprints };
}

function version(value, field, expectedNo, expectedParent) {
  exactKeys(value, expectedNo === 2
    ? ["id", "version_no", "parent_id", "child_count_for_parent", "current"]
    : ["id", "version_no", "parent_id", "source_run_fingerprint", "recording_fingerprint"], field);
  const versionId = id(value.id, "version", `${field}.id`);
  count(value.version_no, expectedNo, `${field}.version_no`, "evidence_lineage_invalid");
  exact(value.parent_id, expectedParent, "evidence_lineage_invalid", `${field}.parent_id`);
  if (expectedNo === 2) {
    count(value.child_count_for_parent, 1, `${field}.child_count_for_parent`, "evidence_lineage_invalid");
    exact(value.current, true, "evidence_lineage_invalid", `${field}.current`);
  }
  return versionId;
}

function replayProof(value, field) {
  hash(value.client_request_fingerprint, `${field}.client_request_fingerprint`);
  const original = hash(value.original_payload_fingerprint, `${field}.original_payload_fingerprint`);
  const replay = hash(value.replay_payload_fingerprint, `${field}.replay_payload_fingerprint`);
  const conflicting = hash(value.conflicting_payload_fingerprint, `${field}.conflicting_payload_fingerprint`);
  if (original !== replay || conflicting === original) fail("evidence_replay_invalid", `${field} must prove exact replay and a different conflicting payload`);
  count(value.idempotency_attempt_count, 3, `${field}.idempotency_attempt_count`);
  count(value.accepted_request_count, 2, `${field}.accepted_request_count`);
  count(value.event_count, 1, `${field}.event_count`);
  count(value.replay_count, 1, `${field}.replay_count`);
  count(value.payload_conflict_count, 1, `${field}.payload_conflict_count`);
  count(value.conflict_event_count, 0, `${field}.conflict_event_count`);
}

function validateAdopted(value) {
  exactKeys(value, ["journey_fingerprint", "recording_fingerprint", "five_agent_run", "v1", "revision", "v2", "feedback_replay", "wechat_recovery"], "evidence.journeys.adopted");
  const journeyFingerprint = hash(value.journey_fingerprint, "evidence.journeys.adopted.journey_fingerprint");
  const recordingFingerprint = hash(value.recording_fingerprint, "evidence.journeys.adopted.recording_fingerprint");

  const run = value.five_agent_run;
  exactKeys(run, ["run_fingerprint", "journey_fingerprint", "recording_fingerprint", "run_count", "agent_count", "completed_agent_count", "frozen_article_count", "status"], "evidence.journeys.adopted.five_agent_run");
  const runFingerprint = hash(run.run_fingerprint, "evidence.journeys.adopted.five_agent_run.run_fingerprint");
  if (hash(run.journey_fingerprint, "evidence.journeys.adopted.five_agent_run.journey_fingerprint") !== journeyFingerprint) {
    fail("evidence_journey_binding_invalid", "five-Agent run must belong to the adopted journey");
  }
  if (hash(run.recording_fingerprint, "evidence.journeys.adopted.five_agent_run.recording_fingerprint") !== recordingFingerprint) {
    fail("evidence_journey_binding_invalid", "five-Agent run must use the adopted recording");
  }
  count(run.run_count, 1, "five_agent_run.run_count");
  count(run.agent_count, 5, "five_agent_run.agent_count");
  count(run.completed_agent_count, 5, "five_agent_run.completed_agent_count");
  count(run.frozen_article_count, 1, "five_agent_run.frozen_article_count");
  exact(run.status, "completed", "evidence_five_agent_run_invalid", "five_agent_run.status");

  const v1 = version(value.v1, "evidence.journeys.adopted.v1", 1, null);
  if (hash(value.v1.source_run_fingerprint, "evidence.journeys.adopted.v1.source_run_fingerprint") !== runFingerprint) {
    fail("evidence_journey_binding_invalid", "v1 must come from the five-Agent frozen run");
  }
  if (hash(value.v1.recording_fingerprint, "evidence.journeys.adopted.v1.recording_fingerprint") !== recordingFingerprint) {
    fail("evidence_journey_binding_invalid", "v1 must belong to the adopted recording");
  }
  const revision = value.revision;
  exactKeys(revision, ["id", "feedback_id", "feedback_version_id", "feedback_event_count", "action", "client_request_fingerprint", "original_payload_fingerprint", "replay_payload_fingerprint", "conflicting_payload_fingerprint", "parent_version_id", "child_version_id", "idempotency_attempt_count", "accepted_request_count", "event_count", "replay_count", "payload_conflict_count", "conflict_event_count", "stale_parent_rejection_count", "stale_parent_side_effect_count"], "evidence.journeys.adopted.revision");
  id(revision.id, "revision", "revision.id");
  exact(id(revision.feedback_id, "feedback", "revision.feedback_id"), "feedback_continue", "evidence_feedback_invalid", "revision.feedback_id");
  exact(revision.feedback_version_id, v1, "evidence_lineage_invalid", "revision.feedback_version_id");
  count(revision.feedback_event_count, 1, "revision.feedback_event_count");
  exact(revision.action, "continue_revision", "evidence_feedback_invalid", "revision.action");
  exact(revision.parent_version_id, v1, "evidence_lineage_invalid", "revision.parent_version_id");
  replayProof(revision, "revision");
  count(revision.stale_parent_rejection_count, 1, "revision.stale_parent_rejection_count");
  count(revision.stale_parent_side_effect_count, 0, "revision.stale_parent_side_effect_count");

  const v2 = version(value.v2, "evidence.journeys.adopted.v2", 2, v1);
  if (v2 === v1) fail("evidence_lineage_invalid", "v2 must be unique");
  exact(revision.child_version_id, v2, "evidence_lineage_invalid", "revision.child_version_id");

  const feedback = value.feedback_replay;
  exactKeys(feedback, ["id", "version_id", "action", "client_request_fingerprint", "original_payload_fingerprint", "replay_payload_fingerprint", "conflicting_payload_fingerprint", "idempotency_attempt_count", "accepted_request_count", "event_count", "replay_count", "payload_conflict_count", "conflict_event_count", "stale_version_rejection_count", "stale_version_side_effect_count"], "evidence.journeys.adopted.feedback_replay");
  id(feedback.id, "feedback", "feedback_replay.id");
  exact(feedback.version_id, v2, "evidence_lineage_invalid", "feedback_replay.version_id");
  exact(feedback.action, "adopted", "evidence_feedback_invalid", "feedback_replay.action");
  replayProof(feedback, "feedback_replay");
  count(feedback.stale_version_rejection_count, 1, "feedback_replay.stale_version_rejection_count");
  count(feedback.stale_version_side_effect_count, 0, "feedback_replay.stale_version_side_effect_count");

  const wechat = value.wechat_recovery;
  exactKeys(wechat, ["version_id", "first_status", "recovery_status", "attempt_count", "draft_count", "version_count_before_recovery", "version_count_after_recovery", "recovery_version_creation_count", "recovery_asr_count", "recovery_writing_count", "recovery_review_count", "recovery_image_generation_count", "recovery_cover_generation_count", "recovery_article_pipeline_count"], "evidence.journeys.adopted.wechat_recovery");
  exact(wechat.version_id, v2, "evidence_lineage_invalid", "wechat_recovery.version_id");
  exact(wechat.first_status, "wechat_failed", "evidence_wechat_recovery_invalid", "wechat_recovery.first_status");
  exact(wechat.recovery_status, "completed", "evidence_wechat_recovery_invalid", "wechat_recovery.recovery_status");
  count(wechat.attempt_count, 2, "wechat_recovery.attempt_count");
  count(wechat.draft_count, 1, "wechat_recovery.draft_count");
  count(wechat.version_count_before_recovery, 2, "wechat_recovery.version_count_before_recovery");
  count(wechat.version_count_after_recovery, 2, "wechat_recovery.version_count_after_recovery");
  count(wechat.recovery_version_creation_count, 0, "wechat_recovery.recovery_version_creation_count");
  for (const field of [
    "recovery_asr_count", "recovery_writing_count", "recovery_review_count",
    "recovery_image_generation_count", "recovery_cover_generation_count",
    "recovery_article_pipeline_count",
  ]) count(wechat[field], 0, `wechat_recovery.${field}`);
  return {
    v1,
    v2,
    feedbackIds: new Set([revision.feedback_id, feedback.id]),
    journeyFingerprint,
    recordingFingerprint,
  };
}

function validateNotAdopted(value) {
  exactKeys(value, ["journey_fingerprint", "recording_fingerprint", "version", "feedback"], "evidence.journeys.not_adopted");
  const journeyFingerprint = hash(value.journey_fingerprint, "evidence.journeys.not_adopted.journey_fingerprint");
  const recordingFingerprint = hash(value.recording_fingerprint, "evidence.journeys.not_adopted.recording_fingerprint");
  exactKeys(value.version, ["id", "version_no", "current", "recording_fingerprint"], "evidence.journeys.not_adopted.version");
  const versionId = id(value.version.id, "version", "not_adopted.version.id");
  if (hash(value.version.recording_fingerprint, "not_adopted.version.recording_fingerprint") !== recordingFingerprint) {
    fail("evidence_journey_binding_invalid", "not-adopted version must belong to its recording");
  }
  if (!Number.isSafeInteger(value.version.version_no) || value.version.version_no < 1) fail("evidence_lineage_invalid", "not_adopted.version.version_no must be positive");
  exact(value.version.current, true, "evidence_lineage_invalid", "not_adopted.version.current");
  exactKeys(value.feedback, ["id", "version_id", "recording_fingerprint", "action", "event_count"], "evidence.journeys.not_adopted.feedback");
  id(value.feedback.id, "feedback", "not_adopted.feedback.id");
  exact(value.feedback.version_id, versionId, "evidence_lineage_invalid", "not_adopted.feedback.version_id");
  if (hash(value.feedback.recording_fingerprint, "not_adopted.feedback.recording_fingerprint") !== recordingFingerprint) {
    fail("evidence_journey_binding_invalid", "not-adopted feedback must belong to its recording");
  }
  exact(value.feedback.action, "not_adopted", "evidence_feedback_invalid", "not_adopted.feedback.action");
  count(value.feedback.event_count, 1, "not_adopted.feedback.event_count");
  return { versionId, feedbackId: value.feedback.id, journeyFingerprint, recordingFingerprint };
}

export function validateArticleFeedbackLoopEvidence(raw, manifestRaw, expectedCandidateCommit) {
  const manifest = validateManifest(manifestRaw, "deploy");
  scanPrivacy(raw);
  exactKeys(raw, ["schema_version", "candidate", "isolation", "device", "journeys", "compatibility"], "evidence");
  exact(raw.schema_version, SCHEMA_VERSION, "evidence_schema_invalid", "evidence.schema_version");

  exactKeys(raw.candidate, ["commit_sha", "backend_commit_sha", "actual_apk", "synthetic_apk"], "evidence.candidate");
  const expectedCommit = commit(expectedCandidateCommit, "expected_candidate_commit");
  const candidateCommit = commit(raw.candidate.commit_sha, "candidate.commit_sha");
  exact(candidateCommit, expectedCommit, "evidence_commit_mismatch", "candidate.commit_sha");
  exact(commit(raw.candidate.backend_commit_sha, "candidate.backend_commit_sha"), candidateCommit, "evidence_commit_mismatch", "candidate.backend_commit_sha");

  exactKeys(raw.isolation, ["staging_origin", "account_fingerprint", "resource_fingerprints", "production_data_touched"], "evidence.isolation");
  const origin = stagingOrigin(raw.isolation.staging_origin, "isolation.staging_origin");
  exact(origin, manifest.main.public_base_url, "evidence_origin_mismatch", "isolation.staging_origin");
  const expectedIsolation = expectedIsolationFingerprints(manifest);
  exact(raw.isolation.account_fingerprint, expectedIsolation.account_fingerprint, "evidence_isolation_binding_invalid", "isolation.account_fingerprint");
  const fingerprints = [hash(raw.isolation.account_fingerprint, "isolation.account_fingerprint")];
  exactKeys(raw.isolation.resource_fingerprints, ["main_d1", "writing_d1", "audio_r2", "image_r2"], "evidence.isolation.resource_fingerprints");
  for (const key of ["main_d1", "writing_d1", "audio_r2", "image_r2"]) {
    const value = hash(raw.isolation.resource_fingerprints[key], `isolation.resource_fingerprints.${key}`);
    exact(value, expectedIsolation.resource_fingerprints[key], "evidence_isolation_binding_invalid", `isolation.resource_fingerprints.${key}`);
    fingerprints.push(value);
  }
  if (new Set(fingerprints).size !== fingerprints.length) fail("evidence_fingerprint_invalid", "account and resource fingerprints must be distinct");
  exact(raw.isolation.production_data_touched, false, "evidence_production_touched", "isolation.production_data_touched");

  const actualApk = apkEvidence(raw.candidate.actual_apk, "candidate.actual_apk", candidateCommit, origin);
  const syntheticApk = apkEvidence(raw.candidate.synthetic_apk, "candidate.synthetic_apk", candidateCommit, origin);
  if (actualApk.apkFingerprint === syntheticApk.apkFingerprint ||
      actualApk.completionFingerprint === syntheticApk.completionFingerprint) {
    fail("evidence_apk_attestation_invalid", "APK artifacts and completion attestations must be independently fingerprinted");
  }

  exactKeys(raw.device, ["identifier_fingerprint", "journey_fingerprints", "recording_fingerprints"], "evidence.device");
  hash(raw.device.identifier_fingerprint, "device.identifier_fingerprint");

  exactKeys(raw.journeys, ["adopted", "not_adopted"], "evidence.journeys");
  const adopted = validateAdopted(raw.journeys.adopted);
  const notAdopted = validateNotAdopted(raw.journeys.not_adopted);
  if (notAdopted.versionId === adopted.v1 || notAdopted.versionId === adopted.v2 ||
      adopted.feedbackIds.has(notAdopted.feedbackId)) {
    fail("evidence_journey_separation_invalid", "adopted and not-adopted journeys must have separate versions and events");
  }
  const expectedJourneys = [adopted.journeyFingerprint, notAdopted.journeyFingerprint];
  for (const apk of [actualApk, syntheticApk]) {
    if (apk.journeyFingerprints.some((fingerprint, index) => fingerprint !== expectedJourneys[index])) {
      fail("evidence_journey_binding_invalid", "APK completion evidence must bind both exact journeys");
    }
  }

  exactKeys(raw.compatibility, ["old_recording", "old_app"], "evidence.compatibility");
  exactKeys(raw.compatibility.old_recording, ["journey_fingerprint", "recording_fingerprint", "device_identifier_fingerprint", "apk_fingerprint", "readable", "read_count", "article_version_count", "feedback_controls_visible"], "evidence.compatibility.old_recording");
  const oldJourneyFingerprint = hash(raw.compatibility.old_recording.journey_fingerprint, "old_recording.journey_fingerprint");
  const oldRecordingFingerprint = hash(raw.compatibility.old_recording.recording_fingerprint, "old_recording.recording_fingerprint");
  exact(hash(raw.compatibility.old_recording.device_identifier_fingerprint, "old_recording.device_identifier_fingerprint"), raw.device.identifier_fingerprint, "evidence_compatibility_invalid", "old_recording.device_identifier_fingerprint");
  exact(hash(raw.compatibility.old_recording.apk_fingerprint, "old_recording.apk_fingerprint"), actualApk.apkFingerprint, "evidence_compatibility_invalid", "old_recording.apk_fingerprint");
  for (const [field, values, expected] of [
    ["device.journey_fingerprints", raw.device.journey_fingerprints, [...expectedJourneys, oldJourneyFingerprint]],
    ["device.recording_fingerprints", raw.device.recording_fingerprints, [adopted.recordingFingerprint, notAdopted.recordingFingerprint, oldRecordingFingerprint]],
  ]) {
    if (!Array.isArray(values) || values.length !== expected.length ||
        values.some((value, index) => hash(value, `${field}[${index}]`) !== expected[index])) {
      fail("evidence_journey_binding_invalid", `${field} must bind every exact device journey`);
    }
  }
  exact(raw.compatibility.old_recording.readable, true, "evidence_compatibility_invalid", "old_recording.readable");
  count(raw.compatibility.old_recording.read_count, 1, "old_recording.read_count");
  count(raw.compatibility.old_recording.article_version_count, 0, "old_recording.article_version_count", "evidence_compatibility_invalid");
  exact(raw.compatibility.old_recording.feedback_controls_visible, false, "evidence_compatibility_invalid", "old_recording.feedback_controls_visible");
  exactKeys(raw.compatibility.old_app, ["client_fingerprint", "client_version_fingerprint", "journey_fingerprint", "recording_fingerprint", "latest_version_id", "latest_version_no", "read_count", "revision_parent_version_id", "revision_request_count", "revision_status"], "evidence.compatibility.old_app");
  hash(raw.compatibility.old_app.client_fingerprint, "old_app.client_fingerprint");
  hash(raw.compatibility.old_app.client_version_fingerprint, "old_app.client_version_fingerprint");
  exact(hash(raw.compatibility.old_app.journey_fingerprint, "old_app.journey_fingerprint"), adopted.journeyFingerprint, "evidence_compatibility_invalid", "old_app.journey_fingerprint");
  exact(hash(raw.compatibility.old_app.recording_fingerprint, "old_app.recording_fingerprint"), adopted.recordingFingerprint, "evidence_compatibility_invalid", "old_app.recording_fingerprint");
  exact(raw.compatibility.old_app.latest_version_id, adopted.v2, "evidence_compatibility_invalid", "old_app.latest_version_id");
  count(raw.compatibility.old_app.latest_version_no, 2, "old_app.latest_version_no");
  count(raw.compatibility.old_app.read_count, 1, "old_app.read_count");
  exact(raw.compatibility.old_app.revision_parent_version_id, adopted.v2, "evidence_compatibility_invalid", "old_app.revision_parent_version_id");
  count(raw.compatibility.old_app.revision_request_count, 1, "old_app.revision_request_count");
  exact(raw.compatibility.old_app.revision_status, "queued", "evidence_compatibility_invalid", "old_app.revision_status");

  return {
    schema_version: SCHEMA_VERSION,
    candidate_commit_bound: true,
    staging_origin_bound: true,
    apk_completion_count: 2,
    journey_count: 2,
    privacy_safe: true,
  };
}

async function main() {
  const [manifestPath, evidencePath, expectedCandidateCommit, extra] = process.argv.slice(2);
  if (!manifestPath || !evidencePath || !expectedCandidateCommit || extra) throw new ArticleFeedbackLoopEvidenceError("usage_invalid");
  const [manifest, raw] = await Promise.all([
    readFile(resolve(manifestPath), "utf8").then(JSON.parse),
    readFile(resolve(evidencePath), "utf8").then(JSON.parse),
  ]);
  process.stdout.write(`${JSON.stringify(validateArticleFeedbackLoopEvidence(raw, manifest, expectedCandidateCommit))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof ArticleFeedbackLoopEvidenceError ? error.code : "evidence_read_invalid"}\n`);
    process.exitCode = 1;
  });
}
