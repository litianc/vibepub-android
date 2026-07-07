import { processAudioText, reviseArticleWithInstruction, type ArticleResult } from "./llm.js";
import { normalizeArticleImageActions } from "./articleImageActions.js";

type RewriteArticleInput = {
  rawText: string;
  clientJobId: string;
  sourceType: "audio_transcript" | "text_submission";
  userId?: string;
  workspaceId?: string;
  titleHint?: string;
  styleProfileId?: string;
  styleProfileVersion?: string;
  styleProfileName?: string;
  styleProfileDescription?: string;
  styleProfileBody?: string;
  layoutProfileId?: string;
  layoutProfileVersion?: string;
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
    image_actions?: unknown;
    imageActions?: unknown;
    warnings?: string[];
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type ReviseArticleInput = {
  rawText: string;
  currentTitle: string;
  currentContent: string;
  instructionText: string;
  clientJobId?: string;
  userId?: string;
  workspaceId?: string;
  styleProfileId?: string;
  styleProfileVersion?: string;
  styleProfileName?: string;
  styleProfileDescription?: string;
  styleProfileBody?: string;
  layoutProfileId?: string;
  layoutProfileVersion?: string;
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
      ...writingAgentIdentityHeaders(input),
    },
    body: JSON.stringify(buildWritingAgentRequest(input)),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`WritingAgent rewrite failed: HTTP ${response.status} ${responseBody.slice(0, 500)}`);
  }

  return articleResultFromWritingAgentResponse(JSON.parse(responseBody) as WritingAgentResponse);
}

export async function reviseArticle(input: ReviseArticleInput): Promise<ArticleResult> {
  const baseUrl = process.env.WRITING_AGENT_BASE_URL?.trim();
  if (!baseUrl) {
    return reviseArticleWithInstruction({
      rawText: input.rawText,
      currentTitle: input.currentTitle,
      currentContent: input.currentContent,
      instructionText: input.instructionText,
    });
  }

  const token = process.env.WRITING_AGENT_TOKEN?.trim() || process.env.FILES_TOKEN?.trim();
  if (!token) {
    throw new Error("WRITING_AGENT_TOKEN or FILES_TOKEN is required when WRITING_AGENT_BASE_URL is set");
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/revision-jobs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...writingAgentIdentityHeaders(input),
    },
    body: JSON.stringify(buildWritingAgentRevisionRequest(input)),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`WritingAgent revision failed: HTTP ${response.status} ${responseBody.slice(0, 500)}`);
  }

  return articleResultFromWritingAgentResponse(JSON.parse(responseBody) as WritingAgentResponse);
}

export function buildWritingAgentRequest(input: RewriteArticleInput): Record<string, unknown> {
  return {
    protocol_version: "vibepub.rewrite.v1",
    client_job_id: input.clientJobId,
    idempotency_key: input.clientJobId,
    user: {
      user_id: writingAgentUserId(input),
      workspace_id: writingAgentWorkspaceId(input),
    },
    input: {
      source_type: input.sourceType,
      raw_text: input.rawText,
      title_hint: input.titleHint,
      language: "zh-CN",
    },
    profiles: {
      style_profile_id: normalizeProfileValue(input.styleProfileId) ||
        process.env.WRITING_AGENT_STYLE_PROFILE_ID?.trim() ||
        "style_litianc_default",
      style_profile_version: normalizeProfileValue(input.styleProfileVersion) ||
        process.env.WRITING_AGENT_STYLE_PROFILE_VERSION?.trim() ||
        undefined,
      style_profile_name: normalizeProfileValue(input.styleProfileName) || undefined,
      style_profile_description: normalizeProfileValue(input.styleProfileDescription) || undefined,
      style_profile_body: normalizeProfileValue(input.styleProfileBody) || undefined,
      layout_profile_id: normalizeProfileValue(input.layoutProfileId) ||
        process.env.WRITING_AGENT_LAYOUT_PROFILE_ID?.trim() ||
        "wechat_clean_article",
      layout_profile_version: normalizeProfileValue(input.layoutProfileVersion) ||
        process.env.WRITING_AGENT_LAYOUT_PROFILE_VERSION?.trim() ||
        undefined,
    },
    output_contract: {
      format: "wechat_article_package",
      content_format: "html_fragment",
      require_cover_fields: true,
      allow_image_actions: true,
      image_actions: {
        max_actions: 3,
        supported_actions: ["insert_image"],
        supported_positions: ["start", "end", "before", "after"],
      },
    },
  };
}

export function buildWritingAgentRevisionRequest(input: ReviseArticleInput): Record<string, unknown> {
  const clientJobId = input.clientJobId || `revision:${input.currentTitle}:${input.instructionText}`;
  return {
    protocol_version: "vibepub.rewrite.v1",
    client_job_id: clientJobId,
    idempotency_key: clientJobId,
    user: {
      user_id: writingAgentUserId(input),
      workspace_id: writingAgentWorkspaceId(input),
    },
    current_article: {
      raw_text: input.rawText,
      title: input.currentTitle,
      content_html: input.currentContent,
    },
    instruction: {
      source_type: "voice_instruction",
      text: input.instructionText,
      language: "zh-CN",
    },
    profiles: {
      style_profile_id: normalizeProfileValue(input.styleProfileId) ||
        process.env.WRITING_AGENT_STYLE_PROFILE_ID?.trim() ||
        "style_litianc_default",
      style_profile_version: normalizeProfileValue(input.styleProfileVersion) ||
        process.env.WRITING_AGENT_STYLE_PROFILE_VERSION?.trim() ||
        undefined,
      style_profile_name: normalizeProfileValue(input.styleProfileName) || undefined,
      style_profile_description: normalizeProfileValue(input.styleProfileDescription) || undefined,
      style_profile_body: normalizeProfileValue(input.styleProfileBody) || undefined,
      layout_profile_id: normalizeProfileValue(input.layoutProfileId) ||
        process.env.WRITING_AGENT_LAYOUT_PROFILE_ID?.trim() ||
        "wechat_clean_article",
      layout_profile_version: normalizeProfileValue(input.layoutProfileVersion) ||
        process.env.WRITING_AGENT_LAYOUT_PROFILE_VERSION?.trim() ||
        undefined,
    },
    output_contract: {
      format: "wechat_article_package",
      content_format: "html_fragment",
      require_cover_fields: true,
      allow_image_actions: true,
      image_actions: {
        max_actions: 3,
        supported_actions: ["insert_image"],
        supported_positions: ["start", "end", "before", "after"],
      },
    },
  };
}

function writingAgentUserId(input: { userId?: string }): string {
  return input.userId?.trim() || process.env.WRITING_AGENT_USER_ID?.trim() || "default_user";
}

function writingAgentWorkspaceId(input: { workspaceId?: string; userId?: string }): string {
  return input.workspaceId?.trim() ||
    process.env.WRITING_AGENT_WORKSPACE_ID?.trim() ||
    (input.userId ? `ws_${input.userId.replace(/^usr_/, "")}` : "vibepub-dogfood");
}

function writingAgentIdentityHeaders(input: { userId?: string; workspaceId?: string }): Record<string, string> {
  return {
    "X-VibePub-User-Id": writingAgentUserId(input),
    "X-VibePub-Workspace-Id": writingAgentWorkspaceId(input),
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
  const imageActions = normalizeArticleImageActions(result?.image_actions ?? result?.imageActions);

  return {
    title,
    content,
    imagePrompt: normalizeString(result?.cover?.image_prompt) ||
      "A clean editorial cover image, no text, no logo, no watermark",
    coverTitle: normalizeStringArray(result?.cover?.cover_title),
    coverSubtitle: normalizeString(result?.cover?.cover_subtitle) || undefined,
    ...(imageActions.length > 0 ? { imageActions } : {}),
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

function normalizeProfileValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
