import { submitBigModelAsrTask } from "./asr.js";

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
  });
  process.exit(1);
});
