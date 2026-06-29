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
      filename: "voice.m4a",
      status: "PROCESSING",
      created_at: "2026-06-29 08:00:00",
      updated_at: "2026-06-29 08:01:00",
      article_title: "整理好的标题",
      raw_text_preview: "这是一段原始识别结果",
      processing_stage: "DRAFTING",
      wechat_url: null,
      wechat_draft_id: "MEDIA_ID_123",
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
  assert.equal(body.recordings[0].filename, "voice.m4a");
  assert.equal(body.recordings[0].article_title, "整理好的标题");
  assert.equal(body.recordings[0].processing_stage, "DRAFTING");
  assert.equal(body.recordings[0].wechat_draft_id, "MEDIA_ID_123");
});

test("keeps rich recording fields when only processing_stage is not migrated yet", async () => {
  let calls = 0;
  const db = {
    prepare(sql) {
      calls += 1;
      if (calls === 1) {
        assert.match(sql, /processing_stage/);
        return statement({
          all: async () => {
            throw new Error("D1_ERROR: no such column: processing_stage");
          },
        });
      }
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
  assert.equal(body.recordings[0].wechat_draft_id, "MEDIA_ID_OLD");
});

test("persists mining status metadata for Android progress display", async () => {
  let boundValues = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /processing_stage = COALESCE/);
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
    null,
    "default_user",
    "voice.m4a",
  ]);
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

function createDb(results) {
  return {
    prepare() {
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
        all: handlers.all,
        run: () => handlers.run(values),
      };
    },
  };
}
