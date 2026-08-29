import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const AUDIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\.(?:m4a|mp3|wav|aac|ogg|webm)$/i;
const REVISION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\.json$/;

export function validateStagingAudioCanaryInput(input) {
  const {
    PHASE = "",
    TARGET_KEY = "",
    USER_ID = "",
    WORKSPACE_ID = "",
    REVISION_REQUEST_KEY = "",
    RECORDING_ID = "",
    ARTICLE_ID = "",
    PARENT_VERSION_ID = "",
  } = input;
  const audioPrefix = `users/${USER_ID}/inbox/`;
  const audioName = TARGET_KEY.startsWith(audioPrefix) ? TARGET_KEY.slice(audioPrefix.length) : "";
  const revisionPrefix = `users/${USER_ID}/revision-requests/`;
  const revisionName = REVISION_REQUEST_KEY.startsWith(revisionPrefix)
    ? REVISION_REQUEST_KEY.slice(revisionPrefix.length)
    : "";
  const revisionInvalid = !REVISION_NAME.test(revisionName) || REVISION_REQUEST_KEY.includes("..") ||
    !/^\d+$/.test(RECORDING_ID) || !ID.test(ARTICLE_ID) || !ID.test(PARENT_VERSION_ID);
  const extra = [REVISION_REQUEST_KEY, RECORDING_ID, ARTICLE_ID, PARENT_VERSION_ID].some(Boolean);

  return ["transcribe", "start", "revision"].includes(PHASE) &&
    ID.test(USER_ID) && ID.test(WORKSPACE_ID) && !TARGET_KEY.includes("..") && AUDIO_NAME.test(audioName) &&
    (PHASE === "revision" ? !revisionInvalid : !extra);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])) &&
    !validateStagingAudioCanaryInput(process.env)) {
  process.exit(1);
}
