import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const worker = await loadWorker();

test("rejects unauthorized API requests", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/recordings"),
    createEnv(),
    createExecutionContext(),
  );

  assert.equal(response.status, 401);
});

test("article feedback keeps history, replays exact events, and exposes the latest server choice", async () => {
  const db = articleFeedbackDb();
  const env = createEnv({ DB: db });
  const endpoint = "https://example.test/api/recordings/voice.m4a/article-feedback";

  const initial = await worker.fetch(
    authorizedRequest(endpoint),
    env,
    createExecutionContext(),
  );
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    recording_id: 71,
    legacy: false,
    current_version: { id: "version_1", version_no: 1 },
    current_feedback: null,
    feedback: [],
  });

  const adopted = {
    version_id: "version_1",
    action: "adopted",
    client_event_id: "client_adopt_1",
  };
  const first = await worker.fetch(
    authorizedRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adopted),
    }),
    env,
    createExecutionContext(),
  );
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.idempotent, false);
  assert.equal(firstBody.feedback.action, "adopted");
  assert.equal(firstBody.feedback.server_sequence, 1);

  const replay = await worker.fetch(
    authorizedRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adopted),
    }),
    env,
    createExecutionContext(),
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).feedback.id, firstBody.feedback.id);
  assert.equal(db.events.length, 1);

  const conflict = await worker.fetch(
    authorizedRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...adopted, action: "not_adopted" }),
    }),
    env,
    createExecutionContext(),
  );
  assert.equal(conflict.status, 409);
  assert.equal(db.events.length, 1);

  const changed = await worker.fetch(
    authorizedRequest(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version_id: "version_1",
        action: "not_adopted",
        client_event_id: "client_not_adopted_1",
      }),
    }),
    env,
    createExecutionContext(),
  );
  assert.equal(changed.status, 201);
  assert.equal(db.events.length, 2);

  const latest = await worker.fetch(
    authorizedRequest(endpoint),
    env,
    createExecutionContext(),
  );
  assert.equal(latest.status, 200);
  const latestBody = await latest.json();
  assert.equal(latestBody.current_feedback.action, "not_adopted");
  assert.equal(latestBody.current_feedback.server_sequence, 2);
  assert.deepEqual(latestBody.feedback.map((event) => event.action), ["adopted", "not_adopted"]);
});

test("article feedback hides legacy controls and rejects a new event for a stale version", async () => {
  const db = articleFeedbackDb();
  const env = createEnv({ DB: db });

  const legacy = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/legacy.m4a/article-feedback"),
    env,
    createExecutionContext(),
  );
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).legacy, true);

  db.versions.push({
    id: "version_2",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    article_id: "article_1",
    recording_id: 71,
    version_no: 2,
  });
  const stale = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/voice.m4a/article-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version_id: "version_1",
        action: "adopted",
        client_event_id: "client_stale_1",
      }),
    }),
    env,
    createExecutionContext(),
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "stale_article_version",
    message: "文章已有新版本，请刷新后再选择",
  });
  assert.equal(db.events.length, 0);
});

test("article feedback rejects a version that becomes stale during the insert", async () => {
  const db = articleFeedbackDb();
  db.beforeFeedbackInsert(() => {
    db.versions.push({
      id: "version_2",
      user_id: "default_user",
      workspace_id: "vibepub-dogfood",
      article_id: "article_1",
      recording_id: 71,
      version_no: 2,
    });
  });

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/voice.m4a/article-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version_id: "version_1",
        action: "adopted",
        client_event_id: "client_race_1",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "stale_article_version");
  assert.equal(db.events.length, 0);
});

test("transcript reads merge the generated article projection for the existing Android client", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM recordings/);
      return statement({
        all: async () => ({
          results: [{
            id: 71,
            status: "PROCESSING",
            raw_text: "完整识别文本",
            article_title: "整理后的标题",
            article_content: "整理后的正文",
            processing_stage: "ARTICLE_READY",
            wechat_url: null,
            wechat_draft_id: null,
            cover_image_url: null,
            error_message: null,
          }],
        }),
      });
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/transcripts/voice.m4a"),
    createEnv({
      DB: db,
      FILES_BUCKET: {
        async get(key) {
          assert.equal(key, "users/default_user/transcripts/voice.json");
          return { text: async () => JSON.stringify({ rawText: "旧识别文本" }) };
        },
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=0");
  const body = await response.json();
  assert.equal(body.rawText, "完整识别文本");
  assert.equal(body.articleTitle, "整理后的标题");
  assert.equal(body.article_content, "整理后的正文");
  assert.equal(body.processingStage, "ARTICLE_READY");
});

test("transcript reads prefer the current frozen run over a non-empty stale recording body", async () => {
  const db = {
    prepare() {
      return statement({
        all: async () => ({ results: [{
          id: 71,
          status: "PROCESSING",
          raw_text: "识别文本",
          article_title: "上一轮标题",
          article_content: "上一轮正文",
          processing_stage: "ARTICLE_READY",
          wechat_url: null,
          wechat_draft_id: null,
          cover_image_url: null,
          error_message: null,
        }] }),
      });
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/transcripts/voice.m4a"),
    {
      ...publicationEnabledEnv(db),
      TEST_FROZEN_RECORDING_PROJECTION: {
        title: "当前轮标题",
        body: "当前轮正文",
        processingStage: "ARTICLE_READY",
        versionId: "av_frozen_current",
        versionNo: 1,
      },
      FILES_BUCKET: { async get() { return { text: async () => JSON.stringify({ rawText: "识别文本" }) }; } },
    },
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.articleTitle, "当前轮标题");
  assert.equal(body.articleContent, "当前轮正文");
  assert.equal(body.articleVersion, 1);
  assert.equal(body.article_version, 1);
  assert.equal(body.articleVersionId, "av_frozen_current");
  assert.equal(body.article_version_id, "av_frozen_current");
});

test("transcript reads rebuild a missing legacy R2 JSON from the current frozen article", async () => {
  const db = {
    prepare() {
      return statement({
        all: async () => ({ results: [{
          id: 71,
          status: "PROCESSING",
          raw_text: null,
          article_title: null,
          article_content: null,
          processing_stage: "ASR",
          wechat_url: null,
          wechat_draft_id: null,
          cover_image_url: null,
          error_message: null,
        }] }),
      });
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/transcripts/missing.m4a"),
    {
      ...publicationEnabledEnv(db),
      TEST_FROZEN_RECORDING_PROJECTION: {
        title: "冻结稿标题",
        body: "冻结稿正文",
        processingStage: "ARTICLE_READY",
      },
      FILES_BUCKET: { async get() { return null; } },
    },
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.articleTitle, "冻结稿标题");
  assert.equal(body.articleContent, "冻结稿正文");
  assert.equal(body.processingStage, "ARTICLE_READY");
});

test("transcript reads retry instead of caching an empty body when D1 is unavailable", async () => {
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/transcripts/voice.m4a"),
    createEnv({
      DB: {
        prepare() {
          return statement({ first: async () => { throw new Error("D1 temporarily unavailable"); } });
        },
      },
      FILES_BUCKET: {
        async get() {
          return { text: async () => JSON.stringify({ rawText: "已识别，但还没有正文" }) };
        },
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, max-age=0");
  assert.equal((await response.json()).error, "transcript_projection_unavailable");
});

test("transcript reads support legacy recordings without a workspace_id column", async () => {
  let attempts = 0;
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/transcripts/legacy.m4a"),
    createEnv({
      DB: {
        prepare(sql) {
          attempts += 1;
          if (sql.includes("editorial_recording_scopes")) {
            return statement({ first: async () => { throw new Error("D1_ERROR: no such table: editorial_recording_scopes"); } });
          }
          assert.doesNotMatch(sql, /workspace_id/);
          return statement({
            all: async () => ({ results: [{
              id: 7,
              status: "COMPLETED",
              raw_text: "旧库识别文本",
              article_title: "旧库标题",
              article_content: "旧库正文",
              processing_stage: "ARTICLE_READY",
              wechat_url: null,
              wechat_draft_id: null,
              cover_image_url: null,
              error_message: null,
            }] }),
          });
        },
      },
      FILES_BUCKET: {
        async get() {
          return { text: async () => JSON.stringify({ rawText: "旧内容" }) };
        },
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  const body = await response.json();
  assert.equal(body.articleContent, "旧库正文");
  assert.equal(body.articleVersion, undefined);
  assert.equal(body.article_version, undefined);
});

test("transcript reads reject malformed R2 JSON so Android can retry", async () => {
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/transcripts/voice.m4a"),
    createEnv({ FILES_BUCKET: { async get() { return { text: async () => "{broken" }; } } }),
    createExecutionContext(),
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, max-age=0");
  assert.equal((await response.json()).error, "transcript_payload_invalid");
});

test("editorial producer writes are behind the internal service boundary", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/internal/editorial/versions", { method: "POST" }),
    createEnv(),
    createExecutionContext(),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("Mining V3 handoff auth rejects every legacy token before parsing or I/O", async () => {
  for (const authorization of ["Bearer files-token", "Bearer mining-token", "Bearer five-agent-token", "Bearer session-access-token"]) {
    let reads = 0;
    const response = await worker.fetch(
      new Request("https://example.test/api/internal/v3/mining-handoffs/eligibility", {
        method: "POST",
        headers: { Authorization: authorization, "content-type": "application/json" },
        body: "{not-json",
      }),
      createEnv({
        FILES_TOKEN: "files-token",
        MINING_SERVICE_TOKEN: "mining-token",
        FIVE_AGENT_PUBLISHING_TOKEN: "five-agent-token",
        MINING_V3_HANDOFF_TOKEN: "mining-v3-token",
        DB: { prepare() { reads += 1; throw new Error("DB must not be read"); } },
        FILES_BUCKET: { get() { reads += 1; throw new Error("R2 must not be read"); } },
      }),
      createExecutionContext(),
    );
    assert.equal(response.status, 401);
    assert.equal(reads, 0);
  }
});

test("Mining V3 handoff accepts only its dedicated bearer before dispatch", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/internal/v3/mining-handoffs/eligibility", {
      method: "POST",
      headers: { Authorization: "Bearer mining-v3-token", "content-type": "application/json" },
      body: "{}",
    }),
    createEnv({ MINING_V3_HANDOFF_TOKEN: "mining-v3-token" }),
    createExecutionContext(),
  );
  // The data-URL harness intentionally stubs the real coordinator module;
  // 503 proves auth routed to the dedicated endpoint rather than a fallback.
  assert.equal(response.status, 503);
});

test("health check exposes deploy version metadata", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/health"),
    createEnv({
      DEPLOY_COMMIT: "abc1234",
      DEPLOY_REF: "main",
      DEPLOYED_AT: "2026-07-10T05:32:00Z",
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "vibepub-api");
  assert.deepEqual(body.version, {
    commit: "abc1234",
    ref: "main",
    deployed_at: "2026-07-10T05:32:00Z",
  });
});

test("main health aggregates private adapter version evidence without provider work", async () => {
  const adapter = (service) => ({
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/health");
      return Response.json({
        ok: true,
        service,
        version: { commit: "abc1234", ref: "staging", deployed_at: "2026-07-22T10:00:00Z" },
      });
    },
  });
  const response = await worker.fetch(
    new Request("https://example.test/health?adapters=1"),
    createEnv({
      WRITING_AGENT: adapter("writing-agent"),
      REVIEW_AGENT: adapter("editorial-review-agent"),
      IMAGE_GENERATION_ADAPTER: adapter("image-generation-adapter"),
      WECHAT_PUBLISHING_ADAPTER: adapter("wechat-publishing-adapter"),
    }),
    createExecutionContext(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.adapters).sort(), ["image", "review", "wechat", "writing"]);
  assert.equal(body.adapters.wechat.version.commit, "abc1234");
});

test("main health fails closed when a private adapter health response is unavailable", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/health?adapters=1"),
    createEnv({
      WRITING_AGENT: { fetch: async () => Response.json({ ok: true, service: "writing-agent", version: {} }) },
    }),
    createExecutionContext(),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "adapter_health_unavailable" });
});

test("publication action routes stay disabled when the V3 allowlist is empty", async () => {
  let prepareCalled = false;
  const db = {
    prepare() {
      prepareCalled = true;
      throw new Error("publication DB must not be touched while the flag is off");
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "retry-1" },
      body: JSON.stringify({ expected_state_revision: 0 }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "publication_workflow_disabled");
  assert.equal(prepareCalled, false);
});

test("all publication reads stay disabled when the V3 flag is off", async () => {
  let publicationReads = 0;
  const db = {
    prepare(sql) {
      if (sql.includes("publication_")) {
        publicationReads += 1;
        throw new Error("publication DB must not be read while the flag is off");
      }
      if (sql.includes("FROM recordings")) {
        return statement({ all: async () => ({ results: [{
          id: 101,
          filename: "flag-off.m4a",
          status: "COMPLETED",
          created_at: "2026-07-19T00:00:01Z",
          updated_at: "2026-07-19T00:00:02Z",
          article_title: null,
          raw_text_preview: null,
          processing_stage: "COMPLETED",
          wechat_url: null,
          wechat_draft_id: null,
          error_message: null,
        }] }) });
      }
      throw new Error(`unexpected flag-off SQL: ${sql}`);
    },
  };
  const disabledEnv = createEnv({ DB: db });
  const runResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/101/publication-run"),
    disabledEnv,
    createExecutionContext(),
  );
  const eventsResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events"),
    disabledEnv,
    createExecutionContext(),
  );
  const recordingsResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    disabledEnv,
    createExecutionContext(),
  );
  assert.equal(runResponse.status, 404);
  assert.equal(eventsResponse.status, 404);
  assert.equal(recordingsResponse.status, 200);
  assert.equal((await recordingsResponse.json()).recordings[0].run_id, undefined);
  assert.equal(publicationReads, 0);
});

test("recording publication route falls back once to a legacy run when projection tables are absent", async () => {
  const legacyRow = {
    run_id: "legacy-run",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    article_id: "legacy-article",
    recording_id: 101,
    state: "awaiting_human_confirmation",
    schema_version: "editorial-orchestration.v2",
    workflow_version: "editorial-workflow.v2",
    policy_version: "editorial-policy.v2",
    agent_versions_json: "{}",
    skill_pins_json: "{}",
    idempotency_key: "legacy-key",
    payload_hash: "sha256:legacy",
    created_at: "2026-07-19T00:00:01Z",
    updated_at: "2026-07-19T00:00:02Z",
  };
  const db = {
    prepare(sql) {
      if (sql.includes("publication_current_runs") || sql.includes("FROM publication_runs")) {
        return statement({
          all: async () => {
            throw new Error("no such table: publication_runs");
          },
        });
      }
      if (sql.includes("FROM editorial_runs")) {
        return statement({ all: async () => ({ results: [legacyRow] }) });
      }
      throw new Error(`Unexpected publication fallback SQL: ${sql}`);
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/101/publication-run"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.run.legacy, true);
  assert.equal(body.run.state, "content_frozen");
  assert.equal(body.run.publication_stage, "review");
  assert.equal(body.run.identity_status, "legacy_unpinned");
  assert.deepEqual(body.run.capabilities, { read_only: true, actions: [] });
  assert.equal(body.run.next_action, "v3_projection_required");
  assert.equal(body.run.source_manifest_hash, null);
});

test("public publication run details redact persisted provider error codes", async () => {
  const runRow = publicationRunRow({
    state: "failed",
    run_status: "failed",
    error_code: "provider_internal_error_500",
    next_action: "retry",
  });
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_runs")) {
        return statement({ all: async () => ({ results: [runRow] }) });
      }
      throw new Error(`Unexpected public publication detail SQL: ${sql}`);
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/101/publication-run"),
    publicationEnabledEnv(db),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.clone().text(), /provider_internal_error_500/);
  assert.equal((await response.json()).run.error_code, null);
});

test("publication events paginate in bounded revision order and reject invalid bounds", async () => {
  const runRow = {
    run_id: "synthetic-run",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    article_id: "synthetic-article",
    recording_id: 101,
    source_run_id: "synthetic-run",
    source_manifest_hash: "sha256:synthetic",
    source_state: "writing",
    source_state_revision: 0,
    schema_version: "publication-projection.v1",
    workflow_version: "publishing-workflow.v1",
    policy_version: "publishing-policy.v1",
    agent_versions_json: "{}",
    skill_pins_json: "{}",
    state: "writing",
    run_status: "active",
    state_revision: 3,
    progress_percent: 28,
    resume_state: null,
    last_successful_state: "writing",
    last_successful_progress_percent: 28,
    retry_count: 0,
    next_action: null,
    error_code: "provider_internal_error_500",
    idempotency_key: "synthetic-run",
    payload_hash: "sha256:synthetic",
    created_at: "2026-07-19T00:00:01Z",
    updated_at: "2026-07-19T00:00:04Z",
  };
  const events = [0, 1, 2, 3].map((revision) => ({
    event_id: `synthetic-run:event:${revision}`,
    run_id: "synthetic-run",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    revision,
    event_type: "projection",
    state: revision === 0 ? "queued" : revision === 1 ? "transcribing" : revision === 2 ? "transcript_ready" : "writing",
    publication_stage: revision === 0 ? "upload" : revision < 3 ? "transcription" : "writing",
    progress_percent: revision === 0 ? 0 : revision === 1 ? 14 : revision === 2 ? 20 : 28,
    retry_count: 0,
    next_action: null,
    error_code: "provider_internal_error_500",
    idempotency_key: `synthetic-event:${revision}`,
    payload_hash: `sha256:event:${revision}`,
    created_at: `2026-07-19T00:00:0${revision}Z`,
  }));
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_run_events")) {
        return statement({
          all: async (values) => ({
            results: events
              .filter((event) => event.revision > values[3])
              .slice(0, values[4]),
          }),
        });
      }
      if (sql.includes("FROM publication_runs")) {
        return statement({ all: async () => ({ results: [runRow] }) });
      }
      throw new Error(`Unexpected publication event SQL: ${sql}`);
    },
  };

  const firstPageResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  assert.equal(firstPageResponse.status, 200);
  assert.doesNotMatch(await firstPageResponse.clone().text(), /provider_internal_error_500/);
  const firstPage = await firstPageResponse.json();
  assert.deepEqual(firstPage.events.map((event) => event.revision), [0, 1, 2, 3]);
  assert.deepEqual(firstPage.events.map((event) => event.error_code), [null, null, null, null]);
  assert.equal(firstPage.after_revision, -1);
  assert.equal(firstPage.has_more, false);
  assert.equal(firstPage.next_after_revision, 3);

  const exactPageResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events?after_revision=0&limit=2"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  const exactPage = await exactPageResponse.json();
  assert.deepEqual(exactPage.events.map((event) => event.revision), [1, 2]);
  assert.equal(exactPage.has_more, true);
  assert.equal(exactPage.next_after_revision, 2);

  const finalPageResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events?after_revision=1&limit=2"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  const finalPage = await finalPageResponse.json();
  assert.deepEqual(finalPage.events.map((event) => event.revision), [2, 3]);
  assert.equal(finalPage.has_more, false);
  assert.equal(finalPage.next_after_revision, 3);

  const remainderResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events?after_revision=2&limit=2"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  const remainder = await remainderResponse.json();
  assert.deepEqual(remainder.events.map((event) => event.revision), [3]);
  assert.equal(remainder.has_more, false);
  assert.equal(remainder.next_after_revision, 3);

  const emptyResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events?after_revision=3&limit=2"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  const empty = await emptyResponse.json();
  assert.deepEqual(empty.events, []);
  assert.equal(empty.has_more, false);
  assert.equal(empty.next_after_revision, 3);

  const repeatResponse = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events?after_revision=0&limit=2"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  const repeat = await repeatResponse.json();
  assert.deepEqual(repeat.events.map((event) => event.revision), exactPage.events.map((event) => event.revision));

  const invalid = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/events?after_revision=0&limit=101"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "event_limit_invalid");
});

test("publication action rejects a stale revision before writing an intent", async () => {
  const runRow = {
    run_id: "synthetic-run",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    article_id: "synthetic-article",
    recording_id: 101,
    source_run_id: "synthetic-run",
    source_manifest_hash: "sha256:synthetic",
    source_state: "writing",
    source_state_revision: 0,
    schema_version: "publication-projection.v1",
    workflow_version: "publishing-workflow.v1",
    policy_version: "publishing-policy.v1",
    agent_versions_json: "{}",
    skill_pins_json: "{}",
    state: "failed",
    run_status: "failed",
    state_revision: 4,
    progress_percent: 28,
    resume_state: null,
    last_successful_state: "writing",
    last_successful_progress_percent: 28,
    retry_count: 0,
    next_action: "retry",
    error_code: "synthetic_failure",
    idempotency_key: "synthetic-run",
    payload_hash: "sha256:synthetic",
    created_at: "2026-07-19T00:00:01Z",
    updated_at: "2026-07-19T00:00:04Z",
  };
  let batchCalled = false;
  const db = {
    prepare(sql) {
      if (sql.includes("SELECT p.state") && sql.includes("AS has_revision_requested")) {
        return statement({ all: async () => ({ results: [{
          state: "writing", error_code: null, next_action: null, has_revision_requested: 0,
        }] }) });
      }
      if (sql.includes("AS has_revision_requested")) {
        return statement({ all: async () => ({ results: [{ has_revision_requested: 0 }] }) });
      }
      if (sql.includes("FROM publication_run_actions")) {
        return statement({ all: async () => ({ results: [] }) });
      }
      if (sql.includes("FROM publication_runs")) {
        return statement({ all: async () => ({ results: [runRow] }) });
      }
      throw new Error(`Unexpected stale action SQL: ${sql}`);
    },
    batch() {
      batchCalled = true;
      throw new Error("stale action must not write");
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/publication-runs/synthetic-run/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "retry-stale" },
      body: JSON.stringify({ expected_state_revision: 3 }),
    }),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "publication_revision_conflict");
  assert.equal(batchCalled, false);
});

test("writing service retries require restart evidence and recover a failed receipt without restarting twice", async () => {
  const expectedStateRevision = 8;
  const retryRevision = expectedStateRevision + 1;
  const retryCount = 2;
  const idempotencyKey = "retry-writing-service-fix";
  const payloadHash = `sha256:${createHash("sha256").update(JSON.stringify({
    action: "retry",
    expected_state_revision: expectedStateRevision,
    contract: "system.v1",
  })).digest("hex")}`;
  const restarts = [];
  const workflowIds = [];
  let projectionState = "writing";
  let projectionRevision = retryRevision + 1;
  const db = {
    prepare(sql) {
      if (sql.includes("SELECT p.state") && sql.includes("AS has_revision_requested")) {
        return statement({ all: async () => ({ results: [{
          state: "writing", error_code: null, next_action: null, has_revision_requested: 0,
        }] }) });
      }
      if (sql.includes("AS has_revision_requested")) {
        return statement({ all: async () => ({ results: [{ has_revision_requested: 0 }] }) });
      }
      if (sql.includes("FROM publication_run_actions")) {
        return statement({
          all: async (values) => {
            const actionKey = values[3];
            const retryAction = actionKey === idempotencyKey;
            const actionPayloadHash = retryAction
              ? payloadHash
              : `sha256:${createHash("sha256").update(JSON.stringify({
                action: "resume",
                expected_state_revision: retryRevision,
                contract: "system.v1",
                cause: "writing_service_fix_retry",
              })).digest("hex")}`;
            return {
              results: [{
                payload_hash: actionPayloadHash,
                result_json: JSON.stringify({
                  action: retryAction ? "retry" : "resume",
                  run: {
                    run_id: "synthetic-run",
                    article_id: "synthetic-article",
                    state: retryAction ? "retrying" : "writing",
                    state_revision: retryAction ? retryRevision : retryRevision + 1,
                    last_successful_state: "writing",
                    retry_count: retryCount,
                    error_code: null,
                  },
                  replayed: false,
                }),
              }],
            };
          },
        });
      }
      if (sql.includes("FROM publication_run_events")) {
        return statement({
          all: async (values) => {
            const revision = values[3];
            assert.deepEqual(values.slice(0, 3), ["synthetic-run", "default_user", "vibepub-dogfood"]);
            return { results: [revision === expectedStateRevision ? {
              state: "failed", error_code: "writing_adapter_non_retryable", next_action: "retry_after_service_fix",
            } : {
              event_type: "action_retry", state: "retrying", retry_count: retryCount,
              payload_hash: payloadHash, created_at: "2026-08-03T00:00:00.000Z",
            }] };
          },
        });
      }
      if (sql.includes("FROM publication_runs")) {
        return statement({
          all: async () => ({ results: [publicationRunRow({
            state: projectionState,
            run_status: "active",
            state_revision: projectionRevision,
            retry_count: retryCount,
            last_event_type: projectionState === "writing" ? "action_resume" : "review_started",
            error_code: null,
            next_action: null,
          })] }),
        });
      }
      throw new Error(`Unexpected writing retry SQL: ${sql}`);
    },
  };
  let workflowStatus = "running";
  let receiptRequested = false;
  let receiptWriteFailures = 1;
  const coordinator = {
    async getFiveAgentWritingRestartReceipt() {
      return { requested: receiptRequested, recorded_at: receiptRequested ? "2026-08-03T00:00:01.000Z" : null };
    },
    async startFiveAgentWritingRecovery(input) {
      workflowIds.push(input.workflow_id);
      if (workflowStatus === "running") {
        return { requested: false, replayed: false, workflow_status: "running", attempt: null };
      }
      restarts.push({ from: { name: "write-draft-1", type: "do" } });
      workflowStatus = "running";
      await coordinator.recordFiveAgentWritingRestartReceipt();
      return { requested: true, replayed: false, workflow_status: "restart_requested", attempt: 1 };
    },
    async recordFiveAgentWritingRestartReceipt() {
      if (receiptWriteFailures > 0) {
        receiptWriteFailures -= 1;
        throw new Error("synthetic restart receipt write failure");
      }
      receiptRequested = true;
      return { replayed: false };
    },
  };
  const retryRequest = () => authorizedRequest("https://example.test/api/publication-runs/synthetic-run/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ expected_state_revision: expectedStateRevision }),
    });
  const retryEnv = createEnv({
    DB: db,
    FIVE_AGENT_PUBLISHING_V3: "true",
    FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood",
    EDITORIAL_COORDINATOR: { getByName: () => coordinator },
  });

  const ambiguousActive = await worker.fetch(retryRequest(), retryEnv, createExecutionContext());
  assert.equal(ambiguousActive.status, 503);
  assert.deepEqual(await ambiguousActive.json(), { error: "publication_workflow_restart_reconciliation_required" });
  assert.deepEqual(workflowIds, ["five-agent-synthetic-run"]);
  assert.deepEqual(restarts, []);

  workflowStatus = "complete";
  const originalConsoleError = console.error;
  let failedReceipt;
  console.error = () => {};
  try {
    failedReceipt = await worker.fetch(retryRequest(), retryEnv, createExecutionContext());
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failedReceipt.status, 503);
  assert.deepEqual(workflowIds, Array(2).fill("five-agent-synthetic-run"));
  assert.deepEqual(restarts, [{ from: { name: "write-draft-1", type: "do" } }]);

  const activeAfterRestart = await worker.fetch(retryRequest(), retryEnv, createExecutionContext());
  assert.equal(activeAfterRestart.status, 503);
  assert.deepEqual(await activeAfterRestart.json(), { error: "publication_workflow_restart_reconciliation_required" });
  assert.deepEqual(workflowIds, Array(3).fill("five-agent-synthetic-run"));
  assert.deepEqual(restarts, [{ from: { name: "write-draft-1", type: "do" } }]);

  projectionState = "reviewing";
  projectionRevision = retryRevision + 2;
  const response = await worker.fetch(retryRequest(), retryEnv, createExecutionContext());

  assert.equal(response.status, 200);
  assert.deepEqual(workflowIds, Array(3).fill("five-agent-synthetic-run"));
  assert.deepEqual(restarts, [{ from: { name: "write-draft-1", type: "do" } }]);
  const responseBody = await response.json();
  assert.deepEqual({
    action: responseBody.action,
    replayed: responseBody.replayed,
    workflow_restart_requested: responseBody.workflow_restart_requested,
    run: {
      run_id: responseBody.run.run_id,
      article_id: responseBody.run.article_id,
      state: responseBody.run.state,
      state_revision: responseBody.run.state_revision,
      last_successful_state: responseBody.run.last_successful_state,
      retry_count: responseBody.run.retry_count,
      error_code: responseBody.run.error_code,
    },
  }, {
    action: "retry",
    replayed: true,
    workflow_restart_requested: true,
    run: { run_id: "synthetic-run", article_id: "synthetic-article", state: "reviewing", state_revision: retryRevision + 2,
      last_successful_state: "writing", retry_count: retryCount, error_code: null },
  });

  const receiptReplay = await worker.fetch(retryRequest(), retryEnv, createExecutionContext());
  assert.equal(receiptReplay.status, 200);
  assert.deepEqual(workflowIds, Array(3).fill("five-agent-synthetic-run"));
  assert.deepEqual(restarts, [{ from: { name: "write-draft-1", type: "do" } }]);
});

test("public retry, cancel, and human action replays redact persisted provider error codes", async () => {
  for (const [path, action, contract] of [
    ["retry", "retry", "system.v1"],
    ["cancel", "cancel", "system.v1"],
    ["actions", "confirm", "human.v1"],
  ]) {
    const expectedStateRevision = 3;
    const payloadHash = `sha256:${createHash("sha256").update(JSON.stringify({
      action,
      expected_state_revision: expectedStateRevision,
      contract,
    })).digest("hex")}`;
    const db = {
      prepare(sql) {
        if (path === "retry" && sql.includes("SELECT p.state") && sql.includes("AS has_revision_requested")) {
          return statement({ all: async () => ({ results: [{
            state: "failed", error_code: "provider_internal_error_500", next_action: "retry", has_revision_requested: 0,
          }] }) });
        }
        if (sql.includes("FROM publication_run_actions")) {
          return statement({
            all: async () => ({
              results: [{
                payload_hash: payloadHash,
                result_json: JSON.stringify({
                  action,
                  run: { run_id: "synthetic-run", error_code: "provider_internal_error_500" },
                  replayed: false,
                }),
              }],
            }),
          });
        }
        throw new Error(`Unexpected public ${path} replay SQL: ${sql}`);
      },
    };
    const body = path === "actions"
      ? { action, expected_state_revision: expectedStateRevision }
      : { expected_state_revision: expectedStateRevision };
    const response = await worker.fetch(
      authorizedRequest(`https://example.test/api/publication-runs/synthetic-run/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `redaction-${path}` },
        body: JSON.stringify(body),
      }),
      publicationEnabledEnv(db),
      createExecutionContext(),
    );

    assert.equal(response.status, 200, path);
    assert.doesNotMatch(await response.clone().text(), /provider_internal_error_500/, path);
    assert.equal((await response.json()).run.error_code, null, path);
  }
});

test("GLM production defaults keep Mining and WritingAgent on the Coding endpoint", async () => {
  const codingBaseUrl = "https://open.bigmodel.cn/api/coding/paas/v4/";
  const [miningLlm, writingAgent, writingAgentWrangler] = await Promise.all([
    readFile(new URL("../../mining/src/llm.ts", import.meta.url), "utf8"),
    readFile(new URL("../../writing-agent/src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../writing-agent/wrangler.toml", import.meta.url), "utf8"),
  ]);

  assert.ok(
    miningLlm.includes(`const GLM_BASE_URL = process.env.GLM_BASE_URL || "${codingBaseUrl}";`),
  );
  assert.ok(
    writingAgent.includes(`const DEFAULT_GLM_BASE_URL = "${codingBaseUrl}";`),
  );
  assert.ok(writingAgentWrangler.includes(`GLM_BASE_URL = "${codingBaseUrl}"`));
});

test("mining input claims allow one active holder and keep completed inputs out of repeat processing", async () => {
  const db = miningClaimDb();
  const targetKey = "users/usr_claim/inbox/voice.m4a";
  const claimResponses = await Promise.all([
    worker.fetch(
      miningClaimRequest("claim", "usr_claim", targetKey, "claim-a"),
      createEnv({ DB: db, MINING_SERVICE_TOKEN: "mining-token" }),
      createExecutionContext(),
    ),
    worker.fetch(
      miningClaimRequest("claim", "usr_claim", targetKey, "claim-b"),
      createEnv({ DB: db, MINING_SERVICE_TOKEN: "mining-token" }),
      createExecutionContext(),
    ),
  ]);
  const claimBodies = await Promise.all(claimResponses.map((response) => response.json()));
  assert.equal(claimBodies.filter((body) => body.claimed).length, 1);

  const winningClaimId = claimBodies[0].claimed ? "claim-a" : "claim-b";
  const complete = await worker.fetch(
    miningClaimRequest("complete", "usr_claim", targetKey, winningClaimId),
    createEnv({ DB: db, MINING_SERVICE_TOKEN: "mining-token" }),
    createExecutionContext(),
  );
  assert.equal((await complete.json()).completed, true);

  const repeated = await worker.fetch(
    miningClaimRequest("claim", "usr_claim", targetKey, "claim-later"),
    createEnv({ DB: db, MINING_SERVICE_TOKEN: "mining-token" }),
    createExecutionContext(),
  );
  assert.equal((await repeated.json()).claimed, false);
});

test("mining input claims reject a target outside the stated user scope", async () => {
  const response = await worker.fetch(
    miningClaimRequest("claim", "usr_one", "users/usr_two/inbox/voice.m4a", "claim-one"),
    createEnv({
      MINING_SERVICE_TOKEN: "mining-token",
      DB: { prepare() { throw new Error("invalid claim target must not reach D1"); } },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_claim_target");
});

test("lists Android recording display fields including processing stage", async () => {
  const db = createDb([
    {
      id: 1,
      filename: "VibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.m4a",
      status: "PROCESSING",
      created_at: "2026-06-29 08:00:00",
      updated_at: "2026-06-29 08:01:00",
      article_title: "整理好的标题",
      raw_text_preview: "这是一段原始识别结果",
      processing_stage: "DRAFTING",
      wechat_url: null,
      wechat_draft_id: "MEDIA_ID_123",
      cover_image_url: "https://example.test/api/files/covers%2FVibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.png",
      error_message: null,
    },
  ]);

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.recordings[0].filename,
    "VibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.m4a",
  );
  assert.equal(body.recordings[0].duration_ms, 6_000);
  assert.equal(body.recordings[0].article_title, "整理好的标题");
  assert.equal(body.recordings[0].processing_stage, "DRAFTING");
  assert.equal(body.recordings[0].wechat_draft_id, "MEDIA_ID_123");
  assert.equal(body.recordings[0].cover_image_url, "https://example.test/api/files/covers%2FVibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.png");
});

test("recording list marks a frozen five-Agent article ready so Android refreshes its transcript", async () => {
  const startedAt = Date.now();
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_runs")) {
        return statement({ all: async () => ({ results: [publicationRunRow({
          recording_id: 71,
          state: "needs_action",
          run_status: "needs_action",
          progress_percent: 96,
          last_successful_state: "draft_syncing",
          last_successful_progress_percent: 96,
          next_action: "reconcile_external_side_effect",
          updated_at: "2026-08-04T02:50:08.000Z",
        })] }) });
      }
      if (sql.includes("FROM recordings")) {
        return statement({ all: async () => ({ results: [{
          id: 71,
          filename: "voice.m4a",
          status: "PROCESSING",
          created_at: "2026-08-03T00:00:00.000Z",
          updated_at: "2026-08-05T00:01:00.000Z",
          article_title: null,
          raw_text_preview: "识别文本",
          processing_stage: "ASR",
          wechat_url: null,
          wechat_draft_id: null,
          error_message: null,
        }] }) });
      }
      throw new Error(`Unexpected article-ready list SQL: ${sql}`);
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    publicationEnabledEnv(db),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const recording = (await response.json()).recordings[0];
  assert.equal(recording.processing_stage, "ARTICLE_READY");
  assert.ok(Date.parse(recording.updated_at) >= startedAt + 1_500);
  assert.equal(recording.status, "PROCESSING");
});

test("recording list exposes only the agreed publication projection fields", async () => {
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_runs")) {
        return statement({
          all: async () => ({
            results: [{
              run_id: "synthetic-run",
              recording_id: 1,
              source_manifest_hash: "sha256:internal",
              agent_versions_json: '{"writing":"writing.agent.v3"}',
              skill_pins_json: '{"formatting":{"id":"md_to_wechat","version":"1.0.0"}}',
              state: "writing",
              run_status: "active",
              state_revision: 2,
              progress_percent: 28,
              last_successful_state: "writing",
              last_successful_progress_percent: 28,
              retry_count: 0,
              next_action: null,
              error_code: "provider_internal_error_500",
              created_at: "2026-07-22T00:00:00.000Z",
              updated_at: "2026-07-22T00:00:01.000Z",
            }],
          }),
        });
      }
      if (sql.includes("FROM recordings")) {
        return statement({
          all: async () => ({
            results: [{
              id: 1,
              filename: "synthetic.m4a",
              status: "PROCESSING",
              created_at: "2026-07-19 00:00:01",
              updated_at: "2026-07-19 00:00:02",
              article_title: "合成标题",
              raw_text_preview: "合成预览",
              processing_stage: "DRAFTING",
              wechat_url: null,
              wechat_draft_id: null,
              error_message: null,
            }],
          }),
        });
      }
      throw new Error(`Unexpected recording list SQL: ${sql}`);
    },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.equal(responseText.includes("provider_internal_error_500"), false);
  const recording = JSON.parse(responseText).recordings[0];
  assert.deepEqual({
    run_id: recording.run_id,
    publication_stage: recording.publication_stage,
    state_revision: recording.state_revision,
    progress_percent: recording.progress_percent,
    retry_count: recording.retry_count,
    next_action: recording.next_action,
  }, {
    run_id: "synthetic-run",
    publication_stage: "writing",
    state_revision: 2,
    progress_percent: 28,
    retry_count: 0,
    next_action: null,
  });
  assert.equal(recording.source_manifest_hash, undefined);
  assert.equal(recording.agent_versions, undefined);
  assert.equal(recording.skill_pins, undefined);
  assert.deepEqual(Object.keys(recording.publication_summary).sort(), [
    "created_at",
    "error_code",
    "last_successful_progress_percent",
    "last_successful_state",
    "next_action",
    "progress_percent",
    "publication_stage",
    "retry_count",
    "run_id",
    "run_status",
    "state",
    "state_revision",
    "updated_at",
  ]);
  assert.deepEqual(recording.publication_summary, {
    run_id: "synthetic-run",
    state: "writing",
    run_status: "active",
    publication_stage: "writing",
    state_revision: 2,
    progress_percent: 28,
    last_successful_state: "writing",
    last_successful_progress_percent: 28,
    retry_count: 0,
    next_action: null,
    error_code: null,
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:01.000Z",
  });
});

test("recording list requires current pointers to match run owner, workspace, and recording", async () => {
  let projectionSql = "";
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_runs")) {
        projectionSql = sql;
        const exactPointerJoin = [
          "c.current_run_id = p.run_id",
          "c.user_id = p.user_id",
          "c.workspace_id = p.workspace_id",
          "c.recording_id = p.recording_id",
        ].every((fragment) => sql.includes(fragment));
        return statement({
          all: async () => ({
            results: exactPointerJoin ? [] : [{
              run_id: "cross-tenant-pointer",
              recording_id: 1,
              state: "writing",
              run_status: "active",
              state_revision: 1,
              progress_percent: 28,
              last_successful_state: "writing",
              last_successful_progress_percent: 28,
              retry_count: 0,
              next_action: null,
              error_code: null,
              created_at: "2026-07-22T00:00:00.000Z",
              updated_at: "2026-07-22T00:00:01.000Z",
            }],
          }),
        });
      }
      if (sql.includes("FROM recordings")) {
        return statement({
          all: async () => ({ results: [{
            id: 1,
            filename: "scoped.m4a",
            status: "PROCESSING",
            created_at: "2026-07-22 00:00:00",
            updated_at: "2026-07-22 00:00:01",
            processing_stage: "ASR",
            error_message: null,
          }] }),
        });
      }
      throw new Error(`Unexpected recording list SQL: ${sql}`);
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).recordings[0].publication_summary, null);
  assert.equal(projectionSql.includes("c.user_id = p.user_id"), true);
  assert.equal(projectionSql.includes("c.workspace_id = p.workspace_id"), true);
  assert.equal(projectionSql.includes("c.recording_id = p.recording_id"), true);
});

test("recording list keeps legacy fields and skips publication access when the V3 projection flag is off", async () => {
  let publicationQueryCount = 0;
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_runs")) {
        publicationQueryCount += 1;
        throw new Error("publication projection must not be queried while disabled");
      }
      if (sql.includes("FROM recordings")) {
        return statement({
          all: async () => ({
            results: [{
              id: 9,
              filename: "legacy.m4a",
              status: "PROCESSING",
              created_at: "2026-07-22 00:00:00",
              updated_at: "2026-07-22 00:00:01",
              processing_stage: "ASR",
              error_message: null,
            }],
          }),
        });
      }
      throw new Error(`Unexpected recording list SQL: ${sql}`);
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const recording = (await response.json()).recordings[0];
  assert.equal(publicationQueryCount, 0);
  assert.equal(Object.hasOwn(recording, "publication_summary"), false);
  assert.equal(recording.processing_stage, "ASR");
});

test("recording list returns a null publication summary when the V3 projection has no current run", async () => {
  const db = {
    prepare(sql) {
      if (sql.includes("FROM publication_runs")) {
        return statement({ all: async () => ({ results: [] }) });
      }
      if (sql.includes("FROM recordings")) {
        return statement({
          all: async () => ({
            results: [{
              id: 10,
              filename: "legacy-with-v3-enabled.m4a",
              status: "PROCESSING",
              created_at: "2026-07-22 00:00:00",
              updated_at: "2026-07-22 00:00:01",
              processing_stage: "ASR",
              error_message: null,
            }],
          }),
        });
      }
      throw new Error(`Unexpected recording list SQL: ${sql}`);
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db, FIVE_AGENT_PUBLISHING_V3: "true", FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood" }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const recording = (await response.json()).recordings[0];
  assert.equal(recording.publication_summary, null);
  assert.equal(recording.run_id, null);
  assert.equal(recording.publication_stage, null);
});

test("preserves explicit recording duration when D1 starts returning it", async () => {
  let selectedSql = "";
  const db = createDb([
    {
      id: 1,
      filename: "VibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.m4a",
      status: "COMPLETED",
      created_at: "2026-06-29 08:00:00",
      updated_at: "2026-06-29 08:01:00",
      duration_ms: 6_250,
      article_title: "整理好的标题",
      raw_text_preview: "这是一段原始识别结果",
      processing_stage: "COMPLETED",
      wechat_url: null,
      wechat_draft_id: "MEDIA_ID_123",
      error_message: null,
    },
  ], {
    onPrepare(sql) {
      if (/duration_ms/.test(sql)) selectedSql = sql;
    },
  });

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(selectedSql, /duration_ms/);
  assert.equal(body.recordings[0].duration_ms, 6_250);
});

test("lists placeholder draft references as missing values", async () => {
  const db = createDb([
    {
      id: 1,
      filename: "VibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.m4a",
      status: "COMPLETED",
      created_at: "2026-06-29 08:00:00",
      updated_at: "2026-06-29 08:01:00",
      article_title: "整理好的标题",
      raw_text_preview: "这是一段原始识别结果",
      processing_stage: "COMPLETED",
      wechat_url: "null",
      wechat_draft_id: "undefined",
      error_message: null,
    },
  ]);

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recordings[0].wechat_url, null);
  assert.equal(body.recordings[0].wechat_draft_id, null);
});

test("deletes a recording and its remote files", async () => {
  const deletedKeys = [];
  const sqlCalls = [];
  const valueCalls = [];
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      return statement({
        all: async (values) => {
          valueCalls.push(values);
          return {
            results: [
      {
        r2_key: "users/default_user/inbox/custom-upload-key.m4a",
      },
            ],
          };
        },
        run: async (values) => {
          valueCalls.push(values);
          return { meta: { changes: 1 } };
        },
      });
    },
  };
  const bucket = {
    async delete(key) {
      deletedKeys.push(key);
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3", {
      method: "DELETE",
    }),
    createEnv({ DB: db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted_record_count, 1);
  assert.match(sqlCalls[0], /SELECT r2_key FROM recordings/);
  assert.match(sqlCalls[1], /DELETE FROM recordings/);
  assert.deepEqual(valueCalls[0], [
    "default_user",
    "VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3",
  ]);
  assert.deepEqual(valueCalls[1], [
    "default_user",
    "VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3",
  ]);
  assert.deepEqual(deletedKeys.sort(), [
    "users/default_user/covers/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.png",
    "users/default_user/inbox/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3",
    "users/default_user/inbox/custom-upload-key.m4a",
    "users/default_user/profile-selections/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3.json",
    "users/default_user/transcripts/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.json",
  ].sort());
});

test("rejects unauthorized recording deletion", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/recordings/voice.m4a", {
      method: "DELETE",
    }),
    createEnv(),
    createExecutionContext(),
  );

  assert.equal(response.status, 401);
});

test("returns the current user from an access-token session", async () => {
  const db = sessionDb({
    id: "usr_1",
    email: "reader@example.com",
    role: "user",
    workspace_id: "ws_reader",
    email_verified_at: "2026-07-07T00:00:00.000Z",
  });

  const response = await worker.fetch(
    sessionRequest("https://example.test/api/me"),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.user, {
    id: "usr_1",
    email: "reader@example.com",
    role: "user",
    workspace_id: "ws_reader",
    email_verified: true,
  });
});

test("refresh keeps a stable long-lived token and returns the user identity", async () => {
  const updates = [];
  const refreshToken = "stable-refresh-token";
  const refreshHash = createHash("sha256").update(refreshToken).digest("hex");
  const db = {
    prepare(sql) {
      if (sql.includes("FROM sessions s") && sql.includes("refresh_token_hash")) {
        assert.match(sql, /s\.id AS session_id/);
        assert.match(sql, /s\.user_id AS id/);
        return statement({
          all: async (values) => {
            assert.deepEqual(values, [refreshHash]);
            return { results: [{
              session_id: "ses_refresh_1",
              id: "usr_refresh_1",
              refresh_expires_at: futureIso(),
              revoked_at: null,
              email: "refresh@example.com",
              role: "user",
              workspace_id: "ws_refresh",
              status: "active",
              email_verified_at: "2026-07-07T00:00:00.000Z",
            }] };
          },
        });
      }
      if (sql.includes("UPDATE sessions")) {
        return statement({
          run: async (values) => {
            updates.push(values);
            return { meta: { changes: 1 } };
          },
        });
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const request = () => worker.fetch(
    new Request("https://example.test/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );
  const first = await request();
  const second = await request();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(firstBody.user.id, "usr_refresh_1");
  assert.equal(secondBody.user.id, "usr_refresh_1");
  assert.equal(firstBody.tokens.refresh_token, refreshToken);
  assert.equal(secondBody.tokens.refresh_token, refreshToken);
  assert.notEqual(firstBody.tokens.access_token, secondBody.tokens.access_token);
  assert.equal(updates.length, 2);
  for (const values of updates) {
    assert.equal(values[1], refreshHash);
    assert.equal(values.at(-2), "ses_refresh_1");
    assert.equal(values.at(-1), refreshHash);
    const slidingDays = (Date.parse(values[3]) - Date.now()) / (24 * 60 * 60 * 1_000);
    assert.ok(slidingDays > 364 && slidingDays <= 365);
  }
});

test("refresh rejects a session revoked during renewal with an explicit auth error", async () => {
  const refreshToken = "revoked-during-refresh";
  const refreshHash = createHash("sha256").update(refreshToken).digest("hex");
  const db = {
    prepare(sql) {
      if (sql.includes("FROM sessions s") && sql.includes("refresh_token_hash")) {
        return statement({
          all: async () => ({ results: [{
            session_id: "ses_refresh_race",
            id: "usr_refresh_race",
            refresh_expires_at: futureIso(),
            revoked_at: null,
            email: "refresh-race@example.com",
            role: "user",
            workspace_id: "ws_refresh_race",
            status: "active",
            email_verified_at: "2026-07-07T00:00:00.000Z",
          }] }),
        });
      }
      if (sql.includes("UPDATE sessions")) {
        assert.match(sql, /refresh_token_hash = \? AND revoked_at IS NULL/);
        return statement({
          run: async (values) => {
            assert.equal(values.at(-1), refreshHash);
            return { meta: { changes: 0 } };
          },
        });
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const response = await worker.fetch(
    new Request("https://example.test/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-vibepub-auth-error"), "invalid_refresh_token");
  assert.deepEqual(await response.json(), { error: "invalid_refresh_token" });
});

test("blocks write APIs until the session email is verified", async () => {
  let putCalled = false;
  const db = sessionDb({
    id: "usr_unverified",
    email: "pending@example.com",
    role: "user",
    workspace_id: "ws_pending",
    email_verified_at: null,
  });
  const bucket = {
    async put() {
      putCalled = true;
    },
  };

  const response = await worker.fetch(
    sessionRequest("https://example.test/api/uploads", {
      method: "POST",
      headers: { "X-File-Name": "voice.m4a" },
      body: "audio",
    }),
    createEnv({ DB: db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "email_unverified");
  assert.equal(putCalled, false);
});

test("allows the bootstrap admin to invite users and send email", async () => {
  const invitationInserts = [];
  const emails = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /INSERT INTO invitations/);
      return statement({
        run: async (values) => {
          invitationInserts.push(values);
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new-user@example.com", role: "user" }),
    }),
    createEnv({
      DB: db,
      EMAIL: {
        send: async (message) => {
          emails.push(message);
        },
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.invitation.email, "new-user@example.com");
  assert.equal(body.invitation.role, "user");
  assert.match(body.invitation.invite_url, /accept-invite/);
  assert.equal(invitationInserts.length, 1);
  assert.equal(invitationInserts[0][1], "new-user@example.com");
  assert.equal(invitationInserts[0][4], "default_user");
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "new-user@example.com");
});

test("stores publishing credentials encrypted and exposes them only to internal callers", async () => {
  let publishingRow = null;
  const db = {
    prepare(sql) {
      if (sql.includes("FROM sessions")) {
        return sessionStatement({
          id: "usr_publisher",
          email: "publisher@example.com",
          role: "user",
          workspace_id: "ws_publisher",
          email_verified_at: "2026-07-07T00:00:00.000Z",
        });
      }
      if (sql.includes("SELECT app_secret_ciphertext FROM publishing_accounts")) {
        return statement({ all: async () => ({ results: [] }) });
      }
      if (sql.includes("INSERT INTO publishing_accounts")) {
        return statement({
          run: async (values) => {
            publishingRow = {
              user_id: values[0],
              app_id: values[1],
              app_secret_ciphertext: values[2],
              proxy_url: values[3],
              updated_at: values[5],
            };
            return { meta: { changes: 1 } };
          },
        });
      }
      if (sql.includes("SELECT app_id, proxy_url, updated_at FROM publishing_accounts")) {
        return statement({
          all: async () => ({
            results: publishingRow
              ? [{
                  app_id: publishingRow.app_id,
                  proxy_url: publishingRow.proxy_url,
                  updated_at: publishingRow.updated_at,
                }]
              : [],
          }),
        });
      }
      if (sql.includes("SELECT app_id, app_secret_ciphertext, proxy_url, updated_at FROM publishing_accounts")) {
        return statement({
          all: async () => ({
            results: publishingRow
              ? [{
                  app_id: publishingRow.app_id,
                  app_secret_ciphertext: publishingRow.app_secret_ciphertext,
                  proxy_url: publishingRow.proxy_url,
                  updated_at: publishingRow.updated_at,
                }]
              : [],
          }),
        });
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const updateResponse = await worker.fetch(
    sessionRequest("https://example.test/api/publishing-account", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: "wx123",
        app_secret: "secret-value",
        proxy_url: "https://proxy.example.test",
      }),
    }),
    createEnv({
      DB: db,
      CREDENTIAL_ENCRYPTION_KEY: "test-credential-key",
    }),
    createExecutionContext(),
  );

  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).publishing_account.connected, true);
  assert.equal(publishingRow.user_id, "usr_publisher");
  assert.notEqual(publishingRow.app_secret_ciphertext, "secret-value");
  assert.match(publishingRow.app_secret_ciphertext, /^v1:/);

  const internalResponse = await worker.fetch(
    new Request("https://example.test/api/internal/publishing-account", {
      method: "POST",
      headers: {
        "Authorization": "Bearer mining-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: "usr_publisher" }),
    }),
    createEnv({
      DB: db,
      MINING_SERVICE_TOKEN: "mining-token",
      CREDENTIAL_ENCRYPTION_KEY: "test-credential-key",
    }),
    createExecutionContext(),
  );

  assert.equal(internalResponse.status, 200);
  const internalAccount = (await internalResponse.json()).publishing_account;
  assert.equal(internalAccount.app_secret, "secret-value");
  assert.equal(internalAccount.updated_at, publishingRow.updated_at);

  const resolverResponse = await worker.fetch(
    new Request("https://example.test/api/internal/publishing-account", {
      method: "POST",
      headers: {
        "Authorization": "Bearer resolver-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: "usr_publisher" }),
    }),
    createEnv({
      DB: db,
      PUBLISHING_ACCOUNT_RESOLVER_TOKEN: "resolver-token",
      CREDENTIAL_ENCRYPTION_KEY: "test-credential-key",
    }),
    createExecutionContext(),
  );
  assert.equal(resolverResponse.status, 200);
  assert.equal((await resolverResponse.json()).publishing_account.app_secret, "secret-value");
});

test("keeps rich recording fields when only processing_stage is not migrated yet", async () => {
  const sqlCalls = [];
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      if (/\n\s*processing_stage,/.test(sql)) {
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: processing_stage");
          },
        });
      }
      return statement({
        all: async () => ({
          results: [
            {
              id: 1,
              filename: "legacy.m4a",
              status: "COMPLETED",
              created_at: "2026-06-29 08:00:00",
              updated_at: "2026-06-29 08:01:00",
              article_title: "旧库文章",
              raw_text_preview: "旧库转录预览",
              processing_stage: null,
              wechat_url: null,
              wechat_draft_id: "MEDIA_ID_OLD",
              error_message: null,
            },
          ],
        }),
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recordings[0].article_title, "旧库文章");
  assert.equal(body.recordings[0].processing_stage, null);
  assert.equal(body.recordings[0].duration_ms, null);
  assert.equal(body.recordings[0].wechat_draft_id, "MEDIA_ID_OLD");
  assert.equal(body.recordings[0].cover_image_url, null);
  const recordingQueries = sqlCalls.filter((sql) => /FROM recordings/.test(sql));
  assert.equal(recordingQueries.length, 2);
  assert.match(recordingQueries[0], /\n\s*processing_stage,/);
  assert.match(recordingQueries[1], /NULL AS processing_stage/);
});

test("keeps processing stage when only duration column is not migrated yet", async () => {
  const sqlCalls = [];
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      if (/\n\s*duration_ms,/.test(sql)) {
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: duration_ms");
          },
        });
      }
      return statement({
        all: async () => ({
          results: [
            {
              id: 1,
              filename: "legacy-duration.m4a",
              status: "PROCESSING",
              created_at: "2026-06-29 08:00:00",
              updated_at: "2026-06-29 08:01:00",
              article_title: "旧库文章",
              raw_text_preview: "旧库转录预览",
              processing_stage: "DRAFTING",
              wechat_url: null,
              wechat_draft_id: null,
              error_message: null,
            },
          ],
        }),
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings"),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recordings[0].duration_ms, null);
  assert.equal(body.recordings[0].processing_stage, "DRAFTING");
  assert.equal(body.recordings[0].cover_image_url, null);
  const recordingQueries = sqlCalls.filter((sql) => /FROM recordings/.test(sql));
  assert.equal(recordingQueries.length, 2);
  assert.match(recordingQueries[0], /\n\s*duration_ms,/);
  assert.match(recordingQueries[1], /NULL AS duration_ms/);
  assert.match(recordingQueries[1], /\n\s*processing_stage,/);
});

test("stores parsed duration on upload when duration column exists", async () => {
  const putCalls = [];
  const sqlCalls = [];
  const valueCalls = [];
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      const prepareIndex = sqlCalls.length;
      return statement({
        run: async (values) => {
          valueCalls.push(values);
          return { meta: { changes: prepareIndex === 1 ? 0 : 1 } };
        },
      });
    },
  };
  const bucket = {
    async put(key, body, options) {
      putCalls.push({ key, body, options });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/uploads", {
      method: "POST",
      headers: {
        "X-File-Name": "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
        "X-Style-Profile-Id": "style_product_review",
        "X-Style-Profile-Version": "2026-07-05",
        "X-Style-Profile-Name-B64": Buffer.from("我的产品复盘风格").toString("base64"),
        "X-Style-Profile-Description-B64": Buffer.from("保留具体排查过程").toString("base64"),
        "X-Style-Profile-Body-B64": Buffer.from("请用真实克制的产品复盘风格写作。").toString("base64"),
        "X-Layout-Profile-Id": "wechat_clean_article",
        "X-Layout-Profile-Version": "2026-07-05",
      },
      body: "audio",
    }),
    createEnv({ DB: db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 201);
  assert.equal(putCalls.length, 2);
  assert.equal(putCalls[0].options.customMetadata.styleProfileId, "style_product_review");
  assert.equal(putCalls[0].options.customMetadata.layoutProfileId, "wechat_clean_article");
  assert.equal(putCalls[1].key, "users/default_user/profile-selections/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a.json");
  const sidecarBody = JSON.parse(String(putCalls[1].body));
  assert.equal(sidecarBody.styleProfileName, "我的产品复盘风格");
  assert.equal(sidecarBody.styleProfileBody, "请用真实克制的产品复盘风格写作。");
  assert.match(String(sqlCalls[0]), /duration_ms = COALESCE/);
  assert.match(String(sqlCalls[1]), /processing_stage, duration_ms/);
  assert.deepEqual(valueCalls[0].slice(0, 4), [
    "users/default_user/inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
    18_000,
  ]);
  assert.deepEqual(valueCalls[0].slice(4, 8), [
    "style_product_review",
    "2026-07-05",
    "wechat_clean_article",
    "2026-07-05",
  ]);
  assert.deepEqual(valueCalls[1].slice(0, 6), [
    "default_user",
    "vibepub-dogfood",
    "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "users/default_user/inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
  ]);
  assert.equal(valueCalls[1][6], 18_000);
  assert.deepEqual(valueCalls[1].slice(7, 11), [
    "style_product_review",
    "2026-07-05",
    "wechat_clean_article",
    "2026-07-05",
  ]);
});

test("keeps upload stage when only duration column is not migrated yet", async () => {
  const sqlCalls = [];
  const valueCalls = [];
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      const prepareIndex = sqlCalls.length;
      return statement({
        run: async (values) => {
          valueCalls.push(values);
          if (prepareIndex === 1) {
            throw new Error("D1_ERROR: no such column: duration_ms");
          }
          return { meta: { changes: prepareIndex === 2 ? 0 : 1 } };
        },
      });
    },
  };
  const bucket = {
    async put() {},
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/uploads", {
      method: "POST",
      headers: { "X-File-Name": "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a" },
      body: "audio",
    }),
    createEnv({ DB: db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 201);
  assert.match(String(sqlCalls[0]), /duration_ms = COALESCE/);
  assert.doesNotMatch(String(sqlCalls[1]), /duration_ms/);
  assert.match(String(sqlCalls[1]), /processing_stage/);
  assert.doesNotMatch(String(sqlCalls[2]), /duration_ms/);
  assert.match(String(sqlCalls[2]), /processing_stage/);
  assert.deepEqual(valueCalls[1].slice(0, 3), [
    "users/default_user/inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
  ]);
  assert.deepEqual(valueCalls[2].slice(0, 5), [
    "default_user",
    "vibepub-dogfood",
    "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "users/default_user/inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
  ]);
  assert.equal(valueCalls[2][5], "QUEUED");
});

test("dispatches mining workflow for the uploaded filename", async () => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  const waitUntilPromises = [];
  globalThis.fetch = async (url, init = {}) => {
    dispatches.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body || "{}")),
    });
    return new Response(null, { status: 204 });
  };

  try {
    const bucket = {
      async put() {},
    };
    const context = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    };

    const response = await worker.fetch(
      authorizedRequest("https://example.test/api/uploads", {
        method: "POST",
        headers: { "X-File-Name": "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a" },
        body: "audio",
      }),
      createEnv({
        FILES_BUCKET: bucket,
        GITHUB_PAT: "github-token",
        GITHUB_WORKFLOW_REF: "main",
      }),
      context,
    );

    assert.equal(response.status, 201);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(dispatches.length, 1);
  assert.equal(
    dispatches[0].url,
    "https://api.github.com/repos/litianc/vibepub-android/actions/workflows/mining-job.yml/dispatches",
  );
  assert.equal(dispatches[0].init.method, "POST");
  assert.equal(dispatches[0].body.ref, "main");
  assert.deepEqual(dispatches[0].body.inputs, {
    target_filename: "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    target_key: "users/default_user/inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    user_id: "default_user",
  });
});

test("creates text submission and dispatches mining workflow", async () => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  const putCalls = [];
  const sqlCalls = [];
  const valueCalls = [];
  const waitUntilPromises = [];
  globalThis.fetch = async (url, init = {}) => {
    dispatches.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body || "{}")),
    });
    return new Response(null, { status: 204 });
  };

  try {
    const bucket = {
      async put(key, body, options) {
        putCalls.push({ key, body, options });
      },
    };
    const db = {
      prepare(sql) {
        sqlCalls.push(sql);
        const prepareIndex = sqlCalls.length;
        return statement({
          run: async (values) => {
            valueCalls.push(values);
            return { meta: { changes: prepareIndex === 1 ? 0 : 1 } };
          },
        });
      },
    };
    const context = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    };

    const response = await worker.fetch(
      authorizedRequest("https://example.test/api/text-submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "这是一段手动输入的文字，后续应该直接进入文章改写流程。",
          title_hint: "文字输入测试",
          source: "android_text",
          style_profile_id: "style_product_review",
          style_profile_version: "2026-07-05",
          style_profile_name: "我的产品复盘风格",
          style_profile_description: "保留具体排查过程",
          style_profile_body: "请用真实克制的产品复盘风格写作。",
          layout_profile_id: "wechat_clean_article",
          layout_profile_version: "2026-07-05",
        }),
      }),
      createEnv({
        FILES_BUCKET: bucket,
        DB: db,
        GITHUB_PAT: "github-token",
      }),
      context,
    );

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.match(body.filename, /^VibePub-.+-Text-.+\.txt$/);
    assert.equal(body.status, "PROCESSING");
    assert.equal(body.processing_stage, "REWRITING");
    assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].key, `users/default_user/text-submissions/${body.filename}`);
    assert.equal(putCalls[0].options.httpMetadata.contentType, "application/json; charset=utf-8");
    const textPayload = JSON.parse(String(putCalls[0].body));
    assert.equal(textPayload.text, "这是一段手动输入的文字，后续应该直接进入文章改写流程。");
    assert.equal(textPayload.styleProfileId, "style_product_review");
    assert.equal(textPayload.styleProfileBody, "请用真实克制的产品复盘风格写作。");
    assert.equal(textPayload.layoutProfileId, "wechat_clean_article");
    assert.equal(putCalls[0].options.customMetadata.styleProfileId, "style_product_review");
    assert.equal(putCalls[0].options.customMetadata.layoutProfileId, "wechat_clean_article");
    assert.match(sqlCalls[0], /source_type/);
    assert.match(sqlCalls[1], /source_type/);
    assert.match(sqlCalls[2], /editorial_recording_scopes/);
    assert.deepEqual(valueCalls[1].slice(0, 10), [
      "default_user",
      "vibepub-dogfood",
      body.filename,
      `users/default_user/text-submissions/${body.filename}`,
      "PROCESSING",
      "REWRITING",
      0,
      "这是一段手动输入的文字，后续应该直接进入文章改写流程。",
      "文字输入测试",
      "TEXT",
    ]);
    assert.deepEqual(valueCalls[1].slice(10, 14), [
      "style_product_review",
      "2026-07-05",
      "wechat_clean_article",
      "2026-07-05",
    ]);
    assert.deepEqual(valueCalls[2], [
      "default_user",
      "vibepub-dogfood",
      "default_user",
      body.filename,
    ]);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].body.inputs, {
    target_filename: putCalls[0].key.replace("users/default_user/text-submissions/", ""),
    target_key: putCalls[0].key,
    user_id: "default_user",
  });
});

test("keeps text submission compatible before the editorial scope migration", async () => {
  const sqlCalls = [];
  const bucket = { async put() {} };
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      return statement({
        run: async () => {
          if (sql.includes("editorial_recording_scopes")) throw new Error("no such table: editorial_recording_scopes");
          return { meta: { changes: sql.includes("UPDATE recordings") ? 0 : 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/text-submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "这是一条迁移前仍应接受的合成文字提交。" }),
    }),
    createEnv({ DB: db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 202);
  assert.match(sqlCalls.at(-1), /editorial_recording_scopes/);
});

test("creates voice article revision request and dispatches mining workflow with revision key", async () => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  const putCalls = [];
  const getCalls = [];
  const waitUntilPromises = [];
  globalThis.fetch = async (url, init = {}) => {
    dispatches.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body || "{}")),
    });
    return new Response(null, { status: 204 });
  };

  try {
    const bucket = {
      async get(key) {
        getCalls.push(key);
        return { body: "transcript" };
      },
      async put(key, body, options) {
        putCalls.push({ key, body, options });
      },
    };
    const state = articleRevisionState();
    const context = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    };

    const response = await worker.fetch(
      authorizedRequest("https://example.test/api/recordings/VibePub-2026-07-02-160000-0m18s-Test.m4a/revisions", {
        method: "POST",
        headers: { "Content-Type": "audio/mp4" },
        body: "revision audio",
      }),
      createEnv({
        FILES_BUCKET: bucket,
        DB: state.db,
        GITHUB_PAT: "github-token",
        GITHUB_WORKFLOW_REF: "main",
      }),
      context,
    );

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, "queued");
    assert.match(body.revision_request_key, /^users\/default_user\/revision-requests\/VibePub-2026-07-02-160000-0m18s-Test\/.+\.json$/);
    assert.deepEqual(getCalls, [
      "users/default_user/transcripts/VibePub-2026-07-02-160000-0m18s-Test.json",
    ]);
    assert.equal(putCalls.length, 2);
    assert.match(putCalls[0].key, /^users\/default_user\/revision-requests\/VibePub-2026-07-02-160000-0m18s-Test\/.+\.m4a$/);
    assert.equal(putCalls[0].options.httpMetadata.contentType, "audio/mp4");
    assert.equal(putCalls[1].key, body.revision_request_key);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].body.inputs, {
    target_filename: "VibePub-2026-07-02-160000-0m18s-Test.m4a",
    user_id: "default_user",
    revision_request_key: putCalls[1].key,
  });
});

test("rejects article revision before transcript exists", async () => {
  const bucket = {
    async get() {
      return null;
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
      method: "POST",
      body: "revision audio",
    }),
    createEnv({ FILES_BUCKET: bucket, DB: articleRevisionState().db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "article_not_ready");
});

test("versioned article revision binds the latest version and stores the Mining contract", async () => {
  const state = articleRevisionState();
  const putCalls = [];
  const bucket = {
    async get() { return { body: "transcript" }; },
    async put(key, body, options) { putCalls.push({ key, body, options }); },
  };
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
      method: "POST",
      headers: {
        "Content-Type": "audio/mp4",
        "X-Article-Version-Id": "version_2",
        "X-Revision-Request-Id": "client_revision_1",
        "X-Revision-Feedback-Id": "feedback_revision_1",
        "X-Revision-Audio-Sha256": "sha256:audio_1",
      },
      body: "revision audio",
    }),
    createEnv({ DB: state.db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual({
    parent_version_id: body.parent_version_id,
    continue_revision: body.continue_revision,
    feedback: body.feedback,
    status: body.status,
    replayed: body.replayed,
  }, {
    parent_version_id: "version_2",
    continue_revision: { accepted: true, parent_version_id: "version_2" },
    feedback: { id: "feedback_revision_1", version_id: "version_2", action: "continue_revision" },
    status: "queued",
    replayed: false,
  });
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].client_request_id, "client_revision_1");
  assert.equal(state.requests[0].feedback_id, "feedback_revision_1");
  const contract = JSON.parse(String(putCalls[1].body));
  assert.deepEqual(Object.keys(contract), [
    "revisionId", "clientRequestId", "filename", "userId", "workspaceId", "recordingId",
    "articleId", "parentVersionId", "parentTitle", "parentContent", "transcriptKey",
    "audioKey", "audioSha256", "feedbackId", "createdAt",
  ]);
});

test("old App selects the latest Article Version", async () => {
  const state = articleRevisionState();
  const response = await worker.fetch(authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "Content-Type": "audio/mp4" },
    body: "legacy revision audio",
  }), createEnv({
    DB: state.db,
    FILES_BUCKET: { async get() { return { body: "transcript" }; }, async put() {} },
  }), createExecutionContext());

  assert.equal(response.status, 202);
  assert.equal((await response.json()).parent_version_id, "version_2");
  assert.match(state.requests[0].client_request_id, /^legacy_/);
});

test("stable request ID without a parent header replays its original parent", async () => {
  const state = articleRevisionState();
  const bucket = { async get() { return { body: "transcript" }; }, async put() {} };
  const env = createEnv({ DB: state.db, FILES_BUCKET: bucket });
  const firstRequest = authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "Content-Type": "audio/mp4", "X-Revision-Request-Id": "client_replay", "X-Revision-Audio-Sha256": "sha256:same" },
    body: "same audio",
  });
  const first = await worker.fetch(firstRequest, env, createExecutionContext());
  assert.equal(first.status, 202);
  assert.equal((await first.json()).parent_version_id, "version_2");

  state.versions.push({
    ...state.versions[1], id: "version_3", version_no: 3,
    parent_version_id: "version_2", title: "Title 3", body: "Body 3",
  });

  const replay = await worker.fetch(authorizedRequest(firstRequest.url, {
    method: "POST",
    headers: { "Content-Type": "audio/mp4", "X-Revision-Request-Id": "client_replay", "X-Revision-Audio-Sha256": "sha256:same" },
    body: "same audio",
  }), env, createExecutionContext());
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(state.requests.length, 1);
});

test("article revision rejects payload conflicts and stale parents without R2 writes", async () => {
  const state = articleRevisionState();
  const putCalls = [];
  const bucket = {
    async get() { return { body: "transcript" }; },
    async put(...args) { putCalls.push(args); },
  };
  const env = createEnv({ DB: state.db, FILES_BUCKET: bucket });
  const endpoint = "https://example.test/api/recordings/voice.m4a/revisions";
  const headers = {
    "Content-Type": "audio/mp4", "X-Article-Version-Id": "version_2",
    "X-Revision-Request-Id": "client_conflict", "X-Revision-Audio-Sha256": "sha256:one",
  };
  assert.equal((await worker.fetch(authorizedRequest(endpoint, { method: "POST", headers, body: "one" }), env, createExecutionContext())).status, 202);

  const conflict = await worker.fetch(authorizedRequest(endpoint, {
    method: "POST",
    headers: { ...headers, "X-Revision-Audio-Sha256": "sha256:two" },
    body: "two",
  }), env, createExecutionContext());
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");

  const sameClaimedHashDifferentAudio = await worker.fetch(authorizedRequest(endpoint, {
    method: "POST",
    headers,
    body: "different bytes with the same claimed hash",
  }), env, createExecutionContext());
  assert.equal(sameClaimedHashDifferentAudio.status, 409);
  assert.equal((await sameClaimedHashDifferentAudio.json()).error, "idempotency_conflict");

  const duplicate = await worker.fetch(authorizedRequest(endpoint, {
    method: "POST",
    headers: { ...headers, "X-Revision-Request-Id": "client_second" },
    body: "one",
  }), env, createExecutionContext());
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, "revision_parent_conflict");

  const writesBeforeStale = putCalls.length;
  const stale = await worker.fetch(authorizedRequest(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "X-Article-Version-Id": "version_1",
      "X-Revision-Request-Id": "client_stale",
      "X-Revision-Audio-Sha256": "sha256:stale",
    },
    body: "stale",
  }), env, createExecutionContext());
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "stale_article_version");
  assert.equal(putCalls.length, writesBeforeStale);
});

test("article revision does not disguise unknown database failures as conflicts", async () => {
  const state = articleRevisionState();
  state.failures.requestInsert = true;
  const response = await worker.fetch(authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "X-Revision-Request-Id": "client_db_failure" },
    body: "revision audio",
  }), createEnv({
    DB: state.db,
    FILES_BUCKET: { async get() { return { body: "transcript" }; }, async put() {} },
  }), createExecutionContext());

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "article_revision_write_unavailable");
});

test("internal revision version creates one child and exact replay returns it", async () => {
  const state = articleRevisionState();
  const bucket = { async get() { return { body: "transcript" }; }, async put() {} };
  const env = createEnv({ DB: state.db, FILES_BUCKET: bucket, MINING_V3_HANDOFF_TOKEN: "handoff-token" });
  const queued = await worker.fetch(authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "X-Revision-Request-Id": "client_internal", "X-Revision-Audio-Sha256": "sha256:internal" },
    body: "internal audio",
  }), env, createExecutionContext());
  const revisionId = (await queued.json()).revision_id;
  const versionBody = { title: "Revised title", content: "Revised body", prepared_artifact_key: "prepared/revision.json" };
  const endpoint = `https://example.test/api/internal/v3/article-revisions/${revisionId}/version`;

  const first = await worker.fetch(internalRevisionRequest(endpoint, versionBody), env, createExecutionContext());
  assert.equal(first.status, 201);
  const child = await first.json();
  assert.deepEqual(child.version, {
    id: child.child_version_id,
    version_no: 3,
    parent_version_id: "version_2",
  });
  assert.equal(child.replayed, false);
  assert.deepEqual(state.versions[2].blocks, [{
    block_id: "block_1",
    kind: "paragraph",
    order: 0,
    text: "Revised body",
    claim_ids: [],
    image_ids: [],
  }]);
  assert.deepEqual(state.versionStates, [{ version_id: child.child_version_id, state: "content_frozen" }]);

  const replay = await worker.fetch(internalRevisionRequest(endpoint, { ...versionBody, body: versionBody.content }), env, createExecutionContext());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).child_version_id, child.child_version_id);
  assert.equal(state.versions.length, 3);
  const conflict = await worker.fetch(internalRevisionRequest(endpoint, { ...versionBody, content: "Different body" }), env, createExecutionContext());
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "revision_version_conflict");
  assert.deepEqual(state.recording, {
    id: 81,
    filename: "voice.m4a",
    article_title: "Revised title",
    article_content: "Revised body",
  });
});

test("internal revision version does not disguise unknown database failures as conflicts", async () => {
  const state = articleRevisionState();
  const env = createEnv({
    DB: state.db,
    FILES_BUCKET: { async get() { return { body: "transcript" }; }, async put() {} },
    MINING_V3_HANDOFF_TOKEN: "handoff-token",
  });
  const queued = await worker.fetch(authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "X-Revision-Request-Id": "client_version_db_failure" },
    body: "revision audio",
  }), env, createExecutionContext());
  const revisionId = (await queued.json()).revision_id;
  state.failures.versionInsert = true;

  const response = await worker.fetch(internalRevisionRequest(
    `https://example.test/api/internal/v3/article-revisions/${revisionId}/version`,
    { title: "Revised", body: "Revised body" },
  ), env, createExecutionContext());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "revision_version_write_unavailable");
});

test("internal revision replay does not replace a newer recording projection", async () => {
  const state = articleRevisionState();
  const env = createEnv({
    DB: state.db,
    FILES_BUCKET: { async get() { return { body: "transcript" }; }, async put() {} },
    MINING_V3_HANDOFF_TOKEN: "handoff-token",
  });
  const queued = await worker.fetch(authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "X-Revision-Request-Id": "client_stale_projection" },
    body: "revision audio",
  }), env, createExecutionContext());
  const revisionId = (await queued.json()).revision_id;
  const endpoint = `https://example.test/api/internal/v3/article-revisions/${revisionId}/version`;
  const versionBody = { title: "Version 3", body: "Body 3" };
  assert.equal((await worker.fetch(internalRevisionRequest(endpoint, versionBody), env, createExecutionContext())).status, 201);

  state.versions.push({
    ...state.versions.at(-1), id: "version_4", version_no: 4,
    parent_version_id: state.versions.at(-1).id, title: "Version 4", body: "Body 4",
  });
  state.recording.article_title = "Version 4";
  state.recording.article_content = "Body 4";

  const replay = await worker.fetch(internalRevisionRequest(endpoint, versionBody), env, createExecutionContext());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(state.recording.article_title, "Version 4");
  assert.equal(state.recording.article_content, "Body 4");
});

test("internal revision replay cannot race a newer recording projection", async () => {
  const state = articleRevisionState();
  const env = createEnv({
    DB: state.db,
    FILES_BUCKET: { async get() { return { body: "transcript" }; }, async put() {} },
    MINING_V3_HANDOFF_TOKEN: "handoff-token",
  });
  const queued = await worker.fetch(authorizedRequest("https://example.test/api/recordings/voice.m4a/revisions", {
    method: "POST",
    headers: { "X-Revision-Request-Id": "client_projection_race" },
    body: "revision audio",
  }), env, createExecutionContext());
  const revisionId = (await queued.json()).revision_id;
  const endpoint = `https://example.test/api/internal/v3/article-revisions/${revisionId}/version`;
  const versionBody = { title: "Version 3", body: "Body 3" };
  assert.equal((await worker.fetch(internalRevisionRequest(endpoint, versionBody), env, createExecutionContext())).status, 201);

  state.hooks.beforeProjectionUpdate = () => {
    state.versions.push({
      ...state.versions.at(-1), id: "version_4", version_no: 4,
      parent_version_id: state.versions.at(-1).id, title: "Version 4", body: "Body 4",
    });
    state.recording.article_title = "Version 4";
    state.recording.article_content = "Body 4";
  };
  const replay = await worker.fetch(internalRevisionRequest(endpoint, versionBody), env, createExecutionContext());

  assert.equal(replay.status, 200);
  assert.equal(state.recording.article_title, "Version 4");
  assert.equal(state.recording.article_content, "Body 4");
});

test("internal revision completion replays and WeChat failure preserves the parent version", async () => {
  const state = articleRevisionState();
  const requestObjects = [];
  const bucket = {
    async get() { return { body: "transcript" }; },
    async put(key, body) {
      if (String(key).endsWith(".json")) requestObjects.push({ key, body: String(body) });
    },
  };
  const env = createEnv({ DB: state.db, FILES_BUCKET: bucket, MINING_V3_HANDOFF_TOKEN: "handoff-token" });
  const publicHeaders = {
    "X-Article-Version-Id": "version_2",
    "X-Revision-Request-Id": "client_status",
    "X-Revision-Audio-Sha256": "sha256:status",
  };
  const publicEndpoint = "https://example.test/api/recordings/voice.m4a/revisions";
  const queued = await worker.fetch(authorizedRequest(publicEndpoint, {
    method: "POST", headers: publicHeaders, body: "status audio",
  }), env, createExecutionContext());
  const revisionId = (await queued.json()).revision_id;
  await worker.fetch(internalRevisionRequest(
    `https://example.test/api/internal/v3/article-revisions/${revisionId}/version`,
    { title: "Child title", body: "Child body" },
  ), env, createExecutionContext());

  const statusEndpoint = `https://example.test/api/internal/v3/article-revisions/${revisionId}/status`;
  const failed = await worker.fetch(internalRevisionRequest(statusEndpoint, {
    status: "wechat_failed", error_message: "wechat timeout",
  }), env, createExecutionContext());
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).status, "wechat_failed");
  assert.deepEqual({ title: state.versions[1].title, body: state.versions[1].body }, { title: "Title 2", body: "Body 2" });

  const requestContract = requestObjects[0].body;
  const recovered = await worker.fetch(authorizedRequest(publicEndpoint, {
    method: "POST", headers: publicHeaders, body: "status audio",
  }), env, createExecutionContext());
  assert.equal(recovered.status, 202);
  assert.deepEqual(await recovered.json(), {
    ok: true,
    revision_id: revisionId,
    parent_version_id: "version_2",
    continue_revision: { accepted: true, parent_version_id: "version_2" },
    feedback: {
      id: state.requests[0].feedback_id,
      version_id: "version_2",
      action: "continue_revision",
    },
    status: "wechat_failed",
    replayed: true,
    revision_request_key: state.requests[0].request_key,
  });
  assert.equal(requestObjects.at(-1).body, requestContract);

  const completed = await worker.fetch(internalRevisionRequest(statusEndpoint, { status: "completed" }), env, createExecutionContext());
  assert.equal((await completed.json()).replayed, false);
  const completionReplay = await worker.fetch(internalRevisionRequest(statusEndpoint, { status: "completed" }), env, createExecutionContext());
  assert.deepEqual(await completionReplay.json(), {
    revision_id: revisionId,
    child_version_id: state.versions[2].id,
    status: "completed",
    replayed: true,
  });
  const delayedFailure = await worker.fetch(internalRevisionRequest(statusEndpoint, {
    status: "wechat_failed",
    error_message: "late timeout",
  }), env, createExecutionContext());
  assert.deepEqual(await delayedFailure.json(), {
    revision_id: revisionId,
    child_version_id: state.versions[2].id,
    status: "completed",
    replayed: true,
  });
});

test("persists mining status metadata for Android progress display", async () => {
  let boundValues = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /processing_stage = COALESCE/);
      assert.match(sql, /error_message = CASE WHEN \? = 1 THEN \? ELSE error_message END/);
      return statement({
        run: async (values) => {
          boundValues = values;
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "PROCESSING",
        rawText: "口述内容",
        articleTitle: "整理标题",
        articleContent: "整理正文",
        processingStage: "DRAFTING",
        wechatDraftId: "MEDIA_ID_123",
        coverImageUrl: "https://example.test/api/files/covers%2Fvoice.png",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(boundValues, [
    "PROCESSING",
    "口述内容",
    "整理标题",
    "整理正文",
    "DRAFTING",
    null,
    "MEDIA_ID_123",
    "https://example.test/api/files/covers%2Fvoice.png",
    1,
    null,
    "default_user",
    "voice.m4a",
  ]);
});

test("keeps rich status updates before cover image column is migrated", async () => {
  const sqlCalls = [];
  const valueCalls = [];
  const db = {
    prepare(sql) {
      sqlCalls.push(sql);
      const prepareIndex = sqlCalls.length;
      return statement({
        run: async (values) => {
          valueCalls.push(values);
          if (prepareIndex === 1) {
            throw new Error("D1_ERROR: no such column: cover_image_url");
          }
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "PROCESSING",
        rawText: "口述内容",
        articleTitle: "整理标题",
        articleContent: "整理正文",
        processingStage: "DRAFTING",
        wechatDraftId: "MEDIA_ID_123",
        coverImageUrl: "https://example.test/api/files/covers%2Fvoice.png",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(String(sqlCalls[0]), /cover_image_url = COALESCE/);
  assert.doesNotMatch(String(sqlCalls[1]), /cover_image_url/);
  assert.deepEqual(valueCalls[1], [
    "PROCESSING",
    "口述内容",
    "整理标题",
    "整理正文",
    "DRAFTING",
    null,
    "MEDIA_ID_123",
    1,
    null,
    "default_user",
    "voice.m4a",
  ]);
});

test("does not persist placeholder draft references from status updates", async () => {
  let boundValues = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /wechat_url = COALESCE/);
      assert.match(sql, /wechat_draft_id = COALESCE/);
      return statement({
        run: async (values) => {
          boundValues = values;
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "COMPLETED",
        processingStage: "COMPLETED",
        wechatUrl: " null ",
        wechatDraftId: "undefined",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(boundValues.slice(5, 8), [null, null, null]);
});

test("keeps valid draft URL and ID from status updates", async () => {
  let boundValues = [];
  const db = {
    prepare() {
      return statement({
        run: async (values) => {
          boundValues = values;
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "COMPLETED",
        processingStage: "COMPLETED",
        wechatUrl: " https://mp.weixin.qq.com/draft ",
        wechatDraftId: " MEDIA_ID_123 ",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(boundValues.slice(5, 8), [
    "https://mp.weixin.qq.com/draft",
    "MEDIA_ID_123",
    null,
  ]);
});

test("clears stale status error when progress resumes without an error message", async () => {
  let boundValues = [];
  const db = {
    prepare() {
      return statement({
        run: async (values) => {
          boundValues = values;
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "PROCESSING",
        processingStage: "ASR",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(boundValues.slice(8, 10), [1, null]);
});

test("preserves stale status error when failed update has no replacement message", async () => {
  let boundValues = [];
  const db = {
    prepare() {
      return statement({
        run: async (values) => {
          boundValues = values;
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "FAILED",
        processingStage: "ASR",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(boundValues.slice(8, 10), [0, null]);
});

test("persists snake_case status error for draft failure metadata", async () => {
  let boundValues = [];
  const db = {
    prepare() {
      return statement({
        run: async (values) => {
          boundValues = values;
          return { meta: { changes: 1 } };
        },
      });
    },
  };

  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/internal/status", {
      method: "PUT",
      body: JSON.stringify({
        filename: "voice.m4a",
        status: "COMPLETED",
        processing_stage: "DRAFT_FAILED",
        error_message: "公众号草稿创建失败：502",
      }),
    }),
    createEnv({ DB: db }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(boundValues.slice(8, 10), [1, "公众号草稿创建失败：502"]);
});

test("proxies style profile listing to WritingAgent with server-side token", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      style_profiles: [
        { id: "style_litianc_default", name: "默认风格" },
        { id: "style_my_old_articles", name: "我的旧文风格" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  try {
    const response = await worker.fetch(
      authorizedRequest("https://example.test/api/style-profiles?workspace_id=vibepub-dogfood"),
      createEnv({
        WRITING_AGENT_BASE_URL: "https://writing-agent.example.test",
        WRITING_AGENT_TOKEN: "writing-token",
      }),
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      style_profiles: [
        { id: "style_litianc_default", name: "默认风格" },
        { id: "style_my_old_articles", name: "我的旧文风格" },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://writing-agent.example.test/v1/style-profiles?workspace_id=vibepub-dogfood",
  );
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer writing-token");
});

test("proxies style source imports without exposing WritingAgent token to Android", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: String(init.body || "") });
    return new Response(JSON.stringify({
      source_import: {
        id: "ssi_1",
        source_type: "wechat_article",
        title: "参考文章",
        status: "ready",
      },
    }), {
      status: 201,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  try {
    const response = await worker.fetch(
      authorizedRequest("https://example.test/api/style-source-imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "wechat_article",
          url: "https://mp.weixin.qq.com/s/example",
          title: "参考文章",
          text: "有现场感的旧文章。",
        }),
      }),
      createEnv({
        WRITING_AGENT_BASE_URL: "https://writing-agent.example.test/",
        WRITING_AGENT_TOKEN: "writing-token",
      }),
      createExecutionContext(),
    );

    assert.equal(response.status, 201);
    assert.equal((await response.json()).source_import.id, "ssi_1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://writing-agent.example.test/v1/style-source-imports?workspace_id=vibepub-dogfood");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer writing-token");
  assert.equal(calls[0].init.headers.get("X-VibePub-User-Id"), "default_user");
  assert.equal(calls[0].init.headers.get("X-VibePub-Workspace-Id"), "vibepub-dogfood");
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
  assert.equal(JSON.parse(calls[0].body).title, "参考文章");
});

test("returns a clear error when WritingAgent proxy is not configured", async () => {
  const response = await worker.fetch(
    authorizedRequest("https://example.test/api/style-profiles"),
    createEnv({ WRITING_AGENT_BASE_URL: "", WRITING_AGENT_TOKEN: "" }),
    createExecutionContext(),
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "writing_agent_unconfigured");
});

async function loadWorker() {
  const sourcePath = resolve("src/index.ts");
  const pipelinePath = resolve("src/editorialPipeline.ts");
  const contractsPath = resolve("src/editorialContracts.ts");
  const contracts = transpile(await readFile(contractsPath, "utf8"), contractsPath);
  const contractsUrl = moduleDataUrl(contracts);
  const pipeline = transpile(await readFile(pipelinePath, "utf8"), pipelinePath)
    .replaceAll('from "./editorialContracts"', `from ${JSON.stringify(contractsUrl)}`);
  const pipelineUrl = moduleDataUrl(pipeline);
  const publicationProjectionPath = resolve("src/publicationProjection.ts");
  const publicationProjection = transpile(await readFile(publicationProjectionPath, "utf8"), publicationProjectionPath)
    .replaceAll('from "./editorialContracts"', `from ${JSON.stringify(contractsUrl)}`);
  const publicationProjectionUrl = moduleDataUrl(publicationProjection);
  const source = transpile(await readFile(sourcePath, "utf8"), sourcePath)
    .replaceAll('from "./editorialPipeline"', `from ${JSON.stringify(pipelineUrl)}`)
    .replaceAll('from "./publicationProjection"', `from ${JSON.stringify(publicationProjectionUrl)}`)
    // The legacy Node harness exercises the Worker HTTP contract only. The
    // real Agents SDK classes are covered by the Workers runtime suite.
    .replace(
      /import\s+\{\s*EditorialCoordinatorAgent,[\s\S]*?\}\s+from\s+"\.\/editorialAgents";/,
      [
        "class EditorialCoordinatorAgent {}",
        "class EditorialCoverAgent {}",
        "class EditorialIllustrationAgent {}",
        "class EditorialVisualProductionAgent {}",
        "class EditorialWechatPublishingAgent {}",
        "class EditorialReviewAgent {}",
        "class EditorialWorkflow {}",
        "class EditorialWritingAgent {}",
        'const coordinatorShardName = async (userId, workspaceId, articleId, runId) => `${userId}:${workspaceId}:${articleId}:${runId}`;',
        'const handleEditorialOrchestrationInternalRoute = async () => new Response(JSON.stringify({ error: "editorial_workflow_disabled" }), { status: 404 });',
      ].join("\n"),
    );
  // The legacy data-URL harness does not load the Agents SDK or the V3
  // workflow module. Keep the module boundary explicit so HTTP contract tests
  // can still import index.ts without resolving a relative data-URL import.
  const fiveAgentStub = [
    "class FiveAgentPublishingWorkflow {}",
    'const handleFiveAgentPublishingInternalRoute = async () => new Response(JSON.stringify({ error: "editorial_workflow_disabled" }), { status: 404 });',
    "const reconcileFrozenArticleRecordingProjection = async (env) => env.TEST_FROZEN_RECORDING_PROJECTION || null;",
  ].join("\n");
  const miningHandoffStub = [
    'const handleMiningV3HandoffInternalRoute = async () => new Response(JSON.stringify({ error: "mining_v3_handoff_unavailable" }), { status: 503 });',
  ].join("\n");
  const withFiveAgentStub = source
    .replace(/import\s+\{[^;]*FiveAgentPublishingWorkflow,[^;]*handleFiveAgentPublishingInternalRoute,[^;]*reconcileFrozenArticleRecordingProjection,[^;]*\}\s+from\s+"\.\/fiveAgentPublishing";/, fiveAgentStub)
    .replace(/import\s+\{\s*handleMiningV3HandoffInternalRoute\s*\}\s+from\s+"\.\/miningV3Handoff";/, miningHandoffStub);
  try {
    return (await import(moduleDataUrl(withFiveAgentStub))).default;
  } catch (error) {
    throw new Error(`failed to load Worker contract module: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function transpile(source, fileName) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName,
  });
  return outputText;
}

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function authorizedRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Files-Token", "test-token");
  return new Request(url, { ...init, headers });
}

function internalRevisionRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer handoff-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", "Bearer session-access-token");
  return new Request(url, { ...init, headers });
}

function miningClaimRequest(action, userId, targetKey, claimId) {
  return new Request("https://example.test/api/internal/mining-claims", {
    method: "POST",
    headers: {
      "Authorization": "Bearer mining-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      user_id: userId,
      target_key: targetKey,
      claim_id: claimId,
    }),
  });
}

function sessionDb(userRow) {
  return {
    prepare(sql) {
      assert.match(sql, /FROM sessions/);
      return sessionStatement(userRow);
    },
  };
}

function sessionStatement(userRow) {
  return statement({
    all: async () => ({
      results: [
        {
          session_id: "ses_1",
          access_expires_at: futureIso(),
          revoked_at: null,
          status: "active",
          ...userRow,
        },
      ],
    }),
  });
}

function createEnv(overrides = {}) {
  return {
    FILES_TOKEN: "test-token",
    PUBLIC_BASE_URL: "https://example.test",
    FILES_BUCKET: {},
    DB: createDb([]),
    ...overrides,
  };
}

function publicationEnabledEnv(db) {
  return createEnv({
    DB: db,
    FIVE_AGENT_PUBLISHING_V3: "true",
    FIVE_AGENT_PUBLISHING_V3_ALLOWLIST: "default_user:vibepub-dogfood",
  });
}

function publicationRunRow(overrides = {}) {
  return {
    run_id: "synthetic-run",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    article_id: "synthetic-article",
    recording_id: 101,
    source_run_id: "synthetic-run",
    source_manifest_hash: "sha256:synthetic",
    source_state: "writing",
    source_state_revision: 0,
    schema_version: "publication-projection.v1",
    workflow_version: "publishing-workflow.v1",
    policy_version: "publishing-policy.v1",
    agent_versions_json: "{}",
    skill_pins_json: "{}",
    state: "writing",
    run_status: "active",
    state_revision: 3,
    progress_percent: 28,
    resume_state: null,
    last_successful_state: "writing",
    last_successful_progress_percent: 28,
    retry_count: 0,
    next_action: null,
    error_code: null,
    idempotency_key: "synthetic-run",
    payload_hash: "sha256:synthetic",
    created_at: "2026-07-19T00:00:01Z",
    updated_at: "2026-07-19T00:00:04Z",
    ...overrides,
  };
}

function futureIso() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function createExecutionContext() {
  return {
    waitUntil() {},
  };
}

function createDb(results, options = {}) {
  return {
    prepare(sql) {
      options.onPrepare?.(sql);
      return statement({
        all: async () => ({ results }),
        run: async () => ({ meta: { changes: 1 } }),
      });
    },
  };
}

function miningClaimDb() {
  const claims = new Map();
  return {
    prepare(sql) {
      if (sql.includes("INSERT INTO mining_input_claims")) {
        return statement({
          run: async (values) => {
            const [userId, targetKey, claimId, leaseExpiresAt, now, , staleBefore] = values;
            const key = `${userId}:${targetKey}`;
            const existing = claims.get(key);
            if (!existing || (existing.state === "processing" && existing.lease_expires_at <= staleBefore)) {
              claims.set(key, {
                state: "processing",
                claim_id: claimId,
                lease_expires_at: leaseExpiresAt,
                updated_at: now,
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        });
      }
      if (sql.includes("UPDATE mining_input_claims")) {
        return statement({
          run: async (values) => {
            const [, , userId, targetKey, claimId] = values;
            const key = `${userId}:${targetKey}`;
            const existing = claims.get(key);
            if (!existing || existing.state !== "processing" || existing.claim_id !== claimId) {
              return { meta: { changes: 0 } };
            }
            claims.set(key, { ...existing, state: "completed", lease_expires_at: null });
            return { meta: { changes: 1 } };
          },
        });
      }
      if (sql.includes("DELETE FROM mining_input_claims")) {
        return statement({
          run: async (values) => {
            const [userId, targetKey, claimId] = values;
            const key = `${userId}:${targetKey}`;
            const existing = claims.get(key);
            if (!existing || existing.state !== "processing" || existing.claim_id !== claimId) {
              return { meta: { changes: 0 } };
            }
            claims.delete(key);
            return { meta: { changes: 1 } };
          },
        });
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function articleFeedbackDb() {
  const recordings = new Map([
    ["default_user:voice.m4a", { id: 71 }],
    ["default_user:legacy.m4a", { id: 72 }],
  ]);
  const versions = [{
    id: "version_1",
    user_id: "default_user",
    workspace_id: "vibepub-dogfood",
    article_id: "article_1",
    recording_id: 71,
    version_no: 1,
  }];
  const events = [];
  let feedbackInsertHook = null;

  return {
    versions,
    events,
    beforeFeedbackInsert(callback) {
      feedbackInsertHook = callback;
    },
    prepare(sql) {
      if (sql.includes("SELECT id FROM recordings")) {
        return statement({
          all: async ([userId, filename]) => {
            const row = recordings.get(`${userId}:${filename}`);
            return { results: row ? [row] : [] };
          },
        });
      }
      if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM article_versions") && sql.includes("ORDER BY version_no DESC")) {
        return statement({
          all: async ([userId, workspaceId, recordingId]) => ({
            results: versions
              .filter((row) => row.user_id === userId && row.workspace_id === workspaceId && row.recording_id === recordingId)
              .sort((left, right) => right.version_no - left.version_no),
          }),
        });
      }
      if (sql.includes("FROM article_feedback_events") && sql.includes("client_event_id = ?")) {
        return statement({
          all: async ([userId, workspaceId, clientEventId]) => ({
            results: events.filter((row) =>
              row.user_id === userId && row.workspace_id === workspaceId && row.client_event_id === clientEventId),
          }),
        });
      }
      if (sql.includes("FROM article_feedback_events") && sql.includes("ORDER BY server_sequence ASC")) {
        return statement({
          all: async ([userId, workspaceId, recordingId]) => ({
            results: events
              .filter((row) => row.user_id === userId && row.workspace_id === workspaceId && row.recording_id === recordingId)
              .sort((left, right) => left.server_sequence - right.server_sequence),
          }),
        });
      }
      if (sql.includes("INSERT INTO article_feedback_events")) {
        return statement({
          run: async ([id, userId, workspaceId, articleId, recordingId, versionId, action, clientEventId, payloadHash, occurredAt]) => {
            feedbackInsertHook?.();
            feedbackInsertHook = null;
            if (events.some((row) =>
              row.user_id === userId && row.workspace_id === workspaceId && row.client_event_id === clientEventId)) {
              return { meta: { changes: 0 } };
            }
            const current = versions
              .filter((row) => row.user_id === userId && row.workspace_id === workspaceId && row.recording_id === recordingId)
              .sort((left, right) => right.version_no - left.version_no)[0];
            if (current?.id !== versionId) return { meta: { changes: 0 } };
            events.push({
              server_sequence: events.length + 1,
              id,
              user_id: userId,
              workspace_id: workspaceId,
              article_id: articleId,
              recording_id: recordingId,
              version_id: versionId,
              action,
              client_event_id: clientEventId,
              payload_hash: payloadHash,
              occurred_at: occurredAt,
              created_at: occurredAt,
            });
            return { meta: { changes: 1 } };
          },
        });
      }
      throw new Error(`Unexpected article feedback SQL: ${sql}`);
    },
  };
}

function articleRevisionState() {
  const recording = { id: 81, filename: "voice.m4a", article_title: "Title 2", article_content: "Body 2" };
  const versions = [
    { id: "version_1", article_id: "article_1", recording_id: 81, version_no: 1, parent_version_id: null, title: "Title 1", body: "Body 1", cover_json: "{}", cover_title_json: "[]", formatting_skill_id: null, formatting_skill_version: null },
    { id: "version_2", article_id: "article_1", recording_id: 81, version_no: 2, parent_version_id: "version_1", title: "Title 2", body: "Body 2", cover_json: "{}", cover_title_json: "[]", formatting_skill_id: null, formatting_skill_version: null },
  ];
  const requests = [];
  const versionStates = [];
  const failures = { requestInsert: false, versionInsert: false };
  const hooks = { beforeProjectionUpdate: null };
  const db = {
    async batch(statements) {
      return Promise.all(statements.map(item => item.run()));
    },
    prepare(sql) {
      if (sql.includes("FROM article_revision_requests rr") && sql.includes("JOIN article_versions p")) {
        return statement({ all: async ([revisionId]) => {
          const request = requests.find(row => row.id === revisionId);
          if (!request) return { results: [] };
          const parent = versions.find(row => row.id === request.parent_version_id);
          return { results: [{
            ...request,
            parent_version_no: parent.version_no,
            parent_title: parent.title,
            parent_body: parent.body,
            parent_cover_json: parent.cover_json,
            parent_cover_title_json: parent.cover_title_json,
            parent_formatting_skill_id: parent.formatting_skill_id,
            parent_formatting_skill_version: parent.formatting_skill_version,
          }] };
        } });
      }
      if (sql.includes("FROM recordings r") && sql.includes("article_versions")) {
        return statement({ all: async () => ({ results: [{
          recording_id: recording.id,
          ...versions.at(-1),
        }] }) });
      }
      if (sql.includes("FROM article_revision_requests") && sql.includes("client_request_id")) {
        return statement({ all: async ([, , clientRequestId]) => ({
          results: requests.filter(row => row.client_request_id === clientRequestId),
        }) });
      }
      if (sql.includes("FROM article_revision_requests") && sql.includes("parent_version_id")) {
        return statement({ all: async ([, , parentVersionId]) => ({
          results: requests.filter(row => row.parent_version_id === parentVersionId),
        }) });
      }
      if (sql.includes("SELECT * FROM article_revision_requests") && sql.includes("WHERE id = ?")) {
        return statement({ all: async ([revisionId]) => ({ results: requests.filter(row => row.id === revisionId) }) });
      }
      if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM article_versions WHERE parent_version_id = ?")) {
        return statement({ all: async ([parentVersionId]) => ({
          results: versions.filter(row => row.parent_version_id === parentVersionId),
        }) });
      }
      if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM article_versions") && sql.includes("WHERE id = ?")) {
        return statement({ all: async ([versionId]) => ({ results: versions.filter(row => row.id === versionId) }) });
      }
      if (sql.trimStart().startsWith("SELECT") && sql.includes("SELECT id FROM article_versions") && sql.includes("ORDER BY version_no DESC")) {
        return statement({ all: async () => ({ results: [{ id: versions.at(-1).id }] }) });
      }
      if (sql.includes("INSERT INTO article_versions")) {
        return statement({ run: async (values) => {
          if (failures.versionInsert) throw new Error("D1 temporarily unavailable");
          const [id, userId, workspaceId, articleId, recordingId, versionNo, parentVersionId,
            sourceJobId, sourceHash, title, body, coverJson, blocksJson, titleCandidatesJson, selectedTitle,
            coverTitleJson, formattingSkillId, formattingSkillVersion, contentHtmlHash,
            idempotencyKey, payloadHash, createdAt] = values;
          if (versions.some(row => row.parent_version_id === parentVersionId)) throw new Error("UNIQUE child");
          versions.push({
            id, user_id: userId, workspace_id: workspaceId, article_id: articleId,
            recording_id: recordingId, version_no: versionNo, parent_version_id: parentVersionId,
            source_job_id: sourceJobId, source_hash: sourceHash, title, body, cover_json: coverJson,
            blocks: JSON.parse(blocksJson),
            title_candidates_json: titleCandidatesJson, selected_title: selectedTitle,
            cover_title_json: coverTitleJson, formatting_skill_id: formattingSkillId,
            formatting_skill_version: formattingSkillVersion, content_html_hash: contentHtmlHash,
            idempotency_key: idempotencyKey,
            payload_hash: payloadHash, created_at: createdAt,
          });
          return { meta: { changes: 1 } };
        } });
      }
      if (sql.includes("INSERT INTO editorial_version_states")) {
        return statement({ run: async ([versionId, , , , , , ,]) => {
          versionStates.push({ version_id: versionId, state: "content_frozen" });
          return { meta: { changes: 1 } };
        } });
      }
      if (sql.includes("INSERT INTO article_revision_requests")) {
        return statement({ run: async (values) => {
          if (failures.requestInsert) throw new Error("D1 temporarily unavailable");
          const [id, userId, workspaceId, articleId, recordingId, parentVersionId,
            feedbackId, clientRequestId, payloadHash, audioSha256, audioKey, requestKey, transcriptKey,
            status, createdAt, updatedAt] = values;
          if (requests.some(row => row.client_request_id === clientRequestId || row.parent_version_id === parentVersionId)) {
            throw new Error("UNIQUE constraint failed");
          }
          requests.push({
            id, user_id: userId, workspace_id: workspaceId, article_id: articleId,
            recording_id: recordingId, parent_version_id: parentVersionId,
            feedback_id: feedbackId,
            client_request_id: clientRequestId, payload_hash: payloadHash, audio_sha256: audioSha256,
            audio_key: audioKey, request_key: requestKey, transcript_key: transcriptKey,
            status, child_version_id: null, error_message: null, created_at: createdAt, updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        } });
      }
      if (sql.includes("UPDATE article_revision_requests") && sql.includes("child_version_id = ?")) {
        return statement({ run: async ([childId, updatedAt, revisionId]) => {
          const request = requests.find(row => row.id === revisionId);
          request.child_version_id = childId;
          if (request.status === "queued") request.status = "wechat_pending";
          request.error_message = null;
          request.updated_at = updatedAt;
          return { meta: { changes: 1 } };
        } });
      }
      if (sql.includes("UPDATE article_revision_requests") && sql.includes("SET status = ?")) {
        return statement({ run: async ([status, errorMessage, updatedAt, revisionId]) => {
          const request = requests.find(row => row.id === revisionId);
          Object.assign(request, { status, error_message: errorMessage, updated_at: updatedAt });
          return { meta: { changes: 1 } };
        } });
      }
      if (sql.includes("UPDATE recordings") && sql.includes("article_title = ?")) {
        return statement({ run: async ([title, content, , , , , projectedVersionId]) => {
          hooks.beforeProjectionUpdate?.();
          hooks.beforeProjectionUpdate = null;
          if (projectedVersionId && versions.at(-1).id !== projectedVersionId) {
            return { meta: { changes: 0 } };
          }
          recording.article_title = title;
          recording.article_content = content;
          return { meta: { changes: 1 } };
        } });
      }
      if (sql.includes("UPDATE recordings")) {
        return statement({ run: async () => ({ meta: { changes: 1 } }) });
      }
      throw new Error(`Unexpected article revision SQL: ${sql}`);
    },
  };
  return {
    recording,
    versions,
    requests,
    versionStates,
    failures,
    hooks,
    db,
  };
}

function statement(handlers) {
  return {
    bind(...values) {
      return {
        all: () => handlers.all(values),
        first: async () => {
          if (handlers.first) return handlers.first(values);
          const result = await handlers.all(values);
          return result.results?.[0] || null;
        },
        run: () => handlers.run(values),
      };
    },
  };
}
