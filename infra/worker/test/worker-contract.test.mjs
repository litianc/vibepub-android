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
                r2_key: "inbox/custom-upload-key.m4a",
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
    "covers/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.png",
    "inbox/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3",
    "inbox/custom-upload-key.m4a",
    "transcripts/VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.json",
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

test("keeps rich recording fields when only processing_stage is not migrated yet", async () => {
  let calls = 0;
  const db = {
    prepare(sql) {
      calls += 1;
      if (calls === 1) {
        assert.match(sql, /duration_ms/);
        assert.match(sql, /processing_stage/);
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: processing_stage");
          },
        });
      }
      if (calls === 2) {
        assert.match(sql, /duration_ms/);
        assert.match(sql, /processing_stage/);
        assert.doesNotMatch(sql, /cover_image_url/);
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: processing_stage");
          },
        });
      }
      if (calls === 3) {
        assert.doesNotMatch(sql, /duration_ms/);
        assert.match(sql, /processing_stage/);
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: processing_stage");
          },
        });
      }
      assert.doesNotMatch(sql, /duration_ms/);
      assert.doesNotMatch(sql, /processing_stage/);
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
});

test("keeps processing stage when only duration column is not migrated yet", async () => {
  let calls = 0;
  const db = {
    prepare(sql) {
      calls += 1;
      if (calls === 1) {
        assert.match(sql, /duration_ms/);
        assert.match(sql, /processing_stage/);
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: duration_ms");
          },
        });
      }
      if (calls === 2) {
        assert.match(sql, /duration_ms/);
        assert.match(sql, /processing_stage/);
        assert.doesNotMatch(sql, /cover_image_url/);
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: duration_ms");
          },
        });
      }
      assert.doesNotMatch(sql, /duration_ms/);
      assert.match(sql, /processing_stage/);
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
      headers: { "X-File-Name": "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a" },
      body: "audio",
    }),
    createEnv({ DB: db, FILES_BUCKET: bucket }),
    createExecutionContext(),
  );

  assert.equal(response.status, 201);
  assert.equal(putCalls.length, 1);
  assert.match(String(sqlCalls[0]), /duration_ms = COALESCE/);
  assert.match(String(sqlCalls[1]), /processing_stage, duration_ms/);
  assert.deepEqual(valueCalls[0].slice(0, 4), [
    "inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
    18_000,
  ]);
  assert.deepEqual(valueCalls[1].slice(0, 6), [
    "default_user",
    "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
    18_000,
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
    "inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
  ]);
  assert.deepEqual(valueCalls[2].slice(0, 5), [
    "default_user",
    "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "inbox/VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
    "UPLOADED",
    "QUEUED",
  ]);
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
        GITHUB_WORKFLOW_REF: "codex/android-experience-v1",
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
  assert.equal(dispatches[0].body.ref, "codex/android-experience-v1");
  assert.deepEqual(dispatches[0].body.inputs, {
    target_filename: "VibePub-2026-06-30-160000-0m18s-Tue-Afternoon.m4a",
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

async function loadWorker() {
  const sourcePath = resolve("src/index.ts");
  const source = await readFile(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    fileName: sourcePath,
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  return (await import(moduleUrl)).default;
}

function authorizedRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", "Bearer test-token");
  return new Request(url, { ...init, headers });
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
