import axios from "axios";
import { randomUUID } from "crypto";

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

type AsrConfig = {
  appId: string;
  accessToken: string;
  resourceIds: string[];
};

type AsrTask = {
  taskId: string;
  resourceId: string;
};

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAsrConfig(): AsrConfig {
  const appId = process.env.VOLC_ASR_APPID?.trim();
  const accessToken = process.env.VOLC_ASR_ACCESS_TOKEN?.trim();
  const configuredResourceId = process.env.VOLC_ASR_RESOURCE_ID?.trim();
  const resourceIds = configuredResourceId
    ? [configuredResourceId]
    : ["volc.bigasr.auc", "volc.seedasr.auc"];

  const missing = [
    ["VOLC_ASR_APPID", appId],
    ["VOLC_ASR_ACCESS_TOKEN", accessToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing ASR environment variables: ${missing.join(", ")}`);
  }

  return {
    appId: appId!,
    accessToken: accessToken!,
    resourceIds,
  };
}

function buildHeaders(requestId: string, resourceId: string) {
  const config = getAsrConfig();
  return {
    "Content-Type": "application/json",
    "X-Api-App-Key": config.appId,
    "X-Api-Access-Key": config.accessToken,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Request-Id": requestId,
  };
}

async function submitBigModelAsrJob(audioBuffer: Buffer, format: string = "m4a"): Promise<AsrTask> {
  const config = getAsrConfig();
  let lastError: unknown;

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

  for (const resourceId of config.resourceIds) {
    const reqId = randomUUID();
    const headers = buildHeaders(reqId, resourceId);

    try {
      console.log(`Submitting to Doubao Big Model ASR v3 with resource ${resourceId}...`);
      const submitResponse = await axios.post(SUBMIT_URL, submitPayload, { headers });

      if (submitResponse.data.resp?.code !== 1000) {
        throw new Error(`Volcengine ASR Submit failed: ${JSON.stringify(submitResponse.data)}`);
      }

      const taskId = submitResponse.data.resp.id;
      console.log(`Task submitted successfully. Task ID: ${taskId}`);
      return { taskId, resourceId };
    } catch (error) {
      lastError = error;
      console.warn(`ASR submit failed for resource ${resourceId}.`);
    }
  }

  throw lastError;
}

export async function submitBigModelAsrTask(audioBuffer: Buffer, format: string = "m4a"): Promise<string> {
  const { taskId } = await submitBigModelAsrJob(audioBuffer, format);
  return taskId;
}

export async function transcribeAudio(audioBuffer: Buffer, format: string = 'm4a'): Promise<string> {
  const { taskId, resourceId } = await submitBigModelAsrJob(audioBuffer, format);
  
  // Polling
  const queryHeaders = buildHeaders(taskId, resourceId);

  for (let i = 0; i < 60; i++) { // Poll for up to 5 minutes (60 * 5s)
    await sleep(5000);
    console.log(`Polling task ${taskId}...`);
    const queryResponse = await axios.post(QUERY_URL, {}, { headers: queryHeaders });
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
