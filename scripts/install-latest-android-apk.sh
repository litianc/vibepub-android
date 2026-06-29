#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"
ACTIVITY_NAME="${ACTIVITY_NAME:-.MainActivity}"
APK_PATH="${1:-}"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-install/$RUN_ID}"
START_APP="${START_APP:-true}"
REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-true}"

usage() {
  cat <<EOF
Usage:
  scripts/install-latest-android-apk.sh [path/to/app-debug.apk]

Environment:
  ANDROID_SERIAL    Optional adb device serial, recommended when multiple
                    devices are visible.
  PACKAGE_NAME      Android package. Default: cn.litianc.vibepub.
  ACTIVITY_NAME     Launch activity. Default: .MainActivity.
  START_APP         Start the app after install. Default: true.
  REQUIRE_UNLOCKED  Fail fast if the device appears locked. Default: true.
  OUT_DIR           Evidence directory. Default: artifacts/android-install/<time>.

When no APK path is passed, the script downloads the latest successful Android
Build & Release APK via scripts/download-latest-android-apk.sh.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

truthy() {
  [[ "${1:-}" == "true" || "${1:-}" == "1" || "${1:-}" == "yes" ]]
}

if [[ -z "$APK_PATH" ]]; then
  APK_PATH="$("$ROOT_DIR/scripts/download-latest-android-apk.sh" | tail -n 1)"
fi

if [[ ! -f "$APK_PATH" ]]; then
  echo "APK not found: $APK_PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Installing APK on Android device..."
echo "APK: $APK_PATH"
echo "Evidence: $OUT_DIR"

CHECK_APK_INSTALL=true \
REQUIRE_UNLOCKED="$REQUIRE_UNLOCKED" \
OUT_DIR="$OUT_DIR/readiness" \
"$ROOT_DIR/scripts/check-android-device-ready.sh" "$APK_PATH"

if truthy "$START_APP"; then
  echo "Starting $PACKAGE_NAME/$ACTIVITY_NAME..."
  adb shell am start -n "$PACKAGE_NAME/$ACTIVITY_NAME" > "$OUT_DIR/start-app.txt"
  adb shell screencap -p /sdcard/vibepub-installed-launch.png >/dev/null 2>&1 || true
  adb pull /sdcard/vibepub-installed-launch.png "$OUT_DIR/launch.png" >/dev/null 2>&1 || true
fi

cat > "$OUT_DIR/summary.md" <<EOF
# Android APK Install

- Package: \`$PACKAGE_NAME\`
- Activity: \`$ACTIVITY_NAME\`
- APK: \`$APK_PATH\`
- Started app: \`$START_APP\`
EOF

echo "Install complete. Summary: $OUT_DIR/summary.md"
