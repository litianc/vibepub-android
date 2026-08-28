import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { validateArticleFeedbackLoopEvidence } from "../validate-article-feedback-loop-evidence.mjs";

const SHA = "a".repeat(40);
const HASH = value => `sha256:${value.repeat(64)}`;
const PAIR_HASH = value => `sha256:${value.repeat(32)}`;
const ORIGIN = "https://vibepub-api-staging.account-staging.workers.dev";
const OLD_JOURNEY = PAIR_HASH("12");
const OLD_RECORDING = PAIR_HASH("34");
const manifestFixture = JSON.parse(await readFile(new URL("../fixtures/staging-resource-manifest.synthetic.json", import.meta.url), "utf8"));

function deployManifest() {
  const manifest = structuredClone(manifestFixture);
  manifest.mode = "deploy";
  manifest.main.public_base_url = ORIGIN;
  return manifest;
}

function domainFingerprint(kind, value) {
  return `sha256:${createHash("sha256").update(`${kind}:${value}`).digest("hex")}`;
}

function validEvidence() {
  return {
    schema_version: "vibepub-article-feedback-loop-evidence.v1",
    candidate: {
      commit_sha: SHA,
      backend_commit_sha: SHA,
      actual_apk: {
        commit_sha: SHA,
        staging_origin: ORIGIN,
        apk_fingerprint: HASH("e"),
        completion_fingerprint: HASH("f"),
        completion_count: 2,
        completed_journey_fingerprints: [HASH("7"), HASH("e")],
      },
      synthetic_apk: {
        commit_sha: SHA,
        staging_origin: ORIGIN,
        apk_fingerprint: HASH("0"),
        completion_fingerprint: PAIR_HASH("ab"),
        completion_count: 2,
        completed_journey_fingerprints: [HASH("7"), HASH("e")],
      },
    },
    isolation: {
      staging_origin: ORIGIN,
      account_fingerprint: domainFingerprint("account", "account-staging"),
      resource_fingerprints: {
        main_d1: domainFingerprint("main_d1", manifestFixture.main.d1.id),
        writing_d1: domainFingerprint("writing_d1", manifestFixture.writing.d1.id),
        audio_r2: domainFingerprint("audio_r2", manifestFixture.main.files_bucket),
        image_r2: domainFingerprint("image_r2", manifestFixture.image.results_bucket),
      },
      production_data_touched: false,
    },
    device: {
      identifier_fingerprint: HASH("6"),
      journey_fingerprints: [HASH("7"), HASH("e"), OLD_JOURNEY],
      recording_fingerprints: [PAIR_HASH("cd"), PAIR_HASH("ef"), OLD_RECORDING],
    },
    journeys: {
      adopted: {
        journey_fingerprint: HASH("7"),
        recording_fingerprint: PAIR_HASH("cd"),
        five_agent_run: {
          run_fingerprint: HASH("7"),
          journey_fingerprint: HASH("7"),
          recording_fingerprint: PAIR_HASH("cd"),
          run_count: 1,
          agent_count: 5,
          completed_agent_count: 5,
          frozen_article_count: 1,
          status: "completed",
        },
        v1: {
          id: "version_adopted_v1", version_no: 1, parent_id: null,
          source_run_fingerprint: HASH("7"), recording_fingerprint: PAIR_HASH("cd"),
        },
        revision: {
          id: "revision_adopted",
          feedback_id: "feedback_continue",
          feedback_version_id: "version_adopted_v1",
          feedback_event_count: 1,
          action: "continue_revision",
          client_request_fingerprint: HASH("8"),
          original_payload_fingerprint: HASH("9"),
          replay_payload_fingerprint: HASH("9"),
          conflicting_payload_fingerprint: HASH("a"),
          parent_version_id: "version_adopted_v1",
          child_version_id: "version_adopted_v2",
          idempotency_attempt_count: 3,
          accepted_request_count: 2,
          event_count: 1,
          replay_count: 1,
          payload_conflict_count: 1,
          conflict_event_count: 0,
          stale_parent_rejection_count: 1,
          stale_parent_side_effect_count: 0,
        },
        v2: { id: "version_adopted_v2", version_no: 2, parent_id: "version_adopted_v1", child_count_for_parent: 1, current: true },
        feedback_replay: {
          id: "feedback_adopted",
          version_id: "version_adopted_v2",
          action: "adopted",
          client_request_fingerprint: HASH("b"),
          original_payload_fingerprint: HASH("c"),
          replay_payload_fingerprint: HASH("c"),
          conflicting_payload_fingerprint: HASH("d"),
          idempotency_attempt_count: 3,
          accepted_request_count: 2,
          event_count: 1,
          replay_count: 1,
          payload_conflict_count: 1,
          conflict_event_count: 0,
          stale_version_rejection_count: 1,
          stale_version_side_effect_count: 0,
        },
        wechat_recovery: {
          version_id: "version_adopted_v2",
          first_status: "wechat_failed",
          recovery_status: "completed",
          attempt_count: 2,
          draft_count: 1,
          version_count_before_recovery: 2,
          version_count_after_recovery: 2,
          recovery_version_creation_count: 0,
          recovery_asr_count: 0,
          recovery_writing_count: 0,
          recovery_review_count: 0,
          recovery_image_generation_count: 0,
          recovery_cover_generation_count: 0,
          recovery_article_pipeline_count: 0,
        },
      },
      not_adopted: {
        journey_fingerprint: HASH("e"),
        recording_fingerprint: PAIR_HASH("ef"),
        version: { id: "version_not_adopted", version_no: 1, current: true, recording_fingerprint: PAIR_HASH("ef") },
        feedback: { id: "feedback_not_adopted", version_id: "version_not_adopted", recording_fingerprint: PAIR_HASH("ef"), action: "not_adopted", event_count: 1 },
      },
    },
    compatibility: {
      old_recording: {
        journey_fingerprint: OLD_JOURNEY, recording_fingerprint: OLD_RECORDING,
        device_identifier_fingerprint: HASH("6"), apk_fingerprint: HASH("e"),
        readable: true, read_count: 1, article_version_count: 0, feedback_controls_visible: false,
      },
      old_app: {
        client_fingerprint: HASH("f"), client_version_fingerprint: HASH("0"),
        journey_fingerprint: HASH("7"), recording_fingerprint: PAIR_HASH("cd"),
        latest_version_id: "version_adopted_v2", latest_version_no: 2, read_count: 1,
        revision_parent_version_id: "version_adopted_v2", revision_request_count: 1,
        revision_status: "queued",
      },
    },
  };
}

function errorCode(value) {
  try {
    validateArticleFeedbackLoopEvidence(value, deployManifest(), SHA);
  } catch (error) {
    return error.code;
  }
  assert.fail("expected evidence validation to fail");
}

test("accepts strict redacted evidence and returns only a compact safe summary", () => {
  assert.deepEqual(validateArticleFeedbackLoopEvidence(validEvidence(), deployManifest(), SHA), {
    schema_version: "vibepub-article-feedback-loop-evidence.v1",
    candidate_commit_bound: true,
    staging_origin_bound: true,
    apk_completion_count: 2,
    journey_count: 2,
    privacy_safe: true,
  });
});

test("CLI accepts a valid file without printing trace IDs or fingerprints", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "vibepub-feedback-evidence-"));
  const evidencePath = resolve(directory, "evidence.json");
  const manifestPath = resolve(directory, "manifest.json");
  await writeFile(evidencePath, JSON.stringify(validEvidence()), "utf8");
  await writeFile(manifestPath, JSON.stringify(deployManifest()), "utf8");
  const scriptPath = new URL("../validate-article-feedback-loop-evidence.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [scriptPath.pathname, manifestPath, evidencePath, SHA], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: "vibepub-article-feedback-loop-evidence.v1",
    candidate_commit_bound: true,
    staging_origin_bound: true,
    apk_completion_count: 2,
    journey_count: 2,
    privacy_safe: true,
  });
  assert.doesNotMatch(result.stdout, /version_v|feedback_|sha256:/);
});

test("rejects any candidate commit mismatch", () => {
  for (const mutate of [
    value => { value.candidate.backend_commit_sha = "b".repeat(40); },
    value => { value.candidate.actual_apk.commit_sha = "b".repeat(40); },
    value => { value.candidate.synthetic_apk.commit_sha = "b".repeat(40); },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.equal(errorCode(evidence), "evidence_commit_mismatch");
  }

  assert.throws(
    () => validateArticleFeedbackLoopEvidence(validEvidence(), deployManifest(), "b".repeat(40)),
    error => error.code === "evidence_commit_mismatch",
  );
  assert.throws(
    () => validateArticleFeedbackLoopEvidence(validEvidence(), deployManifest()),
    error => error.code === "evidence_commit_invalid",
  );
});

test("binds isolation fingerprints to the protected Staging manifest", () => {
  for (const path of ["account_fingerprint", "main_d1", "writing_d1", "audio_r2", "image_r2"]) {
    const evidence = validEvidence();
    if (path === "account_fingerprint") evidence.isolation[path] = HASH("1");
    else evidence.isolation.resource_fingerprints[path] = HASH("1");
    assert.equal(errorCode(evidence), "evidence_isolation_binding_invalid");
  }
});

test("requires distinct APK artifacts and independent completion attestations", () => {
  const sameApk = validEvidence();
  sameApk.candidate.synthetic_apk.apk_fingerprint = sameApk.candidate.actual_apk.apk_fingerprint;
  assert.equal(errorCode(sameApk), "evidence_apk_attestation_invalid");

  const sameCompletion = validEvidence();
  sameCompletion.candidate.synthetic_apk.completion_fingerprint = sameCompletion.candidate.actual_apk.completion_fingerprint;
  assert.equal(errorCode(sameCompletion), "evidence_apk_attestation_invalid");
});

test("rejects production, non-HTTPS, and mismatched Staging origins", () => {
  const production = validEvidence();
  production.candidate.actual_apk.staging_origin = "https://vibepub.litianc.cn";
  assert.equal(errorCode(production), "evidence_origin_mismatch");

  const insecure = validEvidence();
  insecure.isolation.staging_origin = "http://vibepub-api-staging.example.test";
  assert.equal(errorCode(insecure), "evidence_origin_invalid");

  const mismatch = validEvidence();
  mismatch.candidate.synthetic_apk.staging_origin = "https://other-staging.account-staging.workers.dev";
  assert.equal(errorCode(mismatch), "evidence_origin_mismatch");

  const wrongManifest = deployManifest();
  wrongManifest.main.public_base_url = "https://vibepub-api-staging.other-staging.workers.dev";
  assert.throws(
    () => validateArticleFeedbackLoopEvidence(validEvidence(), wrongManifest, SHA),
    error => error.code === "evidence_origin_mismatch",
  );
});

test("rejects broken version lineage and evidence counts", () => {
  for (const mutate of [
    value => { value.journeys.adopted.v2.parent_id = "version_not_adopted"; },
    value => { value.journeys.adopted.revision.child_version_id = "version_not_adopted"; },
    value => { value.journeys.adopted.v2.child_count_for_parent = 2; },
    value => { value.journeys.adopted.revision.event_count = 2; },
    value => { value.journeys.adopted.revision.idempotency_attempt_count = 2; },
    value => { value.journeys.adopted.feedback_replay.conflict_event_count = 1; },
    value => { value.journeys.adopted.wechat_recovery.version_count_after_recovery = 3; },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.match(errorCode(evidence), /^evidence_(?:lineage|count)_invalid$/);
  }
});

test("binds both APK completions, five Agents, and v1 to the same journeys", () => {
  for (const mutate of [
    value => { value.candidate.actual_apk.completed_journey_fingerprints[0] = HASH("f"); },
    value => { value.journeys.adopted.five_agent_run.journey_fingerprint = HASH("f"); },
    value => { value.journeys.adopted.v1.source_run_fingerprint = HASH("f"); },
    value => { value.device.journey_fingerprints[0] = HASH("f"); },
    value => { value.device.recording_fingerprints[0] = HASH("f"); },
    value => { value.journeys.adopted.five_agent_run.recording_fingerprint = HASH("f"); },
    value => { value.journeys.adopted.v1.recording_fingerprint = HASH("f"); },
    value => { value.journeys.not_adopted.version.recording_fingerprint = HASH("f"); },
    value => { value.journeys.not_adopted.feedback.recording_fingerprint = HASH("f"); },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.equal(errorCode(evidence), "evidence_journey_binding_invalid");
  }
});

test("binds the continue feedback event to v1 before creating v2", () => {
  for (const mutate of [
    value => { value.journeys.adopted.revision.feedback_id = "feedback_adopted"; },
    value => { value.journeys.adopted.revision.feedback_version_id = "version_adopted_v2"; },
    value => { value.journeys.adopted.revision.feedback_event_count = 0; },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.match(errorCode(evidence), /^evidence_(?:feedback|lineage|count)_invalid$/);
  }
});

test("proves WeChat recovery reruns no article pipeline stage", () => {
  for (const field of [
    "recovery_asr_count", "recovery_writing_count", "recovery_review_count",
    "recovery_image_generation_count", "recovery_cover_generation_count",
    "recovery_article_pipeline_count",
  ]) {
    const evidence = validEvidence();
    evidence.journeys.adopted.wechat_recovery[field] = 1;
    assert.equal(errorCode(evidence), "evidence_count_invalid");
  }
});

test("requires stale feedback rejection and complete old-client compatibility", () => {
  const staleFeedback = validEvidence();
  staleFeedback.journeys.adopted.feedback_replay.stale_version_rejection_count = 0;
  assert.equal(errorCode(staleFeedback), "evidence_count_invalid");

  const oldRecording = validEvidence();
  oldRecording.compatibility.old_recording.article_version_count = 1;
  assert.equal(errorCode(oldRecording), "evidence_compatibility_invalid");

  for (const mutate of [
    value => { value.compatibility.old_recording.journey_fingerprint = HASH("f"); },
    value => { value.compatibility.old_recording.recording_fingerprint = HASH("f"); },
    value => { value.compatibility.old_recording.device_identifier_fingerprint = HASH("f"); },
    value => { value.compatibility.old_recording.apk_fingerprint = HASH("f"); },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.match(errorCode(evidence), /^evidence_(?:compatibility|journey_binding)_invalid$/);
  }

  const oldApp = validEvidence();
  oldApp.compatibility.old_app.revision_parent_version_id = "version_adopted_v1";
  assert.equal(errorCode(oldApp), "evidence_compatibility_invalid");

  for (const mutate of [
    value => { value.compatibility.old_app.client_fingerprint = "old-app"; },
    value => { value.compatibility.old_app.client_version_fingerprint = "1.0"; },
    value => { value.compatibility.old_app.journey_fingerprint = HASH("e"); },
    value => { value.compatibility.old_app.recording_fingerprint = PAIR_HASH("ef"); },
    value => { value.compatibility.old_app.revision_status = "completed"; },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.match(errorCode(evidence), /^evidence_(?:fingerprint|compatibility)_invalid$/);
  }
});

test("rejects inexact replays and a conflict carrying the original payload", () => {
  const inexactReplay = validEvidence();
  inexactReplay.journeys.adopted.revision.replay_payload_fingerprint = HASH("e");
  assert.equal(errorCode(inexactReplay), "evidence_replay_invalid");

  const unchangedConflict = validEvidence();
  unchangedConflict.journeys.adopted.feedback_replay.conflicting_payload_fingerprint =
    unchangedConflict.journeys.adopted.feedback_replay.original_payload_fingerprint;
  assert.equal(errorCode(unchangedConflict), "evidence_replay_invalid");
});

test("rejects a missing adopted or not-adopted path", () => {
  for (const path of ["adopted", "not_adopted"]) {
    const evidence = validEvidence();
    delete evidence.journeys[path];
    assert.equal(errorCode(evidence), "evidence_shape_invalid");
  }
});

test("requires the not-adopted journey to be separate", () => {
  const sharedVersion = validEvidence();
  sharedVersion.journeys.not_adopted.version.id = sharedVersion.journeys.adopted.v2.id;
  sharedVersion.journeys.not_adopted.feedback.version_id = sharedVersion.journeys.adopted.v2.id;
  assert.equal(errorCode(sharedVersion), "evidence_journey_separation_invalid");

  const sharedEvent = validEvidence();
  sharedEvent.journeys.not_adopted.feedback.id = sharedEvent.journeys.adopted.feedback_replay.id;
  assert.equal(errorCode(sharedEvent), "evidence_journey_separation_invalid");
});

test("rejects any attestation that production data was touched", () => {
  const evidence = validEvidence();
  evidence.isolation.production_data_touched = true;
  assert.equal(errorCode(evidence), "evidence_production_touched");
});

test("rejects privacy leaks before reporting any leaked value", async () => {
  const leaks = [
    value => { value.device.raw_serial = "192.168.1.2:5555"; },
    value => { value.ordinary_user_email = "person@example.com"; },
    value => { value.journeys.adopted.full_article_body = "private article text"; },
    value => { value.access_token = "Bearer secret-value"; },
  ];
  for (const mutate of leaks) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.equal(errorCode(evidence), "evidence_privacy_violation");
  }

  const directory = await mkdtemp(resolve(tmpdir(), "vibepub-feedback-evidence-leak-"));
  const evidencePath = resolve(directory, "evidence.json");
  const manifestPath = resolve(directory, "manifest.json");
  const leaked = validEvidence();
  leaked.ordinary_user_email = "person@example.com";
  await writeFile(evidencePath, JSON.stringify(leaked), "utf8");
  await writeFile(manifestPath, JSON.stringify(deployManifest()), "utf8");
  const scriptPath = new URL("../validate-article-feedback-loop-evidence.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [scriptPath.pathname, manifestPath, evidencePath, SHA], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "evidence_privacy_violation\n");
});

test("fails closed on malformed evidence and arbitrary extra keys", () => {
  assert.equal(errorCode(null), "evidence_shape_invalid");

  const extra = validEvidence();
  extra.device.note = "harmless-but-unsupported";
  assert.equal(errorCode(extra), "evidence_shape_invalid");

  const malformedFingerprint = validEvidence();
  malformedFingerprint.device.identifier_fingerprint = "device-123";
  assert.equal(errorCode(malformedFingerprint), "evidence_fingerprint_invalid");

  const rawResourceId = validEvidence();
  rawResourceId.isolation.resource_fingerprints.main_d1 = "11111111-1111-4111-8111-111111111111";
  assert.equal(errorCode(rawResourceId), "evidence_fingerprint_invalid");

  const rawTraceId = validEvidence();
  rawTraceId.journeys.adopted.revision.id = "revision_123e4567-e89b-12d3-a456-426614174000";
  assert.equal(errorCode(rawTraceId), "evidence_identifier_invalid");
});
