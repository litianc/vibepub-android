import { listUnprocessedFiles, createPresignedDownloadUrl, deleteFile, uploadTranscript } from "./r2.js";
import { transcribeAudioUrl } from "./asr.js";
import { processAudioText, generateCoverImageBuffer } from "./llm.js";
import { getAccessToken, publishDraft } from "./wechat.js";
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
  processingStage?: string;
  wechatUrl?: string;
  wechatDraftId?: string;
  errorMessage?: string;
};

type ArticleResult = Awaited<ReturnType<typeof processAudioText>>;

type TranscriptMetadata = {
  processingStage: string;
  wechatDraftId?: string;
  wechatUrl?: string;
  errorMessage?: string;
};

export function filterTargetFiles(files: string[], targetFilename?: string): string[] {
  const target = targetFilename?.trim();
  if (!target) {
    return files;
  }
  return files.filter(fileKey => path.basename(fileKey) === target);
}

async function updateStatus(filename: string, status: string, metadata: StatusMetadata = {}) {
  const url = `${process.env.PUBLIC_BASE_URL}/api/internal/status`;
  const token = process.env.FILES_TOKEN;
  if (!url || !token) {
    console.warn("PUBLIC_BASE_URL or FILES_TOKEN missing, skipping status update");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ filename, status, ...metadata })
    });
    if (!res.ok) console.error(`Status update failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("Failed to update status:", e);
  }
}

function transcriptJsonKey(fileKey: string): string {
  return fileKey.replace("inbox/", "transcripts/").replace(/\.[^/.]+$/, ".json");
}

export function buildArticleTranscriptPayload(
  rawText: string,
  article: ArticleResult,
  metadata: TranscriptMetadata,
): Record<string, string | undefined> {
  return {
    rawText,
    articleTitle: article.title,
    articleContent: article.content,
    processingStage: metadata.processingStage,
    wechatDraftId: metadata.wechatDraftId,
    wechatUrl: metadata.wechatUrl,
    errorMessage: metadata.errorMessage,
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

function buildDraftFailureMessage(error: unknown): string {
  const message = getErrorMessage(error).slice(0, 450);
  return `公众号草稿创建失败：${message}`;
}

async function completeWithArticleOnly(
  fileKey: string,
  filename: string,
  rawText: string,
  article: ArticleResult,
  error: unknown,
  transcriptAlreadySaved: boolean,
): Promise<boolean> {
  const errorMessage = buildDraftFailureMessage(error);
  let transcriptSaved = transcriptAlreadySaved;

  try {
    await saveArticleTranscript(fileKey, rawText, article, {
      processingStage: "DRAFT_FAILED",
      errorMessage,
    });
    transcriptSaved = true;
  } catch (transcriptError) {
    console.error("Failed to save article transcript after draft failure:", describeError(transcriptError));
  }

  if (!transcriptSaved) {
    return false;
  }

  await updateStatus(filename, "COMPLETED", {
    rawText,
    articleTitle: article.title,
    articleContent: article.content,
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

export async function main() {
  console.log("Starting VibePub Mining Job...");
  let failedCount = 0;
  let permanentFailedCount = 0;
  const targetFilename = process.env.TARGET_FILENAME?.trim();

  // 1. Check for new audio files
  console.log("Fetching unprocessed files from R2...");
  const allFiles = await listUnprocessedFiles();
  const files = filterTargetFiles(allFiles, targetFilename);
  
  if (files.length === 0) {
    if (targetFilename) {
      console.log(`No R2 inbox file found for TARGET_FILENAME=${targetFilename}. Exiting.`);
    } else {
      console.log("No new audio files found. Exiting.");
    }
    return;
  }
  
  if (targetFilename) {
    console.log(`Found target file to process: ${targetFilename}`);
  } else {
    console.log(`Found ${files.length} file(s) to process.`);
  }

  // Process files one by one (could also be parallelized if needed)
  for (const fileKey of files) {
    let processingStage = "QUEUED";
    const filename = path.basename(fileKey);
    let rawText = "";
    let article: ArticleResult | undefined;
    let articleTranscriptSaved = false;

    try {
      console.log(`\n--- Processing file: ${fileKey} ---`);
      
      await updateStatus(filename, "PROCESSING", { processingStage });
      
      // 3. Build a short-lived R2 URL for Volcengine ASR.
      console.log("Creating temporary audio URL from R2...");
      const audioUrl = await createPresignedDownloadUrl(fileKey);
      const ext = path.extname(fileKey).slice(1);
      
      // 4. ASR: Speech to text
      processingStage = "ASR";
      await updateStatus(filename, "PROCESSING", { processingStage });
      console.log("Transcribing audio via Volcengine ASR...");
      try {
        rawText = await transcribeAudioUrl(audioUrl, ext || 'm4a');
      } catch (e: any) {
        console.error("ASR failed:", e.message);
        throw e;
      }
      
      console.log(`Raw Transcript: ${rawText.substring(0, 50)}...`);
      
      if (!rawText || rawText.trim().length === 0) {
        console.log("Transcript was empty. Skipping.");
        await deleteFile(fileKey);
        await updateStatus(filename, "FAILED", { processingStage, errorMessage: "转录结果为空" });
        continue;
      }

      // 5. LLM: Style Distillation
      processingStage = "REWRITING";
      await updateStatus(filename, "PROCESSING", { processingStage, rawText });
      console.log("Running Style Distillation via GLM...");
      article = await processAudioText(rawText);
      console.log(`Generated Article Title: ${article.title}`);
      
      processingStage = "ARTICLE_READY";
      await updateStatus(filename, "PROCESSING", {
        processingStage,
        rawText,
        articleTitle: article.title,
        articleContent: article.content,
      });
      await saveArticleTranscript(fileKey, rawText, article, {
        processingStage: "ARTICLE_READY",
      });
      articleTranscriptSaved = true;

      // 5.5 LLM: Image Generation
      processingStage = "DRAFTING";
      await updateStatus(filename, "PROCESSING", {
        processingStage,
        rawText,
        articleTitle: article.title,
        articleContent: article.content,
      });
      console.log(`Generating cover image with prompt: ${article.imagePrompt}`);
      const coverBuffer = await generateCoverImageBuffer(article.imagePrompt);
      
      // 6. WeChat: Publish Draft
      console.log("Getting WeChat Access Token...");
      const wxToken = await getAccessToken();
      console.log("Publishing to WeChat Drafts...");
      const mediaId = await publishDraft(wxToken, article.title, article.content, coverBuffer);
      console.log(`Successfully published draft! Media ID: ${mediaId}`);
      
      // 6.5 Save Transcript JSON to R2
      try {
        await saveArticleTranscript(fileKey, rawText, article, {
          processingStage: "COMPLETED",
          wechatDraftId: mediaId,
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
        rawText,
        articleTitle: article.title,
        articleContent: article.content,
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
          rawText,
          article,
          e,
          articleTranscriptSaved,
        );
        if (recovered) {
          continue;
        }
      }

      await updateStatus(filename, "FAILED", {
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
