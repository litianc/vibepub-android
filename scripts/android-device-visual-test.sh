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
START_DELAY_SECONDS="${START_DELAY_SECONDS:-1}"
POST_STOP_WAIT_SECONDS="${POST_STOP_WAIT_SECONDS:-5}"
DETAIL_WAIT_SECONDS="${DETAIL_WAIT_SECONDS:-8}"
DEBUG_START_ACTION="cn.litianc.vibepub.DEBUG_START_RECORDING"
DEBUG_STOP_ACTION="cn.litianc.vibepub.DEBUG_STOP_RECORDING"
SCREENRECORD_PID=""

usage() {
  cat <<EOF
Usage:
  scripts/android-device-visual-test.sh [path/to/app-debug.apk]

Environment:
  OUT_DIR          Output directory for screenshots, video, logs.
  RECORD_SECONDS  Screen recording length after launch. Default: 20.
  AUDIO_FILE      Optional local audio file. If set, the script automatically
                  taps record, plays this audio through the Mac speaker, stops
                  recording, opens the first recording, and captures evidence.
  API_BASE_URL    Optional API base URL to inject into app preferences.
  FILES_TOKEN     Optional upload/files token to inject into app preferences.
  RESET_APP_DATA  Set to true to clear app data before the run. Default: false.
  REQUIRE_PREFS_INJECTION
                  Fail if API_BASE_URL/FILES_TOKEN injection fails. Default: true.
  AUTOMATION_MODE debug-broadcast or ui-tap. Default: debug-broadcast.
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

truthy() {
  [[ "${1:-}" == "true" || "${1:-}" == "1" || "${1:-}" == "yes" ]]
}

adb_shell() {
  adb shell "$@"
}

pull_if_exists() {
  local remote="$1"
  local local_path="$2"
  if adb_shell test -f "$remote" >/dev/null 2>&1; then
    adb pull "$remote" "$local_path" >/dev/null
  fi
}

cleanup() {
  if [[ -n "${SCREENRECORD_PID:-}" ]]; then
    kill "$SCREENRECORD_PID" >/dev/null 2>&1 || true
    adb_shell pkill -f screenrecord >/dev/null 2>&1 || true
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

if [[ -n "$AUDIO_FILE" ]]; then
  require_cmd afplay
  if [[ ! -f "$AUDIO_FILE" ]]; then
    echo "AUDIO_FILE not found: $AUDIO_FILE" >&2
    exit 1
  fi
fi

if [[ ! -f "$APK_PATH" ]]; then
  echo "APK not found: $APK_PATH" >&2
  echo "Download the APK from GitHub Actions, or build it in CI first." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Checking connected Android device..."
adb start-server >/dev/null
device_count="$(adb devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')"
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

if truthy "$RESET_APP_DATA"; then
  echo "Uninstalling existing app for deterministic test run..."
  if ! adb uninstall "$PACKAGE_NAME" > "$OUT_DIR/uninstall-for-reset.txt" 2>&1; then
    if ! grep -q "Unknown package" "$OUT_DIR/uninstall-for-reset.txt"; then
      cat "$OUT_DIR/uninstall-for-reset.txt" >&2
      exit 1
    fi
  fi
fi

echo "Installing APK: $APK_PATH"
if ! adb install -r "$APK_PATH" > "$OUT_DIR/install.txt" 2>&1; then
  cat "$OUT_DIR/install.txt" >&2
  if grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
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

echo "Granting permissions where possible..."
adb_shell pm grant "$PACKAGE_NAME" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
adb_shell pm grant "$PACKAGE_NAME" android.permission.ACCESS_COARSE_LOCATION >/dev/null 2>&1 || true
adb_shell pm grant "$PACKAGE_NAME" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

write_app_preferences

echo "Clearing logcat and launching app..."
adb logcat -c || true
adb_shell am start -n "$PACKAGE_NAME/$ACTIVITY_NAME" > "$OUT_DIR/launch.txt"
sleep 3

echo "Capturing launch screenshot..."
adb_shell screencap -p /sdcard/vibepub-launch.png
adb pull /sdcard/vibepub-launch.png "$OUT_DIR/01-launch.png" >/dev/null

if [[ -n "$AUDIO_FILE" ]]; then
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

Audio file:
  $AUDIO_FILE

Tap coordinates:
  record:     $record_tap_x,$record_tap_y
  stop:       $stop_tap_x,$stop_tap_y
  first item: $first_item_tap_x,$first_item_tap_y

Keep the phone near the Mac speaker in a quiet room. The app will record what
the physical phone microphone hears from the Mac speaker.
EOF

  adb_shell rm -f /sdcard/vibepub-visual-test.mp4
  adb_shell screenrecord --time-limit "$RECORD_SECONDS" /sdcard/vibepub-visual-test.mp4 >/dev/null 2>&1 &
  SCREENRECORD_PID="$!"

  sleep "$START_DELAY_SECONDS"
  if [[ "$AUTOMATION_MODE" == "debug-broadcast" ]]; then
    echo "Starting recording through debug broadcast..."
    adb_shell am broadcast -a "$DEBUG_START_ACTION" -p "$PACKAGE_NAME" > "$OUT_DIR/debug-start-broadcast.txt"
    require_debug_status "STARTED" "start"
  else
    echo "Tapping record..."
    adb_shell input tap "$record_tap_x" "$record_tap_y"
  fi
  sleep 1

  echo "Playing audio through Mac speaker..."
  afplay "$AUDIO_FILE"
  sleep 1

  if [[ "$AUTOMATION_MODE" == "debug-broadcast" ]]; then
    echo "Stopping recording through debug broadcast..."
    adb_shell am broadcast -a "$DEBUG_STOP_ACTION" -p "$PACKAGE_NAME" > "$OUT_DIR/debug-stop-broadcast.txt"
    require_debug_status "STOPPED|STOPPED_WITHOUT_UPLOAD_TOKEN" "stop"
  else
    echo "Tapping stop..."
    adb_shell input tap "$stop_tap_x" "$stop_tap_y"
  fi
  sleep "$POST_STOP_WAIT_SECONDS"

  echo "Capturing home-after-record screenshot..."
  adb_shell screencap -p /sdcard/vibepub-after-record.png
  adb pull /sdcard/vibepub-after-record.png "$OUT_DIR/02-after-record.png" >/dev/null

  echo "Opening first recording..."
  if [[ "$AUTOMATION_MODE" == "debug-broadcast" ]]; then
    adb_shell am start -n "$PACKAGE_NAME/.debug.DebugLatestRecordingActivity" > "$OUT_DIR/open-latest-detail.txt"
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

Review:

- [ ] \`01-launch.png\` shows VibePub home screen.
- [ ] \`vibepub-visual-test.mp4\` shows one recording flow.
- [ ] \`02-after-record.png\` or \`final.png\` shows only one new recording for one recording attempt.
- [ ] No duplicate 0-second rows appear for the same time.
- [ ] \`03-detail.png\` or \`final.png\` shows transcript/article content after processing finishes.
- [ ] \`logcat.txt\` has no obvious upload/sync/transcript errors.
EOF

echo
echo "Done."
echo "Evidence directory:"
echo "  $OUT_DIR"
