import { listUnprocessedFiles, createPresignedDownloadUrl, deleteFile, downloadFile, getFileMetadata, uploadCoverImage, uploadTranscript, isSupportedTextSubmissionKey, userIdFromPipelineKey } from "./r2.js";
import { transcribeAudioUrl } from "./asr.js";
import { reviseArticle, rewriteArticle } from "./writingAgent.js";
import { generateWechatCoverBuffer } from "./coverRenderer.js";
import { articleImagesForTranscript, insertArticleImagesIntoHtml, type ArticleImageAsset } from "./articleImageActions.js";
import { prepareArticleImages, type PreparedArticleImage } from "./articleImages.js";
import { canonicalizeWechatDraftContent, getAccessToken, getDraftReadback, publishDraft, updateDraft, uploadWechatArticleImage, type WechatConfig } from "./wechat.js";
import { acceptMiningV3Handoff, decideMiningV3Route, miningV3HandoffEnabled, readMiningV3Status, type MiningV3Status } from "./v3Handoff.js";
import path from "path";
import { pathToFileURL } from "url";
import { createHash, randomUUID } from "node:crypto";

function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }

  const maybeAxios = error as {
    message?: string;
    code?: string;
    response?: {
      status?: number;
      headers?: Record<string, string | string[] | undefined>;
      data?: unknown;
    };
  };

  return {
    message: maybeAxios.message,
    code: maybeAxios.code,
    httpStatus: maybeAxios.response?.status,
    apiStatusCode: maybeAxios.response?.headers?.["x-api-status-code"],
    apiMessage: maybeAxios.response?.headers?.["x-api-message"],
    responseData: maybeAxios.response?.data,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isPermanentAudioFailure(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("invalid audio format") ||
    message.includes("audio convert failed") ||
    message.includes("no valid speech") ||
    message.includes("normal silence audio") ||
    message.includes("invalid argument")
  );
}

function shouldCleanupPermanentAudioFailures(): boolean {
  return ["true", "1", "yes"].includes(
    (process.env.CLEANUP_PERMANENT_AUDIO_FAILURES || "").toLowerCase(),
  );
}

type StatusMetadata = {
  rawText?: string;
  articleTitle?: string;
  articleContent?: string;
  coverImageUrl?: string;
  processingStage?: string;
  wechatUrl?: string;
  wechatDraftId?: string;
  errorMessage?: string | null;
  articleVersionId?: string;
  articleVersionNo?: number;
};

type ProfileSelection = {
  styleProfileId?: string;
  styleProfileVersion?: string;
  styleProfileName?: string;
  styleProfileDescription?: string;
  styleProfileBody?: string;
  layoutProfileId?: string;
  layoutProfileVersion?: string;
};

type ArticleResult = Awaited<ReturnType<typeof rewriteArticle>>;

type TranscriptMetadata = {
  processingStage: string;
  coverImageUrl?: string;
  wechatDraftId?: string;
  wechatUrl?: string;
  errorMessage?: string;
  profileSelection?: ProfileSelection;
  articleImages?: ArticleImageAsset[];
};

type RevisionRequest = {
  revisionId?: string;
  clientRequestId?: string;
  filename: string;
  userId?: string;
  workspaceId?: string;
  recordingId?: number;
  articleId?: string;
  parentVersionId?: string;
  feedbackId?: string;
  parentTitle?: string;
  parentContent?: string;
  transcriptKey?: string;
  audioKey: string;
  audioSha256?: string;
  createdAt?: string;
};

type VersionedRevisionRequest = RevisionRequest & Required<Pick<RevisionRequest,
  "revisionId" | "clientRequestId" | "userId" | "workspaceId" | "recordingId" |
  "articleId" | "parentVersionId" | "feedbackId" | "parentTitle" | "parentContent" |
  "transcriptKey" | "audioSha256" | "createdAt"
>>;

type ArticleVersionReference = {
  id: string;
  versionNo: number;
};

type PreparedRevisionImage = Omit<PreparedArticleImage, "buffer"> & {
  bufferBase64: string;
};

type PreparedRevision = {
  schemaVersion: 1;
  requestIdentity: Record<string, unknown>;
  instructionText: string;
  article: ArticleResult;
  articleImages: PreparedRevisionImage[];
  coverImageUrl?: string;
  coverBase64: string;
  preparedAt: string;
};

class VersionedRevisionWechatError extends Error {
  constructor(readonly original: unknown) {
    super(getErrorMessage(original));
  }
}

export function filterTargetFiles(files: string[], targetFilename?: string, targetKey?: string): string[] {
  const exactKey = targetKey?.trim();
  if (exactKey) {
    return files.filter(fileKey => fileKey === exactKey);
  }
  const target = targetFilename?.trim();
  if (!target) {
    return files;
  }
  return files.filter(fileKey => path.basename(fileKey) === target);
}

async function updateStatus(filename: string, status: string, metadata: StatusMetadata & { userId?: string } = {}) {
  const url = `${process.env.PUBLIC_BASE_URL}/api/internal/status`;
  const token = process.env.MINING_SERVICE_TOKEN || process.env.FILES_TOKEN;
  if (!url || !token) {
    console.warn("PUBLIC_BASE_URL or MINING_SERVICE_TOKEN missing, skipping status update");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ filename, status, userId: metadata.userId, ...metadata })
    });
    if (!res.ok) console.error(`Status update failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("Failed to update status:", e);
  }
}

type MiningClaimAction = "claim" | "complete" | "release";

function miningInternalConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  const token = process.env.MINING_SERVICE_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new Error("PUBLIC_BASE_URL and MINING_SERVICE_TOKEN are required for mining input claims");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

async function updateMiningClaim(
  action: MiningClaimAction,
  userId: string,
  targetKey: string,
  claimId: string,
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = miningInternalConfig();
  const response = await fetch(`${baseUrl}/api/internal/mining-claims`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      action,
      user_id: userId,
      target_key: targetKey,
      claim_id: claimId,
    }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Mining claim ${action} failed HTTP ${response.status}`);
  }
  return body;
}

async function claimMiningInput(userId: string, targetKey: string): Promise<string | null> {
  const claimId = randomUUID();
  const response = await updateMiningClaim("claim", userId, targetKey, claimId);
  return response.claimed === true ? claimId : null;
}

async function completeMiningInput(userId: string, targetKey: string, claimId: string): Promise<void> {
  const response = await updateMiningClaim("complete", userId, targetKey, claimId);
  if (response.completed !== true) {
    throw new Error("Mining input claim could not be completed");
  }
}

async function releaseMiningInput(userId: string, targetKey: string, claimId: string): Promise<void> {
  try {
    const response = await updateMiningClaim("release", userId, targetKey, claimId);
    if (response.released !== true) {
      console.warn(`Mining input claim was not released for ${targetKey}`);
    }
  } catch (error) {
    console.error(`Failed to release mining input claim for ${targetKey}:`, describeError(error));
  }
}

async function getWechatConfigForUser(userId: string): Promise<WechatConfig> {
  const token = process.env.MINING_SERVICE_TOKEN || process.env.FILES_TOKEN;
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  const canUseLegacyWechatConfig = userId === "default_user";
  if (token && baseUrl) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/internal/publishing-account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ userId }),
    });
    if (res.ok) {
      const body = await res.json() as any;
      const account = body.publishing_account;
      if (!account?.app_id || !account?.app_secret || !account?.proxy_url) {
        throw new Error("Publishing account response missing credentials");
      }
      return {
        appId: account.app_id,
        appSecret: account.app_secret,
        proxyUrl: account.proxy_url,
      };
    }
    if (res.status !== 404) {
      throw new Error(`Failed to load publishing account: HTTP ${res.status} ${await res.text()}`);
    }
  }

  if (canUseLegacyWechatConfig && process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET && process.env.WECHAT_PROXY) {
    return {
      appId: process.env.WECHAT_APP_ID,
      appSecret: process.env.WECHAT_APP_SECRET,
      proxyUrl: process.env.WECHAT_PROXY,
    };
  }

  throw new Error("公众号未绑定，文章已生成但无法创建公众号草稿");
}

function userIdForPipelineKey(fileKey: string): string {
  return userIdFromPipelineKey(fileKey) || process.env.WRITING_AGENT_USER_ID?.trim() || "default_user";
}

function workspaceIdForUser(userId: string): string {
  return process.env.WRITING_AGENT_WORKSPACE_ID?.trim() ||
    (userId === "default_user" ? "vibepub-dogfood" : `ws_${userId.replace(/^usr_/, "")}`);
}

function transcriptJsonKey(fileKey: string): string {
  return siblingArtifactKey(fileKey, "transcripts", ".json");
}

function coverImageKey(fileKey: string): string {
  return siblingArtifactKey(fileKey, "covers", ".png");
}

function siblingArtifactKey(fileKey: string, kind: string, extension: string): string {
  const filename = path.basename(fileKey).replace(/\.[^/.]+$/, extension);
  const userId = userIdFromPipelineKey(fileKey);
  return userId ? `users/${userId}/${kind}/${filename}` : `${kind}/${filename}`;
}

function publicFileUrl(key: string): string | undefined {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/api/files/${encodeURIComponent(key)}`;
}

export function buildArticleTranscriptPayload(
  rawText: string,
  article: ArticleResult,
  metadata: TranscriptMetadata,
): Record<string, unknown> {
  return {
    rawText,
    articleTitle: article.title,
    articleContent: article.content,
    coverImageUrl: metadata.coverImageUrl,
    articleImages: metadata.articleImages ?? article.articleImages,
    processingStage: metadata.processingStage,
    wechatDraftId: metadata.wechatDraftId,
    wechatUrl: metadata.wechatUrl,
    errorMessage: metadata.errorMessage,
    styleProfileId: metadata.profileSelection?.styleProfileId,
    styleProfileVersion: metadata.profileSelection?.styleProfileVersion,
    styleProfileName: metadata.profileSelection?.styleProfileName,
    styleProfileDescription: metadata.profileSelection?.styleProfileDescription,
    styleProfileBody: metadata.profileSelection?.styleProfileBody,
    layoutProfileId: metadata.profileSelection?.layoutProfileId,
    layoutProfileVersion: metadata.profileSelection?.layoutProfileVersion,
  };
}

async function saveArticleTranscript(
  fileKey: string,
  rawText: string,
  article: ArticleResult,
  metadata: TranscriptMetadata,
): Promise<void> {
  const jsonKey = transcriptJsonKey(fileKey);
  console.log(`Saving transcript JSON to ${jsonKey}...`);
  await uploadTranscript(jsonKey, JSON.stringify(buildArticleTranscriptPayload(rawText, article, metadata)));
}

async function saveCoverImage(fileKey: string, coverBuffer: Buffer): Promise<string | undefined> {
  const key = coverImageKey(fileKey);
  console.log(`Saving WeChat cover image to ${key}...`);
  await uploadCoverImage(key, coverBuffer);
  return publicFileUrl(key);
}

async function attachArticleImages(
  fileKey: string,
  article: ArticleResult,
  wxToken?: string,
  wechatConfig?: WechatConfig,
): Promise<{ article: ArticleResult; articleImages: ArticleImageAsset[] }> {
  const actions = article.imageActions || [];
  if (actions.length === 0) {
    return { article, articleImages: article.articleImages || [] };
  }

  console.log(`Generating ${actions.length} article image(s)...`);
  const prepared = await prepareArticleImages(fileKey, actions);
  const withWechatUrls = wxToken
    ? await uploadPreparedImagesToWechat(wxToken, prepared, wechatConfig)
    : prepared;
  const articleImages = articleImagesForTranscript(withWechatUrls);
  return {
    article: {
      ...article,
      content: insertArticleImagesIntoHtml(article.content, articleImages),
      articleImages,
    },
    articleImages,
  };
}

async function uploadPreparedImagesToWechat(
  wxToken: string,
  images: PreparedArticleImage[],
  wechatConfig?: WechatConfig,
): Promise<PreparedArticleImage[]> {
  const withWechatUrls: PreparedArticleImage[] = [];
  for (const image of images) {
    console.log(`Uploading article image ${image.imageId} to WeChat...`);
    const wechatUrl = await uploadWechatArticleImage(wxToken, image.buffer, wechatConfig);
    withWechatUrls.push({ ...image, wechatUrl });
  }
  return withWechatUrls;
}

function buildDraftFailureMessage(error: unknown): string {
  const message = getErrorMessage(error).slice(0, 450);
  return `公众号草稿创建失败：${message}`;
}

async function completeWithArticleOnly(
  fileKey: string,
  filename: string,
  userId: string,
  rawText: string,
  article: ArticleResult,
  error: unknown,
  transcriptAlreadySaved: boolean,
  profileSelection: ProfileSelection = {},
): Promise<boolean> {
  const errorMessage = buildDraftFailureMessage(error);
  let transcriptSaved = transcriptAlreadySaved;

  try {
    await saveArticleTranscript(fileKey, rawText, article, {
      processingStage: "DRAFT_FAILED",
      coverImageUrl: article.coverImageUrl,
      errorMessage,
      profileSelection,
    });
    transcriptSaved = true;
  } catch (transcriptError) {
    console.error("Failed to save article transcript after draft failure:", describeError(transcriptError));
  }

  if (!transcriptSaved) {
    return false;
  }

  await updateStatus(filename, "COMPLETED", {
    userId,
    rawText,
    articleTitle: article.title,
    articleContent: article.content,
    coverImageUrl: article.coverImageUrl,
    processingStage: "DRAFT_FAILED",
    errorMessage,
  });

  console.warn(`Article is ready but WeChat draft failed for ${fileKey}: ${errorMessage}`);
  console.log("Cleaning up processed file from R2 after saving article result...");
  try {
    await deleteFile(fileKey);
  } catch (deleteError) {
    console.warn("Article result was saved, but failed to delete the original inbox file:", describeError(deleteError));
  }
  return true;
}

function parseJsonBuffer(key: string, buffer: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${getErrorMessage(error)}`);
  }
  throw new Error(`Invalid JSON in ${key}: expected object`);
}

function requiredStringField(record: Record<string, unknown>, ...fields: string[]): string {
  const value = optionalStringField(record, ...fields);
  if (!value) {
    throw new Error(`Revision request is missing ${fields.join("/")}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalNumberField(record: Record<string, unknown>, ...fields: string[]): number | undefined {
  for (const field of fields) {
    const value = Number(record[field]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function textSubmissionFromBuffer(
  key: string,
  buffer: Buffer,
): { rawText: string; titleHint?: string; profileSelection: ProfileSelection } {
  const body = buffer.toString("utf8").trim();
  if (!body) {
    throw new Error(`Text submission ${key} is empty`);
  }

  if (body.startsWith("{")) {
    const record = parseJsonBuffer(key, buffer);
    const rawText = requiredStringField(record, "text", "rawText", "raw_text");
    return {
      rawText,
      titleHint: optionalStringField(record, "titleHint", "title_hint"),
      profileSelection: profileSelectionFromRecord(record),
    };
  }

  return { rawText: body, profileSelection: {} };
}

function rawTextForArticleInput(textInput: { rawText: string; titleHint?: string }): string {
  const titleHint = textInput.titleHint?.trim();
  if (!titleHint) return textInput.rawText;
  return `标题提示：${titleHint}\n\n${textInput.rawText}`;
}

function profileSelectionFromRecord(record: Record<string, unknown>): ProfileSelection {
  return {
    styleProfileId: optionalStringField(record, "styleProfileId", "style_profile_id"),
    styleProfileVersion: optionalStringField(record, "styleProfileVersion", "style_profile_version"),
    styleProfileName: optionalStringField(record, "styleProfileName", "style_profile_name"),
    styleProfileDescription: optionalStringField(record, "styleProfileDescription", "style_profile_description"),
    styleProfileBody: optionalStringField(record, "styleProfileBody", "style_profile_body"),
    layoutProfileId: optionalStringField(record, "layoutProfileId", "layout_profile_id"),
    layoutProfileVersion: optionalStringField(record, "layoutProfileVersion", "layout_profile_version"),
  };
}

function profileSelectionFromMetadata(metadata: Record<string, string>): ProfileSelection {
  return {
    styleProfileId: metadata.styleprofileid || metadata.style_profile_id,
    styleProfileVersion: metadata.styleprofileversion || metadata.style_profile_version,
    styleProfileName: metadata.styleprofilename || metadata.style_profile_name,
    styleProfileDescription: metadata.styleprofiledescription || metadata.style_profile_description,
    layoutProfileId: metadata.layoutprofileid || metadata.layout_profile_id,
    layoutProfileVersion: metadata.layoutprofileversion || metadata.layout_profile_version,
  };
}

async function profileSelectionForAudioFile(fileKey: string): Promise<ProfileSelection> {
  const metadataSelection = profileSelectionFromMetadata(await getFileMetadata(fileKey));
  const sidecarKey = profileSelectionSidecarKey(fileKey);
  try {
    const sidecar = parseJsonBuffer(sidecarKey, await downloadFile(sidecarKey));
    return {
      ...metadataSelection,
      ...profileSelectionFromRecord(sidecar),
    };
  } catch {
    return metadataSelection;
  }
}

function profileSelectionSidecarKey(fileKey: string): string {
  const filename = path.basename(fileKey);
  const userId = userIdFromPipelineKey(fileKey);
  const sidecarName = `${filename.replace(/[^\w.\-]/g, "_")}.json`;
  return userId ? `users/${userId}/profile-selections/${sidecarName}` : `profile-selections/${sidecarName}`;
}

function revisionFailureMessage(error: unknown): string {
  return `说话修改失败：${getErrorMessage(error).slice(0, 450)}`;
}

function preparedRevisionKey(revisionRequestKey: string): string {
  return revisionRequestKey.endsWith(".json")
    ? `${revisionRequestKey.slice(0, -5)}.prepared.json`
    : `${revisionRequestKey}.prepared.json`;
}

function requireVersionedRevisionRequest(request: RevisionRequest): VersionedRevisionRequest {
  const record = request as unknown as Record<string, unknown>;
  const recordingId = optionalNumberField(record, "recordingId");
  if (!recordingId) throw new Error("Revision request is missing recordingId");
  return {
    ...request,
    revisionId: requiredStringField(record, "revisionId"),
    clientRequestId: requiredStringField(record, "clientRequestId"),
    userId: requiredStringField(record, "userId"),
    workspaceId: requiredStringField(record, "workspaceId"),
    recordingId,
    articleId: requiredStringField(record, "articleId"),
    parentVersionId: requiredStringField(record, "parentVersionId"),
    feedbackId: requiredStringField(record, "feedbackId"),
    parentTitle: requiredStringField(record, "parentTitle"),
    parentContent: requiredStringField(record, "parentContent"),
    transcriptKey: requiredStringField(record, "transcriptKey"),
    audioSha256: requiredStringField(record, "audioSha256"),
    createdAt: requiredStringField(record, "createdAt"),
  };
}

function versionedRevisionIdentity(request: VersionedRevisionRequest): Record<string, unknown> {
  return {
    revisionId: request.revisionId,
    clientRequestId: request.clientRequestId,
    filename: request.filename,
    userId: request.userId,
    workspaceId: request.workspaceId,
    recordingId: request.recordingId,
    articleId: request.articleId,
    parentVersionId: request.parentVersionId,
    feedbackId: request.feedbackId,
    parentTitle: request.parentTitle,
    parentContent: request.parentContent,
    transcriptKey: request.transcriptKey,
    audioKey: request.audioKey,
    audioSha256: request.audioSha256,
    createdAt: request.createdAt,
  };
}

function articleRevisionApiConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.MINING_V3_HANDOFF_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("PUBLIC_BASE_URL and MINING_V3_HANDOFF_TOKEN are required for versioned revisions");
  return { baseUrl, token };
}

async function postArticleRevision(
  revisionId: string,
  action: "version" | "status",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = articleRevisionApiConfig();
  const response = await fetch(`${baseUrl}/api/internal/v3/article-revisions/${encodeURIComponent(revisionId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = optionalStringField(payload, "error") || `http_${response.status}`;
    throw new Error(`Article revision ${action} failed: ${response.status} ${code}`);
  }
  return payload;
}

function articleVersionReference(payload: Record<string, unknown>): ArticleVersionReference {
  const version = payload.version;
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    throw new Error("Article revision version response is missing version");
  }
  const record = version as Record<string, unknown>;
  const id = requiredStringField(record, "id");
  const versionNo = optionalNumberField(record, "version_no", "versionNo");
  if (!versionNo) throw new Error("Article revision version response is missing version_no");
  return { id, versionNo };
}

function serializePreparedImages(images: PreparedArticleImage[]): PreparedRevisionImage[] {
  return images.map(({ buffer, ...image }) => ({ ...image, bufferBase64: buffer.toString("base64") }));
}

function isMissingPreparedRevision(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404 ||
    getErrorMessage(error).includes("NoSuchKey");
}

async function loadPreparedRevision(
  key: string,
  request: VersionedRevisionRequest,
): Promise<{ prepared: PreparedRevision; images: PreparedArticleImage[]; cover: Buffer } | null> {
  let record: Record<string, unknown>;
  try {
    record = parseJsonBuffer(key, await downloadFile(key));
  } catch (error) {
    if (isMissingPreparedRevision(error)) return null;
    throw error;
  }
  if (record.schemaVersion !== 1 ||
      JSON.stringify(record.requestIdentity) !== JSON.stringify(versionedRevisionIdentity(request))) {
    throw new Error("Prepared revision identity does not match its request");
  }
  const articleRecord = record.article;
  if (!articleRecord || typeof articleRecord !== "object" || Array.isArray(articleRecord)) {
    throw new Error("Prepared revision is missing article");
  }
  const article = articleRecord as Record<string, unknown>;
  requiredStringField(article, "title");
  requiredStringField(article, "content");
  const coverBase64 = requiredStringField(record, "coverBase64");
  const serializedImages = Array.isArray(record.articleImages) ? record.articleImages : [];
  const images = serializedImages.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Prepared revision image is invalid");
    }
    const image = value as Record<string, unknown>;
    const bufferBase64 = requiredStringField(image, "bufferBase64");
    const { bufferBase64: _bufferBase64, ...metadata } = image;
    return { ...metadata, buffer: Buffer.from(bufferBase64, "base64") } as PreparedArticleImage;
  });
  return {
    prepared: record as unknown as PreparedRevision,
    images,
    cover: Buffer.from(coverBase64, "base64"),
  };
}

async function processVersionedRevisionRequest(
  revisionRequestKey: string,
  revisionRequest: VersionedRevisionRequest,
): Promise<void> {
  const { revisionId, parentVersionId, parentTitle, parentContent, userId, transcriptKey } = revisionRequest;
  const filename = path.basename(revisionRequest.filename);
  const fileKey = userIdFromPipelineKey(revisionRequestKey) ? `users/${userId}/inbox/${filename}` : `inbox/${filename}`;
  const transcript = parseJsonBuffer(transcriptKey, await downloadFile(transcriptKey));
  const rawText = optionalStringField(transcript, "rawText", "raw_text") || "";
  const currentDraftId = optionalStringField(transcript, "wechatDraftId", "mediaId", "wechat_draft_id");
  const currentWechatUrl = optionalStringField(transcript, "wechatUrl", "wechat_url");
  const profileSelection = profileSelectionFromRecord(transcript);
  const preparedKey = preparedRevisionKey(revisionRequestKey);
  const restored = await loadPreparedRevision(preparedKey, revisionRequest);
  let article: ArticleResult;
  let instructionText: string;
  let preparedImages: PreparedArticleImage[];
  let coverBuffer: Buffer;
  let coverImageUrl: string | undefined;
  if (restored) {
    article = restored.prepared.article;
    instructionText = restored.prepared.instructionText;
    preparedImages = restored.images;
    coverBuffer = restored.cover;
    coverImageUrl = restored.prepared.coverImageUrl;
  } else {
    await updateStatus(filename, "PROCESSING", { userId, processingStage: "ASR" });
    const audioUrl = await createPresignedDownloadUrl(revisionRequest.audioKey);
    instructionText = (await transcribeAudioUrl(audioUrl, path.extname(revisionRequest.audioKey).slice(1) || "m4a")).trim();
    if (!instructionText) throw new Error("修改语音没有识别到有效文字");

    await updateStatus(filename, "PROCESSING", { userId, processingStage: "REWRITING" });
    article = await reviseArticle({
      rawText,
      currentTitle: parentTitle,
      currentContent: parentContent,
      instructionText,
      userId,
      workspaceId: revisionRequest.workspaceId,
      clientJobId: `${filename}:${revisionRequest.clientRequestId}`,
      ...profileSelection,
    });
    preparedImages = article.imageActions?.length
      ? await prepareArticleImages(fileKey, article.imageActions)
      : [];
    const articleImages = articleImagesForTranscript(preparedImages);
    if (articleImages.length) {
      article = {
        ...article,
        content: insertArticleImagesIntoHtml(article.content, articleImages),
        articleImages,
      };
    }
    coverBuffer = await generateWechatCoverBuffer({
      title: article.title,
      titleLines: article.coverTitle,
      subtitle: article.coverSubtitle,
      imagePrompt: article.imagePrompt,
    });
    coverImageUrl = await saveCoverImage(fileKey, coverBuffer);
    const prepared: PreparedRevision = {
      schemaVersion: 1,
      requestIdentity: versionedRevisionIdentity(revisionRequest),
      instructionText,
      article,
      articleImages: serializePreparedImages(preparedImages),
      coverImageUrl,
      coverBase64: coverBuffer.toString("base64"),
      preparedAt: revisionRequest.createdAt,
    };
    await uploadTranscript(preparedKey, JSON.stringify(prepared, null, 2));
  }

  const version = articleVersionReference(await postArticleRevision(revisionId, "version", {
    title: article.title,
    body: article.content,
    cover: {
      image_prompt: article.imagePrompt,
      title_lines: article.coverTitle,
      subtitle: article.coverSubtitle,
      image_url: coverImageUrl,
    },
    prepared_artifact_key: preparedKey,
  }));
  const priorDraftError = restored && optionalStringField(transcript, "processingStage") === "DRAFT_FAILED"
    ? optionalStringField(transcript, "errorMessage", "error_message")
    : undefined;
  if (priorDraftError) {
    try {
      await postArticleRevision(revisionId, "status", { status: "wechat_failed", error_message: priorDraftError });
    } catch (error) {
      throw new VersionedRevisionWechatError(error);
    }
  }
  const previousHistory = Array.isArray(transcript.revisionHistory)
    ? transcript.revisionHistory.filter((entry) => !entry || typeof entry !== "object" || (entry as Record<string, unknown>).revisionId !== revisionId)
    : [];
  const revisionHistoryEntry = {
    revisionId,
    clientRequestId: revisionRequest.clientRequestId,
    revisionRequestKey,
    audioKey: revisionRequest.audioKey,
    createdAt: revisionRequest.createdAt,
    instructionText,
    previousArticleTitle: parentTitle,
    articleTitle: article.title,
    articleVersionId: version.id,
    articleVersionNo: version.versionNo,
    updatedWechatDraft: Boolean(currentDraftId),
  };
  const transcriptBase = {
    ...transcript,
    rawText,
    articleTitle: article.title,
    articleContent: article.content,
    coverImageUrl,
    articleImages: article.articleImages,
    articleVersionId: version.id,
    articleVersionNo: version.versionNo,
    wechatDraftId: currentDraftId,
    wechatUrl: currentWechatUrl,
    styleProfileId: profileSelection.styleProfileId,
    styleProfileVersion: profileSelection.styleProfileVersion,
    layoutProfileId: profileSelection.layoutProfileId,
    layoutProfileVersion: profileSelection.layoutProfileVersion,
    revisionHistory: [...previousHistory, revisionHistoryEntry],
  };
  await uploadTranscript(transcriptKey, JSON.stringify({ ...transcriptBase, processingStage: "ARTICLE_READY" }, null, 2));
  await updateStatus(filename, "PROCESSING", {
    userId, processingStage: "ARTICLE_READY", rawText, articleTitle: article.title,
    articleContent: article.content, coverImageUrl, articleVersionId: version.id, articleVersionNo: version.versionNo,
  });
  await postArticleRevision(revisionId, "status", { status: "wechat_pending" });
  await updateStatus(filename, "PROCESSING", {
    userId, processingStage: "DRAFTING", rawText, articleTitle: article.title,
    articleContent: article.content, coverImageUrl, articleVersionId: version.id, articleVersionNo: version.versionNo,
  });

  let wechatDraftReadback: Record<string, unknown> | undefined;
  try {
    let wechatArticle = article;
    if (currentDraftId) {
      const wechatConfig = await getWechatConfigForUser(userId);
      const wxToken = await getAccessToken(wechatConfig);
      if (preparedImages.length) {
        const uploaded = await uploadPreparedImagesToWechat(wxToken, preparedImages, wechatConfig);
        const wechatImages = articleImagesForTranscript(uploaded);
        let wechatContent = article.content;
        for (let index = 0; index < preparedImages.length; index += 1) {
          const publicUrl = preparedImages[index]?.publicUrl;
          const wechatUrl = uploaded[index]?.wechatUrl;
          if (publicUrl && wechatUrl) wechatContent = wechatContent.split(publicUrl).join(wechatUrl);
        }
        wechatArticle = { ...article, content: wechatContent, articleImages: wechatImages };
      }
      await updateDraft(wxToken, currentDraftId, wechatArticle.title, wechatArticle.content, coverBuffer, wechatConfig);
      const readback = await getDraftReadback(wxToken, currentDraftId, wechatConfig);
      const expectedTitle = wechatArticle.title.trim();
      const actualTitle = readback.title.trim();
      const expectedContent = canonicalizeWechatDraftContent(wechatArticle.content);
      const actualContent = canonicalizeWechatDraftContent(readback.content);
      if (actualTitle !== expectedTitle || actualContent !== expectedContent) {
        throw new Error("WeChat draft readback does not match revised article");
      }
      const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
      wechatDraftReadback = {
        verified: true,
        mediaIdHash: digest(readback.mediaId),
        expectedTitleHash: digest(expectedTitle),
        titleHash: digest(actualTitle),
        expectedContentHash: digest(expectedContent),
        contentHash: digest(actualContent),
        verifiedAt: new Date().toISOString(),
      };
    }
  } catch (error) {
    const errorMessage = buildDraftFailureMessage(error);
    await uploadTranscript(transcriptKey, JSON.stringify({
      ...transcriptBase,
      processingStage: "DRAFT_FAILED",
      errorMessage,
    }, null, 2));
    await updateStatus(filename, "COMPLETED", {
      userId, processingStage: "DRAFT_FAILED", rawText, articleTitle: article.title,
      articleContent: article.content, coverImageUrl, wechatDraftId: currentDraftId,
      wechatUrl: currentWechatUrl, errorMessage, articleVersionId: version.id, articleVersionNo: version.versionNo,
    });
    try {
      await postArticleRevision(revisionId, "status", { status: "wechat_failed", error_message: errorMessage });
    } catch (statusError) {
      throw new VersionedRevisionWechatError(statusError);
    }
    throw new VersionedRevisionWechatError(error);
  }
  const completedTranscript = {
    ...transcriptBase,
    revisionHistory: [...previousHistory, { ...revisionHistoryEntry, wechatDraftReadback }],
    processingStage: "COMPLETED",
    errorMessage: undefined,
  };
  await uploadTranscript(transcriptKey, JSON.stringify(completedTranscript, null, 2));
  await updateStatus(filename, "COMPLETED", {
    userId, processingStage: "COMPLETED", rawText, articleTitle: article.title, articleContent: article.content,
    coverImageUrl, wechatDraftId: currentDraftId, wechatUrl: currentWechatUrl, errorMessage: null,
    articleVersionId: version.id, articleVersionNo: version.versionNo,
  });
  try {
    await postArticleRevision(revisionId, "status", { status: "completed" });
  } catch (error) {
    // The transcript already says COMPLETED. Keep it visible while the exact
    // workflow replay repairs the Worker-side status.
    throw new VersionedRevisionWechatError(error);
  }
}

export function assertStagingCanaryRevisionIdentity(revisionRequest: RevisionRequest, environment: NodeJS.ProcessEnv = process.env): void {
  const expected = [
    environment.STAGING_CANARY_EXPECTED_RECORDING_ID,
    environment.STAGING_CANARY_EXPECTED_ARTICLE_ID,
    environment.STAGING_CANARY_EXPECTED_PARENT_VERSION_ID,
    environment.STAGING_CANARY_EXPECTED_WORKSPACE_ID,
  ].map(value => value?.trim() || "");
  if (!expected.some(Boolean)) return;
  let base: URL;
  try { base = new URL(environment.PUBLIC_BASE_URL || ""); } catch { throw new Error("staging_canary_revision_identity_invalid"); }
  const [recordingId, articleId, parentVersionId, workspaceId] = expected;
  if (base.protocol !== "https:" || !base.hostname.endsWith(".workers.dev") || expected.some(value => !value) ||
      String(revisionRequest.recordingId) !== recordingId || revisionRequest.articleId !== articleId ||
      revisionRequest.parentVersionId !== parentVersionId || revisionRequest.workspaceId !== workspaceId) {
    throw new Error("staging_canary_revision_identity_invalid");
  }
}

async function processRevisionRequest(revisionRequestKey: string): Promise<void> {
  console.log(`Processing article revision request: ${revisionRequestKey}`);

  const revisionRecord = parseJsonBuffer(
    revisionRequestKey,
    await downloadFile(revisionRequestKey),
  );
  const revisionRequest: RevisionRequest = {
    revisionId: optionalStringField(revisionRecord, "revisionId", "revision_id"),
    clientRequestId: optionalStringField(revisionRecord, "clientRequestId", "client_request_id"),
    filename: requiredStringField(revisionRecord, "filename"),
    userId: optionalStringField(revisionRecord, "userId", "user_id"),
    workspaceId: optionalStringField(revisionRecord, "workspaceId", "workspace_id"),
    recordingId: optionalNumberField(revisionRecord, "recordingId", "recording_id"),
    articleId: optionalStringField(revisionRecord, "articleId", "article_id"),
    parentVersionId: optionalStringField(revisionRecord, "parentVersionId", "parent_version_id"),
    feedbackId: optionalStringField(revisionRecord, "feedbackId", "feedback_id"),
    parentTitle: optionalStringField(revisionRecord, "parentTitle", "parent_title"),
    parentContent: optionalStringField(revisionRecord, "parentContent", "parent_content"),
    transcriptKey: optionalStringField(revisionRecord, "transcriptKey", "transcript_key"),
    audioKey: requiredStringField(revisionRecord, "audioKey", "audio_key"),
    audioSha256: optionalStringField(revisionRecord, "audioSha256", "audio_sha256"),
    createdAt: optionalStringField(revisionRecord, "createdAt", "created_at"),
  };
  const filename = path.basename(revisionRequest.filename);
  const userId = revisionRequest.userId || userIdForPipelineKey(revisionRequestKey);
  const transcriptKey = revisionRequest.transcriptKey || `users/${userId}/transcripts/${filename.replace(/\.[^/.]+$/, ".json")}`;
  const fileKey = userIdFromPipelineKey(revisionRequestKey) ? `users/${userId}/inbox/${filename}` : `inbox/${filename}`;
  assertStagingCanaryRevisionIdentity(revisionRequest);

  try {
    if (revisionRequest.parentVersionId) {
      await processVersionedRevisionRequest(revisionRequestKey, requireVersionedRevisionRequest(revisionRequest));
      return;
    }
    if (miningV3HandoffEnabled()) {
      // A V3 marker is authoritative even when a later Worker tenant rollout
      // changes. This client gate is only an opt-in compatibility switch: once
      // enabled, a marked revision must never fall back into legacy mutation.
      const v3Status = await readMiningV3Status(fileKey);
      if (v3Status.decision !== "legacy") {
        throw new Error("v3_revision_reconciliation_required");
      }
    }
    await updateStatus(filename, "PROCESSING", { userId, processingStage: "ASR" });
    const transcript = parseJsonBuffer(transcriptKey, await downloadFile(transcriptKey));
    const rawText = optionalStringField(transcript, "rawText", "raw_text") || "";
    const currentTitle = optionalStringField(transcript, "articleTitle", "article_title", "title") || "";
    const currentContent = optionalStringField(transcript, "articleContent", "article_content", "content") || "";
    const currentDraftId = optionalStringField(transcript, "wechatDraftId", "mediaId", "wechat_draft_id");
    const currentWechatUrl = optionalStringField(transcript, "wechatUrl", "wechat_url");
    const profileSelection = profileSelectionFromRecord(transcript);

    if (!currentContent) {
      throw new Error("原文章正文尚未生成");
    }

    console.log("Creating temporary revision instruction audio URL from R2...");
    const audioUrl = await createPresignedDownloadUrl(revisionRequest.audioKey);
    const ext = path.extname(revisionRequest.audioKey).slice(1);
    console.log("Transcribing voice revision instruction via Volcengine ASR...");
    const instructionText = (await transcribeAudioUrl(audioUrl, ext || "m4a")).trim();
    if (!instructionText) {
      throw new Error("修改语音没有识别到有效文字");
    }

    await updateStatus(filename, "PROCESSING", { userId, processingStage: "REWRITING" });
    console.log(`Voice revision instruction: ${instructionText.slice(0, 80)}...`);
    let article = await reviseArticle({
      rawText,
      currentTitle,
      currentContent,
      instructionText,
      userId,
      workspaceId: workspaceIdForUser(userId),
      clientJobId: revisionRequest.revisionId
        ? `${filename}:${revisionRequest.revisionId}`
        : `${filename}:${revisionRequestKey}`,
      ...profileSelection,
    });

    await updateStatus(filename, "PROCESSING", {
      userId,
      processingStage: "ARTICLE_READY",
      rawText,
      articleTitle: article.title,
      articleContent: article.content,
    });

    await updateStatus(filename, "PROCESSING", {
      userId,
      processingStage: "DRAFTING",
      rawText,
      articleTitle: article.title,
      articleContent: article.content,
    });

    const wechatConfig = currentDraftId ? await getWechatConfigForUser(userId) : undefined;
    const wxToken = currentDraftId ? await getAccessToken(wechatConfig) : undefined;
    const imageResult = await attachArticleImages(fileKey, article, wxToken, wechatConfig);
    article = imageResult.article;

    console.log(`Generating revised WeChat cover from title: ${article.title}`);
    const coverBuffer = await generateWechatCoverBuffer({
      title: article.title,
      titleLines: article.coverTitle,
      subtitle: article.coverSubtitle,
      imagePrompt: article.imagePrompt,
    });
    const coverImageUrl = await saveCoverImage(fileKey, coverBuffer);

    if (currentDraftId) {
      console.log(`Updating existing WeChat draft: ${currentDraftId}`);
      await updateDraft(wxToken!, currentDraftId, article.title, article.content, coverBuffer, wechatConfig);
    } else {
      console.warn(`No WeChat draft ID found for ${filename}. Saving revised article without updating WeChat draft.`);
    }

    const previousHistory = Array.isArray(transcript.revisionHistory)
      ? transcript.revisionHistory
      : [];
    const updatedTranscript: Record<string, unknown> = {
      ...transcript,
      rawText,
      articleTitle: article.title,
      articleContent: article.content,
      coverImageUrl,
      articleImages: article.articleImages,
      processingStage: "COMPLETED",
      wechatDraftId: currentDraftId,
      wechatUrl: currentWechatUrl,
      errorMessage: undefined,
      styleProfileId: profileSelection.styleProfileId,
      styleProfileVersion: profileSelection.styleProfileVersion,
      layoutProfileId: profileSelection.layoutProfileId,
      layoutProfileVersion: profileSelection.layoutProfileVersion,
      revisionHistory: [
        ...previousHistory,
        {
          revisionId: revisionRequest.revisionId,
          revisionRequestKey,
          audioKey: revisionRequest.audioKey,
          createdAt: revisionRequest.createdAt || new Date().toISOString(),
          instructionText,
          previousArticleTitle: currentTitle,
          articleTitle: article.title,
          updatedWechatDraft: Boolean(currentDraftId),
        },
      ],
    };

    await uploadTranscript(transcriptKey, JSON.stringify(updatedTranscript, null, 2));
    await updateStatus(filename, "COMPLETED", {
      userId,
      rawText,
      articleTitle: article.title,
      articleContent: article.content,
      coverImageUrl,
      processingStage: "COMPLETED",
      wechatDraftId: currentDraftId,
      wechatUrl: currentWechatUrl,
      errorMessage: null,
    });

    console.log(`Finished article revision: ${filename}`);
  } catch (error) {
    console.error(`Failed to process article revision ${revisionRequestKey}:`, describeError(error));
    if (!(error instanceof VersionedRevisionWechatError)) {
      await updateStatus(filename, "COMPLETED", {
        userId,
        processingStage: "REVISION_FAILED",
        errorMessage: revisionFailureMessage(error),
      });
    }
    throw error;
  }
}

type V3ClaimOutcome = "legacy" | "accepted" | "held";

async function processV3HandoffClaim(
  fileKey: string,
  filename: string,
  userId: string,
  claimId: string,
): Promise<V3ClaimOutcome> {
  if (!miningV3HandoffEnabled()) return "legacy";
  let decision: MiningV3Status;
  try {
    decision = await decideMiningV3Route(fileKey);
  } catch (error) {
    console.error(`V3 eligibility failed closed for ${fileKey}:`, describeError(error));
    await releaseMiningInput(userId, fileKey, claimId);
    return "held";
  }
  if (decision.decision === "legacy") return "legacy";
  console.log("V3 handoff eligibility", {
    sourceKey: fileKey,
    decision: decision.decision,
    handoffId: decision.handoff_id,
    reason: decision.reason,
  });

  try {
    let status = decision;
    if (status.decision === "v3") status = await readMiningV3Status(fileKey);
    if (status.decision === "accepted") {
      await completeMiningInput(userId, fileKey, claimId);
      return "accepted";
    }
    if (status.decision === "v3_hold") {
      console.warn("V3 handoff status remains held", { sourceKey: fileKey, reason: status.reason });
      await releaseMiningInput(userId, fileKey, claimId);
      return "held";
    }

    let transcript: string | undefined;
    if (status.decision === "v3_pending_asr" && !isSupportedTextSubmissionKey(fileKey)) {
      await updateStatus(filename, "PROCESSING", { userId, processingStage: "ASR" });
      const audioUrl = await createPresignedDownloadUrl(fileKey);
      const ext = path.extname(fileKey).slice(1);
      transcript = await transcribeAudioUrl(audioUrl, ext || "m4a");
    }
    // Text is deliberately sent without a transcript. The authoritative Worker
    // reads and canonicalizes its owner-scoped text source itself.
    const accepted = await acceptMiningV3Handoff(
      fileKey,
      status,
      transcript,
      undefined,
      isSupportedTextSubmissionKey(fileKey),
    );
    console.log("V3 handoff start outcome", {
      sourceKey: fileKey,
      decision: accepted.decision,
      handoffId: accepted.handoff_id,
      runId: accepted.run_id,
      reason: accepted.reason,
    });
    if (accepted.decision === "accepted") {
      await completeMiningInput(userId, fileKey, claimId);
      return "accepted";
    }
  } catch (error) {
    console.error(`V3 handoff failed closed for ${fileKey}:`, describeError(error));
  }
  await releaseMiningInput(userId, fileKey, claimId);
  return "held";
}

export async function main() {
  console.log("Starting VibePub Mining Job...");
  let failedCount = 0;
  let permanentFailedCount = 0;
  const targetFilename = process.env.TARGET_FILENAME?.trim();
  const targetKey = process.env.TARGET_KEY?.trim();
  const revisionRequestKey = process.env.REVISION_REQUEST_KEY?.trim();

  if (revisionRequestKey) {
    await processRevisionRequest(revisionRequestKey);
    console.log("\nMining Job completed article revision successfully.");
    return;
  }

  // 1. Check for new audio files
  console.log("Fetching unprocessed files from R2...");
  const allFiles = await listUnprocessedFiles();
  const files = filterTargetFiles(allFiles, targetFilename, targetKey);
  
  if (files.length === 0) {
    if (targetKey || targetFilename) {
      console.log(`No R2 input found for TARGET_KEY=${targetKey || ""} TARGET_FILENAME=${targetFilename || ""}. Exiting.`);
    } else {
      console.log("No new audio files found. Exiting.");
    }
    return;
  }
  
  if (targetKey || targetFilename) {
    console.log(`Found target file to process: ${targetKey || targetFilename}`);
  } else {
    console.log(`Found ${files.length} file(s) to process.`);
  }

  // Process files one by one (could also be parallelized if needed)
  for (const fileKey of files) {
    let processingStage = "QUEUED";
    const filename = path.basename(fileKey);
    const userId = userIdForPipelineKey(fileKey);
    let rawText = "";
    let article: ArticleResult | undefined;
    let articleTranscriptSaved = false;
    let profileSelection: ProfileSelection = {};
    const claimId = await claimMiningInput(userId, fileKey);

    if (!claimId) {
      console.log(`Skipping already claimed or completed input: ${fileKey}`);
      continue;
    }
    let resultFinalized = false;

    try {
      console.log(`\n--- Processing file: ${fileKey} ---`);
      
      const v3Outcome = await processV3HandoffClaim(fileKey, filename, userId, claimId);
      if (v3Outcome === "accepted") {
        resultFinalized = true;
        continue;
      }
      if (v3Outcome === "held") {
        failedCount += 1;
        continue;
      }

      await updateStatus(filename, "PROCESSING", { userId, processingStage });

      if (isSupportedTextSubmissionKey(fileKey)) {
        console.log("Reading text submission from R2...");
        const textInput = textSubmissionFromBuffer(fileKey, await downloadFile(fileKey));
        rawText = rawTextForArticleInput(textInput);
        profileSelection = textInput.profileSelection;
        processingStage = "REWRITING";
        await updateStatus(filename, "PROCESSING", { userId, processingStage, rawText });
      } else {
        profileSelection = await profileSelectionForAudioFile(fileKey);
        // 3. Build a short-lived R2 URL for Volcengine ASR.
        console.log("Creating temporary audio URL from R2...");
        const audioUrl = await createPresignedDownloadUrl(fileKey);
        const ext = path.extname(fileKey).slice(1);

        // 4. ASR: Speech to text
        processingStage = "ASR";
        await updateStatus(filename, "PROCESSING", { userId, processingStage });
        console.log("Transcribing audio via Volcengine ASR...");
        try {
          rawText = await transcribeAudioUrl(audioUrl, ext || 'm4a');
        } catch (e: any) {
          console.error("ASR failed:", e.message);
          throw e;
        }
      }
      
      console.log(`Raw Transcript: ${rawText.substring(0, 50)}...`);
      
      if (!rawText || rawText.trim().length === 0) {
        console.log("Transcript was empty. Skipping.");
        await deleteFile(fileKey);
        await updateStatus(filename, "FAILED", { userId, processingStage, errorMessage: "转录结果为空" });
        resultFinalized = true;
        await completeMiningInput(userId, fileKey, claimId);
        continue;
      }

      // 5. LLM: Style Distillation
      processingStage = "REWRITING";
      await updateStatus(filename, "PROCESSING", { userId, processingStage, rawText });
      console.log("Running Style Distillation via GLM...");
      article = await rewriteArticle({
        rawText,
        clientJobId: filename,
        sourceType: isSupportedTextSubmissionKey(fileKey) ? "text_submission" : "audio_transcript",
        userId,
        workspaceId: workspaceIdForUser(userId),
        ...profileSelection,
      });
      console.log(`Generated Article Title: ${article.title}`);

      processingStage = "ARTICLE_READY";
      await updateStatus(filename, "PROCESSING", {
        userId,
        processingStage,
        rawText,
        articleTitle: article.title,
        articleContent: article.content,
      });
      await saveArticleTranscript(fileKey, rawText, article, {
        processingStage: "ARTICLE_READY",
        profileSelection,
      });
      articleTranscriptSaved = true;

      // 5.5 LLM: Image Generation
      processingStage = "DRAFTING";
      await updateStatus(filename, "PROCESSING", {
        userId,
        processingStage,
        rawText,
        articleTitle: article.title,
        articleContent: article.content,
      });
      console.log(`Generating WeChat cover from title: ${article.title}`);
      const coverBuffer = await generateWechatCoverBuffer({
        title: article.title,
        titleLines: article.coverTitle,
        subtitle: article.coverSubtitle,
        imagePrompt: article.imagePrompt,
      });
      const coverImageUrl = await saveCoverImage(fileKey, coverBuffer);
      article = { ...article, coverImageUrl };
      
      // 6. WeChat: Publish Draft
      console.log("Getting WeChat Access Token...");
      const wechatConfig = await getWechatConfigForUser(userId);
      const wxToken = await getAccessToken(wechatConfig);
      console.log("Publishing to WeChat Drafts...");
      const mediaId = await publishDraft(wxToken, article.title, article.content, coverBuffer, wechatConfig);
      console.log(`Successfully published draft! Media ID: ${mediaId}`);
      
      // 6.5 Save Transcript JSON to R2
      try {
        await saveArticleTranscript(fileKey, rawText, article, {
          processingStage: "COMPLETED",
          coverImageUrl,
          wechatDraftId: mediaId,
          profileSelection,
        });
        articleTranscriptSaved = true;
      } catch (transcriptError) {
        console.error("Draft was created, but failed to update transcript JSON:", describeError(transcriptError));
        if (!articleTranscriptSaved) {
          throw transcriptError;
        }
      }
      
      // 7. Cleanup: Delete processed file from R2
      console.log("Cleaning up processed file from R2...");
      try {
        await deleteFile(fileKey);
      } catch (deleteError) {
        console.warn("Draft was created, but failed to delete the original inbox file:", describeError(deleteError));
      }
      
      await updateStatus(filename, "COMPLETED", {
        userId,
        rawText,
        articleTitle: article.title,
        articleContent: article.content,
        coverImageUrl,
        processingStage: "COMPLETED",
        wechatDraftId: mediaId,
      });
      resultFinalized = true;
      await completeMiningInput(userId, fileKey, claimId);
      
      console.log(`Finished processing: ${fileKey}`);
    } catch (e) {
      console.error(`Failed to process ${fileKey}:`, describeError(e));

      if (
        article &&
        rawText.trim().length > 0 &&
        (processingStage === "ARTICLE_READY" || processingStage === "DRAFTING")
      ) {
        const recovered = await completeWithArticleOnly(
          fileKey,
          filename,
          userId,
          rawText,
          article,
          e,
          articleTranscriptSaved,
          profileSelection,
        );
        if (recovered) {
          resultFinalized = true;
          await completeMiningInput(userId, fileKey, claimId);
          continue;
        }
      }

      if (resultFinalized) {
        failedCount += 1;
        continue;
      }

      await updateStatus(filename, "FAILED", {
        userId,
        processingStage,
        errorMessage: getErrorMessage(e).slice(0, 500),
      });

      if (isPermanentAudioFailure(e) && shouldCleanupPermanentAudioFailures()) {
        console.warn(`Deleting permanently invalid audio file from R2 inbox: ${fileKey}`);
        await deleteFile(fileKey);
        resultFinalized = true;
        await completeMiningInput(userId, fileKey, claimId);
        permanentFailedCount += 1;
        continue;
      }

      // Keep retryable failures in the inbox so the next run can try again.
      await releaseMiningInput(userId, fileKey, claimId);
      failedCount += 1;
    }
  }
  
  if (failedCount > 0) {
    throw new Error(`Mining Job failed to process ${failedCount} file(s).`);
  }

  if (permanentFailedCount > 0) {
    console.log(`Skipped and cleaned up ${permanentFailedCount} permanently invalid audio file(s).`);
  }

  console.log("\nMining Job completed successfully.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error("Fatal error in mining job:", err);
    process.exit(1);
  });
}
