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
  async fetch(request: Request, env: Env): Promise<Response> {
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
      return uploadAudio(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/uploads") {
      return listUploads(env, url);
    }

    if (request.method === "GET" && url.pathname === "/api/recordings") {
      return listRecordings(env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
      return getFile(env, url.pathname.slice("/api/files/".length));
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/transcripts/")) {
      const filename = url.pathname.slice("/api/transcripts/".length);
      const safeName = sanitizeFileName(filename).replace(/\.[^/.]+$/, ".json");
      return getFile(env, `transcripts/${safeName}`);
    }

    return json({ error: "not_found" }, 404);
  },
};

async function uploadAudio(request: Request, env: Env): Promise<Response> {
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

  // Insert into D1
  try {
    await env.DB.prepare(
      `INSERT INTO recordings (user_id, filename, r2_key, status) VALUES (?, ?, ?, ?)`
    )
    .bind(userId, safeOriginalName, key, 'UPLOADED')
    .run();
  } catch (dbErr) {
    console.error("Failed to insert into D1:", dbErr);
    // Don't fail the upload just because D1 logging failed, though ideally we should
  }

  // Fire and forget triggering of the GitHub Action Mining Job
  env.waitUntil(triggerGitHubAction(env).catch((e) => {
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
    const { results } = await env.DB.prepare(
      `SELECT id, filename, status, created_at, updated_at FROM recordings WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
    )
    .bind(userId)
    .all();

    return json({ recordings: results });
  } catch (dbErr: any) {
    console.error("Failed to fetch from D1:", dbErr);
    return json({ error: "database_error", details: dbErr.message }, 500);
  }
}

async function getFile(env: Env, encodedKey: string): Promise<Response> {
  const key = decodeURIComponent(encodedKey);

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
