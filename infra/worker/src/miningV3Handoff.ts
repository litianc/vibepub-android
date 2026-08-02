import { canonicalJson, sha256 } from "./wave2/artifactContracts";
import {
  buildFiveAgentBriefObject,
  FIVE_AGENT_PUBLISHING_POLICY_VERSION,
  FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION,
  handleFiveAgentPublishingInternalRoute,
  type FiveAgentStartBody,
} from "./fiveAgentPublishing";
import { CANONICAL_EDITORIAL_SCHEMA_VERSION, PUBLICATION_SCHEMA_VERSION, publicationSourceFeatureEnabled } from "./publicationProjection";
import { coordinatorShardName, type EditorialCoordinatorAgent, type EditorialRuntimeEnv } from "./editorialAgents";
import {
  isExactWave2PublicationSkillPins,
  PUBLICATION_AGENT_VERSIONS,
  PUBLICATION_WAVE2_ADAPTER_PINS,
} from "./editorialContracts";
import { readImmutableArtifact } from "./wave2/artifactStore";

const HANDOFF_SCHEMA_VERSION = "mining-v3-handoff.v1";
const DEFAULT_STYLE = { id: "style_litianc_default", version: "2026-07-05" };
const FORMATTING_PIN = { id: "md_to_wechat", version: "1.0.0" };
const APP_LAYOUT_PROFILE_MAPPINGS_VERSION = "app-layout-to-v3-formatting.v1";
const DEFAULT_APP_LAYOUT_PIN = { id: "wechat_clean_article", version: "2026-07-05" };
const APP_LAYOUT_TO_FORMATTING: Record<string, typeof FORMATTING_PIN> = {
  "wechat_clean_article@2026-07-05": FORMATTING_PIN,
};
const CONTENT_GOAL = "将原始内容整理为真实、理性、结构化的公众号文章。";
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_START_CONFIRMED = "workflow_start_confirmed";
const WORKFLOW_CREATE_UNKNOWN = "workflow_create_unknown";
const EXTERNAL_SIDE_EFFECT_UNKNOWN = "external_side_effect_unknown";
const RECONCILE_EXTERNAL_SIDE_EFFECT = "reconcile_external_side_effect";

export type MiningV3HandoffEnv = EditorialRuntimeEnv & {
  DB: D1Database;
  FILES_BUCKET: R2Bucket;
};

type Recording = {
  id: number;
  user_id: string;
  workspace_id: string;
  filename: string;
  r2_key: string;
  source_type: string | null;
  article_title: string | null;
  style_profile_id: string | null;
  style_profile_version: string | null;
  layout_profile_id: string | null;
  layout_profile_version: string | null;
};

type Profile = {
  pins: Record<string, { id: string; version: string }>;
  style_profile_body?: string;
  style_profile_body_hash?: string;
};

type HandoffMarker = {
  schema_version: typeof HANDOFF_SCHEMA_VERSION;
  handoff_id: string;
  source_scope: string;
  source_key: string;
  source_hash: string;
  user_id: string;
  workspace_id: string;
  recording_id: number;
  article_id: string;
  source_type: "audio" | "text";
  title_hint: string | null;
  content_goal: string;
  app_layout_mapping_version: typeof APP_LAYOUT_PROFILE_MAPPINGS_VERSION;
  profile_pins: Profile["pins"];
  style_profile_body?: string;
  style_profile_body_hash?: string;
  created_at: string;
};

type TranscriptRef = {
  transcript_ref: string;
  transcript_hash: string;
  transcript_text: string;
};

type TextSource = {
  text: string;
  payload?: Record<string, unknown>;
};

type AcceptedRun = {
  run_id: string;
  article_id: string;
  state: string;
  brief_artifact_id: string;
  brief_payload_hash: string;
};

export class MiningV3HandoffError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof MiningV3HandoffError) return response({ error: error.code }, error.status);
  return response({ error: "mining_v3_handoff_unavailable" }, 503);
}

function id(prefix: string, hash: string): string {
  return `${prefix}_${hash.replace("sha256:", "")}`;
}

function text(value: unknown, field: string, max = 40_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new MiningV3HandoffError("mining_handoff_payload_invalid", 400, `${field} is invalid`);
  }
  return value;
}

function sourceKey(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_KEY.test(value) || value.includes("..") || value.startsWith("/")) {
    throw new MiningV3HandoffError("mining_handoff_source_invalid", 400, "source_key is invalid");
  }
  return value;
}

async function hashJson(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

async function ownerShard(userId: string, workspaceId: string): Promise<string> {
  return (await hashJson({ user_id: userId, workspace_id: workspaceId })).slice("sha256:".length, "sha256:".length + 24);
}

async function sourceScope(recording: Recording): Promise<string> {
  return id("mhs", await hashJson({
    version: 1,
    user_id: recording.user_id,
    workspace_id: recording.workspace_id,
    recording_id: recording.id,
    source_key: recording.r2_key,
  }));
}

function markerPrefix(shard: string, scope: string): string {
  return `editorial/v3/${shard}/mining-handoffs/${scope}/markers/`;
}

function markerKey(shard: string, scope: string, handoffId: string): string {
  return `${markerPrefix(shard, scope)}${handoffId}.v1.json`;
}

function transcriptPrefix(shard: string, handoffId: string): string {
  return `editorial/v3/${shard}/mining-handoffs/${handoffId}/transcripts/`;
}

function transcriptKey(shard: string, handoffId: string, transcriptHash: string): string {
  return `${transcriptPrefix(shard, handoffId)}${transcriptHash.replace("sha256:", "")}.v1.txt`;
}

function normalizeTranscript(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new MiningV3HandoffError("mining_transcript_empty", 409, "canonical transcript is empty");
  return normalized;
}

async function readBytes(object: R2ObjectBody, code: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new MiningV3HandoffError(code, 503, "R2 object could not be read");
  }
}

async function listObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    let page: R2Objects;
    try {
      page = await bucket.list({ prefix, cursor });
    } catch {
      throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "handoff objects are unavailable");
    }
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function recordingForSource(env: MiningV3HandoffEnv, key: string): Promise<Recording> {
  const rows = await env.DB.prepare(`
    SELECT r.id, r.user_id, s.workspace_id AS workspace_id, r.filename, r.r2_key, r.source_type, r.article_title,
           r.style_profile_id, r.style_profile_version, r.layout_profile_id, r.layout_profile_version
    FROM recordings r
    JOIN editorial_recording_scopes s
      ON s.recording_id = r.id AND s.user_id = r.user_id
    WHERE r.r2_key = ?
  `).bind(key).all<Recording>();
  const found = rows.results || [];
  if (found.length !== 1) {
    throw new MiningV3HandoffError(found.length === 0 ? "mining_handoff_recording_not_found" : "mining_handoff_recording_ambiguous", 409, "source key does not resolve exactly one owner-scoped recording");
  }
  const recording = found[0];
  if (!recording.user_id || !recording.workspace_id || !recording.filename) {
    throw new MiningV3HandoffError("mining_handoff_scope_invalid", 409, "recording owner scope is invalid");
  }
  return recording;
}

async function sourceObject(env: MiningV3HandoffEnv, recording: Recording): Promise<{ bytes: Uint8Array; metadata: Record<string, string> }> {
  let object: R2ObjectBody | null;
  try { object = await env.FILES_BUCKET.get(recording.r2_key); } catch { throw new MiningV3HandoffError("mining_handoff_source_unavailable", 503, "source object is unavailable"); }
  if (!object) throw new MiningV3HandoffError("mining_handoff_source_not_found", 404, "source object is missing");
  const metadata = object.customMetadata || {};
  const owner = metadata.userId || metadata.user_id;
  const workspace = metadata.workspaceId || metadata.workspace_id;
  if (owner !== recording.user_id || workspace !== recording.workspace_id) {
    throw new MiningV3HandoffError("mining_handoff_source_owner_conflict", 403, "source object owner metadata is not exact");
  }
  return { bytes: await readBytes(object, "mining_handoff_source_unavailable"), metadata };
}

function jsonObject(bytes: Uint8Array, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new MiningV3HandoffError(code, 409, "source JSON payload is invalid");
  }
}

function parseTextSource(bytes: Uint8Array): TextSource {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new MiningV3HandoffError("mining_handoff_text_source_invalid", 409, "text source must be valid UTF-8");
  }
  const trimmed = decoded.trim();
  if (!trimmed) throw new MiningV3HandoffError("mining_handoff_text_source_empty", 409, "text source is empty");
  if (!trimmed.startsWith("{")) return { text: trimmed };
  const payload = jsonObject(bytes, "mining_handoff_text_source_invalid");
  const sourceText = optionalString(payload, "text", "rawText", "raw_text");
  if (!sourceText) throw new MiningV3HandoffError("mining_handoff_text_source_invalid", 409, "text source payload has no text");
  return { text: sourceText, payload };
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function sidecarProfile(env: MiningV3HandoffEnv, recording: Recording): Promise<Record<string, unknown>> {
  const stem = recording.filename.replace(/[^\w.\-]/g, "_");
  const key = `users/${recording.user_id}/profile-selections/${stem}.json`;
  let object: R2ObjectBody | null;
  try { object = await env.FILES_BUCKET.get(key); } catch { throw new MiningV3HandoffError("mining_handoff_profile_unavailable", 503, "profile selection is unavailable"); }
  if (!object) throw new MiningV3HandoffError("mining_handoff_custom_profile_missing", 409, "custom style profile body is required");
  const value = jsonObject(await readBytes(object, "mining_handoff_profile_unavailable"), "mining_handoff_profile_unavailable");
  if (optionalString(value, "userId", "user_id") !== recording.user_id ||
      optionalString(value, "workspaceId", "workspace_id") !== recording.workspace_id ||
      optionalString(value, "filename") !== recording.filename) {
    throw new MiningV3HandoffError("mining_handoff_profile_scope_conflict", 409, "profile selection scope is not exact");
  }
  return value;
}

function assertProfileIdentity(recording: Recording, value: Record<string, unknown>): { id: string; version: string; body?: string } {
  const styleId = optionalString(value, "styleProfileId", "style_profile_id");
  const styleVersion = optionalString(value, "styleProfileVersion", "style_profile_version");
  if (!styleId || !styleVersion || styleId !== recording.style_profile_id || styleVersion !== recording.style_profile_version) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "recording and source profile pins do not agree");
  }
  return { id: styleId, version: styleVersion, body: optionalString(value, "styleProfileBody", "style_profile_body") };
}

function appLayoutPin(
  id: string | undefined,
  version: string | undefined,
  source: "recording" | "source",
): { app: { id: string; version: string }; formatting: typeof FORMATTING_PIN } {
  if ((id === undefined) !== (version === undefined)) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, `${source} layout pin is incomplete`);
  }
  const app = id === undefined && version === undefined
    ? DEFAULT_APP_LAYOUT_PIN
    : { id, version } as { id: string; version: string };
  const formatting = APP_LAYOUT_TO_FORMATTING[`${app.id}@${app.version}`];
  if (!formatting) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, `${source} layout pin is not supported by V3`);
  }
  return { app, formatting };
}

function assertTextSourceScope(recording: Recording, value: Record<string, unknown>): void {
  const exact = (label: string, expected: string, ...keys: string[]): void => {
    for (const key of keys) {
      if (!(key in value)) continue;
      const raw = value[key];
      if (typeof raw !== "string" || !raw.trim() || raw.trim() !== expected) {
        throw new MiningV3HandoffError("mining_handoff_text_source_scope_conflict", 409, `${label} is not exact`);
      }
      return;
    }
  };
  exact("text source user", recording.user_id, "userId", "user_id");
  exact("text source workspace", recording.workspace_id, "workspaceId", "workspace_id");
  exact("text source filename", recording.filename, "filename");
}

function assertSourceProfilePin(recording: Recording, value: Record<string, unknown>, requireCustomStylePin: boolean): void {
  const expectedStyleId = recording.style_profile_id?.trim() || DEFAULT_STYLE.id;
  const expectedStyleVersion = recording.style_profile_version?.trim() || DEFAULT_STYLE.version;
  const expectedLayout = appLayoutPin(
    recording.layout_profile_id?.trim() || undefined,
    recording.layout_profile_version?.trim() || undefined,
    "recording",
  );
  const styleId = optionalString(value, "styleProfileId", "style_profile_id", "styleprofileid");
  const styleVersion = optionalString(value, "styleProfileVersion", "style_profile_version", "styleprofileversion");
  if ((styleId === undefined) !== (styleVersion === undefined)) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "source style pin is incomplete");
  }
  if (requireCustomStylePin && (expectedStyleId !== DEFAULT_STYLE.id || expectedStyleVersion !== DEFAULT_STYLE.version) && styleId === undefined) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "custom audio source style pin is required");
  }
  if (styleId !== undefined && (styleId !== expectedStyleId || styleVersion !== expectedStyleVersion)) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "recording and source profile pins do not agree");
  }
  const layoutId = optionalString(value, "layoutProfileId", "layout_profile_id", "layoutprofileid");
  const layoutVersion = optionalString(value, "layoutProfileVersion", "layout_profile_version", "layoutprofileversion");
  const sourceLayout = appLayoutPin(layoutId, layoutVersion, "source");
  if (sourceLayout.app.id !== expectedLayout.app.id || sourceLayout.app.version !== expectedLayout.app.version ||
      sourceLayout.formatting.id !== expectedLayout.formatting.id || sourceLayout.formatting.version !== expectedLayout.formatting.version) {
    throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "recording and source formatting pins do not agree");
  }
}

async function resolveProfile(
  env: MiningV3HandoffEnv,
  recording: Recording,
  sourceBytes: Uint8Array,
  sourceMetadata: Record<string, string>,
): Promise<Profile> {
  const storedId = recording.style_profile_id?.trim() || DEFAULT_STYLE.id;
  const storedVersion = recording.style_profile_version?.trim() || DEFAULT_STYLE.version;
  const appLayout = appLayoutPin(
    recording.layout_profile_id?.trim() || undefined,
    recording.layout_profile_version?.trim() || undefined,
    "recording",
  );
  const sourceType = String(recording.source_type || "").toUpperCase();
  const parsedText = sourceType === "TEXT" ? parseTextSource(sourceBytes) : undefined;
  if (parsedText?.payload) assertTextSourceScope(recording, parsedText.payload);
  const sourceValue = parsedText?.payload || sourceMetadata;
  assertSourceProfilePin(recording, sourceValue, sourceType !== "TEXT");
  if (storedId === DEFAULT_STYLE.id && storedVersion === DEFAULT_STYLE.version) {
    if ((recording.style_profile_id && recording.style_profile_id !== DEFAULT_STYLE.id) ||
        (recording.style_profile_version && recording.style_profile_version !== DEFAULT_STYLE.version)) {
      throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "default profile pin is inconsistent");
    }
    if (optionalString(sourceValue, "styleProfileBody", "style_profile_body")) {
      throw new MiningV3HandoffError("mining_handoff_profile_pin_conflict", 409, "registered default profile cannot carry an inline body");
    }
    return { pins: { style: DEFAULT_STYLE, formatting: appLayout.formatting } };
  }
  if (sourceType === "TEXT" && !parsedText?.payload) {
    throw new MiningV3HandoffError("mining_handoff_custom_profile_missing", 409, "custom text style profile body is required");
  }
  const profileValue = sourceType === "TEXT"
    ? parsedText!.payload!
    : await sidecarProfile(env, recording);
  const resolved = assertProfileIdentity(recording, profileValue);
  const body = resolved.body;
  if (!body) throw new MiningV3HandoffError("mining_handoff_custom_profile_missing", 409, "custom style profile body is required");
  return {
    pins: { style: { id: resolved.id, version: resolved.version }, formatting: appLayout.formatting },
    style_profile_body: body,
    style_profile_body_hash: await sha256(body),
  };
}

function sourceType(recording: Recording): "audio" | "text" {
  const value = String(recording.source_type || "").toUpperCase();
  return value === "TEXT" ? "text" : "audio";
}

function titleHint(recording: Recording, sourceBytes: Uint8Array): string | null {
  if (sourceType(recording) !== "text") return recording.article_title?.trim() || null;
  return optionalString(parseTextSource(sourceBytes).payload || {}, "titleHint", "title_hint") || recording.article_title?.trim() || null;
}

async function makeMarker(env: MiningV3HandoffEnv, recording: Recording): Promise<HandoffMarker> {
  const source = await sourceObject(env, recording);
  const sourceHash = await sha256(source.bytes);
  const scope = await sourceScope(recording);
  const profile = await resolveProfile(env, recording, source.bytes, source.metadata);
  const articleId = id("article_v3", await hashJson({
    version: 1, user_id: recording.user_id, workspace_id: recording.workspace_id, recording_id: recording.id,
  }));
  const handoffId = id("handoff_v3", await hashJson({
    version: 1, source_scope: scope, source_hash: sourceHash, article_id: articleId,
    source_type: sourceType(recording), title_hint: titleHint(recording, source.bytes), content_goal: CONTENT_GOAL,
    app_layout_mapping_version: APP_LAYOUT_PROFILE_MAPPINGS_VERSION,
    profile_pins: profile.pins, style_profile_body_hash: profile.style_profile_body_hash || null,
  }));
  return {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: handoffId,
    source_scope: scope,
    source_key: recording.r2_key,
    source_hash: sourceHash,
    user_id: recording.user_id,
    workspace_id: recording.workspace_id,
    recording_id: recording.id,
    article_id: articleId,
    source_type: sourceType(recording),
    title_hint: titleHint(recording, source.bytes),
    content_goal: CONTENT_GOAL,
    app_layout_mapping_version: APP_LAYOUT_PROFILE_MAPPINGS_VERSION,
    profile_pins: profile.pins,
    ...(profile.style_profile_body ? { style_profile_body: profile.style_profile_body } : {}),
    ...(profile.style_profile_body_hash ? { style_profile_body_hash: profile.style_profile_body_hash } : {}),
    created_at: new Date().toISOString(),
  };
}

function markerIdentity(marker: HandoffMarker): Record<string, unknown> {
  const { created_at: _createdAt, ...identity } = marker;
  return identity;
}

async function readMarkerByKey(env: MiningV3HandoffEnv, key: string): Promise<HandoffMarker | null> {
  let object: R2ObjectBody | null;
  try { object = await env.FILES_BUCKET.get(key); } catch { throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "handoff marker is unavailable"); }
  if (!object) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(await readBytes(object, "mining_handoff_reconciliation_required"))); } catch { throw new MiningV3HandoffError("mining_handoff_marker_invalid", 409, "handoff marker is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MiningV3HandoffError("mining_handoff_marker_invalid", 409, "handoff marker is invalid");
  const marker = parsed as HandoffMarker;
  if (marker.schema_version !== HANDOFF_SCHEMA_VERSION || !marker.handoff_id || !marker.source_scope || !HASH.test(marker.source_hash) || !marker.user_id || !marker.workspace_id || !Number.isSafeInteger(marker.recording_id) || !marker.article_id || !marker.profile_pins || marker.app_layout_mapping_version !== APP_LAYOUT_PROFILE_MAPPINGS_VERSION) {
    throw new MiningV3HandoffError("mining_handoff_marker_invalid", 409, "handoff marker is invalid");
  }
  return marker;
}

async function markerForHandoff(env: MiningV3HandoffEnv, sourceKeyValue: string, handoffId: string): Promise<HandoffMarker> {
  if (!/^handoff_v3_[a-f0-9]{64}$/.test(handoffId)) throw new MiningV3HandoffError("mining_handoff_id_invalid", 400, "handoff_id is invalid");
  const recording = await recordingForSource(env, sourceKeyValue);
  const scope = await sourceScope(recording);
  const shard = await ownerShard(recording.user_id, recording.workspace_id);
  const marker = await readMarkerByKey(env, markerKey(shard, scope, handoffId));
  if (!marker || marker.handoff_id !== handoffId) throw new MiningV3HandoffError("mining_handoff_marker_invalid", 409, "handoff marker does not match");
  if (marker.source_key !== recording.r2_key || marker.source_scope !== scope || marker.recording_id !== recording.id ||
      marker.user_id !== recording.user_id || marker.workspace_id !== recording.workspace_id) {
    throw new MiningV3HandoffError("mining_handoff_marker_invalid", 409, "handoff marker does not match source scope");
  }
  return marker;
}

async function markersForSource(env: MiningV3HandoffEnv, recording: Recording): Promise<HandoffMarker[]> {
  await sourceObject(env, recording);
  const scope = await sourceScope(recording);
  const shard = await ownerShard(recording.user_id, recording.workspace_id);
  const rows = await listObjects(env.FILES_BUCKET, markerPrefix(shard, scope));
  const markers = await Promise.all(rows.map(item => readMarkerByKey(env, item.key)));
  return markers.filter((marker): marker is HandoffMarker => marker !== null);
}

async function persistMarker(env: MiningV3HandoffEnv, marker: HandoffMarker): Promise<void> {
  const shard = await ownerShard(marker.user_id, marker.workspace_id);
  const key = markerKey(shard, marker.source_scope, marker.handoff_id);
  const expected = new TextEncoder().encode(canonicalJson(marker));
  const existing = await readMarkerByKey(env, key);
  if (existing) {
    if (canonicalJson(markerIdentity(existing)) !== canonicalJson(markerIdentity(marker))) {
      throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "handoff marker identity conflicts");
    }
    return;
  }
  try {
    const put = await env.FILES_BUCKET.put(key, expected, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        user_id: marker.user_id,
        workspace_id: marker.workspace_id,
        handoff_id: marker.handoff_id,
        source_hash: marker.source_hash,
      },
    });
    if (!put) throw new Error("conditional marker write was not applied");
  } catch {
    const raced = await readMarkerByKey(env, key);
    if (raced && canonicalJson(markerIdentity(raced)) === canonicalJson(markerIdentity(marker))) return;
    if (raced) throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "handoff marker identity conflicts");
    throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "handoff marker outcome is unknown");
  }
  const readback = await readMarkerByKey(env, key);
  if (!readback || canonicalJson(readback) !== canonicalJson(marker)) {
    throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "handoff marker readback is unavailable");
  }
}

async function existingTranscript(env: MiningV3HandoffEnv, marker: HandoffMarker): Promise<TranscriptRef | null> {
  const shard = await ownerShard(marker.user_id, marker.workspace_id);
  const objects = await listObjects(env.FILES_BUCKET, transcriptPrefix(shard, marker.handoff_id));
  if (objects.length === 0) return null;
  if (objects.length !== 1) throw new MiningV3HandoffError("mining_handoff_transcript_ambiguous", 409, "handoff has multiple canonical transcripts");
  const object = await env.FILES_BUCKET.get(objects[0].key);
  if (!object) throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "canonical transcript is unavailable");
  const bytes = await readBytes(object, "mining_handoff_reconciliation_required");
  const actualHash = await sha256(bytes);
  const expectedHash = `sha256:${objects[0].key.split("/").pop()!.replace(".v1.txt", "")}`;
  const metadata = object.customMetadata || {};
  if (actualHash !== expectedHash || metadata.user_id !== marker.user_id || metadata.workspace_id !== marker.workspace_id ||
      metadata.source_key !== marker.source_key || metadata.source_hash !== marker.source_hash || metadata.handoff_id !== marker.handoff_id) {
    throw new MiningV3HandoffError("mining_handoff_transcript_conflict", 409, "canonical transcript identity conflicts");
  }
  const transcriptText = new TextDecoder().decode(bytes);
  if (normalizeTranscript(transcriptText) !== transcriptText) {
    throw new MiningV3HandoffError("mining_handoff_transcript_conflict", 409, "stored transcript is not canonical");
  }
  return { transcript_ref: objects[0].key, transcript_hash: actualHash, transcript_text: transcriptText };
}

async function persistTranscript(env: MiningV3HandoffEnv, marker: HandoffMarker, input: string): Promise<TranscriptRef> {
  const canonical = normalizeTranscript(input);
  const bytes = new TextEncoder().encode(canonical);
  const transcriptHash = await sha256(bytes);
  const current = await existingTranscript(env, marker);
  if (current) {
    if (current.transcript_hash !== transcriptHash) throw new MiningV3HandoffError("mining_handoff_transcript_conflict", 409, "canonical transcript conflicts with persisted transcript");
    return current;
  }
  const shard = await ownerShard(marker.user_id, marker.workspace_id);
  const key = transcriptKey(shard, marker.handoff_id, transcriptHash);
  try {
    const put = await env.FILES_BUCKET.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: {
        user_id: marker.user_id,
        workspace_id: marker.workspace_id,
        source_key: marker.source_key,
        source_hash: marker.source_hash,
        handoff_id: marker.handoff_id,
      },
    });
    if (!put) throw new Error("conditional transcript write was not applied");
  } catch {
    const raced = await existingTranscript(env, marker);
    if (raced && raced.transcript_hash === transcriptHash) return raced;
    if (raced) throw new MiningV3HandoffError("mining_handoff_transcript_conflict", 409, "canonical transcript conflicts with persisted transcript");
    throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "canonical transcript write outcome is unknown");
  }
  const readback = await existingTranscript(env, marker);
  if (!readback || readback.transcript_hash !== transcriptHash) throw new MiningV3HandoffError("mining_handoff_reconciliation_required", 503, "canonical transcript readback is unavailable");
  return readback;
}

async function runId(marker: HandoffMarker, transcript: TranscriptRef): Promise<string> {
  return id("run_v3", await hashJson({
    version: 1,
    user_id: marker.user_id,
    workspace_id: marker.workspace_id,
    article_id: marker.article_id,
    recording_id: marker.recording_id,
    source_hash: marker.source_hash,
    transcript_hash: transcript.transcript_hash,
    source_type: marker.source_type,
    title_hint: marker.title_hint,
    content_goal: marker.content_goal,
    profile_pins: marker.profile_pins,
    style_profile_body_hash: marker.style_profile_body_hash || null,
  }));
}

async function startBody(marker: HandoffMarker, transcript: TranscriptRef): Promise<FiveAgentStartBody> {
  return {
    run_id: await runId(marker, transcript),
    article_id: marker.article_id,
    recording_id: marker.recording_id,
    source_type: marker.source_type,
    language: "zh-CN",
    transcript_ref: transcript.transcript_ref,
    transcript_hash: transcript.transcript_hash,
    source_hash: marker.source_hash,
    title_hint: marker.title_hint,
    content_goal: marker.content_goal,
    profile_pins: marker.profile_pins,
    ...(marker.style_profile_body ? { style_profile_body: marker.style_profile_body } : {}),
  };
}

async function markerStillMatchesSource(env: MiningV3HandoffEnv, marker: HandoffMarker): Promise<void> {
  const recording = await recordingForSource(env, marker.source_key);
  if (recording.id !== marker.recording_id || recording.user_id !== marker.user_id || recording.workspace_id !== marker.workspace_id) {
    throw new MiningV3HandoffError("mining_handoff_owner_conflict", 409, "handoff recording ownership conflicts");
  }
  const source = await sourceObject(env, recording);
  if (await sha256(source.bytes) !== marker.source_hash) throw new MiningV3HandoffError("mining_handoff_source_conflict", 409, "source bytes changed after handoff marker");
}

async function v3HistoryExists(env: MiningV3HandoffEnv, recording: Recording): Promise<boolean> {
  try {
    const [canonical, publication, current] = await Promise.all([
      env.DB.prepare(`SELECT run_id FROM editorial_runs
        WHERE user_id = ? AND workspace_id = ? AND recording_id = ? AND schema_version = ? LIMIT 1`)
        .bind(recording.user_id, recording.workspace_id, recording.id, CANONICAL_EDITORIAL_SCHEMA_VERSION).first<{ run_id: string }>(),
      env.DB.prepare(`SELECT p.run_id FROM publication_runs p
        JOIN editorial_runs e ON e.run_id = p.source_run_id
          AND e.user_id = p.user_id AND e.workspace_id = p.workspace_id
          AND e.article_id = p.article_id AND e.recording_id = p.recording_id
        WHERE p.user_id = ? AND p.workspace_id = ? AND p.recording_id = ?
          AND p.schema_version = ? AND e.schema_version = ? LIMIT 1`)
        .bind(recording.user_id, recording.workspace_id, recording.id, PUBLICATION_SCHEMA_VERSION, CANONICAL_EDITORIAL_SCHEMA_VERSION).first<{ run_id: string }>(),
      env.DB.prepare(`SELECT c.current_run_id FROM publication_current_runs c
        JOIN publication_runs p ON p.run_id = c.current_run_id
          AND p.user_id = c.user_id AND p.workspace_id = c.workspace_id
          AND p.recording_id = c.recording_id
        JOIN editorial_runs e ON e.run_id = p.source_run_id
          AND e.user_id = p.user_id AND e.workspace_id = p.workspace_id
          AND e.article_id = p.article_id AND e.recording_id = p.recording_id
        WHERE c.user_id = ? AND c.workspace_id = ? AND c.recording_id = ?
          AND p.schema_version = ? AND e.schema_version = ? LIMIT 1`)
        .bind(recording.user_id, recording.workspace_id, recording.id, PUBLICATION_SCHEMA_VERSION, CANONICAL_EDITORIAL_SCHEMA_VERSION).first<{ current_run_id: string }>(),
    ]);
    return Boolean(canonical?.run_id || publication?.run_id || current?.current_run_id);
  } catch {
    throw new MiningV3HandoffError("mining_handoff_history_unavailable", 503, "V3 history cannot be read");
  }
}

function exactRunIdentity(
  row: Record<string, unknown>,
  expectedRunId: string,
  marker: HandoffMarker,
): boolean {
  return row.run_id === expectedRunId && row.user_id === marker.user_id && row.workspace_id === marker.workspace_id &&
    row.article_id === marker.article_id && Number(row.recording_id) === marker.recording_id;
}

function strictJsonRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new MiningV3HandoffError(code, 409, "V3 run manifest evidence is invalid");
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new MiningV3HandoffError(code, 409, "V3 run manifest evidence is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactCoordinatorRunIdentity(
  row: Record<string, unknown>,
  expectedRunId: string,
  marker: HandoffMarker,
  payloadHash: string,
  manifestHash: string,
): boolean {
  return exactRunIdentity(row, expectedRunId, marker) &&
    row.workflow_id === `five-agent-${expectedRunId}` &&
    row.payload_hash === payloadHash && row.manifest_hash === manifestHash;
}

async function canonicalManifestHash(
  canonical: Record<string, unknown>,
  marker: HandoffMarker,
  expectedRunId: string,
  expectedPayloadHash: string,
): Promise<{ manifestHash: string; legacyManifestHash: string }> {
  if (!exactRunIdentity(canonical, expectedRunId, marker) ||
      canonical.schema_version !== CANONICAL_EDITORIAL_SCHEMA_VERSION ||
      canonical.workflow_version !== FIVE_AGENT_PUBLISHING_WORKFLOW_VERSION ||
      canonical.policy_version !== FIVE_AGENT_PUBLISHING_POLICY_VERSION ||
      canonical.idempotency_key !== `run:${expectedRunId}` || canonical.payload_hash !== expectedPayloadHash) {
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "canonical V3 run identity conflicts");
  }
  const agentVersions = strictJsonRecord(canonical.agent_versions_json, "mining_handoff_identity_conflict");
  const skillPins = strictJsonRecord(canonical.skill_pins_json, "mining_handoff_identity_conflict");
  if (canonicalJson(agentVersions) !== canonicalJson(PUBLICATION_AGENT_VERSIONS) ||
      !isExactWave2PublicationSkillPins(skillPins) ||
      canonicalJson(skillPins.style) !== canonicalJson(marker.profile_pins.style) ||
      canonicalJson(skillPins.formatting) !== canonicalJson(marker.profile_pins.formatting) ||
      canonicalJson(skillPins.adapter_pins) !== canonicalJson(PUBLICATION_WAVE2_ADAPTER_PINS) ||
      (marker.style_profile_body_hash === undefined
        ? skillPins.style_profile_body_hash !== undefined
        : skillPins.style_profile_body_hash !== marker.style_profile_body_hash)) {
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "canonical V3 run pins conflict");
  }
  const manifest = {
    schema_version: canonical.schema_version,
    run_id: expectedRunId,
    article_id: marker.article_id,
    recording_id: marker.recording_id,
    user_id: marker.user_id,
    workspace_id: marker.workspace_id,
    workflow_version: canonical.workflow_version,
    policy_version: canonical.policy_version,
    agent_versions: agentVersions,
    skill_pins: skillPins,
    adapter_pins: skillPins.adapter_pins,
    model_pins: skillPins.model_pins,
    idempotency_key: canonical.idempotency_key,
    payload_hash: canonical.payload_hash,
  };
  const { payload_hash: _payloadHash, ...legacyManifest } = manifest;
  return {
    manifestHash: await hashJson(manifest),
    legacyManifestHash: await hashJson(legacyManifest),
  };
}

type PublicationStartEvent = {
  event_id: string;
  run_id: string;
  user_id: string;
  workspace_id: string;
  recording_id: number;
  revision: number;
  event_type: string;
  state: string;
  idempotency_key: string;
  payload_hash: string;
  error_code: string | null;
  next_action: string | null;
  retry_count: number | null;
  created_at: string;
};

type CoordinatorMainEvent = {
  event_type: string;
  state: string;
  state_revision: number;
  artifact_id: string | null;
  payload_hash: string | null;
  error_code: string | null;
  next_action: string | null;
  created_at: string;
};

const START_RECOVERY_REQUIRED = "start_reconciliation_required";
const START_RECOVERY_RECONCILED = "start_reconciled";
const START_RECOVERY_RETRYING = "start_reconciliation_retrying";
const START_RECOVERY_QUEUED = "start_reconciliation_queued";
const PUBLICATION_PROOF_EVENT_TYPES = new Set([
  "run_queued", "transcription_started", "transcript_ready", "writing_started", "draft_generated",
  "review_started", "review_pass", "review_revise", "review_block", "review_2_pass", "review_2_revise",
  "review_2_block", "revision_requested", "content_frozen", "visual_planning", "visual_generating", "visual_ready",
  "formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready", "needs_action", "failed",
  "visual_plan_committed", "visual_asset_committed", "visual_qa_committed", "wechat_artifact_committed",
  START_RECOVERY_REQUIRED, START_RECOVERY_RECONCILED, START_RECOVERY_RETRYING, START_RECOVERY_QUEUED,
  "visual_side_effect_reconciled", "visual_reconciliation_retrying", "visual_reconciliation_resumed",
  "wechat_side_effect_reconciled", "wechat_reconciliation_retrying", "wechat_reconciliation_resumed",
  "workflow_start_confirmed", "action_retry", "action_cancel",
]);
const COORDINATOR_PROOF_EVENT_TYPES = new Set([
  "run_queued", "transcription_started", "transcript_ready", "writing_started", "draft_generated",
  "review_started", "reviewed", "revision_requested", "content_frozen", "visual_planning", "visual_generating",
  "visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying", "draft_ready", "needs_action",
  "failed", "artifact_committed", "visual_plan_committed", "visual_asset_committed", "visual_qa_committed",
  "wechat_artifact_committed",
]);

function startProofConflict(message: string): never {
  throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, message);
}

function isExactPublicationEvent(
  event: PublicationStartEvent | undefined,
  expected: Partial<PublicationStartEvent> & { revision: number; event_type: string; state: string },
  runId: string,
  marker: HandoffMarker,
): boolean {
  return !!event && event.event_id === `${runId}:event:${expected.revision}` &&
    event.run_id === runId && event.user_id === marker.user_id && event.workspace_id === marker.workspace_id &&
    Number(event.recording_id) === marker.recording_id && event.revision === expected.revision &&
    event.event_type === expected.event_type && event.state === expected.state &&
    (expected.idempotency_key === undefined || event.idempotency_key === expected.idempotency_key) &&
    (expected.payload_hash === undefined || event.payload_hash === expected.payload_hash) &&
    (expected.error_code === undefined || event.error_code === expected.error_code) &&
    (expected.next_action === undefined || event.next_action === expected.next_action);
}

function validatePublicationChain(
  events: readonly PublicationStartEvent[],
  publication: Record<string, unknown>,
  runId: string,
  marker: HandoffMarker,
  payloadHash: string,
): void {
  const revision = Number(publication.state_revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || events.length !== revision + 1 || events.some((event, index) =>
    !PUBLICATION_PROOF_EVENT_TYPES.has(event.event_type) ||
    !isExactPublicationEvent(event, { revision: index, event_type: event.event_type, state: event.state }, runId, marker))) {
    startProofConflict("publication V3 event chain is not contiguous");
  }
  const first = events[0];
  if (!isExactPublicationEvent(first, {
    revision: 0, event_type: "run_queued", state: "queued", idempotency_key: `${runId}:event:0`,
    payload_hash: payloadHash, error_code: null, next_action: null,
  }, runId, marker)) {
    startProofConflict("publication V3 initial event conflicts");
  }
  const last = events.at(-1)!;
  if (publication.state !== last.state || publication.error_code !== last.error_code || publication.next_action !== last.next_action ||
      publication.last_event_id !== last.event_id || publication.last_event_type !== last.event_type ||
      publication.last_event_idempotency_key !== last.idempotency_key || publication.last_event_payload_hash !== last.payload_hash ||
      publication.last_event_created_at !== last.created_at) {
    startProofConflict("publication V3 current event identity conflicts");
  }
}

function publicationEventMapsToCoordinator(publication: PublicationStartEvent, coordinator: CoordinatorMainEvent): boolean {
  const expectedCoordinatorType = (() => {
    switch (publication.event_type) {
      case "review_pass":
      case "review_revise":
      case "review_block":
      case "review_2_pass":
      case "review_2_revise":
      case "review_2_block":
        return "reviewed";
      default:
        return publication.event_type;
    }
  })();
  if (coordinator.event_type === "artifact_committed") {
    return publication.payload_hash === coordinator.payload_hash && publication.state === coordinator.state;
  }
  return coordinator.event_type === expectedCoordinatorType && coordinator.state === publication.state &&
    coordinator.payload_hash === publication.payload_hash && coordinator.error_code === publication.error_code &&
    coordinator.next_action === publication.next_action;
}

const VISUAL_RECOVERY_TARGETS = new Set(["visual_planning", "visual_generating"]);
const WECHAT_RECOVERY_TARGETS = new Set(["visual_ready", "formatting", "visual_qa", "draft_syncing", "draft_verifying"]);
const WECHAT_HOLD_ACTIONS: Record<string, string> = {
  draft_readback_mismatch: "reconcile_draft",
  draft_readback_unavailable: "reconcile_draft",
  draft_identity_unresolved: "reconcile_draft_identity",
  wechat_publishing_account_not_allowed: "request_account_enablement",
  wechat_publishing_account_unavailable: "repair_publishing_account",
  wechat_publishing_account_rejected: "repair_publishing_account",
  wechat_access_token_rejected: "repair_publishing_account",
  external_side_effect_unknown: "reconcile_external_side_effect",
  wechat_artifact_reconciliation_required: "reconcile_external_side_effect",
};

function mapsRecoveredPublicationEvent(
  publication: PublicationStartEvent,
  coordinator: CoordinatorMainEvent,
  target: string,
): boolean {
  return coordinator.event_type === target && coordinator.state === target &&
    coordinator.payload_hash === publication.payload_hash &&
    coordinator.error_code === null && coordinator.next_action === null;
}

function exactWave2dHold(
  hold: PublicationStartEvent,
  runId: string,
  target: string,
  allowedCodes: Readonly<Record<string, string>>,
): { phase: number; errorCode: string } {
  const prefix = "wave2d:needs-action:";
  const suffix = `:${runId}`;
  if (!hold.idempotency_key.startsWith(prefix) || !hold.idempotency_key.endsWith(suffix)) {
    startProofConflict("publication recovery hold key is not canonical");
  }
  const parts = hold.idempotency_key.slice(prefix.length, -suffix.length).split(":");
  const phase = Number(parts[0]);
  const errorCode = parts[1];
  const embeddedRevision = Number(parts[2]);
  if (parts.length !== 3 || !Number.isInteger(phase) || phase < 0 ||
      !Number.isInteger(embeddedRevision) || embeddedRevision < 0 ||
      embeddedRevision + 1 !== hold.revision || !allowedCodes[errorCode] ||
      hold.event_type !== "needs_action" || hold.state !== "needs_action" ||
      hold.error_code !== errorCode || hold.next_action !== allowedCodes[errorCode]) {
    startProofConflict("publication recovery hold is not exact");
  }
  if (!target) startProofConflict("publication recovery target is missing");
  return { phase, errorCode };
}

async function validateVisualRecoveryGroup(
  events: readonly PublicationStartEvent[],
  index: number,
  runId: string,
  payloadHash: string,
): Promise<{ resumed: PublicationStartEvent; consumed: number }> {
  const [reconciled, retrying, resumed] = events.slice(index, index + 3);
  const hold = events[index - 1];
  const checkpoint = events[index - 2];
  const target = resumed?.state;
  if (!reconciled || !retrying || !resumed || !hold || !checkpoint || !VISUAL_RECOVERY_TARGETS.has(String(target)) ||
      checkpoint.state !== target || hold.event_type !== "needs_action" || hold.state !== "needs_action" ||
      hold.error_code !== EXTERNAL_SIDE_EFFECT_UNKNOWN || hold.next_action !== RECONCILE_EXTERNAL_SIDE_EFFECT ||
      reconciled.idempotency_key !== `wave2c-reconciled:${target}:${runId}` ||
      retrying.idempotency_key !== `wave2c-retrying:${target}:${runId}` ||
      resumed.idempotency_key !== `wave2c-resumed:${target}:${runId}` ||
      reconciled.event_type !== "visual_side_effect_reconciled" || reconciled.state !== "needs_action" ||
      reconciled.error_code !== "visual_side_effect_reconciled" || reconciled.next_action !== "resume_reconciled_visual" ||
      retrying.event_type !== "visual_reconciliation_retrying" || retrying.state !== "retrying" ||
      retrying.error_code !== null || retrying.next_action !== null ||
      resumed.event_type !== "visual_reconciliation_resumed" || resumed.error_code !== null || resumed.next_action !== null ||
      retrying.revision !== reconciled.revision + 1 || resumed.revision !== retrying.revision + 1) {
    startProofConflict("visual recovery group is not exact");
  }
  const { phase, errorCode } = exactWave2dHold(hold, runId, String(target), {
    [EXTERNAL_SIDE_EFFECT_UNKNOWN]: RECONCILE_EXTERNAL_SIDE_EFFECT,
  });
  const retryCount = Number(hold.retry_count);
  if (!Number.isSafeInteger(retryCount) || retryCount < 1 ||
      hold.payload_hash !== await hashJson({
        run_payload_hash: payloadHash, event_type: "needs_action", phase, target_state: "needs_action",
        error_code: errorCode, next_action: RECONCILE_EXTERNAL_SIDE_EFFECT, revision_count: null, retry_count: retryCount,
      })) {
    startProofConflict("visual recovery hold payload identity conflicts");
  }
  const [reconciledHash, retryingHash, resumedHash] = await Promise.all([
    hashJson({ run_payload_hash: payloadHash, event_type: "visual_side_effect_reconciled", target_state: "needs_action", resume_state: target }),
    hashJson({ run_payload_hash: payloadHash, event_type: "visual_reconciliation_retrying", target_state: "retrying", resume_state: target }),
    hashJson({ run_payload_hash: payloadHash, event_type: "visual_reconciliation_resumed", target_state: target }),
  ]);
  if (reconciled.payload_hash !== reconciledHash || retrying.payload_hash !== retryingHash || resumed.payload_hash !== resumedHash) {
    startProofConflict("visual recovery payload identity conflicts");
  }
  return { resumed, consumed: 3 };
}

async function validateWechatRecoveryGroup(
  events: readonly PublicationStartEvent[],
  index: number,
  runId: string,
  payloadHash: string,
): Promise<{ resumed: PublicationStartEvent; consumed: number }> {
  const [reconciled, retrying, resumed] = events.slice(index, index + 3);
  const hold = events[index - 1];
  const checkpoint = events[index - 2];
  if (!reconciled || !retrying || !resumed || !hold || !checkpoint) startProofConflict("wechat recovery group is incomplete");
  const match = /^wave2d:reconciled:([a-f0-9]{32}):([^:]+):/.exec(reconciled.idempotency_key);
  const cycle = match?.[1];
  const target = match?.[2];
  if (!cycle || !target || !WECHAT_RECOVERY_TARGETS.has(target) || checkpoint.state !== target ||
      retrying.idempotency_key !== `wave2d:retrying:${cycle}:${target}:${runId}` ||
      resumed.idempotency_key !== `wave2d:resumed:${cycle}:${target}:${runId}` ||
      reconciled.event_type !== "wechat_side_effect_reconciled" || reconciled.state !== "needs_action" ||
      reconciled.error_code !== "wechat_side_effect_reconciled" || reconciled.next_action !== "resume_reconciled_wechat" ||
      retrying.event_type !== "wechat_reconciliation_retrying" || retrying.state !== "retrying" ||
      retrying.error_code !== null || retrying.next_action !== null ||
      resumed.event_type !== "wechat_reconciliation_resumed" || resumed.state !== target ||
      resumed.error_code !== null || resumed.next_action !== null ||
      retrying.revision !== reconciled.revision + 1 || resumed.revision !== retrying.revision + 1) {
    startProofConflict("wechat recovery group is not exact");
  }
  const { phase, errorCode } = exactWave2dHold(hold, runId, target, WECHAT_HOLD_ACTIONS);
  const retryCount = Number(hold.retry_count);
  if (!Number.isSafeInteger(retryCount) || retryCount < 1) startProofConflict("wechat recovery hold retry count is invalid");
  const holdHash = await hashJson({
    run_payload_hash: payloadHash, event_type: "needs_action", phase, target_state: "needs_action",
    error_code: errorCode, next_action: WECHAT_HOLD_ACTIONS[errorCode], revision_count: null, retry_count: retryCount,
  });
  if (hold.payload_hash !== holdHash) startProofConflict("wechat recovery hold payload identity conflicts");
  const expectedCycle = (await hashJson({
    run_id: runId, target, hold_revision: hold.revision,
    hold_idempotency_key: hold.idempotency_key, hold_payload_hash: hold.payload_hash,
  })).slice(7, 39);
  if (cycle !== expectedCycle) startProofConflict("wechat recovery cycle conflicts");
  const [reconciledHash, retryingHash, resumedHash] = await Promise.all([
    hashJson({ run_payload_hash: payloadHash, event: "wechat_side_effect_reconciled", target, recovery_cycle: cycle,
      recovered_hold: { revision: hold.revision, idempotency_key: hold.idempotency_key, payload_hash: hold.payload_hash } }),
    hashJson({ run_payload_hash: payloadHash, event: "wechat_reconciliation_retrying", target, recovery_cycle: cycle,
      recovered_hold: { revision: hold.revision, idempotency_key: hold.idempotency_key, payload_hash: hold.payload_hash } }),
    hashJson({ run_payload_hash: payloadHash, event: "wechat_reconciliation_resumed", target, recovery_cycle: cycle,
      recovered_hold: { revision: hold.revision, idempotency_key: hold.idempotency_key, payload_hash: hold.payload_hash } }),
  ]);
  if (reconciled.payload_hash !== reconciledHash || retrying.payload_hash !== retryingHash || resumed.payload_hash !== resumedHash) {
    startProofConflict("wechat recovery payload identity conflicts");
  }
  return { resumed, consumed: 3 };
}

async function validateBusinessCrossMap(
  publicationEvents: readonly PublicationStartEvent[],
  coordinatorEvents: readonly CoordinatorMainEvent[],
  startOffset: number,
  runId: string,
  payloadHash: string,
): Promise<void> {
  let publicationIndex = startOffset === 4 ? 5 : 1;
  let coordinatorIndex = 1;
  while (publicationIndex < publicationEvents.length) {
    const publication = publicationEvents[publicationIndex];
    const coordinator = coordinatorEvents[coordinatorIndex];
    if (!publication || !coordinator) startProofConflict("Coordinator and publication V3 business event chains differ in length");
    if (publication.event_type === "visual_side_effect_reconciled") {
      const group = await validateVisualRecoveryGroup(publicationEvents, publicationIndex, runId, payloadHash);
      if (!mapsRecoveredPublicationEvent(group.resumed, coordinator, group.resumed.state)) {
        startProofConflict("visual recovery does not map to the Coordinator event chain");
      }
      publicationIndex += group.consumed;
      coordinatorIndex += 1;
      continue;
    }
    if (publication.event_type === "wechat_side_effect_reconciled") {
      const group = await validateWechatRecoveryGroup(publicationEvents, publicationIndex, runId, payloadHash);
      if (!mapsRecoveredPublicationEvent(group.resumed, coordinator, group.resumed.state)) {
        startProofConflict("wechat recovery does not map to the Coordinator event chain");
      }
      publicationIndex += group.consumed;
      coordinatorIndex += 1;
      continue;
    }
    if (!publicationEventMapsToCoordinator(publication, coordinator)) {
      startProofConflict("Coordinator and publication V3 business event chains conflict");
    }
    publicationIndex += 1;
    coordinatorIndex += 1;
  }
  if (coordinatorIndex !== coordinatorEvents.length) {
    startProofConflict("Coordinator and publication V3 business event chains differ in length");
  }
}

function validateCoordinatorChain(
  events: readonly CoordinatorMainEvent[],
  coordinatorRun: Record<string, unknown>,
  runId: string,
  payloadHash: string,
): void {
  const revision = Number(coordinatorRun.state_revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || events.length !== revision + 1 || events.some((event, index) =>
    event.state_revision !== index || !COORDINATOR_PROOF_EVENT_TYPES.has(event.event_type) || event.state.length === 0)) {
    startProofConflict("Coordinator V3 event chain is not contiguous");
  }
  const first = events[0];
  if (!first || first.event_type !== "run_queued" || first.state !== "queued" || first.state_revision !== 0 ||
      first.payload_hash !== payloadHash || first.error_code !== null || first.next_action !== null) {
    startProofConflict("Coordinator V3 initial event conflicts");
  }
  const last = events.at(-1)!;
  if (coordinatorRun.state !== last.state || coordinatorRun.error_code !== last.error_code ||
      coordinatorRun.next_action !== last.next_action || Number(coordinatorRun.state_revision) !== last.state_revision ||
      !runId) {
    startProofConflict("Coordinator V3 current event identity conflicts");
  }
}

function exactStartEvidenceOrder(
  events: readonly { event_type: string; created_at: string }[],
  expectedTypes: readonly string[],
): boolean {
  return events.length === expectedTypes.length && events.every((event, index) =>
    event.event_type === expectedTypes[index] && Number.isFinite(Date.parse(event.created_at)) &&
    (index === 0 || Date.parse(events[index - 1].created_at) <= Date.parse(event.created_at)));
}

async function validateCoordinatorArtifactEvents(
  env: MiningV3HandoffEnv,
  coordinator: Pick<EditorialCoordinatorAgent, "getFiveAgentArtifactLedger">,
  events: readonly CoordinatorMainEvent[],
  runId: string,
  marker: HandoffMarker,
): Promise<void> {
  const artifactEvents = events.filter((event) => event.artifact_id !== null);
  if (artifactEvents.length === 0) return;
  const [ledger, mirrors] = await Promise.all([
    coordinator.getFiveAgentArtifactLedger(runId, marker.user_id, marker.workspace_id),
    env.DB.prepare(`SELECT artifact_id, run_id, article_id, recording_id, user_id, workspace_id, kind,
        producer_agent_role, producer_agent_version, workflow_version, policy_version,
        input_artifact_ids_json, payload_hash, storage_ref
      FROM editorial_artifacts WHERE run_id = ? AND user_id = ? AND workspace_id = ?`)
      .bind(runId, marker.user_id, marker.workspace_id).all<Record<string, unknown>>(),
  ]);
  const ledgerById = new Map(ledger.artifacts.map((artifact) => [String(artifact.artifact_id), artifact]));
  const mirrorById = new Map((mirrors.results || []).map((artifact) => [String(artifact.artifact_id), artifact]));
  for (const event of artifactEvents) {
    const artifact = ledgerById.get(String(event.artifact_id));
    const mirror = mirrorById.get(String(event.artifact_id));
    if (!artifact || !mirror || event.payload_hash !== artifact.payload_hash ||
        artifact.run_id !== runId || artifact.user_id !== marker.user_id || artifact.workspace_id !== marker.workspace_id ||
        artifact.article_id !== marker.article_id || Number(artifact.recording_id) !== marker.recording_id ||
        mirror.run_id !== runId || mirror.user_id !== marker.user_id || mirror.workspace_id !== marker.workspace_id ||
        mirror.article_id !== marker.article_id || Number(mirror.recording_id) !== marker.recording_id ||
        mirror.kind !== artifact.kind || mirror.producer_agent_role !== artifact.producer_role ||
        mirror.producer_agent_version !== artifact.producer_version || mirror.workflow_version !== artifact.workflow_version ||
        mirror.policy_version !== artifact.policy_version || mirror.input_artifact_ids_json !== artifact.input_artifact_ids_json ||
        mirror.payload_hash !== artifact.payload_hash || mirror.storage_ref !== artifact.storage_ref) {
      startProofConflict("Coordinator V3 artifact event identity conflicts");
    }
  }
}

async function startRecoveryProof(
  events: readonly PublicationStartEvent[],
  workflowId: string,
  runId: string,
  payloadHash: string,
  marker: HandoffMarker,
): Promise<{ offset: number; status: "normal" | "unknown" | "recovering" }> {
  if (events.length === 1) return { offset: 0, status: "normal" };
  if (events[1]?.event_type !== START_RECOVERY_REQUIRED) return { offset: 0, status: "normal" };
  const requiredHash = await hashJson({
    run_payload_hash: payloadHash,
    event_type: START_RECOVERY_REQUIRED,
    start_status: WORKFLOW_CREATE_UNKNOWN,
    target_state: "needs_action",
  });
  if (!isExactPublicationEvent(events[1], {
    revision: 1, event_type: START_RECOVERY_REQUIRED, state: "needs_action",
    idempotency_key: `start-required:${WORKFLOW_CREATE_UNKNOWN}:${runId}`,
    payload_hash: requiredHash, error_code: EXTERNAL_SIDE_EFFECT_UNKNOWN, next_action: RECONCILE_EXTERNAL_SIDE_EFFECT,
  }, runId, marker)) {
    startProofConflict("publication V3 start hold conflicts");
  }
  if (events.length === 2) return { offset: 0, status: "unknown" };
  const reconciledHash = await hashJson({
    run_payload_hash: payloadHash, event_type: START_RECOVERY_RECONCILED,
    start_status: WORKFLOW_CREATE_UNKNOWN, target_state: "needs_action",
    error_code: "start_side_effect_reconciled", next_action: "resume_reconciled_start",
  });
  if (!isExactPublicationEvent(events[2], {
    revision: 2, event_type: START_RECOVERY_RECONCILED, state: "needs_action",
    idempotency_key: `start-reconcile:${WORKFLOW_CREATE_UNKNOWN}:reconciled:${runId}`,
    payload_hash: reconciledHash, error_code: "start_side_effect_reconciled", next_action: "resume_reconciled_start",
  }, runId, marker)) {
    startProofConflict("publication V3 start reconciliation conflicts");
  }
  if (events.length === 3) return { offset: 0, status: "recovering" };
  const retryingHash = await hashJson({
    run_payload_hash: payloadHash, event_type: START_RECOVERY_RETRYING,
    start_status: WORKFLOW_CREATE_UNKNOWN, target_state: "retrying",
  });
  if (!isExactPublicationEvent(events[3], {
    revision: 3, event_type: START_RECOVERY_RETRYING, state: "retrying",
    idempotency_key: `start-reconcile:${WORKFLOW_CREATE_UNKNOWN}:retrying:${runId}`,
    payload_hash: retryingHash, error_code: EXTERNAL_SIDE_EFFECT_UNKNOWN, next_action: RECONCILE_EXTERNAL_SIDE_EFFECT,
  }, runId, marker)) {
    startProofConflict("publication V3 start retry conflicts");
  }
  if (events.length === 4) return { offset: 0, status: "recovering" };
  const queuedHash = await hashJson({
    run_payload_hash: payloadHash, event_type: START_RECOVERY_QUEUED,
    start_status: WORKFLOW_CREATE_UNKNOWN, target_state: "queued",
  });
  if (!isExactPublicationEvent(events[4], {
    revision: 4, event_type: START_RECOVERY_QUEUED, state: "queued",
    idempotency_key: `start-reconcile:${WORKFLOW_CREATE_UNKNOWN}:queued:${runId}`,
    payload_hash: queuedHash, error_code: null, next_action: null,
  }, runId, marker)) {
    startProofConflict("publication V3 start queued reconciliation conflicts");
  }
  return { offset: 4, status: "recovering" };
}

async function proveCoordinatorStart(
  env: MiningV3HandoffEnv,
  marker: HandoffMarker,
  expectedRunId: string,
  payloadHash: string,
  manifestHash: string,
  legacyManifestHash: string,
  publication: Record<string, unknown>,
  publicationEvents: readonly PublicationStartEvent[],
): Promise<"confirmed" | "workflow_create_unknown" | "legacy_manifest_upgrade_required"> {
  const workflowId = `five-agent-${expectedRunId}`;
  let coordinatorRun: Record<string, unknown>;
  let ledger: Record<string, unknown> | null;
  let evidence: {
    workflow_start_status: string | null;
    events: Array<{ event_type: string; idempotency_key: string; evidence_hash: string; created_at: string }>;
    receipts: Array<{ receipt_id: string; reconciliation_key: string; evidence_hash: string }>;
  };
  let coordinatorEvents: CoordinatorMainEvent[];
  let coordinator: DurableObjectStub<EditorialCoordinatorAgent>;
  try {
    coordinator = env.EDITORIAL_COORDINATOR.getByName(await coordinatorShardName(
      marker.user_id,
      marker.workspace_id,
      marker.article_id,
      expectedRunId,
    ));
    coordinatorRun = await coordinator.getFiveAgentRun(expectedRunId, marker.user_id, marker.workspace_id) as Record<string, unknown>;
    ledger = await coordinator.getFiveAgentStartLedger(expectedRunId, workflowId) as Record<string, unknown> | null;
    evidence = await coordinator.getFiveAgentStartEvidence(expectedRunId, workflowId) as typeof evidence;
    coordinatorEvents = await coordinator.listFiveAgentEvents(expectedRunId, marker.user_id, marker.workspace_id) as CoordinatorMainEvent[];
  } catch (error) {
    if ((error as { status?: unknown })?.status === 409) {
      throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "Coordinator V3 start identity conflicts");
    }
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "Coordinator V3 start evidence is unavailable");
  }
  const canonicalCoordinatorIdentity = isRecord(coordinatorRun) &&
    exactCoordinatorRunIdentity(coordinatorRun, expectedRunId, marker, payloadHash, manifestHash);
  const legacyCoordinatorIdentity = isRecord(coordinatorRun) &&
    exactCoordinatorRunIdentity(coordinatorRun, expectedRunId, marker, payloadHash, legacyManifestHash);
  if (!ledger || (!canonicalCoordinatorIdentity && !legacyCoordinatorIdentity)) {
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "Coordinator V3 start identity conflicts");
  }
  if (ledger.start_status === "brief_storage_unknown") {
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "Brief storage uncertainty never transfers Mining ownership");
  }
  validatePublicationChain(publicationEvents, publication, expectedRunId, marker, payloadHash);
  validateCoordinatorChain(coordinatorEvents, coordinatorRun, expectedRunId, payloadHash);
  await validateCoordinatorArtifactEvents(env, coordinator, coordinatorEvents, expectedRunId, marker);
  const prefix = await startRecoveryProof(publicationEvents, workflowId, expectedRunId, payloadHash, marker);
  const confirmationEvents = evidence.events.filter(event => event.event_type === WORKFLOW_START_CONFIRMED);
  const requiredEvents = evidence.events.filter(event => event.event_type === START_RECOVERY_REQUIRED);
  const reconciledEvents = evidence.events.filter(event => event.event_type === START_RECOVERY_RECONCILED);
  const reconciliationKey = `${WORKFLOW_CREATE_UNKNOWN}:${workflowId}`;
  const requiredEvidenceHash = await hashJson({
    workflow_id: workflowId,
    run_id: expectedRunId,
    event_type: START_RECOVERY_REQUIRED,
    start_status: WORKFLOW_CREATE_UNKNOWN,
    error_code: EXTERNAL_SIDE_EFFECT_UNKNOWN,
    next_action: RECONCILE_EXTERNAL_SIDE_EFFECT,
  });
  const reconciledEvidenceHash = await hashJson({
    workflow_id: workflowId,
    run_id: expectedRunId,
    event_type: START_RECOVERY_RECONCILED,
    start_status: WORKFLOW_CREATE_UNKNOWN,
    reconciliation_key: reconciliationKey,
    evidence_hash: manifestHash,
  });
  const hasExactRequired = requiredEvents.length === 1 &&
    requiredEvents[0].idempotency_key === `start-required:${workflowId}:${WORKFLOW_CREATE_UNKNOWN}` &&
    requiredEvents[0].evidence_hash === requiredEvidenceHash;
  const hasExactReconciled = reconciledEvents.length === 1 &&
    reconciledEvents[0].idempotency_key === `start-reconciled:${workflowId}:${reconciliationKey}` &&
    reconciledEvents[0].evidence_hash === reconciledEvidenceHash &&
    evidence.receipts.length === 1 && evidence.receipts[0].receipt_id === `${workflowId}:start-reconcile:${reconciliationKey}` &&
    evidence.receipts[0].reconciliation_key === reconciliationKey &&
    evidence.receipts[0].evidence_hash === manifestHash;
  const unknownLedger = ledger.status === "needs_action" && ledger.start_status === WORKFLOW_CREATE_UNKNOWN &&
    ledger.error_code === EXTERNAL_SIDE_EFFECT_UNKNOWN && ledger.next_action === RECONCILE_EXTERNAL_SIDE_EFFECT &&
    coordinatorRun.start_ledger_status === "needs_action" && coordinatorRun.start_status === WORKFLOW_CREATE_UNKNOWN &&
    coordinatorRun.start_error_code === EXTERNAL_SIDE_EFFECT_UNKNOWN && coordinatorRun.start_next_action === RECONCILE_EXTERNAL_SIDE_EFFECT &&
    evidence.workflow_start_status === "unknown";
  const reconciledLedger = ledger.status === "reconciled" && ledger.start_status === WORKFLOW_CREATE_UNKNOWN &&
    ledger.error_code === null && ledger.next_action === null &&
    coordinatorRun.start_ledger_status === "reconciled" && coordinatorRun.start_status === "reconciled_resuming" &&
    coordinatorRun.start_error_code === null && coordinatorRun.start_next_action === null &&
    evidence.workflow_start_status === "reconciled";
  const exactUnknownPrefix = prefix.status === "unknown" && publicationEvents.length === 2 && coordinatorEvents.length === 1 &&
    exactStartEvidenceOrder(evidence.events, [START_RECOVERY_REQUIRED]) && evidence.receipts.length === 0 && unknownLedger &&
    publication.state === "needs_action" && publication.error_code === EXTERNAL_SIDE_EFFECT_UNKNOWN &&
    publication.next_action === RECONCILE_EXTERNAL_SIDE_EFFECT && publication.last_successful_state === "queued";
  const exactRecoveryPrefix = prefix.status === "recovering" && publicationEvents.length >= 3 && publicationEvents.length <= 5 &&
    coordinatorEvents.length === 1 && hasExactRequired && hasExactReconciled && exactStartEvidenceOrder(evidence.events, [START_RECOVERY_REQUIRED, START_RECOVERY_RECONCILED]) &&
    (unknownLedger || reconciledLedger);
  if (legacyCoordinatorIdentity) {
    if (confirmationEvents.length === 0 && exactUnknownPrefix) return "legacy_manifest_upgrade_required";
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "legacy Coordinator V3 manifest is not safe to upgrade");
  }
  let confirmation: { confirmed: boolean; event_id: string | null };
  try {
    confirmation = await coordinator.getFiveAgentWorkflowStartConfirmation({
      run_id: expectedRunId,
      workflow_id: workflowId,
      article_id: marker.article_id,
      recording_id: marker.recording_id,
      user_id: marker.user_id,
      workspace_id: marker.workspace_id,
      payload_hash: payloadHash,
      manifest_hash: manifestHash,
    });
  } catch (error) {
    if ((error as { status?: unknown })?.status === 409) {
      throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "Coordinator V3 start identity conflicts");
    }
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "Coordinator V3 start evidence is unavailable");
  }
  if (confirmation.confirmed) {
    const expectedConfirmationHash = await hashJson({
      workflow_id: workflowId,
      run_id: expectedRunId,
      article_id: marker.article_id,
      recording_id: marker.recording_id,
      user_id: marker.user_id,
      workspace_id: marker.workspace_id,
      payload_hash: payloadHash,
      manifest_hash: manifestHash,
      event_type: WORKFLOW_START_CONFIRMED,
    });
    if (prefix.status === "unknown" || prefix.status === "recovering" && publicationEvents.length < 5 ||
        coordinatorRun.start_ledger_status !== "started" || coordinatorRun.start_status !== "workflow_started" ||
        coordinatorRun.start_error_code !== null || coordinatorRun.start_next_action !== null ||
        ledger.status !== "started" || ledger.start_status !== null || ledger.error_code !== null || ledger.next_action !== null ||
        evidence.workflow_start_status !== "started" || confirmationEvents.length !== 1 ||
        confirmationEvents[0].idempotency_key !== `workflow-start-confirmed:${workflowId}` ||
        confirmationEvents[0].evidence_hash !== expectedConfirmationHash || confirmation.event_id === null ||
        (prefix.offset === 0
          ? (!exactStartEvidenceOrder(evidence.events, [WORKFLOW_START_CONFIRMED]) || evidence.receipts.length !== 0)
          : (!hasExactRequired || !hasExactReconciled || !exactStartEvidenceOrder(evidence.events, [START_RECOVERY_REQUIRED, START_RECOVERY_RECONCILED, WORKFLOW_START_CONFIRMED]) || publicationEvents.length < 5))) {
      throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "Coordinator V3 workflow confirmation conflicts");
    }
    await validateBusinessCrossMap(publicationEvents, coordinatorEvents, prefix.offset, expectedRunId, payloadHash);
    return "confirmed";
  }
  if (confirmationEvents.length !== 0 || prefix.status === "normal" || (!exactUnknownPrefix && !exactRecoveryPrefix)) {
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "Workflow-create uncertainty is not durably proven");
  }
  return "workflow_create_unknown";
}

async function acceptedRunProof(env: MiningV3HandoffEnv, marker: HandoffMarker, transcript: TranscriptRef): Promise<AcceptedRun | null> {
  const expectedRunId = await runId(marker, transcript);
  const start = await startBody(marker, transcript);
  const expectedPayloadHash = await hashJson({ ...start, user_id: marker.user_id, workspace_id: marker.workspace_id });
  let canonical: Record<string, unknown> | null;
  let publication: Record<string, unknown> | null;
  let current: Record<string, unknown> | null;
  let publicationEvents: PublicationStartEvent[];
  try {
    [canonical, publication, current, publicationEvents] = await Promise.all([
      env.DB.prepare(`SELECT run_id, user_id, workspace_id, article_id, recording_id, schema_version,
          workflow_version, policy_version, agent_versions_json, skill_pins_json, idempotency_key, payload_hash, created_at
        FROM editorial_runs WHERE run_id = ? LIMIT 1`)
        .bind(expectedRunId).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT run_id, source_run_id, source_manifest_hash, user_id, workspace_id, article_id, recording_id,
          schema_version, state, state_revision, last_successful_state, error_code, next_action,
          last_event_id, last_event_type, last_event_idempotency_key, last_event_payload_hash, last_event_created_at
        FROM publication_runs WHERE run_id = ? LIMIT 1`)
        .bind(expectedRunId).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT current_run_id FROM publication_current_runs
        WHERE user_id = ? AND workspace_id = ? AND recording_id = ? LIMIT 1`)
        .bind(marker.user_id, marker.workspace_id, marker.recording_id).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT event_id, run_id, user_id, workspace_id, recording_id, revision, event_type, state,
          idempotency_key, payload_hash, error_code, next_action, retry_count, created_at
        FROM publication_run_events WHERE run_id = ? AND user_id = ? AND workspace_id = ? ORDER BY revision ASC`)
        .bind(expectedRunId, marker.user_id, marker.workspace_id).all<PublicationStartEvent>()
        .then(result => result.results || []),
    ]);
  } catch {
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "V3 run proof cannot be read");
  }
  if (!canonical && !publication && !current) return null;
  if (!canonical || !publication || !current || !exactRunIdentity(canonical, expectedRunId, marker) ||
      !exactRunIdentity(publication, expectedRunId, marker) || current.current_run_id !== expectedRunId) {
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "canonical and publication V3 run identities do not agree");
  }
  const { manifestHash, legacyManifestHash } = await canonicalManifestHash(canonical, marker, expectedRunId, expectedPayloadHash);
  if (publication.schema_version !== PUBLICATION_SCHEMA_VERSION || publication.source_run_id !== expectedRunId ||
      publication.source_manifest_hash !== manifestHash || typeof publication.state !== "string" ||
      !Number.isSafeInteger(publication.state_revision) || Number(publication.state_revision) < 0) {
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "publication V3 source identity conflicts");
  }
  const createdAt = typeof canonical.created_at === "string" ? canonical.created_at : "";
  if (!createdAt) throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "canonical V3 run has no creation evidence");
  const expectedBrief = await buildFiveAgentBriefObject({
    ...await startBody(marker, transcript),
    user_id: marker.user_id,
    workspace_id: marker.workspace_id,
    created_at: createdAt,
  });
  let mirrors: Array<Record<string, unknown>>;
  try {
    const result = await env.DB.prepare(`SELECT artifact_id, kind, run_id, article_id, recording_id, user_id, workspace_id, payload_hash, storage_ref
      FROM editorial_artifacts WHERE run_id = ? AND user_id = ? AND workspace_id = ? AND kind = 'article_brief'`)
      .bind(expectedRunId, marker.user_id, marker.workspace_id).all<Record<string, unknown>>();
    mirrors = result.results || [];
  } catch {
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "V3 Brief mirror cannot be read");
  }
  if (mirrors.length === 0) throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "V3 Brief evidence is missing");
  if (mirrors.length !== 1) throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "V3 Brief evidence is ambiguous");
  const expected = expectedBrief.envelope;
  const mirror = mirrors[0];
  if (mirror.artifact_id !== expected.artifact_id || mirror.kind !== expected.kind || mirror.run_id !== expected.run_id ||
      mirror.article_id !== expected.article_id || Number(mirror.recording_id) !== expected.recording_id ||
      mirror.user_id !== expected.user_id || mirror.workspace_id !== expected.workspace_id ||
      mirror.payload_hash !== expected.payload_hash || mirror.storage_ref !== expected.storage_ref) {
    throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "V3 Brief mirror identity conflicts");
  }
  try {
    await readImmutableArtifact(env.FILES_BUCKET, expectedBrief, {
      userId: marker.user_id,
      workspaceId: marker.workspace_id,
      runId: expectedRunId,
    });
  } catch {
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "V3 Brief R2 evidence cannot be verified");
  }
  const startProof = await proveCoordinatorStart(
    env, marker, expectedRunId, expectedPayloadHash, manifestHash, legacyManifestHash, publication, publicationEvents,
  );
  if (startProof === "legacy_manifest_upgrade_required") return null;
  return {
    run_id: expectedRunId,
    article_id: marker.article_id,
    state: String(publication.state),
    brief_artifact_id: expected.artifact_id,
    brief_payload_hash: expected.payload_hash,
  };
}

async function startExistingV3Run(env: MiningV3HandoffEnv, marker: HandoffMarker, transcript: TranscriptRef): Promise<Response> {
  const body = await startBody(marker, transcript);
  return handleFiveAgentPublishingInternalRoute(new Request("https://internal/api/internal/v3/publishing/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vibepub-user-id": marker.user_id,
      "x-vibepub-workspace-id": marker.workspace_id,
    },
    body: JSON.stringify(body),
  }), env, new URL("https://internal/api/internal/v3/publishing/runs"));
}

type StartInvoker = (marker: HandoffMarker, transcript: TranscriptRef) => Promise<Response>;

function isV3Enabled(env: MiningV3HandoffEnv, marker: Pick<HandoffMarker, "user_id" | "workspace_id" | "source_key">): boolean {
  return publicationSourceFeatureEnabled(env, marker.user_id, marker.workspace_id, marker.source_key);
}

async function eligibility(env: MiningV3HandoffEnv, sourceKeyValue: string): Promise<Response> {
  const recording = await recordingForSource(env, sourceKeyValue);
  const existing = await markersForSource(env, recording);
  if (existing.length === 0 && await v3HistoryExists(env, recording)) {
    return response({ decision: "v3_hold", reason: "v3_history_without_handoff_marker" }, 202);
  }
  const enabled = publicationSourceFeatureEnabled(env, recording.user_id, recording.workspace_id, recording.r2_key);
  if (!enabled) {
    if (existing.length === 0) return response({ decision: "legacy" });
    return response({ decision: "v3_hold", reason: "v3_disabled_after_marker" }, 202);
  }
  const marker = await makeMarker(env, recording);
  const replay = existing.find(item => item.handoff_id === marker.handoff_id);
  if (replay) {
    if (canonicalJson(markerIdentity(replay)) !== canonicalJson(markerIdentity(marker))) {
      throw new MiningV3HandoffError("mining_handoff_identity_conflict", 409, "handoff marker identity conflicts");
    }
    return response({ decision: "v3", handoff_id: replay.handoff_id, source_type: replay.source_type });
  }
  await persistMarker(env, marker);
  return response({ decision: "v3", handoff_id: marker.handoff_id, source_type: marker.source_type });
}

async function statusByMarker(env: MiningV3HandoffEnv, marker: HandoffMarker): Promise<Response> {
  await markerStillMatchesSource(env, marker);
  if (!isV3Enabled(env, marker)) return response({ decision: "v3_hold", handoff_id: marker.handoff_id, reason: "v3_disabled_after_marker" }, 202);
  const transcript = await existingTranscript(env, marker);
  if (!transcript) return response({ decision: "v3_pending_asr", handoff_id: marker.handoff_id });
  const run = await acceptedRunProof(env, marker, transcript);
  if (run) return response({ decision: "accepted", handoff_id: marker.handoff_id, run_id: run.run_id, transcript_ref: transcript.transcript_ref, transcript_hash: transcript.transcript_hash });
  return response({ decision: "v3_pending_start", handoff_id: marker.handoff_id, transcript_ref: transcript.transcript_ref, transcript_hash: transcript.transcript_hash });
}

async function startWithInvoker(
  env: MiningV3HandoffEnv,
  sourceKeyValue: string,
  handoffId: string,
  transcriptText: string | undefined,
  invoke: StartInvoker,
): Promise<Response> {
  const marker = await markerForHandoff(env, sourceKeyValue, handoffId);
  await markerStillMatchesSource(env, marker);
  if (!isV3Enabled(env, marker)) return response({ decision: "v3_hold", handoff_id: marker.handoff_id, reason: "v3_disabled_after_marker" }, 202);
  let transcript = await existingTranscript(env, marker);
  if (!transcript) {
    if (marker.source_type === "text" && transcriptText === undefined) {
      const recording = await recordingForSource(env, marker.source_key);
      const source = await sourceObject(env, recording);
      transcriptText = parseTextSource(source.bytes).text;
    }
    if (transcriptText === undefined) throw new MiningV3HandoffError("mining_handoff_transcript_required", 409, "canonical transcript is required");
    transcript = await persistTranscript(env, marker, transcriptText);
  } else if (transcriptText !== undefined && await sha256(new TextEncoder().encode(normalizeTranscript(transcriptText))) !== transcript.transcript_hash) {
    throw new MiningV3HandoffError("mining_handoff_transcript_conflict", 409, "canonical transcript conflicts with persisted transcript");
  }
  const result = await invoke(marker, transcript);
  const body = await result.clone().json().catch(() => null);
  if (!result.ok) {
    const errorBody = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return response({ error: typeof errorBody.error === "string" ? errorBody.error : "mining_handoff_start_failed", handoff_id: marker.handoff_id }, result.status);
  }
  if (result.status !== 200 && result.status !== 202) {
    throw new MiningV3HandoffError("mining_handoff_start_response_invalid", 502, "V3 start response status is invalid");
  }
  const expectedRunId = await runId(marker, transcript);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MiningV3HandoffError("mining_handoff_start_response_invalid", 502, "V3 start response is invalid");
  }
  const responseBody = body as Record<string, unknown>;
  const publicRun = responseBody.run;
  if (!publicRun || typeof publicRun !== "object" || Array.isArray(publicRun) ||
      !exactRunIdentity(publicRun as Record<string, unknown>, expectedRunId, marker)) {
    throw new MiningV3HandoffError("mining_handoff_start_response_invalid", 502, "V3 start response identity is invalid");
  }
  if (result.status === 202 && responseBody.workflow_status === "unknown") {
    const hold = publicRun as Record<string, unknown>;
    if (hold.state !== "needs_action" || hold.start_ledger_status !== "needs_action" ||
        hold.start_status !== "workflow_create_unknown" || hold.start_error_code !== "external_side_effect_unknown" ||
        hold.start_next_action !== "reconcile_external_side_effect") {
        throw new MiningV3HandoffError("mining_handoff_start_response_invalid", 502, "V3 workflow hold response is invalid");
    }
  } else if (result.status === 202 && (publicRun as Record<string, unknown>).state !== "queued") {
    throw new MiningV3HandoffError("mining_handoff_start_response_invalid", 502, "V3 queued start response is invalid");
  }
  const proven = await acceptedRunProof(env, marker, transcript);
  if (!proven || proven.run_id !== expectedRunId) {
    throw new MiningV3HandoffError("mining_handoff_start_reconciliation_required", 503, "V3 start is not durably proven");
  }
  return response({ decision: "accepted", handoff_id: marker.handoff_id, run_id: proven.run_id, transcript_ref: transcript.transcript_ref, transcript_hash: transcript.transcript_hash, replayed: result.status === 200 }, result.status === 202 ? 202 : 200);
}

async function start(env: MiningV3HandoffEnv, sourceKeyValue: string, handoffId: string, transcriptText: string | undefined): Promise<Response> {
  return startWithInvoker(env, sourceKeyValue, handoffId, transcriptText, (marker, transcript) => startExistingV3Run(env, marker, transcript));
}

export async function handleMiningV3HandoffInternalRoute(request: Request, env: MiningV3HandoffEnv, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (request.method !== "POST" || parts.length !== 5) return response({ error: "not_found" }, 404);
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new MiningV3HandoffError("invalid_json", 400, "request body must be valid JSON"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MiningV3HandoffError("mining_handoff_payload_invalid", 400, "request body is invalid");
    const body = raw as Record<string, unknown>;
    const action = parts[4];
    if (action === "eligibility") return await eligibility(env, sourceKey(body.source_key));
    if (action === "status") {
      const key = sourceKey(body.source_key);
      if (body.handoff_id !== undefined) return await statusByMarker(env, await markerForHandoff(env, key, text(body.handoff_id, "handoff_id", 160)));
      const recording = await recordingForSource(env, key);
      const markers = await markersForSource(env, recording);
      if (markers.length === 0) {
        if (await v3HistoryExists(env, recording)) return response({ decision: "v3_hold", reason: "v3_history_without_handoff_marker" }, 202);
        return response({ decision: "legacy" });
      }
      if (markers.length !== 1) return response({ decision: "v3_hold", reason: "handoff_id_required_for_multiple_marker_epochs" }, 202);
      return await statusByMarker(env, markers[0]);
    }
    if (action === "start") return await start(env, sourceKey(body.source_key), text(body.handoff_id, "handoff_id", 160), body.transcript_text === undefined ? undefined : text(body.transcript_text, "transcript_text"));
    return response({ error: "not_found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

// Focused runtime tests use these same private primitives to prove byte and
// metadata invariants without duplicating a second R2 implementation.
export const miningV3HandoffTesting = {
  makeMarker,
  normalizeTranscript,
  persistTranscript,
  existingTranscript,
  startBody,
  parseTextSource,
  acceptedRunProof,
  v3HistoryExists,
  startWithInvoker,
};
