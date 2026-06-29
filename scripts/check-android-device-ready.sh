#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"
APK_PATH="${1:-}"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-device-readiness/$RUN_ID}"
REQUIRE_TAP="${REQUIRE_TAP:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"

usage() {
  cat <<EOF
Usage:
  scripts/check-android-device-ready.sh [path/to/app-debug.apk]

Environment:
  PACKAGE_NAME  Android package. Default: cn.litianc.vibepub.
  OUT_DIR       Readiness report directory.
  REQUIRE_TAP   Also require adb input tap support. Default: false.
  SKIP_INSTALL  Skip install check and inspect installed package. Default: false.

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

install_apk() {
  local apk_path="$1"

  if adb install -r -t "$apk_path" > "$OUT_DIR/install.txt" 2>&1; then
    return 0
  fi

  if ! grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
    return 1
  fi

  adb push "$apk_path" /data/local/tmp/vibepub-app-debug.apk \
    > "$OUT_DIR/install-fallback-push.txt" 2>&1
  adb_shell pm install -r -t -g /data/local/tmp/vibepub-app-debug.apk \
    > "$OUT_DIR/install-fallback-pm.txt" 2>&1
}

mkdir -p "$OUT_DIR"

failures=0
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

if [[ -n "$APK_PATH" ]]; then
  if [[ ! -f "$APK_PATH" ]]; then
    check_fail "APK file exists"
  else
    check_pass "APK file exists"

    if truthy "$SKIP_INSTALL"; then
      if adb shell dumpsys package "$PACKAGE_NAME" > "$OUT_DIR/installed-package.txt" 2>&1; then
        check_pass "package is already installed on the phone"
      else
        check_fail "package is already installed on the phone"
      fi
    elif install_apk "$APK_PATH"; then
      check_pass "ADB can install the APK"
    else
      check_fail "ADB can install the APK"
      if grep -q "INSTALL_FAILED_USER_RESTRICTED" "$OUT_DIR/install.txt"; then
        echo "  - Enable USB 安装 / Install via USB on the phone." >> "$report"
        echo "  - Fallback pm install also failed; see install-fallback-pm.txt if present." >> "$report"
      fi
    fi

    if adb shell run-as "$PACKAGE_NAME" id > "$OUT_DIR/run-as.txt" 2>&1; then
      check_pass "run-as works for debug preference injection"
    else
      check_fail "run-as works for debug preference injection"
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
