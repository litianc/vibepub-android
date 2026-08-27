#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_AUDIO_FILE="/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3"
DEVICE_ENV_FILE="${DEVICE_ENV_FILE:-$ROOT_DIR/secrets/device-test.env}"
APK_PATH="${1:-}"
USE_APP_AUTH_SESSION="${USE_APP_AUTH_SESSION:-false}"

usage() {
  cat <<EOF
Usage:
  scripts/run-android-device-smoke.sh [path/to/test.apk]

Environment:
  DEVICE_ENV_FILE  Optional env file. Default: secrets/device-test.env.
  AUDIO_FILE       Test audio file. Defaults to the standard speaker sample.
  API_BASE_URL     Backend URL. Defaults to https://vibepub.litianc.cn.
  FILES_TOKEN      Backend token. Falls back to secrets/files-token.txt.
  USE_APP_AUTH_SESSION
                   When true, use the already logged-in debug app session
                   instead of requiring FILES_TOKEN. Default: false.
  SKIP_INSTALL     Use APK already installed on phone. Default: false.
  CHECK_APK_INSTALL_IN_PREFLIGHT
                   Let readiness preflight install/check the APK before the
                   main smoke script. Default: false to avoid double install.
  TRIGGER_MINING_JOB
                   Trigger and wait for mining-job.yml before final detail
                   assertion. Default: true.
  MINING_TRIGGER_MODE
                   auto waits for the Worker-created workflow_dispatch run,
                   manual dispatches from the script, and auto_or_manual waits
                   first then dispatches manually as fallback. Default: auto.

When no APK path is passed, the latest stable-signed, versioned GitHub Release
APK is downloaded through scripts/download-latest-android-apk.sh. Versioned
release APKs default to ui-tap automation; local debug APKs default to the
debug-only broadcast receiver.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -f "$DEVICE_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEVICE_ENV_FILE"
  set +a
elif [[ -f "$ROOT_DIR/secrets/files-token.txt" ]]; then
  export FILES_TOKEN="${FILES_TOKEN:-$(cat "$ROOT_DIR/secrets/files-token.txt")}"
  export API_BASE_URL="${API_BASE_URL:-https://vibepub.litianc.cn}"
fi

if [[ -z "$APK_PATH" ]]; then
  APK_PATH="$("$ROOT_DIR/scripts/download-latest-android-apk.sh" | tail -n 1)"
fi

default_automation_mode="debug-broadcast"
if [[ "$(basename "$APK_PATH")" == VibePub-*.apk ]]; then
  default_automation_mode="ui-tap"
fi

if [[ -z "${FILES_TOKEN:-}" && "$USE_APP_AUTH_SESSION" != "true" ]]; then
  echo "FILES_TOKEN is required. Put it in secrets/device-test.env or export it." >&2
  exit 1
fi

if [[ ! -f "${AUDIO_FILE:-$DEFAULT_AUDIO_FILE}" ]]; then
  echo "AUDIO_FILE not found: ${AUDIO_FILE:-$DEFAULT_AUDIO_FILE}" >&2
  exit 1
fi

CHECK_APK_INSTALL="${CHECK_APK_INSTALL_IN_PREFLIGHT:-false}" \
REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-true}" \
"$ROOT_DIR/scripts/check-android-device-ready.sh" "$APK_PATH"

AUDIO_FILE="${AUDIO_FILE:-$DEFAULT_AUDIO_FILE}" \
API_BASE_URL="${API_BASE_URL:-https://vibepub.litianc.cn}" \
FILES_TOKEN="${FILES_TOKEN:-}" \
AUTOMATION_MODE="${AUTOMATION_MODE:-$default_automation_mode}" \
RESET_APP_DATA="${RESET_APP_DATA:-$(if [[ "$USE_APP_AUTH_SESSION" == "true" ]]; then printf false; else printf true; fi)}" \
SKIP_INSTALL="${SKIP_INSTALL:-false}" \
RECORD_SECONDS="${RECORD_SECONDS:-15}" \
POST_STOP_WAIT_SECONDS="${POST_STOP_WAIT_SECONDS:-2}" \
DETAIL_WAIT_SECONDS="${DETAIL_WAIT_SECONDS:-2}" \
DETAIL_READY_WAIT_SECONDS="${DETAIL_READY_WAIT_SECONDS:-30}" \
TRIGGER_MINING_JOB="${TRIGGER_MINING_JOB:-true}" \
MINING_TRIGGER_MODE="${MINING_TRIGGER_MODE:-auto}" \
MINING_WAIT_SECONDS="${MINING_WAIT_SECONDS:-300}" \
BACKEND_COMPLETION_WAIT_SECONDS="${BACKEND_COMPLETION_WAIT_SECONDS:-90}" \
BACKEND_POLL_INTERVAL_SECONDS="${BACKEND_POLL_INTERVAL_SECONDS:-2}" \
"$ROOT_DIR/scripts/android-device-visual-test.sh" "$APK_PATH"
