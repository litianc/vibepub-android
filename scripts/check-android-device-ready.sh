#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"
APK_PATH="${1:-}"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-device-readiness/$RUN_ID}"
REQUIRE_TAP="${REQUIRE_TAP:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
CHECK_APK_INSTALL="${CHECK_APK_INSTALL:-true}"
REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-false}"
AUTO_CONFIRM_USB_INSTALL_PROMPT="${AUTO_CONFIRM_USB_INSTALL_PROMPT:-true}"
AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK="${AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK:-true}"
USB_INSTALL_PROMPT_TIMEOUT_SECONDS="${USB_INSTALL_PROMPT_TIMEOUT_SECONDS:-20}"

usage() {
  cat <<EOF
Usage:
  scripts/check-android-device-ready.sh [path/to/app-debug.apk]

Environment:
  PACKAGE_NAME  Android package. Default: cn.litianc.vibepub.
  OUT_DIR       Readiness report directory.
  REQUIRE_TAP   Also require adb input tap support. Default: false.
  SKIP_INSTALL  Skip install check and inspect installed package. Default: false.
  CHECK_APK_INSTALL
                Check APK installation/readiness. Set false for a fast
                device-only preflight. Default: true.
  REQUIRE_UNLOCKED
                Fail if the device appears locked. Default: false.
  AUTO_CONFIRM_USB_INSTALL_PROMPT
                Tap HyperOS/MIUI "继续安装" USB install prompts while adb
                install is waiting. Default: true.
  AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK
                Repeatedly tap the expected "继续安装" dialog coordinate while
                waiting, because HyperOS can auto-reject before UI dumps
                observe the prompt. Default: true.
  USB_INSTALL_PROMPT_TIMEOUT_SECONDS
                Prompt watcher timeout. Default: 20.

Checks whether a USB-connected Android phone is ready for the VibePub
real-device smoke lane.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

truthy() {
  [[ "${1:-}" == "true" || "${1:-}" == "1" || "${1:-}" == "yes" ]]
}

adb_shell() {
  adb shell "$@"
}

current_display_size() {
  local display_size

  display_size="$(adb_shell dumpsys window displays 2>/dev/null \
    | sed -n 's/.*cur=\([0-9][0-9]*\)x\([0-9][0-9]*\).*/\1x\2/p' \
    | head -n 1)"
  if [[ -z "$display_size" ]]; then
    display_size="$(adb_shell dumpsys display 2>/dev/null \
      | sed -n 's/.*mOverrideDisplayInfo=.*real \([0-9][0-9]*\) x \([0-9][0-9]*\).*/\1x\2/p' \
      | head -n 1)"
  fi
  if [[ -z "$display_size" ]]; then
    display_size="$(adb_shell wm size 2>/dev/null | awk -F': ' '/Physical size/ { print $2; exit }')"
  fi

  echo "$display_size"
}

tap_usb_install_prompt_until() {
  local label="$1"
  local watched_pid="$2"

  if ! truthy "$AUTO_CONFIRM_USB_INSTALL_PROMPT"; then
    return 0
  fi

  local deadline=$((SECONDS + USB_INSTALL_PROMPT_TIMEOUT_SECONDS))
  local tap_file="$OUT_DIR/${label}-usb-install-prompt-tap.txt"
  local screen_size width height fallback_x fallback_y

  screen_size="$(current_display_size)"
  width="${screen_size%x*}"
  height="${screen_size#*x}"
  if [[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]]; then
    fallback_x="${USB_INSTALL_PROMPT_TAP_X:-$((width * 42 / 100))}"
    fallback_y="${USB_INSTALL_PROMPT_TAP_Y:-$((height * 64 / 100))}"
  else
    fallback_x="${USB_INSTALL_PROMPT_TAP_X:-1266}"
    fallback_y="${USB_INSTALL_PROMPT_TAP_Y:-1203}"
  fi

  while kill -0 "$watched_pid" >/dev/null 2>&1 && (( SECONDS < deadline )); do
    if truthy "$AUTO_TAP_USB_INSTALL_PROMPT_FALLBACK"; then
      adb_shell input tap "$fallback_x" "$fallback_y" >> "$tap_file" 2>&1 || true
      echo "Fallback-tapped expected HyperOS USB install prompt at $fallback_x,$fallback_y" >> "$tap_file"
    fi
    sleep 0.15
  done
}

run_with_usb_install_prompt_taps() {
  local label="$1"
  local output_file="$2"
  shift 2

  "$@" > "$output_file" 2>&1 &
  local install_pid=$!
  tap_usb_install_prompt_until "$label" "$install_pid"
  wait "$install_pid"
}

install_apk() {
  local apk_path="$1"

  adb devices -l > "$OUT_DIR/adb-devices-before-install.txt" || true

  adb_shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
  sleep 0.3

  if run_with_usb_install_prompt_taps \
    "install" \
    "$OUT_DIR/install.txt" \
    adb install -r -t -g "$apk_path"; then
    return 0
  fi

  if grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE" "$OUT_DIR/install.txt"; then
    adb uninstall "$PACKAGE_NAME" > "$OUT_DIR/install-uninstall-incompatible.txt" 2>&1 || true
    if run_with_usb_install_prompt_taps \
      "install-after-uninstall" \
      "$OUT_DIR/install-after-uninstall.txt" \
      adb install -r -t -g "$apk_path"; then
      return 0
    fi
    cp "$OUT_DIR/install-after-uninstall.txt" "$OUT_DIR/install.txt"
  fi

  if ! grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
    return 1
  fi

  adb push "$apk_path" /data/local/tmp/vibepub-app-debug.apk \
    > "$OUT_DIR/install-fallback-push.txt" 2>&1
  run_with_usb_install_prompt_taps \
    "install-fallback-pm" \
    "$OUT_DIR/install-fallback-pm.txt" \
    adb shell pm install -r -t -g /data/local/tmp/vibepub-app-debug.apk
}

mkdir -p "$OUT_DIR"

failures=0
device_locked=false
report="$OUT_DIR/readiness.md"

{
  echo "# Android Device Readiness"
  echo
  echo "- Package: \`$PACKAGE_NAME\`"
  echo "- APK: \`${APK_PATH:-not provided}\`"
  echo
} > "$report"

check_pass() {
  echo "- [x] $1" >> "$report"
}

check_fail() {
  echo "- [ ] $1" >> "$report"
  failures=$((failures + 1))
}

if ! command -v adb >/dev/null 2>&1; then
  check_fail "adb is installed"
  echo "Missing adb. Install with: brew install --cask android-platform-tools" >&2
  exit 1
fi
check_pass "adb is installed"

adb start-server >/dev/null
adb devices -l > "$OUT_DIR/adb-devices.txt"
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  device_count="$(awk -v serial="$ANDROID_SERIAL" 'NR > 1 && $1 == serial && $2 == "device" { count++ } END { print count + 0 }' "$OUT_DIR/adb-devices.txt")"
else
  device_count="$(awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }' "$OUT_DIR/adb-devices.txt")"
fi

if [[ "$device_count" -eq 1 ]]; then
  check_pass "exactly one authorized Android device is connected"
else
  check_fail "exactly one authorized Android device is connected"
fi

if [[ "$device_count" -ge 1 ]]; then
  adb shell getprop ro.product.model > "$OUT_DIR/device-model.txt" || true
  adb shell getprop ro.build.version.release > "$OUT_DIR/android-version.txt" || true
  check_pass "device properties captured"

  adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  adb shell dumpsys power > "$OUT_DIR/power.txt" 2>&1 || true
  adb shell dumpsys window > "$OUT_DIR/window.txt" 2>&1 || true
  if grep -Eq 'mDreamingLockscreen=true|mShowingLockscreen=true|mInputRestricted=true|isStatusBarKeyguard=true' \
    "$OUT_DIR/power.txt" "$OUT_DIR/window.txt"; then
    device_locked=true
    if truthy "$REQUIRE_UNLOCKED"; then
      check_fail "device is awake and unlocked"
    else
      echo "- [~] device appears locked; unlock it before install/smoke runs" >> "$report"
    fi
  else
    check_pass "device is awake and unlocked"
  fi
fi

if adb shell input tap 1 1 > "$OUT_DIR/input-tap.txt" 2>&1; then
  check_pass "adb input tap is allowed"
else
  if truthy "$REQUIRE_TAP"; then
    check_fail "adb input tap is allowed"
  else
    echo "- [~] adb input tap is blocked, but default debug-broadcast mode does not require it" >> "$report"
  fi
fi

if ! truthy "$CHECK_APK_INSTALL"; then
  echo "- [~] APK install/run-as checks skipped by CHECK_APK_INSTALL=false" >> "$report"
elif [[ -n "$APK_PATH" ]]; then
  if [[ ! -f "$APK_PATH" ]]; then
    check_fail "APK file exists"
  else
    check_pass "APK file exists"

    if truthy "$device_locked"; then
      check_fail "device is unlocked before APK install/run-as checks"
      echo "  - Unlock the phone/tablet, keep the screen awake, then rerun." >> "$report"
      echo "  - APK install and run-as checks were skipped to avoid HyperOS/MIUI install restrictions while locked." >> "$report"
    elif truthy "$SKIP_INSTALL"; then
      if adb shell dumpsys package "$PACKAGE_NAME" > "$OUT_DIR/installed-package.txt" 2>&1; then
        check_pass "package is already installed on the phone"
      else
        check_fail "package is already installed on the phone"
      fi
      if adb shell run-as "$PACKAGE_NAME" id > "$OUT_DIR/run-as.txt" 2>&1; then
        check_pass "run-as works for debug preference injection"
      else
        check_fail "run-as works for debug preference injection"
      fi
    else
      if install_apk "$APK_PATH"; then
        check_pass "ADB can install the APK"
      else
        check_fail "ADB can install the APK"
        if grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
          echo "  - Enable USB 安装 / Install via USB on the phone." >> "$report"
          if grep -Eq '^[^[:space:]]+:[0-9]+[[:space:]]+device|_adb-tls-connect\._tcp[[:space:]]+device' \
            "$OUT_DIR/adb-devices-before-install.txt" 2>/dev/null; then
            echo "  - This device is connected through wireless debugging; HyperOS can still reject APK installs over wireless ADB even when USB 安装 is enabled." >> "$report"
            echo "  - Connect the tablet by USB for installation, or install the APK manually first and rerun with SKIP_INSTALL=true RESET_APP_DATA=false." >> "$report"
          fi
          echo "  - Fallback pm install also failed; see install-fallback-pm.txt if present." >> "$report"
        fi
      fi

      if adb shell run-as "$PACKAGE_NAME" id > "$OUT_DIR/run-as.txt" 2>&1; then
        check_pass "run-as works for debug preference injection"
      else
        check_fail "run-as works for debug preference injection"
      fi
    fi
  fi
else
  echo "- [~] APK install/run-as checks skipped because no APK path was provided" >> "$report"
fi

cat >> "$report" <<EOF

## Xiaomi / HyperOS Hints

If install or reset is blocked, enable these Developer options:

- USB 安装 / Install via USB
- USB 调试（安全设置） / USB debugging (Security settings)
- 允许通过 USB 调试修改权限或模拟点击

On HyperOS/MIUI, wireless debugging can still return
\`INSTALL_FAILED_USER_RESTRICTED\` for APK installs even when those switches are
enabled. If that happens, use a USB data connection for installation, or install
the APK manually and rerun smoke tests with \`SKIP_INSTALL=true RESET_APP_DATA=false\`.

Default VibePub automation uses \`AUTOMATION_MODE=debug-broadcast\`, so tap
injection is optional. ADB install and debug \`run-as\` are still required for
deterministic automated tests.
EOF

cat "$report"

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "Device readiness failed. Report: $report" >&2
  exit 1
fi

echo
echo "Device readiness passed. Report: $report"
