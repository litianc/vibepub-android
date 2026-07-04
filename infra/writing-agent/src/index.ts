import { articlePackageFromResponse } from "./article";
import {
  DEFAULT_LAYOUT_PROFILES,
  DEFAULT_STYLE_PROFILES,
  findLayoutProfile,
  findStyleProfile,
  publicLayoutProfile,
  publicStyleProfile,
  type LayoutProfile,
  type StyleProfile,
} from "./defaultProfiles";

export interface Env {
  WRITING_AGENT_TOKEN?: string;
  FILES_TOKEN?: string;
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
}

type RewriteJobRequest = {
  protocol_version?: string;
  client_job_id?: string;
  idempotency_key?: string;
  user?: {
    user_id?: string;
    workspace_id?: string;
  };
  input?: {
    source_type?: string;
    raw_text?: string;
    title_hint?: string;
    language?: string;
  };
  profiles?: {
    style_profile_id?: string;
    style_profile_version?: string;
    layout_profile_id?: string;
    layout_profile_version?: string;
  };
  output_contract?: {
    format?: string;
    content_format?: string;
    require_cover_fields?: boolean;
  };
};

const PROTOCOL_VERSION = "vibepub.rewrite.v1";
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/";
const DEFAULT_GLM_MODEL = "glm-5.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Writing-Agent-Token",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "writing-agent" });
    }

    if (url.pathname.startsWith("/v1/") && !(await isAuthorized(request, env))) {
      return json({ error: { code: "unauthorized", message: "Missing or invalid WritingAgent token" } }, 401);
    }

    if (request.method === "GET" && url.pathname === "/v1/style-profiles") {
      return json({ style_profiles: DEFAULT_STYLE_PROFILES.map(publicStyleProfile) });
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/style-profiles/")) {
      const profile = findStyleProfile(decodeURIComponent(url.pathname.slice("/v1/style-profiles/".length)));
      return profile ? json({ style_profile: publicStyleProfile(profile) }) : profileNotFound("style_profile");
    }

    if (request.method === "GET" && url.pathname === "/v1/layout-profiles") {
      return json({ layout_profiles: DEFAULT_LAYOUT_PROFILES.map(publicLayoutProfile) });
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/layout-profiles/")) {
      const profile = findLayoutProfile(decodeURIComponent(url.pathname.slice("/v1/layout-profiles/".length)));
      return profile ? json({ layout_profile: publicLayoutProfile(profile) }) : profileNotFound("layout_profile");
    }

    if (request.method === "POST" && url.pathname === "/v1/rewrite-jobs") {
      try {
        return await createRewriteJob(request, env);
      } catch (error) {
        if (error instanceof ResponseError) {
          return json({ error: { code: error.code, message: error.message } }, error.status);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: { code: "internal_error", message } }, 500);
      }
    }

    return json({ error: { code: "not_found", message: "Route not found" } }, 404);
  },
};

async function createRewriteJob(request: Request, env: Env): Promise<Response> {
  let body: RewriteJobRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "invalid_json", message: "Request body must be JSON" } }, 400);
  }

  const rawText = body.input?.raw_text?.trim();
  if (!rawText) {
    return json({ error: { code: "raw_text_required", message: "input.raw_text is required" } }, 400);
  }

  const styleProfile = findStyleProfile(body.profiles?.style_profile_id);
  if (!styleProfile) {
    return profileNotFound("style_profile");
  }

  const layoutProfile = findLayoutProfile(body.profiles?.layout_profile_id);
  if (!layoutProfile) {
    return profileNotFound("layout_profile");
  }

  const jobId = await deterministicJobId(body, rawText);
  const prompt = buildRewritePrompt(body, styleProfile, layoutProfile);
  const article = await generateArticlePackage(env, prompt);

  return json({
    protocol_version: PROTOCOL_VERSION,
    job_id: jobId,
    status: "article_ready",
    result: article,
    profile_versions: {
      style_profile_id: styleProfile.id,
      style_profile_version: styleProfile.version,
      layout_profile_id: layoutProfile.id,
      layout_profile_version: layoutProfile.version,
    },
  }, 201);
}

function buildRewritePrompt(
  request: RewriteJobRequest,
  styleProfile: StyleProfile,
  layoutProfile: LayoutProfile,
): string {
  const titleHint = request.input?.title_hint?.trim();
  return `你是 WritingAgent，一个独立的公众号文章改写平台。
请根据用户选择的写作风格画像和公众号排版要求，把原始文字改写成可发布文章。

【写作风格画像：${styleProfile.name} / ${styleProfile.version}】
${styleProfile.body}

【公众号排版要求：${layoutProfile.name} / ${layoutProfile.version}】
${layoutProfile.body}

【输出要求】
请只返回 JSON 对象，不要返回 Markdown 代码块或额外说明。
JSON 必须包含：
- title：文章标题，保持克制、有对象、有判断。
- content_html：正文 HTML 片段，遵守上面的公众号排版要求。
- summary：可选摘要。
- cover_title：公众号封面主标题短句数组，2-3 行。
- cover_subtitle：可选封面副标题，12 字以内。
- image_prompt：备用英文无字底图提示词；不要让图片模型生成中文标题。

【标题提示】
${titleHint || "无"}

【原始文字】
${request.input?.raw_text?.trim()}`;
}

async function generateArticlePackage(env: Env, prompt: string) {
  const apiKey = env.GLM_API_KEY?.trim();
  if (!apiKey) {
    throw new ResponseError(503, "upstream_unconfigured", "GLM_API_KEY is required");
  }

  const baseUrl = (env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL).replace(/\/+$/, "");
  const model = env.GLM_MODEL || DEFAULT_GLM_MODEL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.6,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new ResponseError(response.status, "upstream_failed", responseText.slice(0, 500));
  }

  const parsed = JSON.parse(responseText) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) {
    throw new ResponseError(502, "empty_model_response", "Model returned an empty article response");
  }
  return articlePackageFromResponse(content);
}

async function deterministicJobId(body: RewriteJobRequest, rawText: string): Promise<string> {
  const key = body.idempotency_key || body.client_job_id || rawText;
  const encoded = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  return `rw_${hex.slice(0, 24)}`;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.WRITING_AGENT_TOKEN?.trim() || env.FILES_TOKEN?.trim();
  if (!expected) return false;
  const authorization = request.headers.get("authorization") || "";
  const tokenHeader = request.headers.get("x-writing-agent-token") || "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return await secureTokenEquals(expected, bearerToken) || await secureTokenEquals(expected, tokenHeader.trim());
}

async function secureTokenEquals(expected: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const encoder = new TextEncoder();
  const [expectedDigest, candidateDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const candidateBytes = new Uint8Array(candidateDigest);
  let diff = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= expectedBytes[index] ^ candidateBytes[index];
  }
  return diff === 0;
}

function profileNotFound(kind: "style_profile" | "layout_profile"): Response {
  return json({ error: { code: "invalid_profile", message: `${kind} does not exist or is not accessible` } }, 404);
}

class ResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}
