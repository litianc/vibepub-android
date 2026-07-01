#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_PATH="$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
BUILD_TASK="${BUILD_TASK:-assemble}"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-install-local/$RUN_ID}"

usage() {
  cat <<EOF
Usage:
  scripts/install-android-local-apk.sh [--serial adb-serial] [--test|--assemble-only|--skip-build]

Builds the debug APK locally with the minimal SDK/JDK 21 setup, then installs
and launches it on a connected Android device.

Options:
  --serial adb-serial  Target adb device serial.
  --test              Run unit tests and assemble before installing.
  --assemble-only     Assemble before installing. Default.
  --skip-build        Install the existing local APK.

Environment:
  OUT_DIR             Evidence directory. Default: artifacts/android-install-local/<time>
  BUILD_TASK          test, assemble, all, or skip. Default: assemble.
  REQUIRE_UNLOCKED    Passed through to install script. Default: true.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --serial)
      if [[ -z "${2:-}" ]]; then
        echo "--serial requires an adb device serial" >&2
        exit 1
      fi
      export ANDROID_SERIAL="$2"
      shift 2
      ;;
    --serial=*)
      export ANDROID_SERIAL="${1#--serial=}"
      shift
      ;;
    --test)
      BUILD_TASK="all"
      shift
      ;;
    --assemble-only)
      BUILD_TASK="assemble"
      shift
      ;;
    --skip-build)
      BUILD_TASK="skip"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUT_DIR"

if [[ "$BUILD_TASK" != "skip" ]]; then
  "$ROOT_DIR/scripts/build-android-local.sh" "$BUILD_TASK" 2>&1 | tee "$OUT_DIR/build.log"
fi

if [[ ! -f "$APK_PATH" ]]; then
  echo "Local APK not found: $APK_PATH" >&2
  echo "Run scripts/build-android-local.sh assemble first." >&2
  exit 1
fi

LC_ALL=C shasum -a 256 "$APK_PATH" > "$OUT_DIR/app-debug.apk.sha256"

install_args=("$APK_PATH")
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  install_args+=(--serial "$ANDROID_SERIAL")
fi

OUT_DIR="$OUT_DIR/install" \
"$ROOT_DIR/scripts/install-latest-android-apk.sh" "${install_args[@]}"

cat > "$OUT_DIR/summary.md" <<EOF
# Local Android APK Install

- Build task: \`$BUILD_TASK\`
- APK: \`$APK_PATH\`
- SHA-256: \`$(awk '{ print $1 }' "$OUT_DIR/app-debug.apk.sha256")\`
- Install evidence: \`$OUT_DIR/install/summary.md\`
EOF

echo "Local build/install complete. Summary: $OUT_DIR/summary.md"
