import axios from "axios";
import { randomUUID } from "crypto";

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const SUBMIT_SUCCESS_CODE = "20000000";
const QUERY_PROCESSING_CODES = new Set(["20000001", "20000002"]);

type AsrConfig = {
  appId: string;
  accessToken: string;
  resourceIds: string[];
};

type AsrTask = {
  taskId: string;
  resourceId: string;
};

type AsrQueryResponse = {
  result?: {
    text?: string;
  };
  resp?: {
    code?: number;
    text?: string;
  };
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

function buildHeaders(requestId: string, resourceId: string, sequence?: string) {
  const config = getAsrConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-App-Key": config.appId,
    "X-Api-Access-Key": config.accessToken,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Request-Id": requestId,
  };
  if (sequence) {
    headers["X-Api-Sequence"] = sequence;
  }
  return headers;
}

function getHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name.toLowerCase()] ?? headers?.[name];
  if (Array.isArray(value)) {
    return value[0] ? String(value[0]) : undefined;
  }
  return value === undefined ? undefined : String(value);
}

function getPollIntervalMs() {
  const configured = Number.parseInt(process.env.VOLC_ASR_POLL_INTERVAL_MS || "", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5000;
}

function buildAsrSubmitPayload(audioUrl: string, format: string) {
  return {
    user: {
      uid: "vibepub_user"
    },
    audio: {
      url: audioUrl,
      format: format.toLowerCase().replace(".", ""),
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
}

async function submitBigModelAsrJob(audioUrl: string, format: string = "m4a"): Promise<AsrTask> {
  const config = getAsrConfig();
  let lastError: unknown;

  const submitPayload = buildAsrSubmitPayload(audioUrl, format);

  for (const resourceId of config.resourceIds) {
    const reqId = randomUUID();
    const headers = buildHeaders(reqId, resourceId, "-1");

    try {
      console.log(`Submitting to Doubao Big Model ASR v3 with resource ${resourceId}...`);
      const submitResponse = await axios.post(SUBMIT_URL, submitPayload, {
        headers,
        validateStatus: () => true,
      });

      const apiStatusCode = getHeader(submitResponse.headers, "x-api-status-code");
      const apiMessage = getHeader(submitResponse.headers, "x-api-message");
      if (submitResponse.status < 200 || submitResponse.status >= 300 || apiStatusCode !== SUBMIT_SUCCESS_CODE) {
        const body = JSON.stringify(submitResponse.data || {});
        throw new Error(
          `Volcengine ASR Submit failed: http=${submitResponse.status} api=${apiStatusCode || "missing"} message=${apiMessage || ""} body=${body}`,
        );
      }

      console.log(`Task submitted successfully. Task ID: ${reqId}`);
      return { taskId: reqId, resourceId };
    } catch (error) {
      lastError = error;
      console.warn(`ASR submit failed for resource ${resourceId}.`);
    }
  }

  throw lastError;
}

export async function submitBigModelAsrTaskFromUrl(audioUrl: string, format: string = "m4a"): Promise<string> {
  const { taskId } = await submitBigModelAsrJob(audioUrl, format);
  return taskId;
}

export async function transcribeAudioUrl(audioUrl: string, format: string = "m4a"): Promise<string> {
  const { taskId, resourceId } = await submitBigModelAsrJob(audioUrl, format);
  
  // Polling
  const queryHeaders = buildHeaders(taskId, resourceId);
  const pollIntervalMs = getPollIntervalMs();

  for (let i = 0; i < 60; i++) { // Poll for up to 5 minutes (60 * 5s)
    await sleep(pollIntervalMs);
    console.log(`Polling task ${taskId}...`);
    const queryResponse = await axios.post<AsrQueryResponse>(
      QUERY_URL,
      {},
      {
        headers: queryHeaders,
        validateStatus: () => true,
      },
    );
    const data = queryResponse.data;
    const apiStatusCode = getHeader(queryResponse.headers, "x-api-status-code");
    const apiMessage = getHeader(queryResponse.headers, "x-api-message");
    
    if (apiStatusCode === SUBMIT_SUCCESS_CODE || data.resp?.code === 1000) {
      console.log("Transcription completed!");
      return data.result?.text || data.resp?.text || "";
    } else if (QUERY_PROCESSING_CODES.has(apiStatusCode || "") || data.resp?.code === 2000) {
      // Still processing
      continue;
    } else {
      throw new Error(
        `Volcengine ASR Query failed: http=${queryResponse.status} api=${apiStatusCode || "missing"} message=${apiMessage || ""} body=${JSON.stringify(data || {})}`,
      );
    }
  }

  throw new Error("Volcengine ASR timed out waiting for result.");
}
