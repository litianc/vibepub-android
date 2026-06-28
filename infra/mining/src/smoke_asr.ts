import { transcribeAudioUrl } from "./asr.js";
import { createPresignedDownloadUrl } from "./r2.js";

function buildAsrFailureHint(error: any) {
  const apiStatusCode = error?.response?.headers?.["x-api-status-code"];
  if (apiStatusCode !== "45000010") {
    return undefined;
  }

  return {
    diagnosis: "Volcengine SaaS grant is missing for this ASR AppID/Access Token and ResourceID.",
    activateWorkflow: "Run GitHub Actions workflow `Volcengine Speech Service` with the console BlueprintID and ResourceID, then rerun `Smoke External Services`.",
    console: "https://console.volcengine.com/speech/new/experience/asr",
    apiExplorer: "https://api.volcengine.com/api-explorer?serviceCode=speech_saas_prod&version=2025-05-20&action=ActivateService",
  };
}

async function main() {
  let audioUrl = process.env.VOLC_ASR_SMOKE_AUDIO_URL?.trim();
  const r2Key = process.env.VOLC_ASR_SMOKE_R2_KEY?.trim();
  if (!audioUrl && r2Key) {
    audioUrl = await createPresignedDownloadUrl(r2Key);
  }
  if (!audioUrl) {
    console.log("Skipping Volcengine BigModel ASR v3 smoke check because no smoke audio URL or R2 key is configured.");
    return;
  }
  const format = process.env.VOLC_ASR_SMOKE_AUDIO_FORMAT?.trim() || "mp3";
  const text = await transcribeAudioUrl(audioUrl, format);
  if (!text.trim()) {
    throw new Error("ASR smoke check returned an empty transcript.");
  }
  console.log(`Volcengine BigModel ASR v3 smoke check passed. Transcript length: ${text.length}`);
}

main().catch((error) => {
  console.error("Volcengine BigModel ASR v3 smoke check failed:", {
    message: error?.message,
    httpStatus: error?.response?.status,
    apiStatusCode: error?.response?.headers?.["x-api-status-code"],
    apiMessage: error?.response?.headers?.["x-api-message"],
    responseData: error?.response?.data,
    hint: buildAsrFailureHint(error),
  });
  process.exit(1);
});
