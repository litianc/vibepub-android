export interface Env {
  FILES_BUCKET: R2Bucket;
  DB: D1Database;
  FILES_TOKEN: string;
  PUBLIC_BASE_URL: string;
  GITHUB_PAT?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Files-Token",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "vibepub-api" });
    }

    if (url.pathname.startsWith("/api/") && !isAuthorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/api/uploads") {
      return uploadAudio(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/api/uploads") {
      return listUploads(env, url);
    }

    if (request.method === "GET" && url.pathname === "/api/recordings") {
      return listRecordings(env);
    }

    if (request.method === "PUT" && url.pathname === "/api/internal/status") {
      return updateStatus(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
      return getFile(env, url.pathname.slice("/api/files/".length));
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/transcripts/")) {
      const filename = safeDecodeURIComponent(url.pathname.slice("/api/transcripts/".length));
      const safeName = sanitizeFileName(filename).replace(/\.[^/.]+$/, ".json");
      return getFile(env, `transcripts/${safeName}`);
    }

    return json({ error: "not_found" }, 404);
  },
};

async function uploadAudio(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!request.body) {
    return json({ error: "missing_body" }, 400);
  }

  const originalName = request.headers.get("x-file-name") || "recording.m4a";
  const safeOriginalName = sanitizeFileName(originalName);
  const uploadedAt = new Date().toISOString();
  const keyPrefix = safeOriginalName.startsWith("VibePub-") || safeOriginalName.startsWith("VoiceDrop-") 
    ? "" 
    : `${uploadedAt.replace(/[:.]/g, "-")}-`;
  const key = `inbox/${keyPrefix}${safeOriginalName}`;
  const contentType = request.headers.get("content-type") || "audio/mp4";

  await env.FILES_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      originalName,
      uploadedAt,
    },
  });

  // Default user ID for now since we have a single global auth token
  const userId = "default_user";

  // Record the upload in D1. Update first so deploys stay compatible before the
  // unique filename migration has been applied.
  try {
    const updated = await env.DB.prepare(
      `
      UPDATE recordings
      SET r2_key = ?, status = ?, processing_stage = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `
    )
    .bind(key, "UPLOADED", "QUEUED", userId, safeOriginalName)
    .run();

    if ((updated.meta.changes ?? 0) === 0) {
      await env.DB.prepare(
        `
        INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage)
        VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(userId, safeOriginalName, key, "UPLOADED", "QUEUED")
      .run();
    }
  } catch (dbErr) {
    const message = String((dbErr as Error)?.message || "");
    if (!message.includes("no such column")) {
      console.error("Failed to insert into D1:", dbErr);
    } else {
      try {
        const updated = await env.DB.prepare(
          `
          UPDATE recordings
          SET r2_key = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND filename = ?
          `
        )
        .bind(key, "UPLOADED", userId, safeOriginalName)
        .run();

        if ((updated.meta.changes ?? 0) === 0) {
          await env.DB.prepare(
            `
            INSERT INTO recordings (user_id, filename, r2_key, status)
            VALUES (?, ?, ?, ?)
            `
          )
          .bind(userId, safeOriginalName, key, "UPLOADED")
          .run();
        }
      } catch (legacyDbErr) {
        console.error("Failed to insert into D1:", legacyDbErr);
      }
    }
  }

  // Fire and forget triggering of the GitHub Action Mining Job
  ctx.waitUntil(triggerGitHubAction(env).catch((e) => {
    console.error("Failed to trigger GitHub Action:", e);
  }));

  return json(
    {
      ok: true,
      key,
      name: safeOriginalName,
      uploadedAt,
      url: `${env.PUBLIC_BASE_URL}/api/files/${encodeURIComponent(key)}`,
    },
    201,
  );
}

async function triggerGitHubAction(env: Env): Promise<void> {
  if (!env.GITHUB_PAT) {
    console.warn("GITHUB_PAT is not configured. Skipping immediate GitHub Action trigger.");
    return;
  }
  
  const repo = "litianc/vibepub-android";
  const workflowId = "mining-job.yml";
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `token ${env.GITHUB_PAT}`,
      "User-Agent": "VibePub-Cloudflare-Worker",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ref: "main"
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API returned ${response.status}: ${errorText}`);
  }
}

async function listUploads(env: Env, url: URL): Promise<Response> {
  const limit = clamp(Number(url.searchParams.get("limit") || "25"), 1, 100);
  const listed = await env.FILES_BUCKET.list({
    prefix: "inbox/",
    limit,
  });

  return json({
    objects: listed.objects.map((object) => ({
      key: object.key,
      size: object.size,
      uploaded: object.uploaded.toISOString(),
      httpEtag: object.httpEtag,
      checksums: object.checksums,
      customMetadata: object.customMetadata,
    })),
  });
}

async function listRecordings(env: Env): Promise<Response> {
  const userId = "default_user";
  try {
    return json({ recordings: withRecordingDisplayFields(await queryRecordings(env, userId, "full")) });
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("no such column")) {
      console.error("Failed to fetch from D1:", dbErr);
      return json({ error: "database_error", details: dbErr.message }, 500);
    }

    try {
      return json({
        recordings: withRecordingDisplayFields(
          await queryRecordings(env, userId, "withoutProcessingStage"),
          { processing_stage: null },
        ),
      });
    } catch (legacyDbErr: any) {
      const legacyMessage = String(legacyDbErr?.message || "");
      if (!legacyMessage.includes("no such column")) {
        console.error("Failed to fetch from D1:", legacyDbErr);
        return json({ error: "database_error", details: legacyDbErr.message }, 500);
      }

      const { results } = await env.DB.prepare(
        `SELECT id, filename, status, created_at, updated_at FROM recordings WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
      )
      .bind(userId)
      .all();
      return json({
        recordings: withRecordingDisplayFields(results, {
          article_title: null,
          raw_text_preview: null,
          processing_stage: null,
          wechat_url: null,
          wechat_draft_id: null,
          error_message: null,
        }),
      });
    }
  }
}

function withRecordingDisplayFields(
  recordings: unknown[],
  defaults: Record<string, unknown> = {},
): unknown[] {
  return recordings.map((recording: any) => {
    const durationMs =
      positiveIntegerOrNull(recording?.duration_ms) ??
      positiveIntegerOrNull(recording?.durationMs) ??
      parseDurationMsFromRecordingFilename(recording?.filename);

    return {
      ...recording,
      ...defaults,
      duration_ms: durationMs,
    };
  });
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDurationMsFromRecordingFilename(filename: unknown): number | null {
  if (typeof filename !== "string") return null;
  const match = filename.match(/-(\d+)m(\d+)s(?:-|\.|$)/);
  if (!match) return null;

  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return ((minutes * 60) + seconds) * 1_000;
}

async function queryRecordings(
  env: Env,
  userId: string,
  shape: "full" | "withoutProcessingStage",
): Promise<unknown[]> {
  if (shape === "full") {
    const { results } = await env.DB.prepare(
      `
      SELECT
        id,
        filename,
        status,
        created_at,
        updated_at,
        article_title,
        substr(raw_text, 1, 120) AS raw_text_preview,
        processing_stage,
        wechat_url,
        wechat_draft_id,
        error_message
      FROM recordings
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
      `
    )
    .bind(userId)
    .all();
    return results;
  }

  const { results } = await env.DB.prepare(
    `
    SELECT
      id,
      filename,
      status,
      created_at,
      updated_at,
      article_title,
      substr(raw_text, 1, 120) AS raw_text_preview,
      wechat_url,
      wechat_draft_id,
      error_message
    FROM recordings
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
    `
    )
    .bind(userId)
    .all();
  return results;
}

async function updateStatus(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const {
      filename,
      status,
      rawText,
      articleTitle,
      articleContent,
      processingStage,
      processing_stage,
      wechatUrl,
      wechatDraftId,
      errorMessage,
      error_message,
    } = body;
    if (!filename || !status) {
      return json({ error: "missing_fields" }, 400);
    }
    const stage = processingStage || processing_stage || null;
    const statusError = resolveStatusErrorUpdate({
      status,
      processingStage: stage,
      hasIncomingErrorMessage: hasOwn(body, "errorMessage") || hasOwn(body, "error_message"),
      incomingErrorMessage: errorMessage ?? error_message,
    });
    const statement = `
      UPDATE recordings
      SET
        status = ?,
        raw_text = COALESCE(?, raw_text),
        article_title = COALESCE(?, article_title),
        article_content = COALESCE(?, article_content),
        processing_stage = COALESCE(?, processing_stage),
        wechat_url = COALESCE(?, wechat_url),
        wechat_draft_id = COALESCE(?, wechat_draft_id),
        error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `;
    try {
      await env.DB.prepare(statement)
        .bind(
          status,
          rawText || null,
          articleTitle || null,
          articleContent || null,
          stage,
          wechatUrl || null,
          wechatDraftId || null,
          statusError.shouldSet ? 1 : 0,
          statusError.value,
          "default_user",
          filename,
        )
        .run();
    } catch (dbErr: any) {
      const message = String(dbErr?.message || "");
      if (!message.includes("no such column")) throw dbErr;
      await updateStatusWithoutProcessingStage(env, {
        filename,
        status,
        rawText,
        articleTitle,
        articleContent,
        wechatUrl,
        wechatDraftId,
        errorMessage: statusError,
      });
    }
    return json({ ok: true });
  } catch (e: any) {
    console.error("Failed to update status:", e);
    return json({ error: "update_failed", details: e.message }, 500);
  }
}

async function updateStatusWithoutProcessingStage(
  env: Env,
  body: {
    filename: string;
    status: string;
    rawText?: string;
    articleTitle?: string;
    articleContent?: string;
    wechatUrl?: string;
    wechatDraftId?: string;
    errorMessage: StatusErrorUpdate;
  },
): Promise<void> {
  const statement = `
    UPDATE recordings
    SET
      status = ?,
      raw_text = COALESCE(?, raw_text),
      article_title = COALESCE(?, article_title),
      article_content = COALESCE(?, article_content),
      wechat_url = COALESCE(?, wechat_url),
      wechat_draft_id = COALESCE(?, wechat_draft_id),
      error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND filename = ?
    `;
  try {
    await env.DB.prepare(statement)
      .bind(
        body.status,
        body.rawText || null,
        body.articleTitle || null,
        body.articleContent || null,
        body.wechatUrl || null,
        body.wechatDraftId || null,
        body.errorMessage.shouldSet ? 1 : 0,
        body.errorMessage.value,
        "default_user",
        body.filename,
      )
      .run();
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("no such column")) throw dbErr;
    await env.DB.prepare(
      `
      UPDATE recordings
      SET
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `
    )
      .bind(
        body.status,
        "default_user",
        body.filename,
      )
      .run();
  }
}

type StatusErrorUpdate = {
  shouldSet: boolean;
  value: string | null;
};

function resolveStatusErrorUpdate(input: {
  status: string;
  processingStage?: string | null;
  hasIncomingErrorMessage: boolean;
  incomingErrorMessage?: unknown;
}): StatusErrorUpdate {
  if (input.hasIncomingErrorMessage) {
    return {
      shouldSet: true,
      value: normalizeOptionalString(input.incomingErrorMessage),
    };
  }

  if (keepsExistingErrorMessage(input.status, input.processingStage)) {
    return { shouldSet: false, value: null };
  }

  return { shouldSet: true, value: null };
}

function keepsExistingErrorMessage(status: string, processingStage?: string | null): boolean {
  const statusKey = statusKeyOf(status);
  const stageKey = statusKeyOf(processingStage || "");
  return statusKey === "FAILED" || isFailureStage(stageKey);
}

function isFailureStage(stageKey: string): boolean {
  return stageKey === "FAILED" ||
    stageKey === "ERROR" ||
    stageKey.endsWith("_FAILED");
}

function statusKeyOf(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_");
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function getFile(env: Env, encodedKey: string): Promise<Response> {
  const key = safeDecodeURIComponent(encodedKey);

  if (!key || key.includes("..")) {
    return json({ error: "invalid_key" }, 400);
  }

  const object = await env.FILES_BUCKET.get(key);
  if (!object) {
    return json({ error: "not_found" }, 404);
  }

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=60");

  return new Response(object.body, { headers });
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.FILES_TOKEN?.trim();
  if (!expected) return false;

  const authorization = request.headers.get("authorization") || "";
  const tokenHeader = request.headers.get("x-files-token") || "";

  return authorization === `Bearer ${expected}` || tokenHeader === expected;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 120) || "recording.m4a";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
