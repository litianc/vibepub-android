#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"
ACTIVITY_NAME="${ACTIVITY_NAME:-.MainActivity}"
APK_PATH="${1:-$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk}"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-device-visual/$RUN_ID}"
RECORD_SECONDS="${RECORD_SECONDS:-20}"
AUDIO_FILE="${AUDIO_FILE:-}"
API_BASE_URL="${API_BASE_URL:-}"
FILES_TOKEN="${FILES_TOKEN:-}"
RESET_APP_DATA="${RESET_APP_DATA:-false}"
REQUIRE_PREFS_INJECTION="${REQUIRE_PREFS_INJECTION:-true}"
AUTOMATION_MODE="${AUTOMATION_MODE:-debug-broadcast}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
START_DELAY_SECONDS="${START_DELAY_SECONDS:-1}"
POST_STOP_WAIT_SECONDS="${POST_STOP_WAIT_SECONDS:-5}"
DETAIL_WAIT_SECONDS="${DETAIL_WAIT_SECONDS:-8}"
DETAIL_SCROLL_PAGES="${DETAIL_SCROLL_PAGES:-3}"
DEBUG_AUDIO_MODE="${DEBUG_AUDIO_MODE:-import}"
TRIGGER_MINING_JOB="${TRIGGER_MINING_JOB:-false}"
MINING_WORKFLOW_ID="${MINING_WORKFLOW_ID:-mining-job.yml}"
MINING_WORKFLOW_REF="${MINING_WORKFLOW_REF:-main}"
MINING_WAIT_SECONDS="${MINING_WAIT_SECONDS:-240}"
BACKEND_UPLOAD_WAIT_SECONDS="${BACKEND_UPLOAD_WAIT_SECONDS:-90}"
BACKEND_COMPLETION_WAIT_SECONDS="${BACKEND_COMPLETION_WAIT_SECONDS:-60}"
FORCE_RECORD_AUDIO_APPOPS="${FORCE_RECORD_AUDIO_APPOPS:-true}"
WAKE_DEVICE="${WAKE_DEVICE:-true}"
DEBUG_START_ACTION="cn.litianc.vibepub.DEBUG_START_RECORDING"
DEBUG_STOP_ACTION="cn.litianc.vibepub.DEBUG_STOP_RECORDING"
DEBUG_IMPORT_AUDIO_ACTION="cn.litianc.vibepub.DEBUG_IMPORT_AUDIO"
SCREENRECORD_PID=""
DETAIL_STATUS="not_checked"
BACKEND_RECORDING_STATUS=""
LATEST_RECORDING_FILENAME=""
EXPECTED_DURATION_TEXT=""

usage() {
  cat <<EOF
Usage:
  scripts/android-device-visual-test.sh [path/to/app-debug.apk]

Environment:
  OUT_DIR          Output directory for screenshots, video, logs.
  RECORD_SECONDS  Screen recording length after launch. Default: 20.
  AUDIO_FILE      Optional local audio file. If set, the script automatically
                  drives the debug APK with this fixture, opens the first
                  recording, and captures evidence.
  API_BASE_URL    Optional API base URL to inject into app preferences.
  FILES_TOKEN     Optional upload/files token to inject into app preferences.
  RESET_APP_DATA  Set to true to clear app data before the run. Default: false.
  REQUIRE_PREFS_INJECTION
                  Fail if API_BASE_URL/FILES_TOKEN injection fails. Default: true.
  AUTOMATION_MODE debug-broadcast or ui-tap. Default: debug-broadcast.
  DEBUG_AUDIO_MODE
                  import or speaker when AUTOMATION_MODE=debug-broadcast.
                  import pushes AUDIO_FILE into the app and uploads it as one
                  recording without relying on Mac audio output. Default: import.
  SKIP_INSTALL    Use the APK already installed on the phone. Default: false.
  TRIGGER_MINING_JOB
                  Trigger and wait for GitHub Actions mining-job.yml after the
                  phone upload appears in the backend. Default: false.
  MINING_WORKFLOW_ID
                  GitHub Actions workflow to dispatch. Default: mining-job.yml.
  MINING_WORKFLOW_REF Git ref for workflow_dispatch. Default: main.
  MINING_WAIT_SECONDS Max seconds to wait for the workflow. Default: 240.
  DETAIL_WAIT_SECONDS
                  Seconds to wait after opening recording detail. Default: 8.
  DETAIL_SCROLL_PAGES
                  Extra detail-page scroll dumps to capture for assertions.
                  Default: 3.
  BACKEND_UPLOAD_WAIT_SECONDS
                  Max seconds to wait for /api/recordings to show the upload.
                  Default: 90.
  BACKEND_COMPLETION_WAIT_SECONDS
                  Max seconds to wait for backend status COMPLETED after mining.
                  Default: 60.
  FORCE_RECORD_AUDIO_APPOPS
                  Also set RECORD_AUDIO appops to allow after permission grant.
                  Default: true.
  PACKAGE_NAME    Android package. Default: cn.litianc.vibepub.
  ACTIVITY_NAME   Launch activity. Default: .MainActivity.
  RECORD_TAP_X/Y  Optional override for the home record button tap.
  STOP_TAP_X/Y    Optional override for the recording stop button tap.
  FIRST_ITEM_TAP_X/Y Optional override for opening the first recording.

This script uses a real USB-connected Android phone through adb. It does not
install Android Studio, the Android SDK, or an emulator.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1" >&2
    echo "Install adb with: brew install --cask android-platform-tools" >&2
    exit 1
  fi
}

install_apk() {
  local apk_path="$1"

  if adb install -r "$apk_path" > "$OUT_DIR/install.txt" 2>&1; then
    return 0
  fi

  if grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE" "$OUT_DIR/install.txt"; then
    cat "$OUT_DIR/install.txt" >&2
    cat >&2 <<EOF

The installed package has a different debug signature. Uninstalling it and
retrying because this is a deterministic smoke run.
EOF
    adb uninstall "$PACKAGE_NAME" > "$OUT_DIR/install-uninstall-incompatible.txt" 2>&1 || true
    if adb install -r "$apk_path" > "$OUT_DIR/install-after-uninstall.txt" 2>&1; then
      return 0
    fi
    cp "$OUT_DIR/install-after-uninstall.txt" "$OUT_DIR/install.txt"
  fi

  if ! grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
    cat "$OUT_DIR/install.txt" >&2
    return 1
  fi

  cat "$OUT_DIR/install.txt" >&2
  cat >&2 <<EOF

The phone blocked streamed APK installation from adb.
Trying the fallback device-side pm install path before giving up.
EOF

  adb push "$apk_path" /data/local/tmp/vibepub-app-debug.apk \
    > "$OUT_DIR/install-fallback-push.txt" 2>&1
  if adb_shell pm install -r -t -g /data/local/tmp/vibepub-app-debug.apk \
    > "$OUT_DIR/install-fallback-pm.txt" 2>&1; then
    return 0
  fi

  cat "$OUT_DIR/install-fallback-pm.txt" >&2
  return 1
}

truthy() {
  [[ "${1:-}" == "true" || "${1:-}" == "1" || "${1:-}" == "yes" ]]
}

adb_shell() {
  adb shell "$@"
}

grant_recording_permissions() {
  adb_shell pm grant "$PACKAGE_NAME" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
  adb_shell pm grant "$PACKAGE_NAME" android.permission.ACCESS_COARSE_LOCATION >/dev/null 2>&1 || true
  adb_shell pm grant "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
  if truthy "$FORCE_RECORD_AUDIO_APPOPS"; then
    adb_shell cmd appops set "$PACKAGE_NAME" RECORD_AUDIO allow >/dev/null 2>&1 || true
    adb_shell appops set "$PACKAGE_NAME" RECORD_AUDIO allow >/dev/null 2>&1 || true
  fi
}

wake_device() {
  if ! truthy "$WAKE_DEVICE"; then
    return 0
  fi

  adb_shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  adb_shell wm dismiss-keyguard >/dev/null 2>&1 || true
}

wait_for_app_focus() {
  local deadline=$((SECONDS + 10))
  local focused

  while (( SECONDS < deadline )); do
    focused="$(adb_shell dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -n 5 || true)"
    if [[ "$focused" == *"$PACKAGE_NAME"* ]]; then
      printf '%s\n' "$focused" > "$OUT_DIR/focused-window.txt"
      return 0
    fi
    sleep 1
  done

  printf '%s\n' "$focused" > "$OUT_DIR/focused-window-timeout.txt"
  return 1
}

pull_if_exists() {
  local remote="$1"
  local local_path="$2"
  if adb_shell test -f "$remote" >/dev/null 2>&1; then
    adb pull "$remote" "$local_path" >/dev/null
  fi
}

evaluate_detail_result() {
  local xml_file="$1"
  if [[ ! -f "$xml_file" ]]; then
    DETAIL_STATUS="missing_ui_dump"
    return 1
  fi

  if grep -q "转录失败" "$xml_file"; then
    DETAIL_STATUS="failed"
    return 1
  fi

  if grep -q "正在获取云端转录\\|正在转录" "$xml_file"; then
    DETAIL_STATUS="pending"
    return 1
  fi

  if grep -Eq "&lt;/?(p|h[1-6]|br|div|ul|ol|li)([[:space:]][^&]*)?&gt;" "$xml_file"; then
    DETAIL_STATUS="raw_html"
    return 1
  fi

  if [[ -n "$EXPECTED_DURATION_TEXT" ]] && ! grep -q "text=\"$EXPECTED_DURATION_TEXT\"" "$xml_file"; then
    DETAIL_STATUS="duration_mismatch"
    return 1
  fi

  if ! grep -q "公众号草稿审核" "$xml_file"; then
    DETAIL_STATUS="missing_review_card"
    return 1
  fi

  if ! grep -q "导出材料包" "$xml_file"; then
    DETAIL_STATUS="missing_export_action"
    return 1
  fi

  if ! grep -q "查看处理进度说明" "$xml_file"; then
    DETAIL_STATUS="missing_status_help"
    return 1
  fi

  if grep -q "原始识别结果\\|转录完成" "$xml_file"; then
    DETAIL_STATUS="completed"
    return 0
  fi

  DETAIL_STATUS="unknown"
  return 1
}

capture_detail_scroll_evidence() {
  local pages="${DETAIL_SCROLL_PAGES:-3}"
  local width height tap_x start_y end_y i bounds
  local xml_all="$OUT_DIR/window-all.xml"

  if [[ ! "$pages" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if (( pages <= 0 )); then
    return 0
  fi

  bounds="$(
    grep -o 'bounds="\[[0-9,]*\]\[[0-9,]*\]"' "$OUT_DIR/window.xml" \
      | sed 's/bounds="\[\([0-9][0-9]*\),\([0-9][0-9]*\)\]\[\([0-9][0-9]*\),\([0-9][0-9]*\)\]"/\1 \2 \3 \4/' \
      | awk '
          {
            width = $3 - $1
            height = $4 - $2
            area = width * height
            if (area > maxArea) {
              maxArea = area
              bestWidth = width
              bestHeight = height
            }
          }
          END {
            if (bestWidth > 0 && bestHeight > 0) {
              print bestWidth, bestHeight
            }
          }
        '
  )"
  if [[ -n "$bounds" ]]; then
    width="$(printf '%s\n' "$bounds" | awk '{ print $1 }')"
    height="$(printf '%s\n' "$bounds" | awk '{ print $2 }')"
  else
    width="$(screen_width)"
    height="$(screen_height)"
  fi

  tap_x=$((width / 2))
  start_y=$((height * 82 / 100))
  end_y=$((height * 28 / 100))

  : > "$xml_all"
  if [[ -f "$OUT_DIR/window.xml" ]]; then
    cat "$OUT_DIR/window.xml" >> "$xml_all"
    printf '\n' >> "$xml_all"
  fi

  for ((i = 1; i <= pages; i++)); do
    adb_shell input swipe "$tap_x" "$start_y" "$tap_x" "$end_y" 450 >/dev/null 2>&1 || true
    sleep 1
    adb_shell screencap -p "/sdcard/vibepub-detail-scroll-$i.png" >/dev/null 2>&1 || true
    pull_if_exists "/sdcard/vibepub-detail-scroll-$i.png" "$OUT_DIR/detail-scroll-$i.png"
    adb_shell uiautomator dump "/sdcard/vibepub-window-scroll-$i.xml" >/dev/null 2>&1 || true
    pull_if_exists "/sdcard/vibepub-window-scroll-$i.xml" "$OUT_DIR/window-scroll-$i.xml"
    if [[ -f "$OUT_DIR/window-scroll-$i.xml" ]]; then
      cat "$OUT_DIR/window-scroll-$i.xml" >> "$xml_all"
      printf '\n' >> "$xml_all"
    fi
  done
}

cleanup() {
  if [[ -n "${SCREENRECORD_PID:-}" ]]; then
    kill "$SCREENRECORD_PID" >/dev/null 2>&1 || true
    adb_shell pkill -f screenrecord >/dev/null 2>&1 || true
  fi

  if [[ -d "${OUT_DIR:-}" && ! -f "$OUT_DIR/logcat.txt" ]]; then
    adb logcat -d > "$OUT_DIR/logcat.txt" 2>/dev/null || true
  fi
}

supports_adb_tap() {
  local output
  if output="$(adb_shell input tap 1 1 2>&1)"; then
    return 0
  fi
  if [[ "$output" == *"INJECT_EVENTS"* ]]; then
    return 1
  fi
  echo "$output" >&2
  return 1
}

read_debug_status() {
  adb shell "run-as '$PACKAGE_NAME' cat files/debug-device-test-status.json" \
    > "$OUT_DIR/debug-device-test-status.json" 2>/dev/null
}

require_debug_status() {
  local expected_regex="$1"
  local label="$2"

  for _ in 1 2 3 4 5; do
    if read_debug_status; then
      if grep -Eq "\"status\"[[:space:]]*:[[:space:]]*\"($expected_regex)\"" "$OUT_DIR/debug-device-test-status.json"; then
        return 0
      fi
      if grep -Eq "\"status\"[[:space:]]*:[[:space:]]*\"ERROR\"" "$OUT_DIR/debug-device-test-status.json"; then
        echo "Debug recording $label failed:" >&2
        cat "$OUT_DIR/debug-device-test-status.json" >&2
        exit 1
      fi
    fi
    sleep 1
  done

  cat >&2 <<EOF
Timed out waiting for debug recording status: $label

Expected status pattern:
  $expected_regex

This usually means the APK does not contain the debug-only recording control
receiver. Use a debug APK built from the current source, or set
AUTOMATION_MODE=ui-tap on devices that allow ADB input tap.
EOF
  if [[ -f "$OUT_DIR/debug-device-test-status.json" ]]; then
    cat "$OUT_DIR/debug-device-test-status.json" >&2
  fi
  exit 1
}

recording_filename_from_debug_status() {
  if [[ ! -f "$OUT_DIR/debug-device-test-status.json" ]]; then
    return 1
  fi

  sed -n 's/.*"filename"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$OUT_DIR/debug-device-test-status.json" | head -n 1
}

recording_duration_text_from_debug_status() {
  local duration_ms
  if [[ ! -f "$OUT_DIR/debug-device-test-status.json" ]]; then
    return 1
  fi

  duration_ms="$(sed -n 's/.*"durationMs"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    "$OUT_DIR/debug-device-test-status.json" | head -n 1)"
  if [[ -z "$duration_ms" ]]; then
    return 1
  fi

  printf '%d:%02d\n' "$((duration_ms / 60000))" "$(((duration_ms % 60000) / 1000))"
}

import_audio_fixture_to_app() {
  local source_file="$1"
  local source_ext
  local remote_path
  source_ext="${source_file##*.}"
  source_ext="$(printf '%s' "$source_ext" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  if [[ -z "$source_ext" || "$source_ext" == "$source_file" ]]; then
    source_ext="audio"
  fi
  remote_path="debug-input/audio-fixture.$source_ext"

  echo "Pushing audio fixture into app private storage..." >&2
  adb push "$source_file" /data/local/tmp/vibepub-audio-fixture \
    > "$OUT_DIR/debug-audio-push.txt"
  adb shell "run-as '$PACKAGE_NAME' sh -c 'mkdir -p files/debug-input && cat > \"files/$remote_path\"' < /data/local/tmp/vibepub-audio-fixture" \
    > "$OUT_DIR/debug-audio-import-copy.txt" 2>&1
  adb_shell rm -f /data/local/tmp/vibepub-audio-fixture >/dev/null 2>&1 || true

  printf '%s\n' "$remote_path" > "$OUT_DIR/debug-audio-app-path.txt"
  printf '%s\n' "$remote_path"
}

fetch_backend_recording_status() {
  local filename="$1"
  local api_base="${API_BASE_URL:-https://vibepub.litianc.cn}"
  local response_file="$OUT_DIR/recordings-api.json"
  local object_line

  if [[ -z "$FILES_TOKEN" ]]; then
    return 1
  fi

  if ! curl -fsS \
    -H "Authorization: Bearer $FILES_TOKEN" \
    "$api_base/api/recordings" > "$response_file.tmp"; then
    rm -f "$response_file.tmp"
    return 1
  fi
  mv "$response_file.tmp" "$response_file"

  object_line="$(tr '\n' ' ' < "$response_file" \
    | sed 's/[[:space:]]//g' \
    | tr '{' '\n' \
    | grep -F "\"filename\":\"$filename\"" \
    | head -n 1 || true)"
  if [[ -z "$object_line" ]]; then
    return 1
  fi

  printf '%s\n' "$object_line" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n 1
}

wait_for_backend_recording() {
  local filename="$1"
  local deadline=$((SECONDS + BACKEND_UPLOAD_WAIT_SECONDS))
  local status

  while (( SECONDS < deadline )); do
    status="$(fetch_backend_recording_status "$filename" || true)"
    if [[ -n "$status" ]]; then
      BACKEND_RECORDING_STATUS="$status"
      printf '%s\n' "$status" > "$OUT_DIR/backend-recording-status.txt"
      return 0
    fi
    sleep 5
  done

  cat >&2 <<EOF
Timed out waiting for the phone upload to appear in backend recordings.

Filename:
  $filename

Check:
  $OUT_DIR/logcat.txt
  $OUT_DIR/debug-device-test-status.json
EOF
  return 1
}

wait_for_backend_completion() {
  local filename="$1"
  local wait_seconds="$2"
  local deadline=$((SECONDS + wait_seconds))
  local status

  while (( SECONDS < deadline )); do
    status="$(fetch_backend_recording_status "$filename" || true)"
    if [[ -n "$status" ]]; then
      BACKEND_RECORDING_STATUS="$status"
      printf '%s\n' "$status" > "$OUT_DIR/backend-recording-status.txt"
      case "$status" in
        COMPLETED)
          return 0
          ;;
        FAILED)
          echo "Backend marked the recording as FAILED: $filename" >&2
          return 1
          ;;
      esac
    fi
    sleep 5
  done

  return 1
}

latest_workflow_dispatch_run_id() {
  gh run list \
    --workflow "$MINING_WORKFLOW_ID" \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // ""' 2>/dev/null || true
}

trigger_and_wait_for_mining_job() {
  local previous_run_id="$1"
  local run_id=""
  local deadline=$((SECONDS + MINING_WAIT_SECONDS))
  local run_tsv status conclusion run_url

  echo "Triggering GitHub Actions workflow: $MINING_WORKFLOW_ID ($MINING_WORKFLOW_REF)"
  if ! gh workflow run "$MINING_WORKFLOW_ID" --ref "$MINING_WORKFLOW_REF" \
    > "$OUT_DIR/mining-workflow-dispatch.txt" 2>&1; then
    cat "$OUT_DIR/mining-workflow-dispatch.txt" >&2
    return 1
  fi

  while (( SECONDS < deadline )); do
    run_id="$(latest_workflow_dispatch_run_id)"
    if [[ -n "$run_id" && "$run_id" != "$previous_run_id" ]]; then
      break
    fi
    sleep 3
  done

  if [[ -z "$run_id" || "$run_id" == "$previous_run_id" ]]; then
    echo "Could not find the dispatched mining workflow run." >&2
    return 1
  fi

  printf '%s\n' "$run_id" > "$OUT_DIR/mining-run-id.txt"
  echo "Waiting for mining workflow run: $run_id"

  while (( SECONDS < deadline )); do
    run_tsv="$(gh run view "$run_id" \
      --json status,conclusion,url \
      --jq '[.status, (.conclusion // ""), .url] | @tsv' 2>/dev/null || true)"
    if [[ -n "$run_tsv" ]]; then
      printf '%s\n' "$run_tsv" > "$OUT_DIR/mining-run-status.tsv"
      status="$(printf '%s\n' "$run_tsv" | awk -F '\t' '{ print $1 }')"
      conclusion="$(printf '%s\n' "$run_tsv" | awk -F '\t' '{ print $2 }')"
      run_url="$(printf '%s\n' "$run_tsv" | awk -F '\t' '{ print $3 }')"
      printf '%s\n' "$run_url" > "$OUT_DIR/mining-run-url.txt"

      if [[ "$status" == "completed" ]]; then
        gh run view "$run_id" --log > "$OUT_DIR/mining-run.log" 2>"$OUT_DIR/mining-run-log.err" || true
        if [[ "$conclusion" == "success" ]]; then
          return 0
        fi
        echo "Mining workflow completed with conclusion: $conclusion" >&2
        gh run view "$run_id" --log-failed > "$OUT_DIR/mining-run-failed.log" 2>/dev/null || true
        if wait_for_backend_completion "$LATEST_RECORDING_FILENAME" "$BACKEND_COMPLETION_WAIT_SECONDS"; then
          echo "Target recording completed even though the mining workflow failed."
          return 0
        fi
        return 1
      fi
    fi
    sleep 5
  done

  echo "Timed out waiting for mining workflow to finish." >&2
  return 1
}

maybe_run_mining_job_for_latest_recording() {
  local filename="$1"
  local previous_run_id

  if ! truthy "$TRIGGER_MINING_JOB"; then
    return 0
  fi

  if [[ -z "$filename" ]]; then
    echo "Cannot trigger mining job because no recording filename was captured." >&2
    return 1
  fi

  require_cmd gh
  require_cmd curl

  if [[ -z "$FILES_TOKEN" ]]; then
    echo "TRIGGER_MINING_JOB=true requires FILES_TOKEN." >&2
    return 1
  fi

  echo "Waiting for backend upload record: $filename"
  wait_for_backend_recording "$filename"

  if [[ "$BACKEND_RECORDING_STATUS" == "COMPLETED" ]]; then
    echo "Backend recording is already COMPLETED."
    return 0
  fi

  if [[ "$BACKEND_RECORDING_STATUS" == "PROCESSING" ]]; then
    echo "Backend recording is already PROCESSING; waiting for completion."
    wait_for_backend_completion "$filename" "$MINING_WAIT_SECONDS"
    return $?
  fi

  previous_run_id="$(latest_workflow_dispatch_run_id)"
  printf '%s\n' "$previous_run_id" > "$OUT_DIR/mining-previous-run-id.txt"

  trigger_and_wait_for_mining_job "$previous_run_id"
  wait_for_backend_completion "$filename" "$BACKEND_COMPLETION_WAIT_SECONDS"
}

screen_width() {
  adb_shell wm size | awk -F'[: x]+' '/Physical size/ { print $3 }'
}

screen_height() {
  adb_shell wm size | awk -F'[: x]+' '/Physical size/ { print $4 }'
}

xml_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g" \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g'
}

write_app_preferences() {
  if [[ -z "$API_BASE_URL" && -z "$FILES_TOKEN" ]]; then
    return 0
  fi

  local api_value="${API_BASE_URL:-https://vibepub.litianc.cn}"
  local token_value="$FILES_TOKEN"
  local tmp_file
  tmp_file="$(mktemp)"

  {
    printf '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n'
    printf '<map>\n'
    printf '    <string name="api_base_url">%s</string>\n' "$(printf '%s' "$api_value" | xml_escape)"
    printf '    <string name="files_token">%s</string>\n' "$(printf '%s' "$token_value" | xml_escape)"
    printf '</map>\n'
  } > "$tmp_file"

  adb push "$tmp_file" /data/local/tmp/vibepub-prefs.xml >/dev/null
  rm -f "$tmp_file"

  if adb shell "cat /data/local/tmp/vibepub-prefs.xml | run-as '$PACKAGE_NAME' sh -c 'mkdir -p shared_prefs && cat > shared_prefs/vibepub.xml && chmod 600 shared_prefs/vibepub.xml'" >/dev/null 2>&1; then
    echo "Injected app preferences: API_BASE_URL=${api_value}, FILES_TOKEN=$(if [[ -n "$token_value" ]]; then printf 'set'; else printf 'empty'; fi)"
  else
    cat >&2 <<EOF
Could not inject app preferences with run-as.

This usually means the APK is not debuggable, or the device blocks run-as.
Use a debug APK for automated backend tests, or set REQUIRE_PREFS_INJECTION=false.
EOF
    if truthy "$REQUIRE_PREFS_INJECTION"; then
      exit 1
    fi
  fi

  adb_shell rm -f /data/local/tmp/vibepub-prefs.xml >/dev/null 2>&1 || true
}

require_cmd adb
trap cleanup EXIT

if [[ "$AUTOMATION_MODE" != "debug-broadcast" && "$AUTOMATION_MODE" != "ui-tap" ]]; then
  echo "Invalid AUTOMATION_MODE: $AUTOMATION_MODE" >&2
  echo "Use debug-broadcast or ui-tap." >&2
  exit 1
fi

if [[ "$DEBUG_AUDIO_MODE" != "import" && "$DEBUG_AUDIO_MODE" != "speaker" ]]; then
  echo "Invalid DEBUG_AUDIO_MODE: $DEBUG_AUDIO_MODE" >&2
  echo "Use import or speaker." >&2
  exit 1
fi

if [[ -n "$AUDIO_FILE" ]]; then
  if [[ "$AUTOMATION_MODE" != "debug-broadcast" || "$DEBUG_AUDIO_MODE" == "speaker" ]]; then
    require_cmd afplay
  fi
  if [[ ! -f "$AUDIO_FILE" ]]; then
    echo "AUDIO_FILE not found: $AUDIO_FILE" >&2
    exit 1
  fi
fi

if [[ ! -f "$APK_PATH" ]]; then
  if truthy "$SKIP_INSTALL"; then
    echo "APK not found locally, but SKIP_INSTALL=true; using installed app on device."
  else
    echo "APK not found: $APK_PATH" >&2
    echo "Download the APK from GitHub Actions, or build it in CI first." >&2
    exit 1
  fi
fi

mkdir -p "$OUT_DIR"

echo "Checking connected Android device..."
adb start-server >/dev/null
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  device_count="$(adb devices | awk -v serial="$ANDROID_SERIAL" 'NR > 1 && $1 == serial && $2 == "device" { count++ } END { print count + 0 }')"
else
  device_count="$(adb devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')"
fi
if [[ "$device_count" -eq 0 ]]; then
  cat >&2 <<EOF
No authorized Android device found.

On the phone:
  1. Enable Developer options.
  2. Enable USB debugging.
  3. Connect it by USB.
  4. Accept the "Allow USB debugging" prompt.

Then rerun:
  adb devices
EOF
  exit 1
fi

if [[ "$device_count" -gt 1 ]]; then
  echo "More than one device is connected. Set ANDROID_SERIAL before running." >&2
  adb devices >&2
  exit 1
fi

echo "Writing evidence to: $OUT_DIR"
adb devices > "$OUT_DIR/adb-devices.txt"
adb_shell getprop ro.product.model > "$OUT_DIR/device-model.txt" || true
adb_shell getprop ro.build.version.release > "$OUT_DIR/android-version.txt" || true

if truthy "$RESET_APP_DATA" && ! truthy "$SKIP_INSTALL"; then
  echo "Uninstalling existing app for deterministic test run..."
  if ! adb uninstall "$PACKAGE_NAME" > "$OUT_DIR/uninstall-for-reset.txt" 2>&1; then
    if ! grep -q "Unknown package" "$OUT_DIR/uninstall-for-reset.txt"; then
      cat "$OUT_DIR/uninstall-for-reset.txt" >&2
      exit 1
    fi
  fi
fi

if truthy "$SKIP_INSTALL"; then
  echo "Skipping APK install; using package already installed on the phone."
  adb_shell dumpsys package "$PACKAGE_NAME" > "$OUT_DIR/installed-package.txt" 2>&1 || {
    echo "Package is not installed on the phone: $PACKAGE_NAME" >&2
    exit 1
  }
else
  echo "Installing APK: $APK_PATH"
  if ! install_apk "$APK_PATH"; then
    if [[ -f "$OUT_DIR/install.txt" ]] && grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
      cat >&2 <<EOF

The phone blocked APK installation from adb.

On Xiaomi/MIUI/HyperOS devices, enable Developer options items usually named:
  Install via USB
  USB debugging (Security settings)

Chinese labels may be:
  USB 安装
  USB 调试（安全设置）
  允许通过 USB 调试修改权限或模拟点击

Then reconnect USB if needed and rerun the script.
EOF
    fi
    exit 1
  fi
fi

if truthy "$RESET_APP_DATA"; then
  echo "Clearing installed app data for deterministic test run..."
  if ! adb_shell pm clear "$PACKAGE_NAME" > "$OUT_DIR/pm-clear-after-install.txt" 2>&1; then
    cat "$OUT_DIR/pm-clear-after-install.txt" >&2
    exit 1
  fi
fi

echo "Granting permissions where possible..."
grant_recording_permissions
adb_shell dumpsys package "$PACKAGE_NAME" > "$OUT_DIR/package-after-permissions.txt" 2>&1 || true
adb_shell appops get "$PACKAGE_NAME" RECORD_AUDIO > "$OUT_DIR/appops-record-audio.txt" 2>&1 || true

write_app_preferences

echo "Clearing logcat and launching app..."
wake_device
adb_shell dumpsys power > "$OUT_DIR/power-before-launch.txt" 2>&1 || true
adb_shell dumpsys window > "$OUT_DIR/window-before-launch.txt" 2>&1 || true
adb logcat -c || true
adb_shell am start -n "$PACKAGE_NAME/$ACTIVITY_NAME" > "$OUT_DIR/launch.txt"
sleep 3
wait_for_app_focus || true

echo "Capturing launch screenshot..."
adb_shell screencap -p /sdcard/vibepub-launch.png
adb pull /sdcard/vibepub-launch.png "$OUT_DIR/01-launch.png" >/dev/null

if [[ -n "$AUDIO_FILE" ]]; then
  LATEST_RECORDING_FILENAME=""
  EXPECTED_DURATION_TEXT=""

  if [[ "$AUTOMATION_MODE" == "ui-tap" ]] && ! supports_adb_tap; then
    cat > "$OUT_DIR/blocker-adb-input.txt" <<EOF
ADB input tap is blocked by the connected Android device.

On Xiaomi/MIUI/HyperOS devices, enable the extra developer option usually named:
  USB debugging (Security settings)

Chinese labels may be:
  USB 调试（安全设置）
  允许通过 USB 调试修改权限或模拟点击

After enabling it, reconnect USB if needed and rerun:
  adb shell input tap 1 1

The command must return no SecurityException.
EOF
    cat "$OUT_DIR/blocker-adb-input.txt" >&2
    exit 1
  fi

  width="$(screen_width)"
  height="$(screen_height)"
  record_tap_x="${RECORD_TAP_X:-$((width / 2))}"
  record_tap_y="${RECORD_TAP_Y:-$((height - 260))}"
  stop_tap_x="${STOP_TAP_X:-$((width / 2))}"
  stop_tap_y="${STOP_TAP_Y:-$((height - 300))}"
  first_item_tap_x="${FIRST_ITEM_TAP_X:-$((width / 2))}"
  first_item_tap_y="${FIRST_ITEM_TAP_Y:-$((height * 27 / 100))}"

  cat <<EOF

Automated mode is enabled.
Mode:
  $AUTOMATION_MODE

Debug audio mode:
  $DEBUG_AUDIO_MODE

Audio file:
  $AUDIO_FILE

Tap coordinates:
  record:     $record_tap_x,$record_tap_y
  stop:       $stop_tap_x,$stop_tap_y
  first item: $first_item_tap_x,$first_item_tap_y
EOF

  if [[ "$AUTOMATION_MODE" != "debug-broadcast" || "$DEBUG_AUDIO_MODE" == "speaker" ]]; then
    cat <<EOF

Keep the phone near the Mac speaker in a quiet room. The app will record what
the physical phone microphone hears from the Mac speaker.
EOF
  fi

  adb_shell rm -f /sdcard/vibepub-visual-test.mp4
  adb_shell screenrecord --time-limit "$RECORD_SECONDS" /sdcard/vibepub-visual-test.mp4 >/dev/null 2>&1 &
  SCREENRECORD_PID="$!"

  sleep "$START_DELAY_SECONDS"
  if [[ "$AUTOMATION_MODE" == "debug-broadcast" && "$DEBUG_AUDIO_MODE" == "import" ]]; then
    wake_device
    adb_shell am start -n "$PACKAGE_NAME/$ACTIVITY_NAME" > "$OUT_DIR/foreground-before-import.txt" 2>&1 || true
    wait_for_app_focus
    local_audio_path="$(import_audio_fixture_to_app "$AUDIO_FILE")"
    echo "Importing audio fixture through debug broadcast..."
    adb_shell am broadcast \
      -a "$DEBUG_IMPORT_AUDIO_ACTION" \
      -p "$PACKAGE_NAME" \
      --es audio_path "$local_audio_path" \
      > "$OUT_DIR/debug-import-broadcast.txt"
    require_debug_status "IMPORTED|IMPORTED_WITHOUT_UPLOAD_TOKEN" "import"
    LATEST_RECORDING_FILENAME="$(recording_filename_from_debug_status || true)"
    EXPECTED_DURATION_TEXT="$(recording_duration_text_from_debug_status || true)"
    if [[ -n "$LATEST_RECORDING_FILENAME" ]]; then
      printf '%s\n' "$LATEST_RECORDING_FILENAME" > "$OUT_DIR/latest-recording-filename.txt"
    fi
    if [[ -n "$EXPECTED_DURATION_TEXT" ]]; then
      printf '%s\n' "$EXPECTED_DURATION_TEXT" > "$OUT_DIR/expected-duration-text.txt"
    fi
  elif [[ "$AUTOMATION_MODE" == "debug-broadcast" ]]; then
    wake_device
    adb_shell am start -n "$PACKAGE_NAME/$ACTIVITY_NAME" > "$OUT_DIR/foreground-before-recording.txt" 2>&1 || true
    wait_for_app_focus
    grant_recording_permissions
    adb_shell dumpsys package "$PACKAGE_NAME" > "$OUT_DIR/package-before-recording.txt" 2>&1 || true
    adb_shell appops get "$PACKAGE_NAME" RECORD_AUDIO > "$OUT_DIR/appops-before-recording.txt" 2>&1 || true
    echo "Starting recording through debug broadcast..."
    adb_shell am broadcast -a "$DEBUG_START_ACTION" -p "$PACKAGE_NAME" > "$OUT_DIR/debug-start-broadcast.txt"
    require_debug_status "STARTED" "start"
  else
    echo "Tapping record..."
    adb_shell input tap "$record_tap_x" "$record_tap_y"
    sleep 1

    echo "Playing audio through Mac speaker..."
    afplay "$AUDIO_FILE"
    sleep 1
  fi

  if [[ "$AUTOMATION_MODE" == "debug-broadcast" && "$DEBUG_AUDIO_MODE" == "speaker" ]]; then
    echo "Stopping recording through debug broadcast..."
    adb_shell am broadcast -a "$DEBUG_STOP_ACTION" -p "$PACKAGE_NAME" > "$OUT_DIR/debug-stop-broadcast.txt"
    require_debug_status "STOPPED|STOPPED_WITHOUT_UPLOAD_TOKEN" "stop"
    LATEST_RECORDING_FILENAME="$(recording_filename_from_debug_status || true)"
    EXPECTED_DURATION_TEXT="$(recording_duration_text_from_debug_status || true)"
    if [[ -n "$LATEST_RECORDING_FILENAME" ]]; then
      printf '%s\n' "$LATEST_RECORDING_FILENAME" > "$OUT_DIR/latest-recording-filename.txt"
    fi
    if [[ -n "$EXPECTED_DURATION_TEXT" ]]; then
      printf '%s\n' "$EXPECTED_DURATION_TEXT" > "$OUT_DIR/expected-duration-text.txt"
    fi
  elif [[ "$AUTOMATION_MODE" == "ui-tap" ]]; then
    echo "Tapping stop..."
    adb_shell input tap "$stop_tap_x" "$stop_tap_y"
  fi
  sleep "$POST_STOP_WAIT_SECONDS"

  echo "Capturing home-after-record screenshot..."
  adb_shell screencap -p /sdcard/vibepub-after-record.png
  adb pull /sdcard/vibepub-after-record.png "$OUT_DIR/02-after-record.png" >/dev/null

  if truthy "$TRIGGER_MINING_JOB"; then
    maybe_run_mining_job_for_latest_recording "$LATEST_RECORDING_FILENAME"
  fi

  echo "Opening first recording..."
  if [[ "$AUTOMATION_MODE" == "debug-broadcast" ]]; then
    if [[ -n "$LATEST_RECORDING_FILENAME" ]]; then
      adb_shell am start \
        -n "$PACKAGE_NAME/.debug.DebugLatestRecordingActivity" \
        --es filename "$LATEST_RECORDING_FILENAME" \
        > "$OUT_DIR/open-latest-detail.txt"
    else
      adb_shell am start -n "$PACKAGE_NAME/.debug.DebugLatestRecordingActivity" > "$OUT_DIR/open-latest-detail.txt"
    fi
  else
    adb_shell input tap "$first_item_tap_x" "$first_item_tap_y"
  fi
  sleep "$DETAIL_WAIT_SECONDS"

  echo "Capturing detail screenshot..."
  adb_shell screencap -p /sdcard/vibepub-detail.png
  adb pull /sdcard/vibepub-detail.png "$OUT_DIR/03-detail.png" >/dev/null

  wait "$SCREENRECORD_PID" || true
  SCREENRECORD_PID=""
else
  cat <<EOF

The phone is now ready for visual testing.

Suggested manual flow while the recording runs:
  1. Tap the red record button in the app.
  2. Speak for 5-10 seconds.
  3. Tap stop.
  4. Wait for the home list to update.
  5. Open the recording detail page.

The script will record the phone screen for ${RECORD_SECONDS}s.
EOF

  adb_shell rm -f /sdcard/vibepub-visual-test.mp4
  adb_shell screenrecord --time-limit "$RECORD_SECONDS" /sdcard/vibepub-visual-test.mp4 || true
fi

echo "Capturing final screenshot and UI dump..."
adb_shell screencap -p /sdcard/vibepub-final.png
adb pull /sdcard/vibepub-final.png "$OUT_DIR/final.png" >/dev/null
pull_if_exists /sdcard/vibepub-visual-test.mp4 "$OUT_DIR/vibepub-visual-test.mp4"
adb_shell uiautomator dump /sdcard/vibepub-window.xml >/dev/null 2>&1 || true
pull_if_exists /sdcard/vibepub-window.xml "$OUT_DIR/window.xml"
if [[ -n "$AUDIO_FILE" ]]; then
  capture_detail_scroll_evidence
fi
if [[ -n "$AUDIO_FILE" ]]; then
  if evaluate_detail_result "$OUT_DIR/window-all.xml"; then
    echo "Transcript detail assertion: completed"
  else
    echo "Transcript detail assertion: $DETAIL_STATUS" >&2
  fi
fi

echo "Collecting logs..."
adb logcat -d > "$OUT_DIR/logcat.txt" || true

cat > "$OUT_DIR/checklist.md" <<EOF
# VibePub Device Visual Test

- APK: \`$APK_PATH\`
- Package: \`$PACKAGE_NAME\`
- Recorded seconds: \`$RECORD_SECONDS\`
- Audio file: \`${AUDIO_FILE:-manual}\`
- API base URL: \`${API_BASE_URL:-app default}\`
- Reset app data: \`$RESET_APP_DATA\`
- Automation mode: \`$AUTOMATION_MODE\`
- Debug audio mode: \`$DEBUG_AUDIO_MODE\`
- Skip install: \`$SKIP_INSTALL\`
- Trigger mining job: \`$TRIGGER_MINING_JOB\`
- Latest recording filename: \`${LATEST_RECORDING_FILENAME:-not_captured}\`
- Expected duration text: \`${EXPECTED_DURATION_TEXT:-not_checked}\`
- Backend recording status: \`${BACKEND_RECORDING_STATUS:-not_checked}\`
- Mining workflow run: \`$(if [[ -f "$OUT_DIR/mining-run-url.txt" ]]; then cat "$OUT_DIR/mining-run-url.txt"; else printf 'not_run'; fi)\`

Review:

- [ ] \`01-launch.png\` shows VibePub home screen.
- [ ] \`vibepub-visual-test.mp4\` shows one recording flow.
- [ ] \`02-after-record.png\` or \`final.png\` shows only one new recording for one recording attempt.
- [ ] No duplicate 0-second rows appear for the same time.
- [ ] \`03-detail.png\` or \`final.png\` shows transcript/article content after processing finishes.
- [ ] \`logcat.txt\` has no obvious upload/sync/transcript errors.

Automated assertion:

- Transcript detail status: \`$DETAIL_STATUS\`
EOF

if [[ -n "$AUDIO_FILE" && "$DETAIL_STATUS" != "completed" ]]; then
  case "$DETAIL_STATUS" in
    failed)
      echo "Transcript processing failed; see final.png, window.xml, and logcat.txt." >&2
      ;;
    pending)
      echo "Transcript was still pending at the end of the smoke test." >&2
      ;;
    *)
      echo "Transcript assertion did not complete: $DETAIL_STATUS" >&2
      ;;
  esac
  exit 1
fi

echo
echo "Done."
echo "Evidence directory:"
echo "  $OUT_DIR"
