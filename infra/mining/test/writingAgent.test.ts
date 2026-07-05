import { afterEach, describe, expect, it, vi } from "vitest";
import {
  articleResultFromWritingAgentResponse,
  buildWritingAgentRequest,
  buildWritingAgentRevisionRequest,
  reviseArticle,
  rewriteArticle,
} from "../src/writingAgent.js";
import { processAudioText, reviseArticleWithInstruction } from "../src/llm.js";

vi.mock("../src/llm.js", () => ({
  processAudioText: vi.fn(),
  reviseArticleWithInstruction: vi.fn(),
}));

describe("WritingAgent mining adapter", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("falls back to the embedded rewrite path when WritingAgent is not configured", async () => {
    process.env = { ...originalEnv, WRITING_AGENT_BASE_URL: "" };
    vi.mocked(processAudioText).mockResolvedValue({
      title: "Fallback title",
      content: "<p>Fallback content</p>",
      imagePrompt: "Fallback image",
    });

    await expect(rewriteArticle({
      rawText: "raw",
      clientJobId: "job-1",
      sourceType: "audio_transcript",
    })).resolves.toMatchObject({
      title: "Fallback title",
      content: "<p>Fallback content</p>",
    });
  });

  it("builds a profile-based rewrite request", () => {
    process.env = {
      ...originalEnv,
      WRITING_AGENT_STYLE_PROFILE_ID: "style_custom",
      WRITING_AGENT_LAYOUT_PROFILE_ID: "layout_custom",
    };

    expect(buildWritingAgentRequest({
      rawText: "原始文字",
      clientJobId: "job-2",
      sourceType: "text_submission",
      titleHint: "标题提示",
    })).toMatchObject({
      protocol_version: "vibepub.rewrite.v1",
      client_job_id: "job-2",
      input: {
        source_type: "text_submission",
        raw_text: "原始文字",
        title_hint: "标题提示",
      },
      profiles: {
        style_profile_id: "style_custom",
        layout_profile_id: "layout_custom",
      },
    });
  });

  it("lets recording profile selections override default rewrite profiles", () => {
    process.env = {
      ...originalEnv,
      WRITING_AGENT_STYLE_PROFILE_ID: "style_env_default",
      WRITING_AGENT_LAYOUT_PROFILE_ID: "layout_env_default",
    };

    expect(buildWritingAgentRequest({
      rawText: "原始文字",
      clientJobId: "job-selected-profile",
      sourceType: "audio_transcript",
      styleProfileId: "style_product_review",
      styleProfileVersion: "2026-07-05",
      styleProfileName: "我的产品复盘风格",
      styleProfileDescription: "保留具体排查过程",
      styleProfileBody: "请用真实克制的产品复盘风格写作。",
      layoutProfileId: "wechat_clean_article",
      layoutProfileVersion: "2026-07-05",
    })).toMatchObject({
      profiles: {
        style_profile_id: "style_product_review",
        style_profile_version: "2026-07-05",
        style_profile_name: "我的产品复盘风格",
        style_profile_description: "保留具体排查过程",
        style_profile_body: "请用真实克制的产品复盘风格写作。",
        layout_profile_id: "wechat_clean_article",
        layout_profile_version: "2026-07-05",
      },
    });
  });

  it("falls back to the embedded revision path when WritingAgent is not configured", async () => {
    process.env = { ...originalEnv, WRITING_AGENT_BASE_URL: "" };
    vi.mocked(reviseArticleWithInstruction).mockResolvedValue({
      title: "Fallback revision",
      content: "<p>Fallback revision content</p>",
      imagePrompt: "Fallback revision image",
    });

    await expect(reviseArticle({
      rawText: "raw",
      currentTitle: "旧标题",
      currentContent: "<p>旧正文</p>",
      instructionText: "补一个结论",
      clientJobId: "revision-job-1",
    })).resolves.toMatchObject({
      title: "Fallback revision",
      content: "<p>Fallback revision content</p>",
    });

    expect(reviseArticleWithInstruction).toHaveBeenCalledWith({
      rawText: "raw",
      currentTitle: "旧标题",
      currentContent: "<p>旧正文</p>",
      instructionText: "补一个结论",
    });
  });

  it("builds a profile-based revision request", () => {
    expect(buildWritingAgentRevisionRequest({
      rawText: "原始口述",
      currentTitle: "旧标题",
      currentContent: "<p>旧正文</p>",
      instructionText: "把标题改得直接一点",
      clientJobId: "revision-job-2",
    })).toMatchObject({
      protocol_version: "vibepub.rewrite.v1",
      client_job_id: "revision-job-2",
      current_article: {
        raw_text: "原始口述",
        title: "旧标题",
        content_html: "<p>旧正文</p>",
      },
      instruction: {
        source_type: "voice_instruction",
        text: "把标题改得直接一点",
      },
      profiles: {
        style_profile_id: "style_litianc_default",
        layout_profile_id: "wechat_clean_article",
      },
      output_contract: {
        allow_image_actions: true,
      },
    });
  });

  it("maps WritingAgent article packages back to mining ArticleResult", () => {
    expect(articleResultFromWritingAgentResponse({
      status: "article_ready",
      result: {
        title: "外部平台标题",
        content_html: "<section><p>外部平台正文</p></section>",
        cover: {
          cover_title: ["外部", "平台"],
          cover_subtitle: "可配置",
          image_prompt: "A clean editorial image, no text",
        },
        image_actions: [
          {
            image_id: "opening desk",
            kind: "insert_image",
            prompt: "A warm desk, no text",
            alt: "办公桌",
            anchor: { position: "after", paragraph_index: 1 },
          },
        ],
      },
    })).toEqual({
      title: "外部平台标题",
      content: "<section><p>外部平台正文</p></section>",
      imagePrompt: "A clean editorial image, no text",
      coverTitle: ["外部", "平台"],
      coverSubtitle: "可配置",
      imageActions: [
        {
          imageId: "opening_desk",
          kind: "insert_image",
          prompt: "A warm desk, no text",
          alt: "办公桌",
          anchor: { position: "after", paragraphIndex: 1, text: undefined },
        },
      ],
    });
  });

  it("calls the configured WritingAgent endpoint", async () => {
    process.env = {
      ...originalEnv,
      WRITING_AGENT_BASE_URL: "https://writing-agent.example.test",
      WRITING_AGENT_TOKEN: "writing-token",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "article_ready",
      result: {
        title: "平台文章",
        content_html: "<p>平台正文</p>",
        cover: {
          image_prompt: "A clean image",
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(rewriteArticle({
      rawText: "raw text",
      clientJobId: "job-3",
      sourceType: "audio_transcript",
    })).resolves.toMatchObject({
      title: "平台文章",
      content: "<p>平台正文</p>",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://writing-agent.example.test/v1/rewrite-jobs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer writing-token",
        }),
      }),
    );
  });

  it("calls the configured WritingAgent revision endpoint", async () => {
    process.env = {
      ...originalEnv,
      WRITING_AGENT_BASE_URL: "https://writing-agent.example.test",
      WRITING_AGENT_TOKEN: "writing-token",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "article_ready",
      result: {
        title: "新版平台文章",
        content_html: "<p>新版平台正文</p>",
        cover: {
          image_prompt: "A revised clean image",
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(reviseArticle({
      rawText: "raw text",
      currentTitle: "旧标题",
      currentContent: "<p>旧正文</p>",
      instructionText: "补充一个结论",
      clientJobId: "revision-job-3",
    })).resolves.toMatchObject({
      title: "新版平台文章",
      content: "<p>新版平台正文</p>",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://writing-agent.example.test/v1/revision-jobs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer writing-token",
        }),
      }),
    );
  });
});
