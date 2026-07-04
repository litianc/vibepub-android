import { processAudioText, type ArticleResult } from "./llm.js";

type RewriteArticleInput = {
  rawText: string;
  clientJobId: string;
  sourceType: "audio_transcript" | "text_submission";
  titleHint?: string;
};

type WritingAgentResponse = {
  status?: string;
  result?: {
    title?: string;
    content_html?: string;
    content?: string;
    cover?: {
      cover_title?: unknown;
      cover_subtitle?: string;
      image_prompt?: string;
    };
    warnings?: string[];
  };
  error?: {
    code?: string;
    message?: string;
  };
};

export async function rewriteArticle(input: RewriteArticleInput): Promise<ArticleResult> {
  const baseUrl = process.env.WRITING_AGENT_BASE_URL?.trim();
  if (!baseUrl) {
    return processAudioText(input.rawText);
  }

  const token = process.env.WRITING_AGENT_TOKEN?.trim() || process.env.FILES_TOKEN?.trim();
  if (!token) {
    throw new Error("WRITING_AGENT_TOKEN or FILES_TOKEN is required when WRITING_AGENT_BASE_URL is set");
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/rewrite-jobs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildWritingAgentRequest(input)),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`WritingAgent rewrite failed: HTTP ${response.status} ${responseBody.slice(0, 500)}`);
  }

  return articleResultFromWritingAgentResponse(JSON.parse(responseBody) as WritingAgentResponse);
}

export function buildWritingAgentRequest(input: RewriteArticleInput): Record<string, unknown> {
  return {
    protocol_version: "vibepub.rewrite.v1",
    client_job_id: input.clientJobId,
    idempotency_key: input.clientJobId,
    user: {
      user_id: process.env.WRITING_AGENT_USER_ID?.trim() || "default_user",
      workspace_id: process.env.WRITING_AGENT_WORKSPACE_ID?.trim() || "vibepub-dogfood",
    },
    input: {
      source_type: input.sourceType,
      raw_text: input.rawText,
      title_hint: input.titleHint,
      language: "zh-CN",
    },
    profiles: {
      style_profile_id: process.env.WRITING_AGENT_STYLE_PROFILE_ID?.trim() || "style_litianc_default",
      style_profile_version: process.env.WRITING_AGENT_STYLE_PROFILE_VERSION?.trim() || undefined,
      layout_profile_id: process.env.WRITING_AGENT_LAYOUT_PROFILE_ID?.trim() || "wechat_clean_article",
      layout_profile_version: process.env.WRITING_AGENT_LAYOUT_PROFILE_VERSION?.trim() || undefined,
    },
    output_contract: {
      format: "wechat_article_package",
      content_format: "html_fragment",
      require_cover_fields: true,
    },
  };
}

export function articleResultFromWritingAgentResponse(response: WritingAgentResponse): ArticleResult {
  if (response.status === "failed") {
    throw new Error(`WritingAgent rewrite failed: ${response.error?.message || response.error?.code || "unknown error"}`);
  }
  if (response.status && response.status !== "article_ready") {
    throw new Error(`WritingAgent returned unsupported async status: ${response.status}`);
  }

  const result = response.result;
  const title = normalizeString(result?.title);
  const content = normalizeString(result?.content_html) || normalizeString(result?.content);
  if (!title || !content) {
    throw new Error("WritingAgent response is missing title or content_html");
  }

  return {
    title,
    content,
    imagePrompt: normalizeString(result?.cover?.image_prompt) ||
      "A clean editorial cover image, no text, no logo, no watermark",
    coverTitle: normalizeStringArray(result?.cover?.cover_title),
    coverSubtitle: normalizeString(result?.cover?.cover_subtitle) || undefined,
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map(item => normalizeString(item))
    .filter(Boolean)
    .slice(0, 3);
  return normalized.length > 0 ? normalized : undefined;
}
