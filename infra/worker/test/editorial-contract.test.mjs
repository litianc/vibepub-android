import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const contracts = await loadContracts();
const pipeline = await loadPipeline();
const fixture = JSON.parse(await readFile(resolve("test/fixtures/editorial/phase1-contract.json"), "utf8"));

test("normalizes a complete synthetic version contract and preserves stable block IDs", () => {
  const normalized = contracts.normalizeVersionInput(fixture.version);
  assert.equal(normalized.article_id, "article_synthetic_001");
  assert.deepEqual(normalized.blocks.map(block => block.block_id), ["b_intro", "b_claim"]);
  assert.equal(normalized.claim_ledger[0].classification, "source_fact");
  assert.equal(normalized.generation_status, "frozen");
  assert.equal(
    contracts.canonicalJson({ b: 2, a: 1 }),
    contracts.canonicalJson({ a: 1, b: 2 }),
  );
});

test("P0 blocks and P1 requires revise or block", () => {
  assert.throws(
    () => contracts.normalizeReviewInput({ ...fixture.p0_review, decision: "pass" }),
    error => error.code === "p0_requires_block",
  );
  assert.throws(
    () => contracts.normalizeReviewInput({ ...fixture.p1_review, decision: "pass" }),
    error => error.code === "p1_requires_revision",
  );
  assert.equal(contracts.normalizeReviewInput(fixture.p0_review).decision, "block");
});

test("charts require provenance and visual items bind to stable blocks", () => {
  const version = contracts.normalizeVersionInput(fixture.version);
  const plan = contracts.normalizeVisualPlanInput(fixture.visual_plan, version.blocks);
  assert.equal(plan.items[0].block_id, "b_claim");
  assert.equal(plan.items[0].data_provenance, "fixture://synthetic/claim-1");
  assert.throws(
    () => contracts.normalizeVisualPlanInput({ ...fixture.visual_plan, items: [{ ...fixture.visual_plan.items[0], data_provenance: "" }] }, version.blocks),
    error => error.code === "chart_provenance_required",
  );
});

test("pipeline stage machine permits the fast path and rejects post-freeze rewrites", () => {
  assert.equal(contracts.canAdvancePipelineStage("draft_generated", "review_pending"), true);
  assert.equal(contracts.canAdvancePipelineStage("content_frozen", "visuals_generating"), true);
  assert.equal(contracts.canAdvancePipelineStage("content_frozen", "draft_generated"), false);
  assert.throws(
    () => contracts.assertPipelineStageTransition("completed", "draft_generated"),
    error => error.code === "invalid_pipeline_transition" && error.status === 409,
  );
});

test("versions are immutable by API, idempotent by payload, and isolated by user", async () => {
  const db = editorialDb();
  const env = { DB: db };
  const authA = { userId: "usr_a", workspaceId: "ws_a", emailVerified: true };
  const authB = { userId: "usr_b", workspaceId: "ws_b", emailVerified: true };
  const create = request("/api/editorial/versions", fixture.version);

  const first = await pipeline.handleEditorialRoute(create, env, new URL(create.url), authA);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.version.version_no, 1);
  assert.equal(firstBody.version.parent_version_id, null);

  const replay = await pipeline.handleEditorialRoute(
    request("/api/editorial/versions", fixture.version), env, new URL(create.url), authA,
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);

  const conflict = await pipeline.handleEditorialRoute(
    request("/api/editorial/versions", { ...fixture.version, title: "Changed payload" }),
    env,
    new URL(create.url),
    authA,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");

  const revision = {
    ...fixture.version,
    source: "revision",
    parent_version_id: firstBody.version.id,
    title: "A revised systems note",
    idempotency_key: "synthetic-v2"
  };
  const second = await pipeline.handleEditorialRoute(
    request("/api/editorial/versions", revision), env, new URL(create.url), authA,
  );
  assert.equal(second.status, 201);
  const secondBody = await second.json();
  assert.equal(secondBody.version.version_no, 2);
  assert.equal(secondBody.version.parent_version_id, firstBody.version.id);

  const crossUser = await pipeline.handleEditorialRoute(
    new Request(`https://example.test/api/editorial/versions/${firstBody.version.id}`),
    env,
    new URL(`https://example.test/api/editorial/versions/${firstBody.version.id}`),
    authB,
  );
  assert.equal(crossUser.status, 404);
  assert.equal(db.versionRows.length, 2);
});

test("review and visual plan retries reuse one immutable result", async () => {
  const db = editorialDb();
  const env = { DB: db };
  const auth = { userId: "usr_a", workspaceId: "ws_a", emailVerified: true };
  const create = request("/api/editorial/versions", fixture.version);
  const first = await pipeline.handleEditorialRoute(create, env, new URL(create.url), auth);
  const versionId = (await first.json()).version.id;

  const reviewUrl = `https://example.test/api/editorial/versions/${versionId}/reviews`;
  const review = await pipeline.handleEditorialRoute(
    request(reviewUrl, fixture.p1_review), env, new URL(reviewUrl), auth,
  );
  assert.equal(review.status, 201);
  const reviewId = (await review.json()).review.id;
  const reviewReplay = await pipeline.handleEditorialRoute(
    request(reviewUrl, fixture.p1_review), env, new URL(reviewUrl), auth,
  );
  assert.equal(reviewReplay.status, 200);
  assert.equal((await reviewReplay.json()).review.id, reviewId);
  const reviewConflict = await pipeline.handleEditorialRoute(
    request(reviewUrl, { ...fixture.p1_review, reviewer_version: "reviewer.synthetic.2" }),
    env, new URL(reviewUrl), auth,
  );
  assert.equal(reviewConflict.status, 409);

  const visualUrl = `https://example.test/api/editorial/versions/${versionId}/visual-plan`;
  const visual = await pipeline.handleEditorialRoute(
    request(visualUrl, fixture.visual_plan), env, new URL(visualUrl), auth,
  );
  assert.equal(visual.status, 201);
  const visualReplay = await pipeline.handleEditorialRoute(
    request(visualUrl, fixture.visual_plan), env, new URL(visualUrl), auth,
  );
  assert.equal(visualReplay.status, 200);
  assert.equal(db.reviewRows.length, 1);
  assert.equal(db.visualRows.length, 1);
});

test("migration contains composite ownership references and append-only guards", async () => {
  const migration = await readFile(resolve("migrations/0010_editorial_visual_pipeline.sql"), "utf8");
  assert.match(migration, /FOREIGN KEY \(recording_id, user_id, workspace_id\)/);
  assert.match(migration, /FOREIGN KEY \(parent_version_id, user_id, workspace_id, article_id, recording_id\)/);
  assert.match(migration, /FOREIGN KEY \(input_version_id, user_id, workspace_id, article_id, recording_id\)/);
  assert.match(migration, /article_versions_append_only_update/);
  assert.match(migration, /editorial_reviews_append_only_delete/);
  assert.match(migration, /UNIQUE\(user_id, workspace_id, article_id, version_no\)/);
});

function request(url, body) {
  return new Request(`https://example.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadContracts() {
  const sourcePath = resolve("src/editorialContracts.ts");
  return import(moduleDataUrl(transpile(await readFile(sourcePath, "utf8"), sourcePath)));
}

async function loadPipeline() {
  const contractsPath = resolve("src/editorialContracts.ts");
  const pipelinePath = resolve("src/editorialPipeline.ts");
  const contractsUrl = moduleDataUrl(transpile(await readFile(contractsPath, "utf8"), contractsPath));
  const source = transpile(await readFile(pipelinePath, "utf8"), pipelinePath)
    .replaceAll('from "./editorialContracts"', `from ${JSON.stringify(contractsUrl)}`);
  return import(moduleDataUrl(source));
}

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName,
  }).outputText;
}

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function editorialDb() {
  const db = {
    recordings: [{ id: 1, user_id: "usr_a", workspace_id: "ws_a" }],
    versionRows: [],
    reviewRows: [],
    visualRows: [],
    prepare(sql) {
      return {
        bind(...values) {
          return {
            all: async () => ({ results: allRows(db, sql, values) }),
            run: async () => ({ meta: { changes: insertRow(db, sql, values) } }),
          };
        },
      };
    },
  };
  return db;
}

function allRows(db, sql, values) {
  if (sql.includes("FROM recordings")) {
    const [id, userId, workspaceId] = values;
    return db.recordings.filter(row => row.id === id && row.user_id === userId && row.workspace_id === workspaceId);
  }
  if (sql.includes("FROM article_versions")) {
    if (sql.includes("MAX(version_no)")) {
      const [userId, workspaceId, articleId] = values;
      const rows = db.versionRows.filter(row => row.user_id === userId && row.workspace_id === workspaceId && row.article_id === articleId);
      return [{ max_version_no: rows.reduce((max, row) => Math.max(max, row.version_no), 0) || null }];
    }
    if (sql.includes("idempotency_key")) {
      const [userId, workspaceId, articleId, key] = values;
      return db.versionRows.filter(row => row.user_id === userId && row.workspace_id === workspaceId && row.article_id === articleId && row.idempotency_key === key);
    }
    if (sql.includes("id = ? AND user_id")) {
      const [id, userId, workspaceId, articleId, recordingId] = values;
      return db.versionRows.filter(row => row.id === id && row.user_id === userId && row.workspace_id === workspaceId &&
        (values.length < 5 || (row.article_id === articleId && row.recording_id === recordingId)));
    }
    if (sql.includes("WHERE user_id = ? AND workspace_id = ? AND article_id = ?")) {
      const [userId, workspaceId, articleId] = values;
      return db.versionRows.filter(row => row.user_id === userId && row.workspace_id === workspaceId && row.article_id === articleId);
    }
    const [id] = values;
    return db.versionRows.filter(row => row.id === id);
  }
  if (sql.includes("FROM editorial_reviews")) {
    if (sql.includes("idempotency_key")) {
      const [userId, workspaceId, articleId, key] = values;
      return db.reviewRows.filter(row => row.user_id === userId && row.workspace_id === workspaceId && row.article_id === articleId && row.idempotency_key === key);
    }
    if (sql.includes("id = ?")) return db.reviewRows.filter(row => row.id === values[0]);
    const [userId, workspaceId, articleId, versionId] = values;
    return db.reviewRows.filter(row => row.user_id === userId && row.workspace_id === workspaceId && row.article_id === articleId && row.input_version_id === versionId);
  }
  if (sql.includes("FROM visual_plans")) {
    if (sql.includes("idempotency_key")) {
      const [userId, workspaceId, articleId, key] = values;
      return db.visualRows.filter(row => row.user_id === userId && row.workspace_id === workspaceId && row.article_id === articleId && row.idempotency_key === key);
    }
    const [id] = values;
    return db.visualRows.filter(row => row.id === id);
  }
  throw new Error(`Unexpected query: ${sql}`);
}

function insertRow(db, sql, values) {
  if (sql.includes("INSERT INTO article_versions")) {
    const row = {
      id: values[0], user_id: values[1], workspace_id: values[2], article_id: values[3], recording_id: values[4],
      version_no: values[5], parent_version_id: values[6], source: values[7], source_job_id: values[8], source_hash: values[9],
      title: values[10], body: values[11], cover_json: values[12], blocks_json: values[13], title_candidates_json: values[14],
      selected_title: values[15], cover_title_json: values[16], claim_ledger_json: values[17], visual_plan_json: values[18],
      formatting_skill_id: values[19], formatting_skill_version: values[20], content_html_hash: values[21], html_warnings_json: values[22],
      generation_status: values[23], idempotency_key: values[24], payload_hash: values[25], created_at: values[26],
    };
    if (db.versionRows.some(existing => existing.id === row.id || (existing.user_id === row.user_id && existing.workspace_id === row.workspace_id && existing.article_id === row.article_id && (existing.version_no === row.version_no || existing.idempotency_key === row.idempotency_key)))) throw new Error("UNIQUE");
    db.versionRows.push(row);
    return 1;
  }
  if (sql.includes("INSERT INTO editorial_reviews")) {
    const row = {
      id: values[0], user_id: values[1], workspace_id: values[2], article_id: values[3], recording_id: values[4], input_version_id: values[5],
      findings_json: values[6], decision: values[7], reviewer_version: values[8], idempotency_key: values[9], payload_hash: values[10], created_at: values[11],
    };
    if (db.reviewRows.some(existing => existing.id === row.id || (existing.user_id === row.user_id && existing.workspace_id === row.workspace_id && existing.article_id === row.article_id && existing.idempotency_key === row.idempotency_key))) throw new Error("UNIQUE");
    db.reviewRows.push(row);
    return 1;
  }
  if (sql.includes("INSERT INTO visual_plans")) {
    const row = {
      id: values[0], user_id: values[1], workspace_id: values[2], article_id: values[3], recording_id: values[4], version_id: values[5],
      items_json: values[6], idempotency_key: values[7], payload_hash: values[8], created_at: values[9],
    };
    if (db.visualRows.some(existing => existing.id === row.id || existing.version_id === row.version_id || (existing.user_id === row.user_id && existing.workspace_id === row.workspace_id && existing.article_id === row.article_id && existing.idempotency_key === row.idempotency_key))) throw new Error("UNIQUE");
    db.visualRows.push(row);
    return 1;
  }
  throw new Error(`Unexpected insert: ${sql}`);
}
