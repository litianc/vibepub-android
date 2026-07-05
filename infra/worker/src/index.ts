export interface Env {
  FILES_BUCKET: R2Bucket;
  DB: D1Database;
  FILES_TOKEN: string;
  PUBLIC_BASE_URL: string;
  GITHUB_PAT?: string;
  GITHUB_WORKFLOW_REF?: string;
  WRITING_AGENT_BASE_URL?: string;
  WRITING_AGENT_TOKEN?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Files-Token, X-Style-Profile-Id, X-Style-Profile-Version, X-Style-Profile-Name-B64, X-Style-Profile-Description-B64, X-Style-Profile-Body-B64, X-Layout-Profile-Id, X-Layout-Profile-Version",
};

type WritingProfileSelection = {
  styleProfileId?: string;
  styleProfileVersion?: string;
  styleProfileName?: string;
  styleProfileDescription?: string;
  styleProfileBody?: string;
  layoutProfileId?: string;
  layoutProfileVersion?: string;
};

const MAX_INLINE_STYLE_PROFILE_BODY_CHARS = 3_000;

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

    if (request.method === "POST" && url.pathname === "/api/text-submissions") {
      return submitText(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/api/style-profiles") {
      return proxyWritingAgent(request, env, "/v1/style-profiles");
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname.startsWith("/api/style-profiles/")
    ) {
      return proxyWritingAgent(
        request,
        env,
        `/v1/style-profiles/${url.pathname.slice("/api/style-profiles/".length)}`,
      );
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === "/api/style-source-imports"
    ) {
      return proxyWritingAgent(request, env, "/v1/style-source-imports");
    }

    if (request.method === "POST" && url.pathname === "/api/style-distillation-jobs") {
      return proxyWritingAgent(request, env, "/v1/style-distillation-jobs");
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/style-distillation-jobs/")) {
      return proxyWritingAgent(
        request,
        env,
        `/v1/style-distillation-jobs/${url.pathname.slice("/api/style-distillation-jobs/".length)}`,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/uploads") {
      return listUploads(env, url);
    }

    if (request.method === "GET" && url.pathname === "/api/recordings") {
      return listRecordings(env);
    }

    if (request.method === "POST" && isRecordingRevisionPath(url.pathname)) {
      const filename = safeDecodeURIComponent(
        url.pathname.slice("/api/recordings/".length, -"/revisions".length),
      );
      return createArticleRevision(request, env, ctx, filename);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/recordings/")) {
      const filename = safeDecodeURIComponent(url.pathname.slice("/api/recordings/".length));
      return deleteRecording(env, filename);
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

async function proxyWritingAgent(request: Request, env: Env, targetPath: string): Promise<Response> {
  const baseUrl = env.WRITING_AGENT_BASE_URL?.trim();
  const token = env.WRITING_AGENT_TOKEN?.trim() || env.FILES_TOKEN?.trim();
  if (!baseUrl || !token) {
    return json({
      error: "writing_agent_unconfigured",
      message: "WritingAgent proxy is not configured",
    }, 503);
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = `${baseUrl.replace(/\/+$/, "")}${targetPath}${sourceUrl.search}`;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });
  const responseHeaders = new Headers(corsHeaders);
  const upstreamContentType = upstream.headers.get("content-type");
  if (upstreamContentType) {
    responseHeaders.set("content-type", upstreamContentType);
  } else {
    responseHeaders.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function submitText(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "文字提交内容不是有效 JSON" }, 400);
  }

  const text = normalizeOptionalString(body?.text);
  if (!text || text.length < 10) {
    return json({ error: "text_too_short", message: "文字太短，请再补充一些想法" }, 400);
  }
  if (text.length > 30_000) {
    return json({ error: "text_too_long", message: "文字太长，请分成多次提交" }, 400);
  }

  const titleHint = normalizeOptionalString(body?.title_hint ?? body?.titleHint);
  const profileSelection = normalizeProfileSelectionFromBody(body);
  const submittedAt = new Date().toISOString();
  const safeTimestamp = submittedAt.replace(/[:.]/g, "-").replace("T", "-").replace("Z", "");
  const filename = sanitizeFileName(`VibePub-${safeTimestamp}-Text-${crypto.randomUUID().slice(0, 8)}.txt`);
  const key = `text-submissions/${filename}`;
  const payload = {
    filename,
    text,
    titleHint,
    source: normalizeOptionalString(body?.source) || "android_text",
    submittedAt,
    styleProfileId: profileSelection.styleProfileId,
    styleProfileVersion: profileSelection.styleProfileVersion,
    styleProfileName: profileSelection.styleProfileName,
    styleProfileDescription: profileSelection.styleProfileDescription,
    styleProfileBody: profileSelection.styleProfileBody,
    layoutProfileId: profileSelection.layoutProfileId,
    layoutProfileVersion: profileSelection.layoutProfileVersion,
  };

  await env.FILES_BUCKET.put(key, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      filename,
      submittedAt,
      sourceType: "TEXT",
      ...profileSelectionMetadata(profileSelection),
    },
  });

  await upsertTextRecording(env, {
    filename,
    key,
    text,
    titleHint,
    profileSelection,
  });

  ctx.waitUntil(triggerGitHubAction(env, filename).catch((e) => {
    console.error("Failed to trigger GitHub Action for text submission:", e);
  }));

  return json({
    ok: true,
    key,
    filename,
    status: "PROCESSING",
    processing_stage: "REWRITING",
    submitted_at: submittedAt,
  }, 202);
}

async function upsertTextRecording(
  env: Env,
  input: {
    filename: string;
    key: string;
    text: string;
    titleHint?: string | null;
    profileSelection?: WritingProfileSelection;
  },
): Promise<void> {
  const userId = "default_user";
  try {
    const updated = await env.DB.prepare(
      `
      UPDATE recordings
      SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = 0, raw_text = ?, article_title = COALESCE(?, article_title), source_type = ?, style_profile_id = COALESCE(?, style_profile_id), style_profile_version = COALESCE(?, style_profile_version), layout_profile_id = COALESCE(?, layout_profile_id), layout_profile_version = COALESCE(?, layout_profile_version), error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `,
    )
      .bind(
        input.key,
        "PROCESSING",
        "REWRITING",
        input.text,
        input.titleHint || null,
        "TEXT",
        input.profileSelection?.styleProfileId || null,
        input.profileSelection?.styleProfileVersion || null,
        input.profileSelection?.layoutProfileId || null,
        input.profileSelection?.layoutProfileVersion || null,
        userId,
        input.filename,
      )
      .run();

    if ((updated.meta.changes ?? 0) === 0) {
      await env.DB.prepare(
        `
        INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage, duration_ms, raw_text, article_title, source_type, style_profile_id, style_profile_version, layout_profile_id, layout_profile_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
        .bind(
          userId,
          input.filename,
          input.key,
          "PROCESSING",
          "REWRITING",
          0,
          input.text,
          input.titleHint || null,
          "TEXT",
          input.profileSelection?.styleProfileId || null,
          input.profileSelection?.styleProfileVersion || null,
          input.profileSelection?.layoutProfileId || null,
          input.profileSelection?.layoutProfileVersion || null,
        )
        .run();
    }
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("no such column")) {
      console.error("Failed to insert text submission into D1:", dbErr);
      throw dbErr;
    }

    if (!message.includes("source_type")) {
      try {
        const updated = await env.DB.prepare(
          `
          UPDATE recordings
          SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = 0, raw_text = ?, article_title = COALESCE(?, article_title), source_type = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND filename = ?
          `,
        )
          .bind(input.key, "PROCESSING", "REWRITING", input.text, input.titleHint || null, "TEXT", userId, input.filename)
          .run();

        if ((updated.meta.changes ?? 0) === 0) {
          await env.DB.prepare(
            `
            INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage, duration_ms, raw_text, article_title, source_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
            .bind(userId, input.filename, input.key, "PROCESSING", "REWRITING", 0, input.text, input.titleHint || null, "TEXT")
            .run();
        }
        return;
      } catch (profileFallbackErr: any) {
        const profileFallbackMessage = String(profileFallbackErr?.message || "");
        if (!profileFallbackMessage.includes("no such column")) {
          console.error("Failed to insert text submission into D1:", profileFallbackErr);
          throw profileFallbackErr;
        }
      }
    }

    const updated = await env.DB.prepare(
      `
      UPDATE recordings
      SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = 0, raw_text = ?, article_title = COALESCE(?, article_title), error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `,
    )
      .bind(input.key, "PROCESSING", "REWRITING", input.text, input.titleHint || null, userId, input.filename)
      .run();

    if ((updated.meta.changes ?? 0) === 0) {
      await env.DB.prepare(
        `
        INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage, duration_ms, raw_text, article_title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
        .bind(userId, input.filename, input.key, "PROCESSING", "REWRITING", 0, input.text, input.titleHint || null)
        .run();
    }
  }
}

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
  const profileSelection = normalizeProfileSelectionFromHeaders(request.headers);

  await env.FILES_BUCKET.put(key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      originalName,
      uploadedAt,
      ...profileSelectionMetadata(profileSelection),
    },
  });

  if (hasInlineProfileSelection(profileSelection)) {
    await env.FILES_BUCKET.put(
      profileSelectionSidecarKey(safeOriginalName),
      JSON.stringify({
        filename: safeOriginalName,
        uploadedAt,
        ...profileSelectionPayload(profileSelection),
      }, null, 2),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );
  }

  // Default user ID for now since we have a single global auth token
  const userId = "default_user";
  const durationMs = parseDurationMsFromRecordingFilename(safeOriginalName);

  // Record the upload in D1. Update first so deploys stay compatible before the
  // unique filename migration has been applied.
  try {
    const updated = await env.DB.prepare(
      `
      UPDATE recordings
      SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = COALESCE(?, duration_ms), style_profile_id = COALESCE(?, style_profile_id), style_profile_version = COALESCE(?, style_profile_version), layout_profile_id = COALESCE(?, layout_profile_id), layout_profile_version = COALESCE(?, layout_profile_version), error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `
    )
    .bind(
      key,
      "UPLOADED",
      "QUEUED",
      durationMs,
      profileSelection.styleProfileId || null,
      profileSelection.styleProfileVersion || null,
      profileSelection.layoutProfileId || null,
      profileSelection.layoutProfileVersion || null,
      userId,
      safeOriginalName,
    )
    .run();

    if ((updated.meta.changes ?? 0) === 0) {
      await env.DB.prepare(
        `
        INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage, duration_ms, style_profile_id, style_profile_version, layout_profile_id, layout_profile_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        userId,
        safeOriginalName,
        key,
        "UPLOADED",
        "QUEUED",
        durationMs,
        profileSelection.styleProfileId || null,
        profileSelection.styleProfileVersion || null,
        profileSelection.layoutProfileId || null,
        profileSelection.layoutProfileVersion || null,
      )
      .run();
    }
  } catch (dbErr) {
    const message = String((dbErr as Error)?.message || "");
    if (!message.includes("no such column")) {
      console.error("Failed to insert into D1:", dbErr);
    } else {
      let profileFallbackHandled = false;
      if (!message.includes("duration_ms") && !message.includes("processing_stage")) {
        try {
          const updated = await env.DB.prepare(
            `
            UPDATE recordings
            SET r2_key = ?, status = ?, processing_stage = ?, duration_ms = COALESCE(?, duration_ms), error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND filename = ?
            `
          )
          .bind(key, "UPLOADED", "QUEUED", durationMs, userId, safeOriginalName)
          .run();

          if ((updated.meta.changes ?? 0) === 0) {
            await env.DB.prepare(
              `
              INSERT INTO recordings (user_id, filename, r2_key, status, processing_stage, duration_ms)
              VALUES (?, ?, ?, ?, ?, ?)
              `
            )
            .bind(userId, safeOriginalName, key, "UPLOADED", "QUEUED", durationMs)
            .run();
          }
          profileFallbackHandled = true;
        } catch (profileFallbackErr) {
          const profileFallbackMessage = String((profileFallbackErr as Error)?.message || "");
          if (!profileFallbackMessage.includes("no such column")) {
            console.error("Failed to insert into D1:", profileFallbackErr);
          }
        }
      }

      if (!profileFallbackHandled) {
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
        } catch (stageDbErr) {
          const stageMessage = String((stageDbErr as Error)?.message || "");
          if (!stageMessage.includes("no such column")) {
            console.error("Failed to insert into D1:", stageDbErr);
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
      }
    }
  }

  // Fire and forget triggering of the GitHub Action Mining Job
  ctx.waitUntil(triggerGitHubAction(env, safeOriginalName).catch((e) => {
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

async function triggerGitHubAction(
  env: Env,
  targetFilename: string,
  options: { revisionRequestKey?: string } = {},
): Promise<void> {
  if (!env.GITHUB_PAT) {
    console.warn("GITHUB_PAT is not configured. Skipping immediate GitHub Action trigger.");
    return;
  }
  
  const repo = "litianc/vibepub-android";
  const workflowId = "mining-job.yml";
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`;
  const workflowRef = env.GITHUB_WORKFLOW_REF?.trim() || "main";
  
  const inputs: Record<string, string> = {
    target_filename: targetFilename,
  };
  if (options.revisionRequestKey) {
    inputs.revision_request_key = options.revisionRequestKey;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `token ${env.GITHUB_PAT}`,
      "User-Agent": "VibePub-Cloudflare-Worker",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ref: workflowRef,
      inputs,
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API returned ${response.status}: ${errorText}`);
  }
}

function isRecordingRevisionPath(pathname: string): boolean {
  return pathname.startsWith("/api/recordings/") && pathname.endsWith("/revisions");
}

async function createArticleRevision(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  filename: string,
): Promise<Response> {
  if (!request.body) {
    return json({ error: "missing_body" }, 400);
  }

  const safeName = sanitizeFileName(filename);
  if (!safeName) {
    return json({ error: "missing_filename" }, 400);
  }

  const transcriptKey = `transcripts/${safeName.replace(/\.[^/.]+$/, ".json")}`;
  const transcriptObject = await env.FILES_BUCKET.get(transcriptKey);
  if (!transcriptObject) {
    return json({
      error: "article_not_ready",
      message: "文章结果尚未生成，暂不能提交语音修改",
    }, 409);
  }

  const revisionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const baseName = safeName.replace(/\.[^/.]+$/, "");
  const audioKey = `revision-requests/${baseName}/${revisionId}.m4a`;
  const revisionRequestKey = `revision-requests/${baseName}/${revisionId}.json`;
  const contentType = request.headers.get("content-type") || "audio/mp4";

  await env.FILES_BUCKET.put(audioKey, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      filename: safeName,
      revisionId,
      createdAt,
    },
  });

  await env.FILES_BUCKET.put(
    revisionRequestKey,
    JSON.stringify({
      revisionId,
      filename: safeName,
      transcriptKey,
      audioKey,
      createdAt,
    }, null, 2),
    {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        filename: safeName,
        revisionId,
        createdAt,
      },
    },
  );

  await markRecordingRevisionQueued(env, safeName);

  ctx.waitUntil(triggerGitHubAction(env, safeName, { revisionRequestKey }).catch((e) => {
    console.error("Failed to trigger GitHub Action for article revision:", e);
  }));

  return json({
    ok: true,
    status: "QUEUED",
    revision_id: revisionId,
    revision_request_key: revisionRequestKey,
  }, 202);
}

async function markRecordingRevisionQueued(env: Env, filename: string): Promise<void> {
  try {
    await env.DB.prepare(
      `
      UPDATE recordings
      SET status = ?, processing_stage = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND filename = ?
      `,
    )
      .bind("PROCESSING", "REWRITING", "default_user", filename)
      .run();
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("no such column")) {
      console.error("Failed to mark article revision queued:", dbErr);
      return;
    }

    try {
      await env.DB.prepare(
        `
        UPDATE recordings
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND filename = ?
        `,
      )
        .bind("PROCESSING", "default_user", filename)
        .run();
    } catch (legacyErr) {
      console.error("Failed to mark article revision queued:", legacyErr);
    }
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

    for (const legacyShape of legacyRecordingQueryShapes(message)) {
      try {
        return json({
          recordings: withRecordingDisplayFields(
            await queryRecordings(env, userId, legacyShape.shape),
            legacyShape.defaults,
          ),
        });
      } catch (legacyDbErr: any) {
        const legacyMessage = String(legacyDbErr?.message || "");
        if (!legacyMessage.includes("no such column")) {
          console.error("Failed to fetch from D1:", legacyDbErr);
          return json({ error: "database_error", details: legacyDbErr.message }, 500);
        }
      }
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
        duration_ms: null,
        processing_stage: null,
        wechat_url: null,
        wechat_draft_id: null,
        cover_image_url: null,
        source_type: null,
        style_profile_id: null,
        style_profile_version: null,
        layout_profile_id: null,
        layout_profile_version: null,
        error_message: null,
      }),
    });
  }
}

async function deleteRecording(env: Env, filename: string): Promise<Response> {
  const safeName = sanitizeFileName(filename);
  if (!safeName) {
    return json({ error: "missing_filename" }, 400);
  }

  const userId = "default_user";
  const r2Keys = new Set<string>();
  const transcriptKey = `transcripts/${safeName.replace(/\.[^/.]+$/, ".json")}`;
  const coverKey = `covers/${safeName.replace(/\.[^/.]+$/, ".png")}`;

  r2Keys.add(`inbox/${safeName}`);
  r2Keys.add(profileSelectionSidecarKey(safeName));
  if (inferSourceType(safeName, "") === "TEXT") {
    r2Keys.add(`text-submissions/${safeName}`);
  }
  r2Keys.add(transcriptKey);
  r2Keys.add(coverKey);

  try {
    const { results } = await env.DB.prepare(
      `SELECT r2_key FROM recordings WHERE user_id = ? AND filename = ? LIMIT 1`
    )
    .bind(userId, safeName)
    .all();
    const r2Key = normalizeOptionalString((results?.[0] as any)?.r2_key);
    if (r2Key) {
      r2Keys.add(r2Key);
    }
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("no such column")) {
      console.error("Failed to fetch recording file key before delete:", dbErr);
    }
  }

  let deletedRecordCount = 0;
  try {
    const deleted = await env.DB.prepare(
      `DELETE FROM recordings WHERE user_id = ? AND filename = ?`
    )
    .bind(userId, safeName)
    .run();
    deletedRecordCount = deleted.meta.changes ?? 0;
  } catch (dbErr: any) {
    console.error("Failed to delete recording from D1:", dbErr);
    return json({ error: "database_error", details: dbErr.message }, 500);
  }

  const deletedFiles: string[] = [];
  const fileErrors: Array<{ key: string; message: string }> = [];
  for (const key of r2Keys) {
    try {
      await env.FILES_BUCKET.delete(key);
      deletedFiles.push(key);
    } catch (fileErr: any) {
      const message = String(fileErr?.message || fileErr);
      console.error(`Failed to delete R2 object ${key}:`, fileErr);
      fileErrors.push({ key, message });
    }
  }

  return json({
    ok: fileErrors.length === 0,
    filename: safeName,
    deleted_record_count: deletedRecordCount,
    deleted_files: deletedFiles,
    file_errors: fileErrors,
  }, fileErrors.length === 0 ? 200 : 207);
}

function withRecordingDisplayFields(
  recordings: unknown[],
  defaults: Record<string, unknown> = {},
): unknown[] {
  return recordings.map((recording: any) => {
    const durationMs =
      nonNegativeIntegerOrNull(recording?.duration_ms) ??
      nonNegativeIntegerOrNull(recording?.durationMs) ??
      parseDurationMsFromRecordingFilename(recording?.filename);
    return {
      ...recording,
      ...defaults,
      duration_ms: durationMs,
      source_type: normalizeOptionalString(recording?.source_type) ??
        normalizeOptionalString(recording?.sourceType) ??
        inferSourceType(recording?.filename, recording?.r2_key),
      cover_image_url: normalizeOptionalString(recording?.cover_image_url) ??
        normalizeOptionalString(recording?.coverImageUrl),
      style_profile_id: normalizeOptionalString(recording?.style_profile_id) ??
        normalizeOptionalString(recording?.styleProfileId),
      style_profile_version: normalizeOptionalString(recording?.style_profile_version) ??
        normalizeOptionalString(recording?.styleProfileVersion),
      layout_profile_id: normalizeOptionalString(recording?.layout_profile_id) ??
        normalizeOptionalString(recording?.layoutProfileId),
      layout_profile_version: normalizeOptionalString(recording?.layout_profile_version) ??
        normalizeOptionalString(recording?.layoutProfileVersion),
      wechat_url: normalizeRemoteReference(recording?.wechat_url),
      wechat_draft_id: normalizeRemoteReference(recording?.wechat_draft_id),
    };
  });
}

function inferSourceType(filename: unknown, r2Key: unknown): string {
  const key = `${typeof r2Key === "string" ? r2Key : ""} ${typeof filename === "string" ? filename : ""}`.toLowerCase();
  if (key.includes("text-submissions/") || key.includes("-text-") || key.endsWith(".txt")) {
    return "TEXT";
  }
  if (key.includes("imported-audio")) {
    return "AUDIO_FILE";
  }
  return "RECORDING";
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

type QueryRecordingShape =
  | "full"
  | "withoutWritingProfiles"
  | "withoutSourceType"
  | "withoutCoverImageUrl"
  | "withoutDuration"
  | "withoutProcessingStage";

function legacyRecordingQueryShapes(message: string): Array<{
  shape: QueryRecordingShape;
  defaults: Record<string, unknown>;
}> {
  const writingProfileDefaults = {
    style_profile_id: null,
    style_profile_version: null,
    layout_profile_id: null,
    layout_profile_version: null,
  };
  const oldSchemaFallbacks = [
    { shape: "withoutCoverImageUrl" as const, defaults: { cover_image_url: null, ...writingProfileDefaults } },
    { shape: "withoutDuration" as const, defaults: { duration_ms: null, cover_image_url: null, ...writingProfileDefaults } },
    {
      shape: "withoutProcessingStage" as const,
      defaults: { duration_ms: null, processing_stage: null, cover_image_url: null, ...writingProfileDefaults },
    },
  ];

  if (message.includes("source_type")) {
    return [
      { shape: "withoutSourceType", defaults: { source_type: null, ...writingProfileDefaults } },
      ...oldSchemaFallbacks,
    ];
  }

  if (
    message.includes("style_profile_id") ||
    message.includes("style_profile_version") ||
    message.includes("layout_profile_id") ||
    message.includes("layout_profile_version")
  ) {
    return [
      {
        shape: "withoutWritingProfiles",
        defaults: writingProfileDefaults,
      },
      ...oldSchemaFallbacks,
    ];
  }

  return oldSchemaFallbacks;
}

async function queryRecordings(
  env: Env,
  userId: string,
  shape: QueryRecordingShape,
): Promise<unknown[]> {
  const selectColumnsByShape: Record<QueryRecordingShape, string[]> = {
    full: [
      "id",
      "filename",
      "status",
      "duration_ms",
      "created_at",
      "updated_at",
      "article_title",
      "substr(raw_text, 1, 120) AS raw_text_preview",
      "processing_stage",
      "wechat_url",
      "wechat_draft_id",
      "cover_image_url",
      "source_type",
      "style_profile_id",
      "style_profile_version",
      "layout_profile_id",
      "layout_profile_version",
      "error_message",
    ],
    withoutWritingProfiles: [
      "id",
      "filename",
      "status",
      "duration_ms",
      "created_at",
      "updated_at",
      "article_title",
      "substr(raw_text, 1, 120) AS raw_text_preview",
      "processing_stage",
      "wechat_url",
      "wechat_draft_id",
      "cover_image_url",
      "source_type",
      "error_message",
    ],
    withoutSourceType: [
      "id",
      "filename",
      "status",
      "duration_ms",
      "created_at",
      "updated_at",
      "article_title",
      "substr(raw_text, 1, 120) AS raw_text_preview",
      "processing_stage",
      "wechat_url",
      "wechat_draft_id",
      "cover_image_url",
      "error_message",
    ],
    withoutCoverImageUrl: [
      "id",
      "filename",
      "status",
      "duration_ms",
      "created_at",
      "updated_at",
      "article_title",
      "substr(raw_text, 1, 120) AS raw_text_preview",
      "processing_stage",
      "wechat_url",
      "wechat_draft_id",
      "error_message",
    ],
    withoutDuration: [
      "id",
      "filename",
      "status",
      "created_at",
      "updated_at",
      "article_title",
      "substr(raw_text, 1, 120) AS raw_text_preview",
      "processing_stage",
      "wechat_url",
      "wechat_draft_id",
      "error_message",
    ],
    withoutProcessingStage: [
      "id",
      "filename",
      "status",
      "created_at",
      "updated_at",
      "article_title",
      "substr(raw_text, 1, 120) AS raw_text_preview",
      "wechat_url",
      "wechat_draft_id",
      "error_message",
    ],
  };

  const { results } = await env.DB.prepare(
    `
    SELECT
      ${selectColumnsByShape[shape].join(",\n      ")}
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
      coverImageUrl,
      cover_image_url,
      errorMessage,
      error_message,
    } = body;
    if (!filename || !status) {
      return json({ error: "missing_fields" }, 400);
    }
    const stage = processingStage || processing_stage || null;
    const normalizedCoverImageUrl = normalizeRemoteReference(coverImageUrl ?? cover_image_url);
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
        cover_image_url = COALESCE(?, cover_image_url),
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
          normalizeRemoteReference(wechatUrl),
          normalizeRemoteReference(wechatDraftId),
          normalizedCoverImageUrl,
          statusError.shouldSet ? 1 : 0,
          statusError.value,
          "default_user",
          filename,
        )
        .run();
    } catch (dbErr: any) {
      const message = String(dbErr?.message || "");
      if (!message.includes("no such column")) throw dbErr;
      const legacyUpdate = {
        filename,
        status,
        rawText,
        articleTitle,
        articleContent,
        processingStage: stage,
        wechatUrl,
        wechatDraftId,
        coverImageUrl: normalizedCoverImageUrl,
        errorMessage: statusError,
      };
      if (message.includes("cover_image_url")) {
        await updateStatusWithoutCoverImageUrl(env, legacyUpdate);
      } else {
        await updateStatusWithoutProcessingStage(env, legacyUpdate);
      }
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
        normalizeRemoteReference(body.wechatUrl),
        normalizeRemoteReference(body.wechatDraftId),
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

async function updateStatusWithoutCoverImageUrl(
  env: Env,
  body: {
    filename: string;
    status: string;
    rawText?: string;
    articleTitle?: string;
    articleContent?: string;
    processingStage?: string | null;
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
        body.status,
        body.rawText || null,
        body.articleTitle || null,
        body.articleContent || null,
        body.processingStage || null,
        normalizeRemoteReference(body.wechatUrl),
        normalizeRemoteReference(body.wechatDraftId),
        body.errorMessage.shouldSet ? 1 : 0,
        body.errorMessage.value,
        "default_user",
        body.filename,
      )
      .run();
  } catch (dbErr: any) {
    const message = String(dbErr?.message || "");
    if (!message.includes("no such column")) throw dbErr;
    await updateStatusWithoutProcessingStage(env, body);
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

function normalizeProfileSelectionFromBody(body: any): WritingProfileSelection {
  return {
    styleProfileId: normalizeOptionalString(body?.style_profile_id ?? body?.styleProfileId) || undefined,
    styleProfileVersion: normalizeOptionalString(body?.style_profile_version ?? body?.styleProfileVersion) || undefined,
    styleProfileName: normalizeOptionalString(body?.style_profile_name ?? body?.styleProfileName) || undefined,
    styleProfileDescription: normalizeOptionalString(body?.style_profile_description ?? body?.styleProfileDescription) || undefined,
    styleProfileBody: normalizeStyleProfileBody(body?.style_profile_body ?? body?.styleProfileBody) || undefined,
    layoutProfileId: normalizeOptionalString(body?.layout_profile_id ?? body?.layoutProfileId) || undefined,
    layoutProfileVersion: normalizeOptionalString(body?.layout_profile_version ?? body?.layoutProfileVersion) || undefined,
  };
}

function normalizeProfileSelectionFromHeaders(headers: Headers): WritingProfileSelection {
  return {
    styleProfileId: normalizeOptionalString(headers.get("x-style-profile-id")) || undefined,
    styleProfileVersion: normalizeOptionalString(headers.get("x-style-profile-version")) || undefined,
    styleProfileName: normalizeOptionalString(decodeBase64Header(headers.get("x-style-profile-name-b64"))) || undefined,
    styleProfileDescription: normalizeOptionalString(decodeBase64Header(headers.get("x-style-profile-description-b64"))) || undefined,
    styleProfileBody: normalizeStyleProfileBody(decodeBase64Header(headers.get("x-style-profile-body-b64"))) || undefined,
    layoutProfileId: normalizeOptionalString(headers.get("x-layout-profile-id")) || undefined,
    layoutProfileVersion: normalizeOptionalString(headers.get("x-layout-profile-version")) || undefined,
  };
}

function profileSelectionMetadata(selection: WritingProfileSelection): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (selection.styleProfileId) metadata.styleProfileId = selection.styleProfileId;
  if (selection.styleProfileVersion) metadata.styleProfileVersion = selection.styleProfileVersion;
  if (selection.layoutProfileId) metadata.layoutProfileId = selection.layoutProfileId;
  if (selection.layoutProfileVersion) metadata.layoutProfileVersion = selection.layoutProfileVersion;
  return metadata;
}

function profileSelectionPayload(selection: WritingProfileSelection): Record<string, string> {
  const payload: Record<string, string> = {};
  if (selection.styleProfileId) payload.styleProfileId = selection.styleProfileId;
  if (selection.styleProfileVersion) payload.styleProfileVersion = selection.styleProfileVersion;
  if (selection.styleProfileName) payload.styleProfileName = selection.styleProfileName;
  if (selection.styleProfileDescription) payload.styleProfileDescription = selection.styleProfileDescription;
  if (selection.styleProfileBody) payload.styleProfileBody = selection.styleProfileBody;
  if (selection.layoutProfileId) payload.layoutProfileId = selection.layoutProfileId;
  if (selection.layoutProfileVersion) payload.layoutProfileVersion = selection.layoutProfileVersion;
  return payload;
}

function hasInlineProfileSelection(selection: WritingProfileSelection): boolean {
  return Boolean(selection.styleProfileBody || selection.styleProfileName || selection.styleProfileDescription);
}

function normalizeStyleProfileBody(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.slice(0, MAX_INLINE_STYLE_PROFILE_BODY_CHARS) : null;
}

function decodeBase64Header(value: string | null): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function profileSelectionSidecarKey(filename: string): string {
  return `profile-selections/${filename.replace(/[^\w.\-]/g, "_")}.json`;
}

function normalizeRemoteReference(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;

  const lowered = normalized.toLowerCase();
  return lowered === "null" || lowered === "undefined" ? null : normalized;
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
