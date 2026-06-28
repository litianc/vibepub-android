import fs from "fs";
import http from "http";
import path from "path";

// Run this script using: node --env-file=.env --import tsx src/test.ts

import { transcribeAudioUrl } from "./asr.js";
import { generateCoverImageBuffer, processAudioText } from "./llm.js";
import { getAccessToken, publishDraft } from "./wechat.js";

async function runTests() {
  const testAudioPath = process.argv[2];

  console.log("=== VibePub Mining Job Local Test ===");

  if (!testAudioPath || !fs.existsSync(testAudioPath)) {
    console.warn(`[!] No valid audio file provided at '${testAudioPath}'. Skipping ASR test.`);
  } else {
    try {
      console.log("\n[Test 1: ASR]");
      const audioBuffer = fs.readFileSync(testAudioPath);
      const ext = path.extname(testAudioPath).slice(1) || 'm4a';
      console.log(`Sending ${audioBuffer.length} bytes to Volcengine ASR...`);
      
      const rawText = await withLocalAudioUrl(audioBuffer, ext, url => transcribeAudioUrl(url, ext));
      console.log("✅ ASR Success! Transcript:");
      console.log(rawText);
      
      // Save transcript to a temp file for next step
      fs.writeFileSync("temp_transcript.txt", rawText);
    } catch (e) {
      console.error("❌ ASR Test Failed:", e);
      return;
    }
  }

  let transcript = "哎，那个今天天气挺好的，我想说说那个什么来着……对，就是产品规划这事儿，我觉得吧，不能太死板，得有那种，那种流动性，你懂吧？就是走到哪算哪，但是大方向不能错。很多时候计划赶不上变化，别整那些虚头巴脑的PPT，直接上手做，做完扔给用户看，挨骂就改，不挨骂就继续加功能，对，就这么简单粗暴。";
  
  if (fs.existsSync("temp_transcript.txt")) {
    transcript = fs.readFileSync("temp_transcript.txt", "utf-8");
  } else {
    console.log("\n[!] Using mock transcript since ASR step was skipped.");
  }

  let generatedArticle: {title: string; content: string; imagePrompt: string} | null = null;
  
  try {
    console.log("\n[Test 2: LLM Style Distillation]");
    console.log("Calling GLM-5.2 with transcript...");
    
    generatedArticle = await processAudioText(transcript);
    console.log("✅ LLM Success! Generated Article:");
    console.log(`Title: ${generatedArticle.title}`);
    console.log(`Content:\n${generatedArticle.content}`);
    
  } catch (e) {
    console.error("❌ LLM Test Failed:", e);
    return;
  }

  try {
    console.log("\n[Test 3: WeChat Publish]");
    if (generatedArticle) {
      console.log("Getting Access Token via Proxy...");
      const token = await getAccessToken();
      console.log("✅ Token acquired.");

      console.log("Generating cover image...");
      const coverBuffer = await generateCoverImageBuffer(generatedArticle.imagePrompt);

      console.log("Pushing draft to WeChat...");
      const mediaId = await publishDraft(token, generatedArticle.title, generatedArticle.content, coverBuffer);
      console.log(`✅ WeChat Publish Success! Media ID: ${mediaId}`);
    }
  } catch (e) {
    console.error("❌ WeChat Test Failed:", e);
  }
}

runTests();

async function withLocalAudioUrl<T>(
  audioBuffer: Buffer,
  format: string,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const contentType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
  const server = http.createServer((request, response) => {
    if (request.url !== "/audio") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": String(audioBuffer.length),
    });
    response.end(audioBuffer);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local audio server did not bind to a TCP port.");
    }
    return await run(`http://127.0.0.1:${address.port}/audio`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
