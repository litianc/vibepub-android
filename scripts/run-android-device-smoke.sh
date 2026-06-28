#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_AUDIO_FILE="/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3"
DEVICE_ENV_FILE="${DEVICE_ENV_FILE:-$ROOT_DIR/secrets/device-test.env}"
APK_PATH="${1:-}"

usage() {
  cat <<EOF
Usage:
  scripts/run-android-device-smoke.sh [path/to/app-debug.apk]

Environment:
  DEVICE_ENV_FILE  Optional env file. Default: secrets/device-test.env.
  AUDIO_FILE       Test audio file. Defaults to the standard speaker sample.
  API_BASE_URL     Backend URL. Defaults to https://vibepub.litianc.cn.
  FILES_TOKEN      Backend token. Falls back to secrets/files-token.txt.

When no APK path is passed, the latest successful GitHub Actions debug APK is
downloaded through scripts/download-latest-android-apk.sh.
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

if [[ -z "${FILES_TOKEN:-}" ]]; then
  echo "FILES_TOKEN is required. Put it in secrets/device-test.env or export it." >&2
  exit 1
fi

if [[ ! -f "${AUDIO_FILE:-$DEFAULT_AUDIO_FILE}" ]]; then
  echo "AUDIO_FILE not found: ${AUDIO_FILE:-$DEFAULT_AUDIO_FILE}" >&2
  exit 1
fi

"$ROOT_DIR/scripts/check-android-device-ready.sh" "$APK_PATH"

AUDIO_FILE="${AUDIO_FILE:-$DEFAULT_AUDIO_FILE}" \
API_BASE_URL="${API_BASE_URL:-https://vibepub.litianc.cn}" \
FILES_TOKEN="$FILES_TOKEN" \
AUTOMATION_MODE="${AUTOMATION_MODE:-debug-broadcast}" \
RESET_APP_DATA="${RESET_APP_DATA:-true}" \
RECORD_SECONDS="${RECORD_SECONDS:-70}" \
POST_STOP_WAIT_SECONDS="${POST_STOP_WAIT_SECONDS:-10}" \
DETAIL_WAIT_SECONDS="${DETAIL_WAIT_SECONDS:-12}" \
"$ROOT_DIR/scripts/android-device-visual-test.sh" "$APK_PATH"
