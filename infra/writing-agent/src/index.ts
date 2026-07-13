import { articlePackageFromResponse, type ArticleImageAction, type ArticlePackage } from "./article";
import {
  DEFAULT_LAYOUT_PROFILES,
  DEFAULT_STYLE_PROFILES,
  findLayoutProfile,
  findStyleProfile,
  publicLayoutProfile,
  publicStyleProfile,
  type StyleProfile,
} from "./defaultProfiles";
import {
  buildFormattingInstructions,
  createFormattingSkillRegistry,
  FormattingSkillError,
  formattingProfileVersions,
  getFormattingSkill,
  listFormattingSkills,
  resolveFormattingSkill,
  validateAndNormalizeArticlePackage,
  type FormattingSkillDefinition,
  type ResolvedFormattingSkill,
} from "./formattingSkills";

export interface Env {
  DB?: D1Database;
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
    style_profile_name?: string;
    style_profile_description?: string;
    style_profile_body?: string;
    layout_profile_id?: string;
    layout_profile_version?: string;
    formatting_skill_id?: string;
    formatting_skill_version?: string;
  };
  output_contract?: {
    format?: string;
    content_format?: string;
    require_cover_fields?: boolean;
    allow_image_actions?: boolean;
  };
};

type RevisionJobRequest = RewriteJobRequest & {
  current_article?: {
    raw_text?: string;
    title?: string;
    content?: string;
    content_html?: string;
  };
  instruction?: {
    source_type?: string;
    text?: string;
    language?: string;
  };
};

type StyleSourceImportRequest = {
  source_type?: string;
  url?: string;
  source_url?: string;
  title?: string;
  text?: string;
  raw_text?: string;
};

type StyleDistillationJobRequest = {
  source_import_ids?: string[];
  source_ids?: string[];
  profile_id?: string;
  profile?: {
    id?: string;
    name?: string;
    description?: string;
  };
  name?: string;
  description?: string;
};

type AuthIdentity = {
  userId: string;
  workspaceId: string;
};

const PROTOCOL_VERSION = "vibepub.rewrite.v1";
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4/";
const DEFAULT_GLM_MODEL = "glm-5.2";
const MAX_INLINE_STYLE_PROFILE_BODY_CHARS = 8_000;
const MAX_STYLE_SOURCE_TEXT_CHARS = 30_000;
const MAX_STYLE_DISTILLATION_SOURCE_CHARS = 80_000;
const MIN_FETCHED_SOURCE_TEXT_CHARS = 1_200;
const SOURCE_FETCH_TIMEOUT_MS = 8_000;
const MAX_PROFILE_VERSIONS = 10;
const DEFAULT_WORKSPACE_ID = "vibepub-dogfood";
const DEFAULT_USER_ID = "default_user";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Writing-Agent-Token, X-VibePub-User-Id, X-VibePub-Workspace-Id",
};

export function createWritingAgentWorker(
  formattingRegistry: readonly FormattingSkillDefinition[] = createFormattingSkillRegistry(),
) {
  const registry = [...formattingRegistry];
  const fetch = async (request: Request, env: Env): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "writing-agent" });
    }

    const identity = await authenticate(request, env);
    if (url.pathname.startsWith("/v1/") && !identity) {
      return json({ error: { code: "unauthorized", message: "Missing or invalid WritingAgent token" } }, 401);
    }

    if (request.method === "GET" && url.pathname === "/v1/style-profiles") {
      return routeJson(() => listStyleProfiles(env, identity!));
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/style-profiles/")) {
      return routeJson(() => getStyleProfile(env, url, identity!));
    }

    if (request.method === "POST" && url.pathname === "/v1/style-source-imports") {
      return routeJson(() => createStyleSourceImport(request, env, identity!), 201);
    }

    if (request.method === "GET" && url.pathname === "/v1/style-source-imports") {
      return routeJson(() => listStyleSourceImports(env, identity!));
    }

    if (request.method === "POST" && url.pathname === "/v1/style-distillation-jobs") {
      return routeJson(() => createStyleDistillationJob(request, env, identity!), 201);
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/style-distillation-jobs/")) {
      return routeJson(() => getStyleDistillationJob(env, url, identity!));
    }

    if (request.method === "GET" && url.pathname === "/v1/layout-profiles") {
      return json({ layout_profiles: DEFAULT_LAYOUT_PROFILES.map(publicLayoutProfile) });
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/layout-profiles/")) {
      const profile = findLayoutProfile(decodeURIComponent(url.pathname.slice("/v1/layout-profiles/".length)));
      return profile ? json({ layout_profile: publicLayoutProfile(profile) }) : profileNotFound("layout_profile");
    }

    if (request.method === "GET" && url.pathname === "/v1/formatting-skills") {
      return json({ formatting_skills: listFormattingSkills(registry) });
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/formatting-skills/")) {
      return routeJson(() => Promise.resolve({
        formatting_skill: getFormattingSkill(
          decodeURIComponent(url.pathname.slice("/v1/formatting-skills/".length)),
          registry,
        ),
      }));
    }

    if (request.method === "POST" && url.pathname === "/v1/rewrite-jobs") {
      try {
        return await createRewriteJob(request, env, identity!, registry);
      } catch (error) {
        if (isPublicResponseError(error)) {
          return json({ error: { code: error.code, message: error.message } }, error.status);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: { code: "internal_error", message } }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/revision-jobs") {
      try {
        return await createRevisionJob(request, env, identity!, registry);
      } catch (error) {
        if (isPublicResponseError(error)) {
          return json({ error: { code: error.code, message: error.message } }, error.status);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: { code: "internal_error", message } }, 500);
      }
    }

    return json({ error: { code: "not_found", message: "Route not found" } }, 404);
  };
  return { fetch };
}

export default createWritingAgentWorker();

async function createRewriteJob(
  request: Request,
  env: Env,
  identity: AuthIdentity,
  formattingRegistry: readonly FormattingSkillDefinition[],
): Promise<Response> {
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

  const styleProfile = await resolveStyleProfile(env, body.profiles, workspaceIdFromRequest(body, identity));

  const formattingSkill = resolveFormattingSkill(body.profiles, formattingRegistry);

  const jobId = await deterministicJobId(body, rawText);
  const prompt = buildRewritePrompt(body, styleProfile, formattingSkill);
  const article = validateAndNormalizeArticlePackage(await generateArticlePackage(env, prompt), formattingSkill);

  return json({
    protocol_version: PROTOCOL_VERSION,
    job_id: jobId,
    status: "article_ready",
    result: article,
    profile_versions: {
      style_profile_id: styleProfile.id,
      style_profile_version: styleProfile.version,
      ...formattingProfileVersions(formattingSkill),
    },
  }, 201);
}

async function createRevisionJob(
  request: Request,
  env: Env,
  identity: AuthIdentity,
  formattingRegistry: readonly FormattingSkillDefinition[],
): Promise<Response> {
  let body: RevisionJobRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "invalid_json", message: "Request body must be JSON" } }, 400);
  }

  const currentContent = body.current_article?.content_html?.trim() || body.current_article?.content?.trim();
  if (!currentContent) {
    return json({
      error: { code: "current_article_required", message: "current_article.content_html is required" },
    }, 400);
  }

  const instructionText = body.instruction?.text?.trim();
  if (!instructionText) {
    return json({
      error: { code: "revision_instruction_required", message: "instruction.text is required" },
    }, 400);
  }

  const styleProfile = await resolveStyleProfile(env, body.profiles, workspaceIdFromRequest(body, identity));

  const formattingSkill = resolveFormattingSkill(body.profiles, formattingRegistry);

  const jobId = await deterministicJobId(body, `${currentContent}\n\n${instructionText}`);
  const prompt = buildRevisionPrompt(body, styleProfile, formattingSkill, currentContent, instructionText);
  const article = validateAndNormalizeArticlePackage(ensureRequestedImageAction(
    await generateArticlePackage(env, prompt),
    instructionText,
    Boolean(body.output_contract?.allow_image_actions),
  ), formattingSkill);

  return json({
    protocol_version: PROTOCOL_VERSION,
    job_id: jobId,
    status: "article_ready",
    result: article,
    profile_versions: {
      style_profile_id: styleProfile.id,
      style_profile_version: styleProfile.version,
      ...formattingProfileVersions(formattingSkill),
    },
  }, 201);
}

function ensureRequestedImageAction(
  article: ArticlePackage,
  instructionText: string,
  allowImageActions: boolean,
): ArticlePackage {
  if (!allowImageActions || article.image_actions?.length || !requestsArticleImage(instructionText)) {
    return article;
  }

  return {
    ...article,
    image_actions: [
      {
        image_id: "requested_image_1",
        kind: "insert_image",
        prompt: fallbackArticleImagePrompt(instructionText),
        alt: "根据修改要求生成的正文配图",
        anchor: fallbackArticleImageAnchor(instructionText),
      },
    ],
    warnings: [
      ...article.warnings,
      "模型没有返回 image_actions，已根据明确配图指令补充一条插图动作。",
    ],
  };
}

function requestsArticleImage(instructionText: string): boolean {
  const normalized = instructionText.trim();
  if (!normalized) return false;
  return /(配图|插图|图片|照片|图像|加.{0,12}图|插.{0,12}图|放.{0,12}图)/.test(normalized);
}

function fallbackArticleImagePrompt(instructionText: string): string {
  const topic = imageTopicFromInstruction(instructionText);
  return [
    topic,
    "Use case: inline illustration for a WeChat public account article.",
    "Style: natural, realistic editorial scene, warm daylight, calm professional mood.",
    "Constraints: no text, no letters, no logos, no watermarks, no UI screenshots.",
  ].join(" ");
}

function imageTopicFromInstruction(instructionText: string): string {
  const topics: string[] = [];
  if (/办公桌|书桌|桌面|桌上/.test(instructionText)) {
    topics.push("a warm office desk with notes");
  }
  if (/录音|语音|麦克风|话筒|播客/.test(instructionText)) {
    topics.push("a small audio recorder and microphone");
  }
  if (/咖啡|茶/.test(instructionText)) {
    topics.push("a cup of coffee or tea");
  }
  if (/手机|电脑|笔记本/.test(instructionText)) {
    topics.push("a laptop and phone used for writing");
  }
  if (topics.length > 0) {
    return topics.join(", ");
  }
  return "an editorial scene related to the article revision request";
}

function fallbackArticleImageAnchor(instructionText: string): ArticleImageAction["anchor"] {
  const paragraphIndex = paragraphIndexFromInstruction(instructionText);
  const position = /前面|之前|前/.test(instructionText)
    ? "before"
    : /后面|之后|后/.test(instructionText)
      ? "after"
      : "end";
  return {
    position,
    paragraph_index: paragraphIndex,
  };
}

function paragraphIndexFromInstruction(instructionText: string): number | undefined {
  const digitMatch = instructionText.match(/第\s*(\d+)\s*段/);
  if (digitMatch) {
    return Number.parseInt(digitMatch[1], 10);
  }
  const hanMatch = instructionText.match(/第\s*([一二三四五六七八九十])\s*段/);
  if (!hanMatch) return undefined;
  return chineseParagraphNumber(hanMatch[1]);
}

function chineseParagraphNumber(value: string): number | undefined {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return map[value];
}

async function resolveStyleProfile(
  env: Env,
  profiles: RewriteJobRequest["profiles"],
  workspaceId: string,
): Promise<StyleProfile> {
  const inlineBody = normalizeInlineStyleProfileBody(profiles?.style_profile_body);
  if (inlineBody) {
    return {
      id: profiles?.style_profile_id?.trim() || "custom_inline_style",
      name: profiles?.style_profile_name?.trim() || "用户自定义写作风格",
      version: profiles?.style_profile_version?.trim() || new Date().toISOString(),
      description: profiles?.style_profile_description?.trim() || "由 VibePub App 提交的自定义风格画像",
      body: inlineBody,
    };
  }

  const persistentProfile = await findPersistedStyleProfile(env, profiles?.style_profile_id, workspaceId);
  if (persistentProfile) {
    return persistentProfile;
  }

  const styleProfile = findStyleProfile(profiles?.style_profile_id);
  if (!styleProfile) {
    throw new ResponseError(404, "invalid_profile", "style_profile does not exist or is not accessible");
  }
  return styleProfile;
}

async function listStyleProfiles(env: Env, identity: AuthIdentity): Promise<unknown> {
  const workspaceId = identity.workspaceId;
  const profiles = [...DEFAULT_STYLE_PROFILES.map(profile => ({
    ...publicStyleProfile(profile),
    visibility: "public",
    owner_type: "system",
    is_default: profile.id === DEFAULT_STYLE_PROFILES[0].id,
  }))];

  if (env.DB) {
    const rows = await env.DB.prepare(
      `
      SELECT p.id, p.name, p.description, p.visibility, p.owner_user_id, p.workspace_id,
             v.id AS active_version_id, v.version_label AS version, v.created_at AS version_created_at
      FROM style_profiles p
      JOIN style_profile_versions v ON v.id = p.active_version_id
      WHERE p.workspace_id = ? AND p.deleted_at IS NULL
      ORDER BY p.updated_at DESC
      `,
    )
      .bind(workspaceId)
      .all<StyleProfileListRow>();
    profiles.push(...(rows.results || []).map(publicPersistedStyleProfile));
  }

  return { style_profiles: profiles };
}

async function getStyleProfile(env: Env, url: URL, identity: AuthIdentity): Promise<unknown> {
  const profileId = decodeURIComponent(url.pathname.slice("/v1/style-profiles/".length));
  const workspaceId = identity.workspaceId;
  const includeBody = url.searchParams.get("include_body") === "true";
  const persistent = await findPersistedStyleProfile(env, profileId, workspaceId);
  if (persistent) {
    return {
      style_profile: includeBody ? persistent : publicStyleProfile(persistent),
    };
  }
  const profile = findStyleProfile(profileId);
  if (!profile) {
    throw new ResponseError(404, "invalid_profile", "style_profile does not exist or is not accessible");
  }
  return { style_profile: includeBody ? profile : publicStyleProfile(profile) };
}

async function createStyleSourceImport(request: Request, env: Env, identity: AuthIdentity): Promise<unknown> {
  requireDb(env);
  const body = await parseRequestJson<StyleSourceImportRequest>(request);
  const sourceType = normalizeSourceType(body.source_type);
  const sourceUrl = normalizeOptionalString(body.source_url ?? body.url);
  const submittedTitle = normalizeOptionalString(body.title);
  const submittedText = normalizeOptionalString(body.text ?? body.raw_text);
  const fetched = await fetchSourceContentIfUseful(sourceType, sourceUrl, submittedText);
  const title = submittedTitle || fetched?.title || "";
  const sourceText = normalizeSourceText(fetched?.text || submittedText, sourceUrl, title);
  const now = new Date().toISOString();
  const id = `ssi_${crypto.randomUUID()}`;
  const workspaceId = identity.workspaceId;
  const userId = identity.userId;

  await env.DB.prepare(
    `
    INSERT INTO style_source_imports
      (id, workspace_id, user_id, source_type, source_url, title, text, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(id, workspaceId, userId, sourceType, sourceUrl || null, title || null, sourceText, "ready", now, now)
    .run();

  return {
    source_import: {
      id,
      workspace_id: workspaceId,
      source_type: sourceType,
      source_url: sourceUrl || null,
      title: title || null,
      status: "ready",
      text_preview: sourceText.slice(0, 240),
      created_at: now,
    },
  };
}

async function listStyleSourceImports(env: Env, identity: AuthIdentity): Promise<unknown> {
  requireDb(env);
  const workspaceId = identity.workspaceId;
  const userId = identity.userId;
  const rows = await env.DB.prepare(
    `
    SELECT id, workspace_id, source_type, source_url, title, status, substr(text, 1, 240) AS text_preview, created_at, updated_at
    FROM style_source_imports
    WHERE workspace_id = ? AND user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
    `,
  )
    .bind(workspaceId, userId)
    .all<StyleSourceImportListRow>();

  return { source_imports: rows.results || [] };
}

async function createStyleDistillationJob(request: Request, env: Env, identity: AuthIdentity): Promise<unknown> {
  requireDb(env);
  const body = await parseRequestJson<StyleDistillationJobRequest>(request);
  const sourceIds = normalizedStringArray(body.source_import_ids ?? body.source_ids);
  if (sourceIds.length === 0) {
    throw new ResponseError(400, "source_imports_required", "At least one style source import is required");
  }

  const workspaceId = identity.workspaceId;
  const userId = identity.userId;
  const profileId = sanitizeProfileId(body.profile?.id ?? body.profile_id) || `style_${crypto.randomUUID()}`;
  const requestedName = normalizeOptionalString(body.profile?.name ?? body.name) ||
    "请根据素材标题、作者和主题生成风格名";
  const requestedDescription = normalizeOptionalString(body.profile?.description ?? body.description) ||
    "由导入素材自动提取的写作风格画像。";
  const sources = await loadStyleSources(env, workspaceId, userId, sourceIds);
  const distilled = await generateStyleProfileFromSources(env, {
    requestedName,
    requestedDescription,
    sources,
  });
  const now = new Date().toISOString();
  const versionId = `spv_${crypto.randomUUID()}`;
  const jobId = `sdj_${crypto.randomUUID()}`;

  await env.DB.prepare(
    `
    INSERT INTO style_profiles
      (id, workspace_id, owner_user_id, name, description, visibility, active_version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, workspace_id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      active_version_id = excluded.active_version_id,
      updated_at = excluded.updated_at,
      deleted_at = NULL
    `,
  )
    .bind(profileId, workspaceId, userId, distilled.name, distilled.description, "private", versionId, now, now)
    .run();

  await env.DB.prepare(
    `
    INSERT INTO style_profile_versions
      (id, profile_id, workspace_id, version_label, body, source_count, source_ids_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(versionId, profileId, workspaceId, now, distilled.body, sources.length, JSON.stringify(sourceIds), now)
    .run();

  await env.DB.prepare(
    `
    INSERT INTO style_distillation_jobs
      (id, workspace_id, profile_id, version_id, status, source_ids_json, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(jobId, workspaceId, profileId, versionId, "profile_ready", JSON.stringify(sourceIds), now, now)
    .run();

  await env.DB.prepare(
    `
    UPDATE style_source_imports
    SET used_in_profile_id = ?, updated_at = ?
    WHERE workspace_id = ? AND id IN (${sourceIds.map(() => "?").join(", ")})
    `,
  )
    .bind(profileId, now, workspaceId, ...sourceIds)
    .run();

  await pruneOldProfileVersions(env, workspaceId, profileId);

  return {
    distillation_job: {
      id: jobId,
      status: "profile_ready",
      source_import_ids: sourceIds,
      created_at: now,
      completed_at: now,
    },
    style_profile: {
      id: profileId,
      name: distilled.name,
      description: distilled.description,
      version: now,
      active_version_id: versionId,
      body: distilled.body,
      visibility: "private",
      workspace_id: workspaceId,
    },
  };
}

async function getStyleDistillationJob(env: Env, url: URL, identity: AuthIdentity): Promise<unknown> {
  requireDb(env);
  const jobId = decodeURIComponent(url.pathname.slice("/v1/style-distillation-jobs/".length));
  const workspaceId = identity.workspaceId;
  const row = await env.DB.prepare(
    `
    SELECT id, workspace_id, profile_id, version_id, status, source_ids_json, error_message, created_at, completed_at
    FROM style_distillation_jobs
    WHERE workspace_id = ? AND id = ?
    `,
  )
    .bind(workspaceId, jobId)
    .first<StyleDistillationJobRow>();
  if (!row) {
    throw new ResponseError(404, "job_not_found", "style distillation job does not exist");
  }
  return {
    distillation_job: {
      ...row,
      source_import_ids: parseJsonArray(row.source_ids_json),
      source_ids_json: undefined,
    },
  };
}

async function findPersistedStyleProfile(
  env: Env,
  profileId: string | undefined,
  workspaceId: string,
): Promise<StyleProfile | undefined> {
  const normalized = profileId?.trim();
  if (!normalized || !env.DB) return undefined;
  const row = await env.DB.prepare(
    `
    SELECT p.id, p.name, p.description, v.version_label AS version, v.body
    FROM style_profiles p
    JOIN style_profile_versions v ON v.id = p.active_version_id
    WHERE p.workspace_id = ? AND p.id = ? AND p.deleted_at IS NULL
    `,
  )
    .bind(workspaceId, normalized)
    .first<StyleProfileRow>();
  return row
    ? {
        id: row.id,
        name: row.name,
        version: row.version,
        description: row.description,
        body: row.body,
      }
    : undefined;
}

function normalizeInlineStyleProfileBody(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_INLINE_STYLE_PROFILE_BODY_CHARS);
}

function buildRewritePrompt(
  request: RewriteJobRequest,
  styleProfile: StyleProfile,
  formattingSkill: ResolvedFormattingSkill,
): string {
  const titleHint = request.input?.title_hint?.trim();
  return `你是 WritingAgent，一个独立的公众号文章改写平台。
请根据用户选择的写作风格画像和公众号排版要求，把原始文字改写成可发布文章。

【写作风格画像：${styleProfile.name} / ${styleProfile.version}】
${styleProfile.body}

【公众号排版 Skill：${formattingSkill.manifest.name} / ${formattingSkill.version}】
${buildFormattingInstructions(formattingSkill)}

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

function buildRevisionPrompt(
  request: RevisionJobRequest,
  styleProfile: StyleProfile,
  formattingSkill: ResolvedFormattingSkill,
  currentContent: string,
  instructionText: string,
): string {
  const currentTitle = request.current_article?.title?.trim() || "无";
  const rawText = request.current_article?.raw_text?.trim() || "无";
  const imageActionContract = request.output_contract?.allow_image_actions
    ? `
- image_actions：数组。只有用户明确要求生成图片、加配图、插图或编辑图片时才返回插图动作；没有配图要求时返回空数组。
  每个插图动作格式：
  {
    "image_id": "image_1",
    "kind": "insert_image",
    "prompt": "English prompt for image generation, no text, no logo, no watermark",
    "alt": "中文图片说明",
    "anchor": { "position": "after", "paragraph_index": 1 }
  }
  position 可用 start、end、before、after；paragraph_index 从 1 开始。不要直接在 content_html 中插入占位图片。`
    : "";
  return `你是 WritingAgent，一个独立的公众号文章改写平台。
用户已经有一篇公众号文章，现在又提交了一条修改指令。请根据写作风格画像和公众号排版要求，更新当前文章。

【写作风格画像：${styleProfile.name} / ${styleProfile.version}】
${styleProfile.body}

【公众号排版 Skill：${formattingSkill.manifest.name} / ${formattingSkill.version}】
${buildFormattingInstructions(formattingSkill)}

【修改原则】
1. 优先修改当前文章，不要因为一次修改指令就另起炉灶。
2. 保留原文章核心观点、作者口吻和已经成立的结构。
3. 对明确的删除、补充、换标题、调整结构、改变语气、增加例子等指令必须执行。
4. 如果修改指令模糊，做最小合理修改，并保持文章完整可发布。
5. 不要编造原始口述、当前文章和修改指令中都没有的信息。

【输出要求】
请只返回 JSON 对象，不要返回 Markdown 代码块或额外说明。
JSON 必须包含：
- title：新版文章标题。
- content_html：新版正文 HTML 片段，遵守上面的公众号排版要求。
- summary：可选摘要。
- cover_title：新版公众号封面主标题短句数组，2-3 行。
- cover_subtitle：可选封面副标题，12 字以内。
- image_prompt：备用英文无字底图提示词；不要让图片模型生成中文标题。
${imageActionContract}

【原始口述转录】
${rawText}

【当前文章标题】
${currentTitle}

【当前文章正文】
${currentContent}

【用户修改指令】
${instructionText}`;
}

async function generateArticlePackage(env: Env, prompt: string): Promise<ArticlePackage> {
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

type StyleProfileListRow = {
  id: string;
  name: string;
  description: string;
  visibility: string;
  owner_user_id: string;
  workspace_id: string;
  active_version_id: string;
  version: string;
  version_created_at: string;
};

type StyleProfileRow = {
  id: string;
  name: string;
  description: string;
  version: string;
  body: string;
};

type StyleSourceImportRow = {
  id: string;
  source_type: string;
  source_url: string | null;
  title: string | null;
  text: string;
};

type StyleSourceImportListRow = Omit<StyleSourceImportRow, "text"> & {
  workspace_id: string;
  status: string;
  text_preview: string;
  created_at: string;
  updated_at: string;
};

type StyleDistillationJobRow = {
  id: string;
  workspace_id: string;
  profile_id: string;
  version_id: string;
  status: string;
  source_ids_json: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

type DistilledStyleProfile = {
  name: string;
  description: string;
  body: string;
};

function publicPersistedStyleProfile(row: StyleProfileListRow) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    visibility: row.visibility,
    owner_type: "user",
    owner_user_id: row.owner_user_id,
    workspace_id: row.workspace_id,
    active_version_id: row.active_version_id,
    version_created_at: row.version_created_at,
    is_default: false,
  };
}

async function loadStyleSources(
  env: Env,
  workspaceId: string,
  userId: string,
  sourceIds: string[],
): Promise<StyleSourceImportRow[]> {
  const placeholders = sourceIds.map(() => "?").join(", ");
  const rows = await env.DB!.prepare(
    `
    SELECT id, source_type, source_url, title, text
    FROM style_source_imports
    WHERE workspace_id = ? AND user_id = ? AND id IN (${placeholders})
    `,
  )
    .bind(workspaceId, userId, ...sourceIds)
    .all<StyleSourceImportRow>();
  const sources = rows.results || [];
  if (sources.length !== sourceIds.length) {
    throw new ResponseError(404, "source_import_not_found", "One or more style source imports do not exist");
  }
  return sourceIds.map(id => sources.find(source => source.id === id)!);
}

async function generateStyleProfileFromSources(
  env: Env,
  input: {
    requestedName: string;
    requestedDescription: string;
    sources: StyleSourceImportRow[];
  },
): Promise<DistilledStyleProfile> {
  const prompt = buildStyleDistillationPrompt(input);
  const response = await generateJsonObject(env, prompt, { temperature: 0.35 });
  const parsed = JSON.parse(response) as Partial<DistilledStyleProfile>;
  const body = normalizeOptionalString(parsed.body);
  if (!body) {
    throw new ResponseError(502, "invalid_distillation_response", "Model response is missing style profile body");
  }
  return {
    name: normalizeOptionalString(parsed.name) || input.requestedName,
    description: normalizeOptionalString(parsed.description) || input.requestedDescription,
    body: body.slice(0, MAX_INLINE_STYLE_PROFILE_BODY_CHARS),
  };
}

function buildStyleDistillationPrompt(input: {
  requestedName: string;
  requestedDescription: string;
  sources: StyleSourceImportRow[];
}): string {
  const sourceText = input.sources
    .map((source, index) => {
      const title = source.title || source.source_url || source.id;
      return `【素材 ${index + 1} / ${source.source_type} / ${title}】\n${source.text}`;
    })
    .join("\n\n---\n\n")
    .slice(0, MAX_STYLE_DISTILLATION_SOURCE_CHARS);

  return `你是 WritingAgent 的风格蒸馏器。
请从用户导入的参考素材中提取可复用的公众号写作风格画像，而不是总结素材内容。

【目标名称】
${input.requestedName}

【目标说明】
${input.requestedDescription}

【输出要求】
只返回 JSON 对象，不要 Markdown，不要额外说明。
JSON 字段：
- name：适合展示给用户的风格名，优先从素材标题、作者、主题和文章气质中提炼 6-14 个中文字；不要使用“蒸馏写作风格”“我的写作风格”这类泛名。
- description：一句话说明这个风格适合什么文章。
- body：完整写作风格画像提示词，使用编号规则，必须包含语气、结构、开头、标题、段落、证据、禁忌和结尾要求。

【素材】
${sourceText}`;
}

async function generateJsonObject(
  env: Env,
  prompt: string,
  options: { temperature: number },
): Promise<string> {
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
      temperature: options.temperature,
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
    throw new ResponseError(502, "empty_model_response", "Model returned an empty JSON response");
  }
  return content;
}

async function pruneOldProfileVersions(env: Env, workspaceId: string, profileId: string): Promise<void> {
  const rows = await env.DB!.prepare(
    `
    SELECT id
    FROM style_profile_versions
    WHERE workspace_id = ? AND profile_id = ?
    ORDER BY created_at DESC
    LIMIT 100 OFFSET ?
    `,
  )
    .bind(workspaceId, profileId, MAX_PROFILE_VERSIONS)
    .all<{ id: string }>();
  const staleIds = (rows.results || []).map(row => row.id);
  if (staleIds.length === 0) return;
  await env.DB!.prepare(
    `
    DELETE FROM style_profile_versions
    WHERE workspace_id = ? AND profile_id = ? AND id IN (${staleIds.map(() => "?").join(", ")})
    `,
  )
    .bind(workspaceId, profileId, ...staleIds)
    .run();
}

function requireDb(env: Env): asserts env is Env & { DB: D1Database } {
  if (!env.DB) {
    throw new ResponseError(503, "profile_store_unconfigured", "WritingAgent profile store is not configured");
  }
}

function workspaceIdFromRequest(_request: Pick<RewriteJobRequest, "user">, identity: AuthIdentity): string {
  return identity.workspaceId || DEFAULT_WORKSPACE_ID;
}

type FetchedSourceContent = {
  title: string;
  text: string;
};

async function fetchSourceContentIfUseful(
  sourceType: string,
  sourceUrl: string,
  submittedText: string,
): Promise<FetchedSourceContent | undefined> {
  if (!sourceUrl || !shouldFetchSourceUrl(sourceType, sourceUrl, submittedText)) return undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; VibePubStyleDistiller/1.0)",
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
        },
      });
      if (!response.ok) return undefined;
      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();
      const parsed = contentType.includes("html") || /<html|<body|id=["']js_content["']/i.test(rawText)
        ? parseHtmlSourceContent(rawText)
        : { title: "", text: rawText };
      const title = normalizeOptionalString(parsed.title);
      const text = normalizeOptionalString(parsed.text).slice(0, MAX_STYLE_SOURCE_TEXT_CHARS);
      if (!text) return undefined;
      return { title, text: sourceTextWithMetadata(text, sourceUrl, title) };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}

function shouldFetchSourceUrl(sourceType: string, sourceUrl: string, submittedText: string): boolean {
  if (!sourceUrl) return false;
  if (sourceType === "wechat_article") return true;
  return ["url", "webpage", "html"].includes(sourceType) && submittedText.length < MIN_FETCHED_SOURCE_TEXT_CHARS;
}

function parseHtmlSourceContent(html: string): FetchedSourceContent {
  const title = extractHtmlTitle(html);
  const author = extractHtmlAuthor(html);
  const contentHtml = extractElementById(html, "js_content") ||
    extractElementByTag(html, "article") ||
    extractElementByTag(html, "body") ||
    html;
  const text = stripHtmlToText(contentHtml);
  const metadata = [
    title ? `标题：${title}` : "",
    author ? `作者：${author}` : "",
  ].filter(Boolean).join("\n");
  return {
    title,
    text: [metadata, text].filter(Boolean).join("\n\n"),
  };
}

function extractHtmlTitle(html: string): string {
  return extractMetaContent(html, "og:title") ||
    extractMetaContent(html, "twitter:title") ||
    stripHtmlToText(extractElementById(html, "activity-name")) ||
    stripHtmlToText(extractElementByTag(html, "title"));
}

function extractHtmlAuthor(html: string): string {
  return extractMetaContent(html, "author") ||
    extractJsString(html, "nickname") ||
    extractJsString(html, "profile_nickname") ||
    stripHtmlToText(extractElementById(html, "js_name"));
}

function extractMetaContent(html: string, key: string): string {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const meta of metas) {
    const metaKey = extractHtmlAttribute(meta, "property") || extractHtmlAttribute(meta, "name");
    if (metaKey.toLowerCase() === key.toLowerCase()) {
      return decodeHtmlEntities(extractHtmlAttribute(meta, "content")).trim();
    }
  }
  return "";
}

function extractJsString(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, "i");
  return decodeHtmlEntities(pattern.exec(html)?.[1] || "").trim();
}

function extractHtmlAttribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i");
  return pattern.exec(tag)?.[1] || "";
}

function extractElementById(html: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
  return pattern.exec(html)?.[2] || "";
}

function extractElementByTag(html: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i");
  return pattern.exec(html)?.[1] || "";
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n"))
    .trim();
}

function sourceTextWithMetadata(text: string, sourceUrl: string, title: string): string {
  const lines = [
    title && !text.includes(`标题：${title}`) ? `标题：${title}` : "",
    sourceUrl ? `来源 URL：${sourceUrl}` : "",
    text,
  ];
  return lines.filter(Boolean).join("\n");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}

function normalizeSourceType(value: unknown): string {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (["url", "wechat_article", "webpage", "text", "html"].includes(normalized)) {
    return normalized;
  }
  return normalized || "text";
}

function normalizeSourceText(value: unknown, sourceUrl: string, title: string): string {
  const text = normalizeOptionalString(value).slice(0, MAX_STYLE_SOURCE_TEXT_CHARS);
  if (text) return text;
  const fallback = [
    title ? `标题：${title}` : "",
    sourceUrl ? `来源 URL：${sourceUrl}` : "",
  ].filter(Boolean).join("\n");
  if (fallback) return fallback;
  throw new ResponseError(400, "source_text_required", "style source import requires text or url/title metadata");
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = normalizeOptionalString(item);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function normalizeOptionalString(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === "null" || lower === "(null)" || lower === "undefined") return "";
  return normalized;
}

function sanitizeProfileId(value: unknown): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return "";
  return normalized.replace(/[^\w.-]/g, "_").slice(0, 120);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function parseRequestJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new ResponseError(400, "invalid_json", "Request body must be JSON");
  }
}

async function routeJson(fn: () => Promise<unknown>, successStatus = 200): Promise<Response> {
  try {
    return json(await fn(), successStatus);
  } catch (error) {
    if (isPublicResponseError(error)) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: { code: "internal_error", message } }, 500);
  }
}

async function deterministicJobId(
  body: Pick<RewriteJobRequest, "idempotency_key" | "client_job_id">,
  fallbackKey: string,
): Promise<string> {
  const key = body.idempotency_key || body.client_job_id || fallbackKey;
  const encoded = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  return `rw_${hex.slice(0, 24)}`;
}

async function authenticate(request: Request, env: Env): Promise<AuthIdentity | null> {
  const expected = env.WRITING_AGENT_TOKEN?.trim() || env.FILES_TOKEN?.trim();
  if (!expected) return null;
  const authorization = request.headers.get("authorization") || "";
  const tokenHeader = request.headers.get("x-writing-agent-token") || "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const authorized = await secureTokenEquals(expected, bearerToken) || await secureTokenEquals(expected, tokenHeader.trim());
  if (!authorized) return null;
  return {
    userId: normalizeOptionalString(request.headers.get("x-vibepub-user-id")) || DEFAULT_USER_ID,
    workspaceId: normalizeOptionalString(request.headers.get("x-vibepub-workspace-id")) || DEFAULT_WORKSPACE_ID,
  };
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

function isPublicResponseError(error: unknown): error is ResponseError | FormattingSkillError {
  return error instanceof ResponseError || error instanceof FormattingSkillError;
}

function json(data: unknown, status = 200): Response {
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}
