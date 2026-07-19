import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("WritingAgent Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires auth for profile endpoints", async () => {
    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-profiles"),
      { WRITING_AGENT_TOKEN: "secret" },
    );

    expect(response.status).toBe(401);
  });

  it("does not allow FILES_TOKEN to authenticate the V3 internal endpoint", async () => {
    const modelFetch = vi.fn();
    vi.stubGlobal("fetch", modelFetch);
    const response = await worker.fetch(
      new Request("https://writing-agent.test/internal/v3/write", {
        method: "POST",
        headers: { Authorization: "Bearer legacy-files-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: "vibepub.editorial.v3",
          job_id: "v3-auth-files-token",
          idempotency_key: "v3-auth-files-token",
          mode: "initial",
          article_id: "article-auth",
          run_id: "run-auth",
          recording_id: 1,
          source_text: "合成认证测试素材。",
        }),
      }),
      { FILES_TOKEN: "legacy-files-token", GLM_API_KEY: "synthetic" },
    );

    expect(response.status).toBe(401);
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("authenticates the V3 internal endpoint only with the dedicated token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "认证测试标题",
        body: "认证测试正文。",
        blocks: [{ block_id: "block_v1_1", kind: "paragraph", order: 0, text: "认证测试正文。", text_hash: await sha256Hex("认证测试正文。"), claim_ids: [], image_ref_ids: [] }],
        claim_ledger: [],
        title_candidates: ["认证测试标题"],
        selected_title: "认证测试标题",
        cover_title: ["认证测试标题"],
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const response = await worker.fetch(
      new Request("https://writing-agent.test/internal/v3/write", {
        method: "POST",
        headers: { Authorization: "Bearer dedicated-v3-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: "vibepub.editorial.v3",
          job_id: "v3-auth-dedicated",
          idempotency_key: "v3-auth-dedicated",
          mode: "initial",
          article_id: "article-auth",
          run_id: "run-auth",
          recording_id: 1,
          source_text: "合成认证测试素材。",
        }),
      }),
      { WRITING_AGENT_TOKEN: "dedicated-v3-token", GLM_API_KEY: "synthetic" },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "vibepub.editorial.v3",
      status: "article_draft_ready",
    });
  });

  it("rejects a wrong token on the V3 internal endpoint without invoking the model", async () => {
    const modelFetch = vi.fn();
    vi.stubGlobal("fetch", modelFetch);
    const response = await worker.fetch(
      new Request("https://writing-agent.test/internal/v3/write", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-v3-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: "vibepub.editorial.v3",
          job_id: "v3-auth-wrong",
          idempotency_key: "v3-auth-wrong",
          mode: "initial",
          article_id: "article-auth",
          run_id: "run-auth",
          recording_id: 1,
          source_text: "合成认证测试素材。",
        }),
      }),
      { WRITING_AGENT_TOKEN: "dedicated-v3-token", FILES_TOKEN: "legacy-files-token", GLM_API_KEY: "synthetic" },
    );

    expect(response.status).toBe(401);
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("lists default profiles for authorized callers", async () => {
    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-profiles", {
        headers: { Authorization: "Bearer secret" },
      }),
      { WRITING_AGENT_TOKEN: "secret" },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { style_profiles: Array<{ id: string; version?: string }> };
    expect(body.style_profiles).toHaveLength(4);
    expect(body.style_profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "style_litianc_default",
          version: "2026-07-05",
        }),
        expect.objectContaining({ id: "style_product_review" }),
        expect.objectContaining({ id: "style_technical_note" }),
        expect.objectContaining({ id: "style_public_explainer" }),
      ]),
    );
  });

  it("creates a rewrite job using the selected style and layout profiles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "把原始想法变成文章",
              content_html: "<section><p>整理后的正文。</p></section>",
              cover_title: ["原始想法", "变文章"],
              cover_subtitle: "减少写作成本",
              image_prompt: "A clean editorial image, no text",
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/rewrite-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          protocol_version: "vibepub.rewrite.v1",
          client_job_id: "recording-1",
          idempotency_key: "recording-1",
          input: {
            source_type: "audio_transcript",
            raw_text: "我今天想说说为什么写作成本需要降低。",
            title_hint: "写作成本",
          },
          profiles: {
            style_profile_id: "style_litianc_default",
            layout_profile_id: "wechat_clean_article",
          },
        }),
      }),
      {
        WRITING_AGENT_TOKEN: "secret",
        GLM_API_KEY: "glm-key",
        GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
        GLM_MODEL: "glm-test",
      },
    );

    expect(response.status).toBe(201);
    const glmBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(glmBody.messages[0].content).toContain("litianc 默认写作风格");
    expect(glmBody.messages[0].content).toContain("公众号 Markdown 排版 / 1.0.0");
    expect(glmBody.messages[0].content).toContain("写作成本");

    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "vibepub.rewrite.v1",
      status: "article_ready",
      result: {
        title: "把原始想法变成文章",
        content_html: expect.stringContaining("整理后的正文。"),
        cover: {
          cover_title: ["原始想法", "变文章"],
          cover_subtitle: "减少写作成本",
          image_prompt: "A clean editorial image, no text",
        },
      },
      profile_versions: {
        formatting_skill_id: "md_to_wechat",
        formatting_skill_version: "1.0.0",
        layout_profile_id: "wechat_clean_article",
        layout_profile_version: "2026-07-05",
      },
    });
  });

  it("creates a rewrite job using an inline custom style profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "自定义风格文章",
              content_html: "<section><p>按自定义风格整理后的正文。</p></section>",
              cover_title: ["自定义", "风格"],
              image_prompt: "A clean editorial image, no text",
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/rewrite-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          protocol_version: "vibepub.rewrite.v1",
          client_job_id: "recording-custom-style",
          input: {
            source_type: "text_submission",
            raw_text: "我想用自己的风格写一篇产品复盘。",
          },
          profiles: {
            style_profile_id: "custom_style_1",
            style_profile_name: "我的产品复盘风格",
            style_profile_version: "v1",
            style_profile_body: "请用真实克制的产品复盘风格写作，保留具体排查过程。",
            layout_profile_id: "wechat_clean_article",
          },
        }),
      }),
      {
        WRITING_AGENT_TOKEN: "secret",
        GLM_API_KEY: "glm-key",
        GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
        GLM_MODEL: "glm-test",
      },
    );

    expect(response.status).toBe(201);
    const glmBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(glmBody.messages[0].content).toContain("我的产品复盘风格");
    expect(glmBody.messages[0].content).toContain("保留具体排查过程");
    await expect(response.json()).resolves.toMatchObject({
      profile_versions: {
        style_profile_id: "custom_style_1",
        style_profile_version: "v1",
      },
    });
  });

  it("creates a revision job from the current article and voice instruction", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "新版标题",
              content_html: "<section><p>按修改要求更新后的正文。</p></section>",
              cover_title: ["新版", "标题"],
              cover_subtitle: "修改已应用",
              image_prompt: "A clean revised editorial image, no text",
              image_actions: [
                {
                  image_id: "opening-desk",
                  kind: "insert_image",
                  prompt: "A warm desk with a recorder, no text",
                  alt: "办公桌上的录音设备",
                  anchor: { position: "after", paragraph_index: 1 },
                },
              ],
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/revision-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          protocol_version: "vibepub.rewrite.v1",
          client_job_id: "recording-1:revision-1",
          idempotency_key: "recording-1:revision-1",
          current_article: {
            raw_text: "原始口述",
            title: "旧标题",
            content_html: "<section><p>旧正文。</p></section>",
          },
          instruction: {
            source_type: "voice_instruction",
            text: "把标题换得更直接，并补充一个结论。",
            language: "zh-CN",
          },
          profiles: {
            style_profile_id: "style_litianc_default",
            layout_profile_id: "wechat_clean_article",
          },
          output_contract: {
            allow_image_actions: true,
          },
        }),
      }),
      {
        WRITING_AGENT_TOKEN: "secret",
        GLM_API_KEY: "glm-key",
        GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
        GLM_MODEL: "glm-test",
      },
    );

    expect(response.status).toBe(201);
    const glmBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(glmBody.messages[0].content).toContain("当前文章正文");
    expect(glmBody.messages[0].content).toContain("<section><p>旧正文。</p></section>");
    expect(glmBody.messages[0].content).toContain("把标题换得更直接");
    expect(glmBody.messages[0].content).toContain("image_actions");

    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "vibepub.rewrite.v1",
      status: "article_ready",
      result: {
        title: "新版标题",
        content_html: expect.stringContaining("按修改要求更新后的正文。"),
        image_actions: [
          expect.objectContaining({
            image_id: "opening-desk",
            kind: "insert_image",
            prompt: "A warm desk with a recorder, no text",
          }),
        ],
      },
    });
  });

  it("adds a fallback image action when the instruction explicitly asks for a picture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "带配图的新版标题",
              content_html: "<section><p>按修改要求更新后的正文。</p></section>",
              cover_title: ["带图", "新版"],
              image_prompt: "A clean revised editorial image, no text",
            }),
          },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/revision-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          protocol_version: "vibepub.rewrite.v1",
          current_article: {
            title: "旧标题",
            content_html: "<section><p>旧正文。</p></section>",
          },
          instruction: {
            source_type: "voice_instruction",
            text: "在第一段后面加一张办公桌录音的图。",
            language: "zh-CN",
          },
          profiles: {
            style_profile_id: "style_litianc_default",
            layout_profile_id: "wechat_clean_article",
          },
          output_contract: {
            allow_image_actions: true,
          },
        }),
      }),
      {
        WRITING_AGENT_TOKEN: "secret",
        GLM_API_KEY: "glm-key",
        GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
        GLM_MODEL: "glm-test",
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        image_actions: [
          {
            image_id: "requested_image_1",
            kind: "insert_image",
            prompt: expect.stringContaining("office desk"),
            alt: "根据修改要求生成的正文配图",
            anchor: { position: "after", paragraph_index: 1 },
          },
        ],
        warnings: [
          expect.stringContaining("补充一条插图动作"),
        ],
      },
    });
  });

  it("imports style sources and lists them for the workspace", async () => {
    const db = createProfileDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-source-imports", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_type: "wechat_article",
          url: "https://mp.weixin.qq.com/s/example",
          title: "一篇满意的旧文章",
          text: "第一段写具体现场。第二段给出判断。第三段拆解原因。",
        }),
      }),
      { WRITING_AGENT_TOKEN: "secret", DB: db },
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { source_import: { id: string; text_preview: string } };
    expect(body.source_import.id).toMatch(/^ssi_/);
    expect(body.source_import.text_preview).toContain("具体现场");

    const listResponse = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-source-imports", {
        headers: { Authorization: "Bearer secret" },
      }),
      { WRITING_AGENT_TOKEN: "secret", DB: db },
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      source_imports: [
        expect.objectContaining({
          id: body.source_import.id,
          source_type: "wechat_article",
          title: "一篇满意的旧文章",
          status: "ready",
        }),
      ],
    });
  });

  it("fetches WeChat article text and title when importing a bare URL", async () => {
    const db = createProfileDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`
      <html>
        <head>
          <meta content="王建硕：一个产品人的现场笔记" property="og:title">
          <meta name="author" content="王建硕">
        </head>
        <body>
          <h1 id="activity-name">备用标题</h1>
          <div id="js_content">
            <p>第一段直接进入现场。</p>
            <p>第二段解释为什么这样取舍。</p>
          </div>
        </body>
      </html>
    `, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));

    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-source-imports", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_type: "wechat_article",
          url: "https://mp.weixin.qq.com/s/example",
        }),
      }),
      { WRITING_AGENT_TOKEN: "secret", DB: db },
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { source_import: { title: string; text_preview: string } };
    expect(body.source_import.title).toBe("王建硕：一个产品人的现场笔记");
    expect(body.source_import.text_preview).toContain("作者：王建硕");
    expect(body.source_import.text_preview).toContain("第一段直接进入现场");
  });

  it("treats literal null style source titles as missing metadata", async () => {
    const db = createProfileDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const response = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-source-imports", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_type: "wechat_article",
          url: "https://mp.weixin.qq.com/s/example",
          title: "NULL",
          text: "第一段写具体现场。第二段给出判断。",
        }),
      }),
      { WRITING_AGENT_TOKEN: "secret", DB: db },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      source_import: {
        source_type: "wechat_article",
        title: null,
        text_preview: expect.stringContaining("具体现场"),
      },
    });
  });

  it("distills imported sources into a persistent profile and uses it for rewrite jobs", async () => {
    const db = createProfileDb();
    const sourceIds: string[] = [];
    for (const title of ["旧文章 A", "旧文章 B"]) {
      const response = await worker.fetch(
        new Request("https://writing-agent.test/v1/style-source-imports", {
          method: "POST",
          headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            source_type: "text",
            title,
            text: `${title}：开头直接进入现场，正文用短段落解释取舍，结尾回到下一步动作。`,
          }),
        }),
        { WRITING_AGENT_TOKEN: "secret", DB: db },
      );
      const body = await response.json() as { source_import: { id: string } };
      sourceIds.push(body.source_import.id);
    }

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                name: "我的旧文风格",
                description: "现场感强、短段落、结尾给下一步。",
                body: "1. 开头直接进入具体现场。\n2. 正文用短段落拆解取舍。\n3. 结尾回到下一步动作。",
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "按旧文风格成文",
                content_html: "<section><p>按蒸馏风格整理后的正文。</p></section>",
                cover_title: ["旧文", "风格"],
                image_prompt: "A clean editorial image, no text",
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })));

    const distillResponse = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-distillation-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_import_ids: sourceIds,
          profile: {
            id: "style_my_old_articles",
            name: "我的旧文风格",
            description: "从满意旧文章提取。",
          },
        }),
      }),
      {
        WRITING_AGENT_TOKEN: "secret",
        GLM_API_KEY: "glm-key",
        GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
        GLM_MODEL: "glm-test",
        DB: db,
      },
    );

    expect(distillResponse.status).toBe(201);
    const distillBody = await distillResponse.json() as {
      style_profile: { id: string; version: string; body: string };
      distillation_job: { id: string; status: string };
    };
    expect(distillBody.distillation_job.status).toBe("profile_ready");
    expect(distillBody.style_profile).toMatchObject({
      id: "style_my_old_articles",
      body: expect.stringContaining("开头直接进入具体现场"),
    });

    const profilesResponse = await worker.fetch(
      new Request("https://writing-agent.test/v1/style-profiles", {
        headers: { Authorization: "Bearer secret" },
      }),
      { WRITING_AGENT_TOKEN: "secret", DB: db },
    );
    const profilesBody = await profilesResponse.json() as { style_profiles: Array<{ id: string; version: string }> };
    expect(profilesBody.style_profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "style_my_old_articles",
          version: distillBody.style_profile.version,
        }),
      ]),
    );

    const rewriteResponse = await worker.fetch(
      new Request("https://writing-agent.test/v1/rewrite-jobs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_job_id: "recording-distilled-style",
          input: {
            source_type: "text_submission",
            raw_text: "今天我想复盘一个功能上线后的取舍。",
          },
          profiles: {
            style_profile_id: "style_my_old_articles",
            layout_profile_id: "wechat_clean_article",
          },
        }),
      }),
      {
        WRITING_AGENT_TOKEN: "secret",
        GLM_API_KEY: "glm-key",
        GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
        GLM_MODEL: "glm-test",
        DB: db,
      },
    );

    expect(rewriteResponse.status).toBe(201);
    const rewritePrompt = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).messages[0].content;
    expect(rewritePrompt).toContain("我的旧文风格");
    expect(rewritePrompt).toContain("开头直接进入具体现场");
    await expect(rewriteResponse.json()).resolves.toMatchObject({
      profile_versions: {
        style_profile_id: "style_my_old_articles",
        style_profile_version: distillBody.style_profile.version,
      },
    });
  });
});

type FakeStatement = {
  bind: (...values: unknown[]) => FakeStatement;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function createProfileDb(): D1Database {
  const sources = new Map<string, any>();
  const profiles = new Map<string, any>();
  const versions = new Map<string, any>();
  const jobs = new Map<string, any>();

  return {
    prepare(sql: string): FakeStatement {
      let bound: unknown[] = [];
      const statement: FakeStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T>() {
          if (sql.includes("FROM style_source_imports") && sql.includes("id IN")) {
            const ids = bound.slice(1) as string[];
            return { results: ids.map(id => sources.get(id)).filter(Boolean) as T[] };
          }
          if (sql.includes("FROM style_source_imports")) {
            const workspaceId = String(bound[0]);
            return {
              results: Array.from(sources.values())
                .filter(source => source.workspace_id === workspaceId)
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .map(source => ({
                  id: source.id,
                  workspace_id: source.workspace_id,
                  source_type: source.source_type,
                  source_url: source.source_url,
                  title: source.title,
                  status: source.status,
                  text_preview: source.text.slice(0, 240),
                  created_at: source.created_at,
                  updated_at: source.updated_at,
                })) as T[],
            };
          }
          if (sql.includes("FROM style_profiles p") && sql.includes("ORDER BY p.updated_at DESC")) {
            const workspaceId = String(bound[0]);
            return {
              results: Array.from(profiles.values())
                .filter(profile => profile.workspace_id === workspaceId && !profile.deleted_at)
                .map(profile => {
                  const version = versions.get(profile.active_version_id);
                  return {
                    id: profile.id,
                    name: profile.name,
                    description: profile.description,
                    visibility: profile.visibility,
                    owner_user_id: profile.owner_user_id,
                    workspace_id: profile.workspace_id,
                    active_version_id: profile.active_version_id,
                    version: version.version_label,
                    version_created_at: version.created_at,
                  };
                }) as T[],
            };
          }
          if (sql.includes("SELECT id") && sql.includes("FROM style_profile_versions") && sql.includes("OFFSET")) {
            const [workspaceId, profileId, offset] = bound as [string, string, number];
            return {
              results: Array.from(versions.values())
                .filter(version => version.workspace_id === workspaceId && version.profile_id === profileId)
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .slice(offset)
                .map(version => ({ id: version.id })) as T[],
            };
          }
          return { results: [] };
        },
        async first<T>() {
          if (sql.includes("FROM style_profiles p") && sql.includes("p.id = ?")) {
            const [workspaceId, profileId] = bound as [string, string];
            const profile = profiles.get(profileId);
            if (!profile || profile.workspace_id !== workspaceId || profile.deleted_at) return null;
            const version = versions.get(profile.active_version_id);
            return {
              id: profile.id,
              name: profile.name,
              description: profile.description,
              version: version.version_label,
              body: version.body,
            } as T;
          }
          if (sql.includes("FROM style_distillation_jobs")) {
            const [workspaceId, jobId] = bound as [string, string];
            const job = jobs.get(jobId);
            return job && job.workspace_id === workspaceId ? job as T : null;
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO style_source_imports")) {
            const [id, workspace_id, user_id, source_type, source_url, title, text, status, created_at, updated_at] = bound;
            sources.set(String(id), { id, workspace_id, user_id, source_type, source_url, title, text, status, created_at, updated_at });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO style_profiles")) {
            const [id, workspace_id, owner_user_id, name, description, visibility, active_version_id, created_at, updated_at] = bound;
            profiles.set(String(id), { id, workspace_id, owner_user_id, name, description, visibility, active_version_id, created_at, updated_at, deleted_at: null });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO style_profile_versions")) {
            const [id, profile_id, workspace_id, version_label, body, source_count, source_ids_json, created_at] = bound;
            versions.set(String(id), { id, profile_id, workspace_id, version_label, body, source_count, source_ids_json, created_at });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO style_distillation_jobs")) {
            const [id, workspace_id, profile_id, version_id, status, source_ids_json, created_at, completed_at] = bound;
            jobs.set(String(id), { id, workspace_id, profile_id, version_id, status, source_ids_json, error_message: null, created_at, completed_at });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE style_source_imports")) {
            const [usedProfileId, updatedAt, workspaceId, ...ids] = bound as string[];
            for (const id of ids) {
              const source = sources.get(id);
              if (source && source.workspace_id === workspaceId) {
                source.used_in_profile_id = usedProfileId;
                source.updated_at = updatedAt;
              }
            }
            return { meta: { changes: ids.length } };
          }
          if (sql.includes("DELETE FROM style_profile_versions")) {
            const ids = bound.slice(2) as string[];
            for (const id of ids) versions.delete(id);
            return { meta: { changes: ids.length } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
