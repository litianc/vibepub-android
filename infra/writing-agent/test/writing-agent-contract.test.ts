import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";

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
    expect(glmBody.messages[0].content).toContain("微信公众号克制长文排版");
    expect(glmBody.messages[0].content).toContain("写作成本");

    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "vibepub.rewrite.v1",
      status: "article_ready",
      result: {
        title: "把原始想法变成文章",
        content_html: "<section><p>整理后的正文。</p></section>",
        cover: {
          cover_title: ["原始想法", "变文章"],
          cover_subtitle: "减少写作成本",
          image_prompt: "A clean editorial image, no text",
        },
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

    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "vibepub.rewrite.v1",
      status: "article_ready",
      result: {
        title: "新版标题",
        content_html: "<section><p>按修改要求更新后的正文。</p></section>",
      },
    });
  });
});
