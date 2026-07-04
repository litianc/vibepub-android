import { afterEach, describe, expect, it, vi } from "vitest";
import {
  articleResultFromWritingAgentResponse,
  buildWritingAgentRequest,
  rewriteArticle,
} from "../src/writingAgent.js";
import { processAudioText } from "../src/llm.js";

vi.mock("../src/llm.js", () => ({
  processAudioText: vi.fn(),
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
      },
    })).toEqual({
      title: "外部平台标题",
      content: "<section><p>外部平台正文</p></section>",
      imagePrompt: "A clean editorial image, no text",
      coverTitle: ["外部", "平台"],
      coverSubtitle: "可配置",
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
});
