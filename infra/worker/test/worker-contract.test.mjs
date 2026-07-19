import assert from "node:assert/strict";
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

test("editorial producer writes are behind the internal service boundary", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/internal/editorial/versions", { method: "POST" }),
    createEnv(),
    createExecutionContext(),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
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
    createEnv({ MINING_SERVICE_TOKEN: "mining-token" }),
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
    createEnv({ DB: db }),
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
      selectedSql = sql;
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
      if (sql.includes("SELECT app_id, app_secret_ciphertext, proxy_url FROM publishing_accounts")) {
        return statement({
          all: async () => ({
            results: publishingRow
              ? [{
                  app_id: publishingRow.app_id,
                  app_secret_ciphertext: publishingRow.app_secret_ciphertext,
                  proxy_url: publishingRow.proxy_url,
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
  assert.equal((await internalResponse.json()).publishing_account.app_secret, "secret-value");
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
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0], /\n\s*processing_stage,/);
  assert.match(sqlCalls[1], /NULL AS processing_stage/);
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
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0], /\n\s*duration_ms,/);
  assert.match(sqlCalls[1], /NULL AS duration_ms/);
  assert.match(sqlCalls[1], /\n\s*processing_stage,/);
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
      async get(key) {
        getCalls.push(key);
        return { body: "transcript" };
      },
      async put(key, body, options) {
        putCalls.push({ key, body, options });
      },
    };
    const db = {
      prepare(sql) {
        sqlCalls.push(sql);
        return statement({
          run: async (values) => {
            valueCalls.push(values);
            return { meta: { changes: 1 } };
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
      authorizedRequest("https://example.test/api/recordings/VibePub-2026-07-02-160000-0m18s-Test.m4a/revisions", {
        method: "POST",
        headers: { "Content-Type": "audio/mp4" },
        body: "revision audio",
      }),
      createEnv({
        FILES_BUCKET: bucket,
        DB: db,
        GITHUB_PAT: "github-token",
        GITHUB_WORKFLOW_REF: "main",
      }),
      context,
    );

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, "QUEUED");
  assert.match(body.revision_request_key, /^users\/default_user\/revision-requests\/VibePub-2026-07-02-160000-0m18s-Test\/.+\.json$/);
  assert.deepEqual(getCalls, [
    "users/default_user/transcripts/VibePub-2026-07-02-160000-0m18s-Test.json",
  ]);
  assert.equal(putCalls.length, 2);
  assert.match(putCalls[0].key, /^users\/default_user\/revision-requests\/VibePub-2026-07-02-160000-0m18s-Test\/.+\.m4a$/);
    assert.equal(putCalls[0].options.httpMetadata.contentType, "audio/mp4");
    assert.equal(putCalls[1].key, body.revision_request_key);
    assert.match(sqlCalls[0], /processing_stage = \?/);
    assert.deepEqual(valueCalls[0], [
      "PROCESSING",
      "REWRITING",
      "default_user",
      "VibePub-2026-07-02-160000-0m18s-Test.m4a",
    ]);
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
    createEnv({ FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "article_not_ready");
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
  const source = transpile(await readFile(sourcePath, "utf8"), sourcePath)
    .replaceAll('from "./editorialPipeline"', `from ${JSON.stringify(pipelineUrl)}`);
  return (await import(moduleDataUrl(source))).default;
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

function statement(handlers) {
  return {
    bind(...values) {
      return {
        all: () => handlers.all(values),
        run: () => handlers.run(values),
      };
    },
  };
}
