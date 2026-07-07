import { listUnprocessedFiles, createPresignedDownloadUrl, deleteFile, downloadFile, getFileMetadata, uploadCoverImage, uploadTranscript, isSupportedTextSubmissionKey, userIdFromPipelineKey } from "./r2.js";
import { transcribeAudioUrl } from "./asr.js";
import { reviseArticle, rewriteArticle } from "./writingAgent.js";
import { generateWechatCoverBuffer } from "./coverRenderer.js";
import { articleImagesForTranscript, insertArticleImagesIntoHtml, type ArticleImageAsset } from "./articleImageActions.js";
import { prepareArticleImages, type PreparedArticleImage } from "./articleImages.js";
import { getAccessToken, publishDraft, updateDraft, uploadWechatArticleImage, type WechatConfig } from "./wechat.js";
import path from "path";
import { pathToFileURL } from "url";

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
  filename: string;
  userId?: string;
  transcriptKey?: string;
  audioKey: string;
  createdAt?: string;
};

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

async function processRevisionRequest(revisionRequestKey: string): Promise<void> {
  console.log(`Processing article revision request: ${revisionRequestKey}`);

  const revisionRecord = parseJsonBuffer(
    revisionRequestKey,
    await downloadFile(revisionRequestKey),
  );
  const revisionRequest: RevisionRequest = {
    revisionId: optionalStringField(revisionRecord, "revisionId", "revision_id"),
    filename: requiredStringField(revisionRecord, "filename"),
    userId: optionalStringField(revisionRecord, "userId", "user_id"),
    transcriptKey: optionalStringField(revisionRecord, "transcriptKey", "transcript_key"),
    audioKey: requiredStringField(revisionRecord, "audioKey", "audio_key"),
    createdAt: optionalStringField(revisionRecord, "createdAt", "created_at"),
  };
  const filename = path.basename(revisionRequest.filename);
  const userId = revisionRequest.userId || userIdForPipelineKey(revisionRequestKey);
  const transcriptKey = revisionRequest.transcriptKey || `users/${userId}/transcripts/${filename.replace(/\.[^/.]+$/, ".json")}`;
  const fileKey = userIdFromPipelineKey(revisionRequestKey) ? `users/${userId}/inbox/${filename}` : `inbox/${filename}`;

  try {
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
    await updateStatus(filename, "COMPLETED", {
      userId,
      processingStage: "REVISION_FAILED",
      errorMessage: revisionFailureMessage(error),
    });
    throw error;
  }
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

    try {
      console.log(`\n--- Processing file: ${fileKey} ---`);
      
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
          continue;
        }
      }

      await updateStatus(filename, "FAILED", {
        userId,
        processingStage,
        errorMessage: getErrorMessage(e).slice(0, 500),
      });

      if (isPermanentAudioFailure(e) && shouldCleanupPermanentAudioFailures()) {
        console.warn(`Deleting permanently invalid audio file from R2 inbox: ${fileKey}`);
        await deleteFile(fileKey);
        permanentFailedCount += 1;
        continue;
      }

      // Keep retryable failures in the inbox so the next run can try again.
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
