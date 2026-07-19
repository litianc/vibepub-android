import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleEditorialOrchestrationInternalRoute } from "../src/editorialAgents";

const workerEnv = env as any;

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
      return { updateRejected, deleteRejected };
    });
    expect(appendOnly).toEqual({ updateRejected: true, deleteRejected: true });
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
