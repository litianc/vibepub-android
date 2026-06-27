import { listUnprocessedFiles, downloadFile, deleteFile } from "./r2.js";
import { transcribeAudio } from "./asr.js";
import { processAudioText, generateCoverImageBuffer } from "./llm.js";
import { getAccessToken, publishDraft } from "./wechat.js";
import path from "path";

async function main() {
  console.log("Starting VibePub Mining Job...");

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
      
      // 3. Download audio
      console.log("Downloading audio from R2...");
      const audioBuffer = await downloadFile(fileKey);
      
      const ext = path.extname(fileKey).slice(1);
      
      // 4. ASR: Speech to text
      console.log("Transcribing audio via Volcengine ASR...");
      const rawText = await transcribeAudio(audioBuffer, ext || 'm4a');
      console.log(`Raw Transcript: ${rawText.substring(0, 50)}...`);
      
      if (!rawText || rawText.trim().length === 0) {
        console.log("Transcript was empty. Skipping.");
        await deleteFile(fileKey);
        continue;
      }

      // 5. LLM: Style Distillation
      console.log("Running Style Distillation via GLM...");
      const article = await processAudioText(rawText);
      console.log(`Generated Article Title: ${article.title}`);
      
      // 5.5 LLM: Image Generation
      console.log(`Generating cover image with prompt: ${article.imagePrompt}`);
      const coverBuffer = await generateCoverImageBuffer(article.imagePrompt);
      
      // 6. WeChat: Publish Draft
      console.log("Publishing to WeChat Drafts...");
      const mediaId = await publishDraft(wxToken, article.title, article.content, coverBuffer);
      console.log(`Successfully published draft! Media ID: ${mediaId}`);
      
      // 7. Cleanup: Delete processed file from R2
      console.log("Cleaning up processed file from R2...");
      await deleteFile(fileKey);
      
      console.log(`Finished processing: ${fileKey}`);
    } catch (e) {
      console.error(`Failed to process ${fileKey}:`, e);
      // We do not delete the file on failure, so it will be retried next time
    }
  }
  
  console.log("\nMining Job completed successfully.");
}

main().catch(err => {
  console.error("Fatal error in mining job:", err);
  process.exit(1);
});
