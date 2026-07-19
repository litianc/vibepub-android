import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleEditorialOrchestrationInternalRoute } from "../src/editorialAgents";

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
      BEFORE UPDATE ON editorial_runs BEGIN SELECT RAISE(ABORT, 'editorial_runs_append_only'); END`),
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
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort());
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
    const appendOnly = await runInDurableObject(first, (_instance, state) => {
      const artifactId = state.storage.sql.exec<{ artifact_id: string }>("SELECT artifact_id FROM editorial_phase2_artifacts LIMIT 1").one().artifact_id;
      const stepKey = state.storage.sql.exec<{ step_key: string }>("SELECT step_key FROM editorial_phase2_steps LIMIT 1").one().step_key;
      const actionId = state.storage.sql.exec<{ action_id: string }>("SELECT action_id FROM editorial_phase2_human_actions LIMIT 1").one().action_id;
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
      const counts = state.storage.sql.exec<{ steps: number; actions: number }>(
        "SELECT (SELECT count(*) FROM editorial_phase2_steps) AS steps, (SELECT count(*) FROM editorial_phase2_human_actions) AS actions",
      ).one();
      return { updateRejected, deleteRejected, stepUpdateRejected, stepDeleteRejected, actionUpdateRejected, actionDeleteRejected, counts };
    });
    expect(appendOnly).toEqual({
      updateRejected: true,
      deleteRejected: true,
      stepUpdateRejected: true,
      stepDeleteRejected: true,
      actionUpdateRejected: true,
      actionDeleteRejected: true,
      counts: { steps: 6, actions: 1 },
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
