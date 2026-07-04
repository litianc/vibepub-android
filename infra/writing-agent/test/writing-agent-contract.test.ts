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
    await expect(response.json()).resolves.toMatchObject({
      style_profiles: [
        {
          id: "style_litianc_default",
          version: "2026-07-05",
        },
      ],
    });
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
});
