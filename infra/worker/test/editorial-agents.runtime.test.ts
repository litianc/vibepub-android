import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleEditorialOrchestrationInternalRoute } from "../src/editorialAgents";
import { canonicalJson } from "../src/editorialContracts";

const workerEnv = env as any;

beforeAll(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(`CREATE TABLE IF NOT EXISTS editorial_recording_scopes (
      recording_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY (recording_id, user_id, workspace_id),
      UNIQUE (recording_id, user_id)
    )`),
    workerEnv.DB.prepare(`CREATE TABLE IF NOT EXISTS editorial_runs (
      run_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      agent_versions_json TEXT NOT NULL,
      skill_pins_json TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, workspace_id, article_id, idempotency_key)
    )`),
    workerEnv.DB.prepare(`CREATE TABLE IF NOT EXISTS editorial_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      recording_id INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      producer_agent_role TEXT NOT NULL,
      producer_agent_version TEXT NOT NULL,
      skill_id TEXT,
      skill_version TEXT,
      workflow_version TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      input_artifact_ids_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, kind, payload_hash)
    )`),
    workerEnv.DB.prepare(`CREATE TRIGGER IF NOT EXISTS editorial_runs_append_only_update
      BEFORE UPDATE ON editorial_runs
      WHEN NEW.run_id <> OLD.run_id OR NEW.user_id <> OLD.user_id OR NEW.workspace_id <> OLD.workspace_id
        OR NEW.article_id <> OLD.article_id OR NEW.recording_id <> OLD.recording_id
        OR NEW.schema_version <> OLD.schema_version OR NEW.workflow_version <> OLD.workflow_version
        OR NEW.policy_version <> OLD.policy_version OR NEW.agent_versions_json <> OLD.agent_versions_json
        OR NEW.skill_pins_json <> OLD.skill_pins_json OR NEW.idempotency_key <> OLD.idempotency_key
        OR NEW.payload_hash <> OLD.payload_hash OR NEW.created_at <> OLD.created_at
        OR NEW.updated_at <= OLD.updated_at
        OR NOT (NEW.status = OLD.status OR (OLD.status IN ('planned', 'running') AND NEW.status IN ('completed', 'failed')))
      BEGIN SELECT RAISE(ABORT, 'editorial_runs_projection_update_invalid'); END`),
    workerEnv.DB.prepare(`CREATE TRIGGER IF NOT EXISTS editorial_runs_append_only_delete
      BEFORE DELETE ON editorial_runs BEGIN SELECT RAISE(ABORT, 'editorial_runs_append_only'); END`),
    workerEnv.DB.prepare(`CREATE TRIGGER IF NOT EXISTS editorial_artifacts_append_only_update
      BEFORE UPDATE ON editorial_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_artifacts_append_only'); END`),
    workerEnv.DB.prepare(`CREATE TRIGGER IF NOT EXISTS editorial_artifacts_append_only_delete
      BEFORE DELETE ON editorial_artifacts BEGIN SELECT RAISE(ABORT, 'editorial_artifacts_append_only'); END`),
    workerEnv.DB.prepare(`INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
      VALUES (91, 'user_runtime_a', 'workspace_runtime_a')`),
    workerEnv.DB.prepare(`INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
      VALUES (92, 'user_runtime_a', 'workspace_runtime_a')`),
  ]);
});

async function payloadHash(payload: unknown): Promise<string> {
  const canonical = canonicalJson(payload);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function start(stub: any, runId: string, scenario: string) {
  const payload = {
    run_id: runId,
    article_id: "article_runtime_synthetic",
    recording_id: 91,
    user_id: "user_runtime_a",
    workspace_id: "workspace_runtime_a",
    scenario,
  };
  return stub.startRun({ ...payload, payload_hash: await payloadHash(payload) });
}

async function waitForState(stub: any, runId: string, expected: string): Promise<any> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const run = await stub.getRun(runId);
    if (run.state === expected) return run;
    if (run.state === "failed") throw new Error(`runtime workflow failed before ${expected}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${expected}`);
}

describe("editorial Agent + Workflow runtime", () => {
  it("shards by ownership, reaches durable human wait, resumes, and is idempotent", async () => {
    const first = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-shard-a");
    const second = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-shard-b");
    const run = await start(first, "runtime-happy", "happy");
    expect(run.state).toBe("queued");
    const waiting = await waitForState(first, "runtime-happy", "awaiting_human_confirmation");
    expect(waiting.approval_state).toBe("awaiting");
    expect(waiting.artifact_count).toBe(6);
    expect(waiting.d1_mirrored_artifact_count).toBe(6);
    expect(waiting.do_receipt_count).toBe(6);
    expect(waiting.outbox_pending_count).toBe(0);
    expect(waiting.workflow_id).toBeTruthy();
    const duplicateStart = await start(first, "runtime-happy", "happy");
    expect(duplicateStart.replayed).toBe(true);
    await evictDurableObject(first);
    const afterEviction = await first.getRun("runtime-happy");
    expect(afterEviction.state).toBe("awaiting_human_confirmation");

    const actionPayload = { action: "approve", reason: null };
    const action = await first.recordHumanAction({
      run_id: "runtime-happy",
      action: "approve",
      idempotency_key: "runtime-approve-1",
      payload_hash: await payloadHash(actionPayload),
      workflow_id: waiting.workflow_id,
    });
    expect(action.approval_state).toBe("approved");
    const competing = await first.recordHumanAction({
      run_id: "runtime-happy",
      action: "reject",
      idempotency_key: "runtime-reject-race",
      payload_hash: await payloadHash({ action: "reject", reason: null }),
      workflow_id: waiting.workflow_id,
    });
    expect(competing.ignored).toBe(true);
    const replay = await first.recordHumanAction({
      run_id: "runtime-happy",
      action: "approve",
      idempotency_key: "runtime-approve-1",
      payload_hash: await payloadHash(actionPayload),
      workflow_id: waiting.workflow_id,
    });
    expect(replay.replayed).toBe(true);
    const approved = await waitForState(first, "runtime-happy", "approved_for_phase3");
    expect(approved.artifact_count).toBe(6);
    const completedRun = await workerEnv.DB.prepare(
      "SELECT status FROM editorial_runs WHERE run_id = ?",
    ).bind("runtime-happy").first();
    expect(completedRun).toEqual({ status: "completed" });
    const appendOnly = await runInDurableObject(first, (_instance, state) => {
      const artifactId = state.storage.sql.exec<{ artifact_id: string }>("SELECT artifact_id FROM editorial_phase2_artifacts LIMIT 1").one().artifact_id;
      const stepKey = state.storage.sql.exec<{ step_key: string }>("SELECT step_key FROM editorial_phase2_steps LIMIT 1").one().step_key;
      const actionId = state.storage.sql.exec<{ action_id: string }>("SELECT action_id FROM editorial_phase2_human_actions LIMIT 1").one().action_id;
      const intentId = state.storage.sql.exec<{ intent_id: string }>("SELECT intent_id FROM editorial_phase2_terminal_intents LIMIT 1").one().intent_id;
      const receiptId = state.storage.sql.exec<{ intent_id: string }>("SELECT intent_id FROM editorial_phase2_terminal_receipts LIMIT 1").one().intent_id;
      let updateRejected = false;
      let deleteRejected = false;
      try {
        state.storage.sql.exec("UPDATE editorial_phase2_artifacts SET summary_json = '{}' WHERE artifact_id = ?", artifactId);
      } catch {
        updateRejected = true;
      }
      try {
        state.storage.sql.exec("DELETE FROM editorial_phase2_artifacts WHERE artifact_id = ?", artifactId);
      } catch {
        deleteRejected = true;
      }
      let stepUpdateRejected = false;
      let stepDeleteRejected = false;
      try {
        state.storage.sql.exec("UPDATE editorial_phase2_steps SET result_json = '{}' WHERE step_key = ?", stepKey);
      } catch {
        stepUpdateRejected = true;
      }
      try {
        state.storage.sql.exec("DELETE FROM editorial_phase2_steps WHERE step_key = ?", stepKey);
      } catch {
        stepDeleteRejected = true;
      }
      let actionUpdateRejected = false;
      let actionDeleteRejected = false;
      try {
        state.storage.sql.exec("UPDATE editorial_phase2_human_actions SET result_json = '{}' WHERE action_id = ?", actionId);
      } catch {
        actionUpdateRejected = true;
      }
      try {
        state.storage.sql.exec("DELETE FROM editorial_phase2_human_actions WHERE action_id = ?", actionId);
      } catch {
        actionDeleteRejected = true;
      }
      let intentUpdateRejected = false;
      let intentDeleteRejected = false;
      try {
        state.storage.sql.exec("UPDATE editorial_phase2_terminal_intents SET payload_hash = 'changed' WHERE intent_id = ?", intentId);
      } catch {
        intentUpdateRejected = true;
      }
      try {
        state.storage.sql.exec("DELETE FROM editorial_phase2_terminal_intents WHERE intent_id = ?", intentId);
      } catch {
        intentDeleteRejected = true;
      }
      let receiptUpdateRejected = false;
      let receiptDeleteRejected = false;
      try {
        state.storage.sql.exec("UPDATE editorial_phase2_terminal_receipts SET d1_status = 'failed' WHERE intent_id = ?", receiptId);
      } catch {
        receiptUpdateRejected = true;
      }
      try {
        state.storage.sql.exec("DELETE FROM editorial_phase2_terminal_receipts WHERE intent_id = ?", receiptId);
      } catch {
        receiptDeleteRejected = true;
      }
      const counts = state.storage.sql.exec<{ steps: number; actions: number; intents: number; receipts: number }>(
        "SELECT (SELECT count(*) FROM editorial_phase2_steps) AS steps, (SELECT count(*) FROM editorial_phase2_human_actions) AS actions, (SELECT count(*) FROM editorial_phase2_terminal_intents) AS intents, (SELECT count(*) FROM editorial_phase2_terminal_receipts) AS receipts",
      ).one();
      return { updateRejected, deleteRejected, stepUpdateRejected, stepDeleteRejected, actionUpdateRejected, actionDeleteRejected, intentUpdateRejected, intentDeleteRejected, receiptUpdateRejected, receiptDeleteRejected, counts };
    });
    expect(appendOnly).toEqual({
      updateRejected: true,
      deleteRejected: true,
      stepUpdateRejected: true,
      stepDeleteRejected: true,
      actionUpdateRejected: true,
      actionDeleteRejected: true,
      intentUpdateRejected: true,
      intentDeleteRejected: true,
      receiptUpdateRejected: true,
      receiptDeleteRejected: true,
      counts: { steps: 6, actions: 1, intents: 1, receipts: 1 },
    });
    const d1Run = await workerEnv.DB.prepare(
      "SELECT count(*) AS count FROM editorial_runs WHERE run_id = ? AND user_id = ? AND workspace_id = ?",
    ).bind("runtime-happy", "user_runtime_a", "workspace_runtime_a").first();
    const d1Artifacts = await workerEnv.DB.prepare(
      "SELECT count(*) AS count, count(DISTINCT artifact_id) AS unique_count, count(DISTINCT payload_hash) AS hash_count FROM editorial_artifacts WHERE run_id = ? AND user_id = ? AND workspace_id = ?",
    ).bind("runtime-happy", "user_runtime_a", "workspace_runtime_a").first();
    expect(d1Run).toEqual({ count: 1 });
    expect(d1Artifacts).toEqual({ count: 6, unique_count: 6, hash_count: 6 });
    const doMetadata = await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{
      artifact_id: string;
      payload_hash: string;
      user_id: string;
      workspace_id: string;
      article_id: string;
      recording_id: number;
    }>(
      "SELECT artifact_id, payload_hash, user_id, workspace_id, article_id, recording_id FROM editorial_phase2_outbox WHERE run_id = ? ORDER BY artifact_id",
      "runtime-happy",
    ).toArray());
    const d1Metadata = await workerEnv.DB.prepare(
      "SELECT artifact_id, payload_hash, user_id, workspace_id, article_id, recording_id FROM editorial_artifacts WHERE run_id = ? ORDER BY artifact_id",
    ).bind("runtime-happy").all();
    expect(d1Metadata.results).toEqual(doMetadata);
    const crossTenantRows = await runInDurableObject(second, (_instance, state) => {
      try {
        return state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_runs").one().count;
      } catch (error) {
        if (String(error).includes("no such table")) return 0;
        throw error;
      }
    });
    expect(crossTenantRows).toBe(0);

    const fixedAgents = [
      [workerEnv.EDITORIAL_WRITING, "writing"],
      [workerEnv.EDITORIAL_REVIEW, "editorial_review"],
      [workerEnv.EDITORIAL_ILLUSTRATION, "illustration"],
      [workerEnv.EDITORIAL_COVER, "cover"],
    ] as const;
    for (const [namespace, role] of fixedAgents) {
      expect(await namespace.getByName(`runtime-agent-${role}`).runtimeIdentity()).toMatchObject({ role });
    }
  });

  it("keeps P0 blocked and allows exactly one P1 revision", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-review-cases");
    const p0 = await start(coordinator, "runtime-p0", "p0");
    expect(p0.state).toBe("queued");
    const p0Failed = await waitForState(coordinator, "runtime-p0", "failed");
    expect(p0Failed.approval_state).toBe("human_action_required");
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind("runtime-p0").first()).toEqual({ status: "failed" });

    const p1 = await start(coordinator, "runtime-p1", "p1_once");
    expect(p1.state).toBe("queued");
    const p1Waiting = await waitForState(coordinator, "runtime-p1", "awaiting_human_confirmation");
    expect(p1Waiting.revision_count).toBe(1);
    expect(p1Waiting.artifact_count).toBe(8);

    const unknownVersionRejected = await runInDurableObject(coordinator, async (instance: any) => {
      try {
        await instance.commitWorkflowStep({
        run_id: "runtime-p1",
        step_name: "unknown-version",
        step_key: "runtime-p1:unknown-version",
        expected_state: "awaiting_human_confirmation",
        next_state: "awaiting_human_confirmation",
        artifacts: [{
          kind: "review_report",
          idempotency_key: "runtime-p1:unknown-version",
          producer_role: "editorial_review",
          producer_version: "editorial-review.agent.999",
          summary: { decision: "pass" },
        }],
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(unknownVersionRejected).toBe(true);

    const unknownArtifactRejected = await runInDurableObject(coordinator, async (instance: any) => {
      try {
        await instance.commitWorkflowStep({
          run_id: "runtime-p1",
          step_name: "unknown-artifact",
          step_key: "runtime-p1:unknown-artifact",
          expected_state: "awaiting_human_confirmation",
          next_state: "awaiting_human_confirmation",
          artifacts: [{
            kind: "arbitrary_payload",
            idempotency_key: "runtime-p1:unknown-artifact",
            producer_role: "editorial_review",
            producer_version: "editorial-review.agent.v2",
            summary: { decision: "pass" },
          }],
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(unknownArtifactRejected).toBe(true);

    const secondFailure = await start(coordinator, "runtime-p1-second-failure", "p1_second_failure");
    expect(secondFailure.state).toBe("queued");
    const failed = await waitForState(coordinator, "runtime-p1-second-failure", "failed");
    expect(failed.approval_state).toBe("human_action_required");
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind("runtime-p1-second-failure").first()).toEqual({ status: "failed" });
  });

  it("rejects human actions outside the durable confirmation state", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-invalid-human-actions");
    const runId = "runtime-invalid-human-actions";
    const initialized = await runInDurableObject(coordinator, async instance => {
      try {
        await instance.getRun(runId);
        return "unexpected_success";
      } catch (error) {
        return (error as { code?: string }).code || "unknown_error";
      }
    });
    expect(initialized).toBe("run_not_found");
    await runInDurableObject(coordinator, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'not_required', 0, ?, ?)`,
        runId,
        "article_invalid_human_actions",
        91,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:invalid-human-actions",
        JSON.stringify({ schema_version: "editorial-orchestration.v2" }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    const actionInput = (action: "wait" | "approve" | "reject" | "timeout", key: string) => ({
      run_id: runId,
      action,
      idempotency_key: key,
      payload_hash: `sha256:${key}`,
      workflow_id: "",
    });
    for (const [state, revision] of [["queued", 0], ["reviewed", 1], ["content_frozen", 2]] as const) {
      await runInDurableObject(coordinator, (_instance, storage) => {
        storage.storage.sql.exec("UPDATE editorial_phase2_runs SET state = ?, state_revision = ? WHERE run_id = ?", state, revision, runId);
      });
      const waitCode = await runInDurableObject(coordinator, async instance => {
        try {
          await instance.recordHumanAction(actionInput("wait", `wait-${state}`));
          return "unexpected_success";
        } catch (error) {
          return (error as { code?: string }).code || "unknown_error";
        }
      });
      const approveCode = await runInDurableObject(coordinator, async instance => {
        try {
          await instance.recordHumanAction(actionInput("approve", `approve-${state}`));
          return "unexpected_success";
        } catch (error) {
          return (error as { code?: string }).code || "unknown_error";
        }
      });
      expect(waitCode).toBe("human_action_not_ready");
      expect(approveCode).toBe("human_action_not_ready");
    }
    const rows = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM editorial_phase2_human_actions WHERE run_id = ?",
      runId,
    ).one().count);
    expect(rows).toBe(0);
  });

  it("keeps the DO state and outbox pending across a D1 failure, then reconciles once", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-d1-recovery");
    const runId = "runtime-d1-recovery";
    await runInDurableObject(coordinator, async instance => {
      try {
        await instance.getRun(runId);
      } catch {
        // getRun initializes the fresh DO schema.
      }
    });
    await workerEnv.DB.prepare(`CREATE TRIGGER IF NOT EXISTS editorial_phase2_synthetic_d1_failure
      BEFORE INSERT ON editorial_artifacts WHEN NEW.run_id = 'runtime-d1-recovery'
      BEGIN SELECT RAISE(ABORT, 'synthetic D1 write failure'); END`).run();
    const failed = await runInDurableObject(coordinator, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'not_required', 0, ?, ?)`,
        runId,
        "article_d1_recovery",
        92,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:d1-recovery",
        JSON.stringify({
          schema_version: "editorial-orchestration.v2",
          agent_versions: { editorial_coordinator: "editorial-coordinator.agent.v2" },
          skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
        }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
      try {
        await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "draft-v1",
          step_key: `${runId}:draft-v1`,
          expected_state: "queued",
          next_state: "draft_generated",
          artifacts: [{
            kind: "article_draft",
            idempotency_key: `${runId}:draft:v1`,
            producer_role: "writing",
            producer_version: "writing.agent.v2",
            summary: { source: "synthetic", version_no: 1, block_ids: ["block_1"] },
          }],
        });
        return { code: "unexpected_success" };
      } catch (error) {
        const stateRow = state.storage.sql.exec<{ state: string }>("SELECT state FROM editorial_phase2_runs WHERE run_id = ?", runId).one();
        const counts = state.storage.sql.exec<{ outbox: number; receipts: number; steps: number }>(
          `SELECT
             (SELECT count(*) FROM editorial_phase2_outbox WHERE run_id = ?) AS outbox,
             (SELECT count(*) FROM editorial_phase2_outbox_receipts WHERE outbox_id IN (SELECT outbox_id FROM editorial_phase2_outbox WHERE run_id = ?)) AS receipts,
             (SELECT count(*) FROM editorial_phase2_steps WHERE run_id = ?) AS steps`,
          runId,
          runId,
          runId,
        ).one();
        return { code: (error as { code?: string }).code, state: stateRow.state, counts };
      }
    });
    expect(failed).toEqual({ code: "editorial_d1_mirror_unavailable", state: "queued", counts: { outbox: 1, receipts: 0, steps: 1 } });
    await workerEnv.DB.prepare("DROP TRIGGER editorial_phase2_synthetic_d1_failure").run();

    const recovered = await runInDurableObject(coordinator, async (instance, state) => {
      const result = await instance.commitWorkflowStep({
        run_id: runId,
        step_name: "draft-v1",
        step_key: `${runId}:draft-v1`,
        expected_state: "queued",
        next_state: "draft_generated",
        artifacts: [{
          kind: "article_draft",
          idempotency_key: `${runId}:draft:v1`,
          producer_role: "writing",
          producer_version: "writing.agent.v2",
          summary: { source: "synthetic", version_no: 1, block_ids: ["block_1"] },
        }],
      });
      const counts = state.storage.sql.exec<{ outbox: number; receipts: number }>(
        `SELECT
           (SELECT count(*) FROM editorial_phase2_outbox WHERE run_id = ?) AS outbox,
           (SELECT count(*) FROM editorial_phase2_outbox_receipts WHERE outbox_id IN (SELECT outbox_id FROM editorial_phase2_outbox WHERE run_id = ?)) AS receipts`,
        runId,
        runId,
      ).one();
      return { result, counts };
    });
    expect(recovered.result.state).toBe("draft_generated");
    expect(recovered.result.replayed).toBe(false);
    expect(recovered.counts).toEqual({ outbox: 1, receipts: 1 });
    const replay = await runInDurableObject(coordinator, async instance => instance.commitWorkflowStep({
      run_id: runId,
      step_name: "draft-v1",
      step_key: `${runId}:draft-v1`,
      expected_state: "queued",
      next_state: "draft_generated",
      artifacts: [{
        kind: "article_draft",
        idempotency_key: `${runId}:draft:v1`,
        producer_role: "writing",
        producer_version: "writing.agent.v2",
        summary: { source: "synthetic", version_no: 1, block_ids: ["block_1"] },
      }],
    }));
    expect(replay.replayed).toBe(true);
    const conflict = await runInDurableObject(coordinator, async instance => {
      try {
        await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "draft-v1",
          step_key: `${runId}:draft-v1`,
          expected_state: "queued",
          next_state: "draft_generated",
          artifacts: [{
            kind: "article_draft",
            idempotency_key: `${runId}:draft:v1`,
            producer_role: "writing",
            producer_version: "writing.agent.v2",
            summary: { source: "different-payload", version_no: 1, block_ids: ["block_1"] },
          }],
        });
        return "unexpected_success";
      } catch (error) {
        return (error as { code?: string }).code || "unknown_error";
      }
    });
    expect(conflict).toBe("idempotency_conflict");
    const d1Counts = await workerEnv.DB.prepare(
      "SELECT (SELECT count(*) FROM editorial_runs WHERE run_id = ?) AS runs, (SELECT count(*) FROM editorial_artifacts WHERE run_id = ?) AS artifacts",
    ).bind(runId, runId).first();
    expect(d1Counts).toEqual({ runs: 1, artifacts: 1 });
  });

  it("recovers a terminal D1 status after the DO receipt/CAS is interrupted", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-terminal-recovery");
    const runId = "runtime-terminal-recovery";
    await runInDurableObject(coordinator, async instance => {
      try {
        await instance.getRun(runId);
      } catch {
        // getRun initializes the fresh DO schema.
      }
    });
    const manifest = JSON.stringify({
      schema_version: "editorial-orchestration.v2",
      agent_versions: { editorial_coordinator: "editorial-coordinator.agent.v2" },
      skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
    });
    await runInDurableObject(coordinator, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'human_action_required', 0, ?, ?)`,
        runId,
        "article_terminal_recovery",
        92,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:terminal-recovery",
        manifest,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    const failed = await runInDurableObject(coordinator, async (instance, state) => {
      (instance as any).failAfterTerminalMirrorOnce = true;
      try {
        await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "terminal-failure",
          step_key: `${runId}:terminal-failure`,
          expected_state: "queued",
          next_state: "failed",
          approval_state: "human_action_required",
          terminal_status: "failed",
          artifacts: [],
        });
        return { code: "unexpected_success" };
      } catch (error) {
        return {
          code: (error as { code?: string }).code,
          state: state.storage.sql.exec<{ state: string }>("SELECT state FROM editorial_phase2_runs WHERE run_id = ?", runId).one().state,
          intents: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_terminal_intents WHERE run_id = ?", runId).one().count,
          receipts: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_terminal_receipts WHERE intent_id IN (SELECT intent_id FROM editorial_phase2_terminal_intents WHERE run_id = ?)", runId).one().count,
          events: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_events WHERE run_id = ?", runId).one().count,
        };
      }
    });
    expect(failed).toEqual({ code: "editorial_terminal_receipt_unavailable", state: "queued", intents: 1, receipts: 0, events: 0 });
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind(runId).first()).toEqual({ status: "failed" });

    const recovered = await runInDurableObject(coordinator, async instance => instance.commitWorkflowStep({
      run_id: runId,
      step_name: "terminal-failure",
      step_key: `${runId}:terminal-failure`,
      expected_state: "queued",
      next_state: "failed",
      approval_state: "human_action_required",
      terminal_status: "failed",
      artifacts: [],
    }));
    expect(recovered).toMatchObject({ state: "failed", replayed: false, terminal_status: "failed" });
    const terminalCounts = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{ intents: number; receipts: number; events: number; state: string }>(
      `SELECT
         (SELECT count(*) FROM editorial_phase2_terminal_intents WHERE run_id = ?) AS intents,
         (SELECT count(*) FROM editorial_phase2_terminal_receipts WHERE intent_id IN (SELECT intent_id FROM editorial_phase2_terminal_intents WHERE run_id = ?)) AS receipts,
         (SELECT count(*) FROM editorial_phase2_events WHERE run_id = ?) AS events,
         (SELECT state FROM editorial_phase2_runs WHERE run_id = ?) AS state`,
      runId,
      runId,
      runId,
      runId,
    ).one());
    expect(terminalCounts).toEqual({ intents: 1, receipts: 1, events: 1, state: "failed" });
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind(runId).first()).toEqual({ status: "failed" });
  });

  it("replays reject signals and mirrors reject/timeout as failed terminals", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-human-terminals");
    await start(coordinator, "runtime-human-reject", "happy");
    const rejectWaiting = await waitForState(coordinator, "runtime-human-reject", "awaiting_human_confirmation");
    const rejectPayload = { action: "reject", reason: null };
    const signalFailed = await runInDurableObject(coordinator, async instance => {
      const original = (instance as any).rejectWorkflow;
      (instance as any).rejectWorkflow = async () => { throw new Error("synthetic signal failure"); };
      try {
        await instance.recordHumanAction({
          run_id: "runtime-human-reject",
          action: "reject",
          idempotency_key: "runtime-human-reject-1",
          payload_hash: await payloadHash(rejectPayload),
          workflow_id: rejectWaiting.workflow_id,
        });
        return false;
      } catch {
        return true;
      } finally {
        (instance as any).rejectWorkflow = original;
      }
    });
    expect(signalFailed).toBe(true);
    const persistedAction = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{ actions: number; state: string; approval_state: string }>(
      `SELECT
         (SELECT count(*) FROM editorial_phase2_human_actions WHERE run_id = ?) AS actions,
         (SELECT state FROM editorial_phase2_runs WHERE run_id = ?) AS state,
         (SELECT approval_state FROM editorial_phase2_runs WHERE run_id = ?) AS approval_state`,
      "runtime-human-reject",
      "runtime-human-reject",
      "runtime-human-reject",
    ).one());
    expect(persistedAction).toEqual({ actions: 1, state: "awaiting_human_confirmation", approval_state: "rejected" });
    const replay = await coordinator.recordHumanAction({
      run_id: "runtime-human-reject",
      action: "reject",
      idempotency_key: "runtime-human-reject-1",
      payload_hash: await payloadHash(rejectPayload),
      workflow_id: rejectWaiting.workflow_id,
    });
    expect(replay.replayed).toBe(true);
    await waitForState(coordinator, "runtime-human-reject", "failed");
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind("runtime-human-reject").first()).toEqual({ status: "failed" });

    await start(coordinator, "runtime-human-timeout", "happy");
    const timeoutWaiting = await waitForState(coordinator, "runtime-human-timeout", "awaiting_human_confirmation");
    const timeout = await coordinator.recordHumanAction({
      run_id: "runtime-human-timeout",
      action: "timeout",
      idempotency_key: "runtime-human-timeout-1",
      payload_hash: await payloadHash({ action: "timeout", reason: null }),
      workflow_id: timeoutWaiting.workflow_id,
    });
    expect(timeout.approval_state).toBe("timed_out");
    await waitForState(coordinator, "runtime-human-timeout", "failed");
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind("runtime-human-timeout").first()).toEqual({ status: "failed" });
  });

  it("allows only one terminal outcome when competing terminal commits race", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-terminal-race");
    const runId = "runtime-terminal-race";
    await runInDurableObject(coordinator, async instance => {
      try {
        await instance.getRun(runId);
      } catch {
        // getRun initializes the fresh DO schema.
      }
    });
    const manifest = JSON.stringify({
      schema_version: "editorial-orchestration.v2",
      agent_versions: { editorial_coordinator: "editorial-coordinator.agent.v2" },
      skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
    });
    await runInDurableObject(coordinator, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'human_action_required', 0, ?, ?)`,
        runId,
        "article_terminal_race",
        92,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:terminal-race",
        manifest,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    const failedAttempt = runInDurableObject(coordinator, async instance => {
      try {
        return { ok: true, result: await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "terminal-failed",
          step_key: `${runId}:terminal-failed`,
          expected_state: "queued",
          next_state: "failed",
          approval_state: "human_action_required",
          terminal_status: "failed",
          artifacts: [],
        }) };
      } catch (error) {
        return { ok: false, code: (error as { code?: string }).code || "unknown_error" };
      }
    });
    const completedAttempt = runInDurableObject(coordinator, async instance => {
      try {
        return { ok: true, result: await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "terminal-completed",
          step_key: `${runId}:terminal-completed`,
          expected_state: "queued",
          next_state: "approved_for_phase3",
          approval_state: "approved",
          terminal_status: "completed",
          artifacts: [],
        }) };
      } catch (error) {
        return { ok: false, code: (error as { code?: string }).code || "unknown_error" };
      }
    });
    const attempts = await Promise.all([failedAttempt, completedAttempt]);
    expect(attempts.filter(attempt => attempt.ok)).toHaveLength(1);
    expect(attempts.filter(attempt => !attempt.ok)).toHaveLength(1);
    expect(["stale_workflow_step", "terminal_conflict", "invalid_state_transition"]).toContain(attempts.find(attempt => !attempt.ok)?.code);
    const winner = attempts.find(attempt => attempt.ok) as { ok: true; result: { state: string; terminal_status?: string } };
    const terminalState = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{
      state: string;
      steps: number;
      intents: number;
      receipts: number;
      events: number;
    }>(
      `SELECT
         (SELECT state FROM editorial_phase2_runs WHERE run_id = ?) AS state,
         (SELECT count(*) FROM editorial_phase2_steps WHERE run_id = ? AND step_key LIKE ?) AS steps,
         (SELECT count(*) FROM editorial_phase2_terminal_intents WHERE run_id = ?) AS intents,
         (SELECT count(*) FROM editorial_phase2_terminal_receipts WHERE intent_id IN (SELECT intent_id FROM editorial_phase2_terminal_intents WHERE run_id = ?)) AS receipts,
         (SELECT count(*) FROM editorial_phase2_events WHERE run_id = ? AND event_type = 'workflow_step') AS events`,
      runId,
      runId,
      `${runId}:terminal-%`,
      runId,
      runId,
      runId,
    ).one());
    expect(terminalState).toEqual({ state: winner.result.state, steps: 1, intents: 1, receipts: 1, events: 1 });
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind(runId).first()).toEqual({ status: winner.result.terminal_status });
  });

  it("fails closed on existing D1 pin or input identity conflicts", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-pin-conflict");
    const runId = "runtime-pin-conflict";
    const artifactId = `${runId}:article_draft:${runId}:draft:v1`;
    const agentVersions = JSON.stringify({
      cover: "cover.agent.v2",
      editorial_coordinator: "editorial-coordinator.agent.v2",
      editorial_review: "editorial-review.agent.v2",
      illustration: "illustration.agent.v2",
      writing: "writing.agent.v2",
    });
    const skillPins = JSON.stringify({ formatting: { id: "md_to_wechat", version: "1.0.0" } });
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(`INSERT INTO editorial_runs
        (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
         workflow_version, policy_version, agent_versions_json, skill_pins_json,
         status, idempotency_key, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .bind(runId, "user_runtime_a", "workspace_runtime_a", "article_pin_conflict", 92, "editorial-orchestration.v2", "editorial-workflow.v2", "editorial-policy.v2", agentVersions, skillPins, `run:${runId}`, "sha256:pin-conflict", "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z"),
      workerEnv.DB.prepare(`INSERT INTO editorial_artifacts
        (artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
         schema_version, kind, producer_agent_role, producer_agent_version,
         skill_id, skill_version, workflow_version, policy_version,
         input_artifact_ids_json, payload_hash, storage_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(artifactId, runId, "user_runtime_a", "workspace_runtime_a", "article_pin_conflict", 92, "editorial-orchestration.v2", "article_draft", "writing", "writing.agent.v2", "md_to_wechat", "1.0.0", "editorial-workflow.v2", "editorial-policy.v2", JSON.stringify(["wrong-parent"]), "sha256:wrong-artifact", `do://editorial-phase2/${runId}/${artifactId}`, "2026-07-19T00:00:00.000Z"),
    ]);
    await runInDurableObject(coordinator, async (_instance, state) => {
      try {
        await _instance.getRun(runId);
      } catch {
        // getRun initializes the fresh DO schema.
      }
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'not_required', 0, ?, ?)`,
        runId,
        "article_pin_conflict",
        92,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:pin-conflict",
        JSON.stringify({
          schema_version: "editorial-orchestration.v2",
          agent_versions: {
            editorial_coordinator: "editorial-coordinator.agent.v2",
            writing: "writing.agent.v2",
            editorial_review: "editorial-review.agent.v2",
            illustration: "illustration.agent.v2",
            cover: "cover.agent.v2",
          },
          skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
        }),
        "2026-07-19T00:00:00.000Z",
        "2026-07-19T00:00:00.000Z",
      );
    });
    const result = await runInDurableObject(coordinator, async (instance, state) => {
      try {
        await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "draft-v1",
          step_key: `${runId}:draft-v1`,
          expected_state: "queued",
          next_state: "draft_generated",
          artifacts: [{
            kind: "article_draft",
            idempotency_key: `${runId}:draft:v1`,
            producer_role: "writing",
            producer_version: "writing.agent.v2",
            summary: { source: "synthetic", version_no: 1 },
          }],
        });
        return { code: "unexpected_success" };
      } catch (error) {
        return {
          code: (error as { code?: string }).code,
          state: state.storage.sql.exec<{ state: string }>("SELECT state FROM editorial_phase2_runs WHERE run_id = ?", runId).one().state,
          outbox: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_outbox WHERE run_id = ?", runId).one().count,
        };
      }
    });
    expect(result).toEqual({ code: "editorial_d1_mirror_conflict", state: "queued", outbox: 1 });
    expect(await workerEnv.DB.prepare("SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ?").bind(runId).first()).toEqual({ count: 1 });
    expect(await workerEnv.DB.prepare("SELECT status FROM editorial_runs WHERE run_id = ?").bind(runId).first()).toEqual({ status: "running" });
  });

  it("fails closed when only an existing D1 artifact schema pin differs", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-schema-pin-conflict");
    const runId = "runtime-schema-pin-conflict";
    const articleId = "article_schema_pin_conflict";
    const artifact = {
      kind: "article_draft" as const,
      idempotency_key: `${runId}:draft:v1`,
      producer_role: "writing" as const,
      producer_version: "writing.agent.v2",
      input_artifact_ids: [] as string[],
      summary: { source: "synthetic", version_no: 1 },
    };
    const artifactId = `${runId}:${artifact.kind}:${artifact.idempotency_key}`;
    const artifactPayloadHash = await payloadHash({ kind: artifact.kind, summary: artifact.summary, input_artifact_ids: [] });
    const agentVersions = JSON.stringify({
      cover: "cover.agent.v2",
      editorial_coordinator: "editorial-coordinator.agent.v2",
      editorial_review: "editorial-review.agent.v2",
      illustration: "illustration.agent.v2",
      writing: "writing.agent.v2",
    });
    const skillPins = JSON.stringify({ formatting: { id: "md_to_wechat", version: "1.0.0" } });
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(`INSERT INTO editorial_runs
        (run_id, user_id, workspace_id, article_id, recording_id, schema_version,
         workflow_version, policy_version, agent_versions_json, skill_pins_json,
         status, idempotency_key, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .bind(runId, "user_runtime_a", "workspace_runtime_a", articleId, 92, "editorial-orchestration.v2", "editorial-workflow.v2", "editorial-policy.v2", agentVersions, skillPins, `run:${runId}`, "sha256:schema-pin-conflict", "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.000Z"),
      workerEnv.DB.prepare(`INSERT INTO editorial_artifacts
        (artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
         schema_version, kind, producer_agent_role, producer_agent_version,
         skill_id, skill_version, workflow_version, policy_version,
         input_artifact_ids_json, payload_hash, storage_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(artifactId, runId, "user_runtime_a", "workspace_runtime_a", articleId, 92, "editorial-orchestration.v1", artifact.kind, artifact.producer_role, artifact.producer_version, "md_to_wechat", "1.0.0", "editorial-workflow.v2", "editorial-policy.v2", JSON.stringify([]), artifactPayloadHash, `do://editorial-phase2/${runId}/${artifactId}`, "2026-07-19T00:00:00.000Z"),
    ]);
    await runInDurableObject(coordinator, async (_instance, state) => {
      try {
        await _instance.getRun(runId);
      } catch {
        // getRun initializes the fresh DO schema.
      }
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'not_required', 0, ?, ?)`,
        runId,
        articleId,
        92,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:schema-pin-conflict",
        JSON.stringify({
          schema_version: "editorial-orchestration.v2",
          agent_versions: {
            editorial_coordinator: "editorial-coordinator.agent.v2",
            writing: "writing.agent.v2",
            editorial_review: "editorial-review.agent.v2",
            illustration: "illustration.agent.v2",
            cover: "cover.agent.v2",
          },
          skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
        }),
        "2026-07-19T00:00:00.000Z",
        "2026-07-19T00:00:00.000Z",
      );
    });
    const result = await runInDurableObject(coordinator, async (instance, state) => {
      try {
        await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "draft-v1",
          step_key: `${runId}:draft-v1`,
          expected_state: "queued",
          next_state: "draft_generated",
          artifacts: [artifact],
        });
        return { code: "unexpected_success" };
      } catch (error) {
        return {
          code: (error as { code?: string }).code,
          state: state.storage.sql.exec<{ state: string }>("SELECT state FROM editorial_phase2_runs WHERE run_id = ?", runId).one().state,
          receipts: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_outbox_receipts WHERE outbox_id IN (SELECT outbox_id FROM editorial_phase2_outbox WHERE run_id = ?)", runId).one().count,
          events: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_events WHERE run_id = ?", runId).one().count,
        };
      }
    });
    expect(result).toEqual({ code: "editorial_d1_mirror_conflict", state: "queued", receipts: 0, events: 0 });
    expect(await workerEnv.DB.prepare("SELECT status, schema_version FROM editorial_runs WHERE run_id = ?").bind(runId).first()).toEqual({ status: "running", schema_version: "editorial-orchestration.v2" });
    expect(await workerEnv.DB.prepare("SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ?").bind(runId).first()).toEqual({ count: 1 });
  });

  it("rejects a D1 orphan artifact, then recovers after append-only quarantine reconciliation", async () => {
    const coordinator = workerEnv.EDITORIAL_COORDINATOR.getByName("runtime-d1-orphan");
    const runId = "runtime-d1-orphan";
    const articleId = "article_d1_orphan";
    const manifest = JSON.stringify({
      schema_version: "editorial-orchestration.v2",
      agent_versions: {
        editorial_coordinator: "editorial-coordinator.agent.v2",
        writing: "writing.agent.v2",
        editorial_review: "editorial-review.agent.v2",
        illustration: "illustration.agent.v2",
        cover: "cover.agent.v2",
      },
      skill_pins: { formatting: { id: "md_to_wechat", version: "1.0.0" } },
    });
    await runInDurableObject(coordinator, async instance => {
      try {
        await instance.getRun(runId);
      } catch {
        // getRun initializes the fresh DO schema.
      }
    });
    await runInDurableObject(coordinator, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_runs
          (run_id, article_id, recording_id, user_id, workspace_id, scenario, payload_hash, manifest_json,
           workflow_id, state, state_revision, approval_state, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, 'not_required', 0, ?, ?)`,
        runId,
        articleId,
        92,
        "user_runtime_a",
        "workspace_runtime_a",
        "happy",
        "sha256:d1-orphan",
        manifest,
        "2026-07-19T00:00:00.000Z",
        "2026-07-19T00:00:00.000Z",
      );
    });
    const draftArtifact = {
      kind: "article_draft" as const,
      idempotency_key: `${runId}:draft:v1`,
      producer_role: "writing" as const,
      producer_version: "writing.agent.v2",
      input_artifact_ids: [] as string[],
      summary: { source: "synthetic", version_no: 1 },
    };
    const draft = await runInDurableObject(coordinator, async instance => instance.commitWorkflowStep({
      run_id: runId,
      step_name: "draft-v1",
      step_key: `${runId}:draft-v1`,
      expected_state: "queued",
      next_state: "draft_generated",
      artifacts: [draftArtifact],
    }));
    expect(draft.state).toBe("draft_generated");
    const orphan = {
      artifactId: `${runId}:orphan:cover`,
      kind: "cover_plan" as const,
      producerRole: "cover",
      producerVersion: "cover.agent.v2",
      summary: { source: "synthetic", version_no: 99 },
      inputArtifactIds: [] as string[],
      storageRef: `do://editorial-phase2/${runId}:${runId}:orphan:cover`,
    };
    const orphanHash = await payloadHash({ kind: orphan.kind, summary: orphan.summary, input_artifact_ids: orphan.inputArtifactIds });
    await workerEnv.DB.prepare(`INSERT INTO editorial_artifacts
      (artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
       schema_version, kind, producer_agent_role, producer_agent_version,
       skill_id, skill_version, workflow_version, policy_version,
       input_artifact_ids_json, payload_hash, storage_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(orphan.artifactId, runId, "user_runtime_a", "workspace_runtime_a", articleId, 92, "editorial-orchestration.v2", orphan.kind, orphan.producerRole, orphan.producerVersion, "md_to_wechat", "1.0.0", "editorial-workflow.v2", "editorial-policy.v2", JSON.stringify(orphan.inputArtifactIds), orphanHash, orphan.storageRef, "2026-07-19T00:00:00.000Z")
      .run();
    const rejected = await runInDurableObject(coordinator, async (instance, state) => {
      try {
        await instance.commitWorkflowStep({
          run_id: runId,
          step_name: "review-v1",
          step_key: `${runId}:review-v1`,
          expected_state: "draft_generated",
          next_state: "review_pending",
          artifacts: [],
        });
        return { code: "unexpected_success" };
      } catch (error) {
        return {
          code: (error as { code?: string }).code,
          state: state.storage.sql.exec<{ state: string }>("SELECT state FROM editorial_phase2_runs WHERE run_id = ?", runId).one().state,
          steps: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_steps WHERE run_id = ?", runId).one().count,
          receipts: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_outbox_receipts WHERE outbox_id IN (SELECT outbox_id FROM editorial_phase2_outbox WHERE run_id = ?)", runId).one().count,
          events: state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM editorial_phase2_events WHERE run_id = ?", runId).one().count,
        };
      }
    });
    expect(rejected).toEqual({ code: "editorial_d1_mirror_conflict", state: "draft_generated", steps: 2, receipts: 1, events: 1 });
    expect(await workerEnv.DB.prepare("SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ?").bind(runId).first()).toEqual({ count: 2 });

    // Immutable D1 rows are not deleted. Quarantine is represented by
    // restoring the same stable artifact identity into the DO outbox, after
    // which replay can prove an exact set without duplicating either row.
    await runInDurableObject(coordinator, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_artifacts
          (artifact_id, run_id, kind, idempotency_key, payload_hash, producer_role, producer_version,
           input_artifact_ids_json, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        orphan.artifactId,
        runId,
        orphan.kind,
        `${runId}:orphan:cover`,
        orphanHash,
        orphan.producerRole,
        orphan.producerVersion,
        JSON.stringify(orphan.inputArtifactIds),
        JSON.stringify(orphan.summary),
        "2026-07-19T00:00:00.000Z",
      );
      state.storage.sql.exec(
        `INSERT INTO editorial_phase2_outbox
          (outbox_id, run_id, artifact_id, user_id, workspace_id, article_id, recording_id, kind,
           payload_hash, producer_role, producer_version, input_artifact_ids_json, summary_json, storage_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${runId}:outbox:${orphan.artifactId}`,
        runId,
        orphan.artifactId,
        "user_runtime_a",
        "workspace_runtime_a",
        articleId,
        92,
        orphan.kind,
        orphanHash,
        orphan.producerRole,
        orphan.producerVersion,
        JSON.stringify(orphan.inputArtifactIds),
        JSON.stringify(orphan.summary),
        orphan.storageRef,
        "2026-07-19T00:00:00.000Z",
      );
    });
    const recovered = await runInDurableObject(coordinator, async instance => instance.commitWorkflowStep({
      run_id: runId,
      step_name: "review-v1",
      step_key: `${runId}:review-v1`,
      expected_state: "draft_generated",
      next_state: "review_pending",
      artifacts: [],
    }));
    expect(recovered.state).toBe("review_pending");
    const reconciled = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{ doRows: number; receipts: number; events: number; state: string }>(
      `SELECT
         (SELECT count(*) FROM editorial_phase2_outbox WHERE run_id = ?) AS doRows,
         (SELECT count(*) FROM editorial_phase2_outbox_receipts WHERE outbox_id IN (SELECT outbox_id FROM editorial_phase2_outbox WHERE run_id = ?)) AS receipts,
         (SELECT count(*) FROM editorial_phase2_events WHERE run_id = ?) AS events,
         (SELECT state FROM editorial_phase2_runs WHERE run_id = ?) AS state`,
      runId,
      runId,
      runId,
      runId,
    ).one());
    expect(reconciled).toEqual({ doRows: 2, receipts: 2, events: 2, state: "review_pending" });
    expect(await workerEnv.DB.prepare("SELECT count(*) AS count FROM editorial_artifacts WHERE run_id = ?").bind(runId).first()).toEqual({ count: 2 });
  });

  it("does not resolve a DO or create orchestration state when the server flag is off", async () => {
    let resolved = false;
    const response = await handleEditorialOrchestrationInternalRoute(
      new Request("https://example.test/api/internal/editorial/runs", {
        method: "POST",
        headers: {
          "x-vibepub-user-id": "flag-off-user",
          "x-vibepub-workspace-id": "flag-off-workspace",
        },
        body: JSON.stringify({ run_id: "flag-off-run", article_id: "flag-off-article", recording_id: 1 }),
      }),
      {
        EDITORIAL_WORKFLOW_V2: "false",
        EDITORIAL_WORKFLOW_V2_ALLOWLIST: "flag-off-user:flag-off-workspace",
        EDITORIAL_COORDINATOR: { getByName: () => { resolved = true; throw new Error("DO must not be resolved"); } },
      } as any,
      new URL("https://example.test/api/internal/editorial/runs"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "editorial_workflow_disabled" });
    expect(resolved).toBe(false);
  });
});
