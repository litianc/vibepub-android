import axios from "axios";
import { randomUUID } from "crypto";

const VOLC_ASR_APPID = process.env.VOLC_ASR_APPID!;
const VOLC_ASR_ACCESS_TOKEN = process.env.VOLC_ASR_ACCESS_TOKEN!;
const VOLC_ASR_RESOURCE_ID = process.env.VOLC_ASR_RESOURCE_ID || "volc.bigasr.auc"; // Default to bigasr

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function transcribeAudio(audioBuffer: Buffer, format: string = 'm4a'): Promise<string> {
  const submitUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
  
  const reqId = randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "X-Api-App-Key": VOLC_ASR_APPID,
    "X-Api-Access-Key": VOLC_ASR_ACCESS_TOKEN,
    "X-Api-Resource-Id": VOLC_ASR_RESOURCE_ID,
    "X-Api-Request-Id": reqId
  };

  const submitPayload = {
    user: {
      uid: "vibepub_user"
    },
    audio: {
      data: audioBuffer.toString('base64'),
      format: format.toLowerCase().replace('.', ''), // e.g. "mp3", "m4a", "wav"
      language: "zh-CN"
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      enable_speaker_info: false
    }
  };

  console.log("Submitting to Doubao Big Model ASR v3...");
  const submitResponse = await axios.post(submitUrl, submitPayload, { headers });

  if (submitResponse.data.resp?.code !== 1000) {
    throw new Error(`Volcengine ASR Submit failed: ${JSON.stringify(submitResponse.data)}`);
  }
  
  const taskId = submitResponse.data.resp.id;
  console.log(`Task submitted successfully. Task ID: ${taskId}`);
  
  // Polling
  const queryUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
  const queryHeaders = {
    ...headers,
    "X-Api-Request-Id": taskId // the task ID becomes the request ID for query
  };

  for (let i = 0; i < 60; i++) { // Poll for up to 5 minutes (60 * 5s)
    await sleep(5000);
    console.log(`Polling task ${taskId}...`);
    const queryResponse = await axios.post(queryUrl, {}, { headers: queryHeaders });
    const data = queryResponse.data;
    
    if (data.resp?.code === 1000) {
      console.log("Transcription completed!");
      return data.resp.text || "";
    } else if (data.resp?.code === 2000) {
      // Still processing
      continue;
    } else {
      throw new Error(`Volcengine ASR Query failed: ${JSON.stringify(data)}`);
    }
  }

  throw new Error("Volcengine ASR timed out waiting for result.");
}
