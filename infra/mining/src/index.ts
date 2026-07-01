import { listUnprocessedFiles, createPresignedDownloadUrl, deleteFile, uploadTranscript } from "./r2.js";
import { transcribeAudioUrl } from "./asr.js";
import { processAudioText } from "./llm.js";
import { generateWechatCoverBuffer } from "./coverRenderer.js";
import { getAccessToken, publishDraft } from "./wechat.js";
import path from "path";

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
    message.includes("invalid argument")
  );
}

function shouldCleanupPermanentAudioFailures(): boolean {
  return ["true", "1", "yes"].includes(
    (process.env.CLEANUP_PERMANENT_AUDIO_FAILURES || "").toLowerCase(),
  );
}

async function updateStatus(filename: string, status: string) {
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
      body: JSON.stringify({ filename, status })
    });
    if (!res.ok) console.error(`Status update failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("Failed to update status:", e);
  }
}

async function main() {
  console.log("Starting VibePub Mining Job...");
  let failedCount = 0;
  let permanentFailedCount = 0;

  // 1. Check for new audio files
  console.log("Fetching unprocessed files from R2...");
  const files = await listUnprocessedFiles();
  
  if (files.length === 0) {
    console.log("No new audio files found. Exiting.");
    return;
  }
  
  console.log(`Found ${files.length} file(s) to process.`);

  // 2. Obtain WeChat Access Token early to fail fast if config is wrong
  console.log("Getting WeChat Access Token...");
  const wxToken = await getAccessToken();

  // Process files one by one (could also be parallelized if needed)
  for (const fileKey of files) {
    try {
      console.log(`\n--- Processing file: ${fileKey} ---`);
      const filename = path.basename(fileKey);
      
      await updateStatus(filename, "PROCESSING");
      
      // 3. Build a short-lived R2 URL for Volcengine ASR.
      console.log("Creating temporary audio URL from R2...");
      const audioUrl = await createPresignedDownloadUrl(fileKey);
      const ext = path.extname(fileKey).slice(1);
      
      // 4. ASR: Speech to text
      console.log("Transcribing audio via Volcengine ASR...");
      let rawText = "";
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
        await updateStatus(filename, "FAILED");
        continue;
      }

      // 5. LLM: Style Distillation
      console.log("Running Style Distillation via GLM...");
      const article = await processAudioText(rawText);
      console.log(`Generated Article Title: ${article.title}`);
      
      // 5.5 Generate deterministic WeChat cover art.
      console.log(`Generating WeChat cover from title: ${article.title}`);
      const coverBuffer = await generateWechatCoverBuffer({
        title: article.title,
        titleLines: article.coverTitle,
        subtitle: article.coverSubtitle,
      });
      
      // 6. WeChat: Publish Draft
      console.log("Publishing to WeChat Drafts...");
      const mediaId = await publishDraft(wxToken, article.title, article.content, coverBuffer);
      console.log(`Successfully published draft! Media ID: ${mediaId}`);
      
      // 6.5 Save Transcript JSON to R2
      const jsonKey = fileKey.replace("inbox/", "transcripts/").replace(/\.[^/.]+$/, ".json");
      console.log(`Saving transcript JSON to ${jsonKey}...`);
      await uploadTranscript(jsonKey, JSON.stringify({
        rawText,
        articleTitle: article.title,
        articleContent: article.content
      }));
      
      // 7. Cleanup: Delete processed file from R2
      console.log("Cleaning up processed file from R2...");
      await deleteFile(fileKey);
      
      await updateStatus(filename, "COMPLETED");
      
      console.log(`Finished processing: ${fileKey}`);
    } catch (e) {
      console.error(`Failed to process ${fileKey}:`, describeError(e));
      const filename = path.basename(fileKey);
      await updateStatus(filename, "FAILED");

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

main().catch(err => {
  console.error("Fatal error in mining job:", err);
  process.exit(1);
});
