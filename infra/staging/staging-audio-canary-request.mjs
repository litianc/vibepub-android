import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ID = /^run_v3_[a-f0-9]{64}$/;
const HANDOFF_ID = /^handoff_v3_[a-f0-9]{64}$/;
const ARTICLE_ID = /^article_v3_[a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const TRANSIENT_STATUS_CODES = new Set([404, 429, 500, 502, 503, 504]);
const DEFAULT_STATUS_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const SAFE_REMOTE_ERRORS = new Set([
  "mining_handoff_recording_not_found",
  "mining_handoff_recording_ambiguous",
  "mining_handoff_scope_invalid",
  "mining_handoff_marker_invalid",
  "mining_handoff_owner_conflict",
  "mining_handoff_source_conflict",
  "mining_handoff_transcript_ambiguous",
  "mining_handoff_transcript_conflict",
  "mining_handoff_identity_conflict",
]);
const MAX_ERROR_BODY_BYTES = 512;

export class StagingAudioCanaryRequestError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "StagingAudioCanaryRequestError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new StagingAudioCanaryRequestError(code, message);
}

function origin(value) {
  let url;
  try { url = new URL(String(value)); } catch { fail("audio_canary_origin_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== "443") || url.pathname !== "/") fail("audio_canary_origin_invalid");
  return url.origin;
}

function sourceKey(value, userId) {
  if (typeof userId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(userId) ||
      typeof value !== "string" || value.includes("..") || value !== `users/${userId}/inbox/${value.split("/").at(-1)}` ||
      !/\.(?:m4a|mp3|wav|aac|ogg|webm)$/i.test(value)) fail("audio_canary_source_invalid");
  return value;
}

async function safeRemoteErrorCode(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (total === 0) return null;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof parsed.error === "string" && SAFE_REMOTE_ERRORS.has(parsed.error)
      ? parsed.error
      : null;
  } catch {
    return null;
  }
}

function validateStatus(raw, expectedDecision, expected) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("audio_canary_status_invalid");
  const value = structuredClone(raw);
  const allowed = new Set([
    "decision", "handoff_id", "run_id", "article_id", "user_id", "workspace_id", "source_key",
    "source_hash", "recording_id", "transcript_ref", "transcript_hash",
    "transcript_created_at",
  ]);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.decision !== expectedDecision ||
      !HANDOFF_ID.test(value.handoff_id) || !RUN_ID.test(value.run_id) || !HASH.test(value.transcript_hash) ||
      !ARTICLE_ID.test(value.article_id) || value.user_id !== expected.userId ||
      value.workspace_id !== expected.workspaceId || value.source_key !== expected.sourceKey ||
      !HASH.test(value.source_hash) || !Number.isSafeInteger(value.recording_id) || value.recording_id < 1 ||
      typeof value.transcript_ref !== "string" || !value.transcript_ref || value.transcript_ref.length > 1024 ||
      typeof value.transcript_created_at !== "string" || !Number.isFinite(Date.parse(value.transcript_created_at)) ||
      new Date(Date.parse(value.transcript_created_at)).toISOString() !== value.transcript_created_at) {
    fail("audio_canary_status_invalid");
  }
  if (expected.minimumTranscriptCreatedAt !== undefined) {
    const minimum = Date.parse(expected.minimumTranscriptCreatedAt);
    if (!Number.isFinite(minimum) || Date.parse(value.transcript_created_at) < minimum) fail("audio_canary_status_stale");
  }
  return value;
}

export async function readStagingAudioCanaryStatus(input) {
  const baseUrl = origin(input.baseUrl);
  if (baseUrl !== origin(input.attestedBaseUrl)) fail("audio_canary_origin_conflict");
  const key = sourceKey(input.sourceKey, input.userId);
  if (typeof input.workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.workspaceId)) fail("audio_canary_workspace_invalid");
  if (input.expectedDecision !== "v3_pending_start" && input.expectedDecision !== "accepted") fail("audio_canary_decision_invalid");
  if (typeof input.token !== "string" || !input.token.trim()) fail("audio_canary_token_missing");
  const maxAttempts = Number.isSafeInteger(input.maxAttempts) && input.maxAttempts > 0
    ? Math.min(input.maxAttempts, DEFAULT_STATUS_ATTEMPTS)
    : DEFAULT_STATUS_ATTEMPTS;
  const retryDelayMs = Number.isSafeInteger(input.retryDelayMs) && input.retryDelayMs >= 0
    ? Math.min(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS)
    : DEFAULT_RETRY_DELAY_MS;
  let response;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await input.fetchImpl(`${baseUrl}/api/internal/v3/mining-handoffs/status`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
        body: JSON.stringify({ source_key: key }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      response = undefined;
    }
    if (response?.status === 200) break;
    if (response && !TRANSIENT_STATUS_CODES.has(response.status)) {
      const remoteError = response.status === 409 ? await safeRemoteErrorCode(response) : null;
      fail(`audio_canary_status_http_${response.status}${remoteError ? `_${remoteError}` : ""}`);
    }
    if (attempt === maxAttempts) {
      fail(response ? `audio_canary_status_http_${response.status}` : "audio_canary_status_unavailable");
    }
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
  let body;
  try { body = await response.json(); } catch { fail("audio_canary_status_invalid"); }
  return validateStatus(body, input.expectedDecision, { userId: input.userId, workspaceId: input.workspaceId,
    sourceKey: key, minimumTranscriptCreatedAt: input.minimumTranscriptCreatedAt });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "status") fail("usage_invalid");
  const out = option(args, "--out");
  if (!out) fail("usage_invalid");
  const status = await readStagingAudioCanaryStatus({
    baseUrl: option(args, "--base-url"),
    attestedBaseUrl: process.env.STAGING_ATTESTED_BASE_URL,
    sourceKey: option(args, "--source-key"),
    userId: option(args, "--user-id"),
    workspaceId: option(args, "--workspace-id"),
    expectedDecision: option(args, "--expected-decision"),
    minimumTranscriptCreatedAt: option(args, "--minimum-transcript-created-at"),
    token: process.env.MINING_V3_HANDOFF_TOKEN,
    fetchImpl: fetch,
  });
  await writeFile(resolve(out), JSON.stringify(status, null, 2), "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof StagingAudioCanaryRequestError ? error.code : "audio_canary_request_failed");
    process.exit(1);
  });
}
