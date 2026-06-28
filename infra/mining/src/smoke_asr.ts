import { submitBigModelAsrTask } from "./asr.js";

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
  const silentAudio = Buffer.alloc(32_000);
  const taskId = await submitBigModelAsrTask(silentAudio, "wav");
  if (!taskId) {
    throw new Error("ASR smoke check did not return a task id.");
  }
  console.log("Volcengine BigModel ASR v3 smoke check passed.");
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
