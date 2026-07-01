#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MODE="install"
SERIAL=""
APK_PATH=""

usage() {
  cat <<EOF
Usage:
  .codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh [options]

Options:
  --mode build|test|install|smoke|release-install
  --serial adb-serial
  --apk path/to/app-debug.apk      Use this APK for install/release-install.
  --test                          Alias for --mode test.

Environment:
  OUT_DIR                         Evidence output directory override.
  REQUIRE_UNLOCKED                Default true for install/smoke.
  DEVICE_ENV_FILE                 Passed to smoke script.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --mode)
      MODE="${2:?--mode requires a value}"
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    --serial)
      SERIAL="${2:?--serial requires a value}"
      shift 2
      ;;
    --serial=*)
      SERIAL="${1#--serial=}"
      shift
      ;;
    --apk)
      APK_PATH="${2:?--apk requires a path}"
      shift 2
      ;;
    --apk=*)
      APK_PATH="${1#--apk=}"
      shift
      ;;
    --test)
      MODE="test"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  build|test|install|smoke|release-install)
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 1
    ;;
esac

cd "$ROOT_DIR"

if [[ -n "$SERIAL" ]]; then
  export ANDROID_SERIAL="$SERIAL"
fi

load_stable_signing() {
  local secrets_env="$ROOT_DIR/secrets/android-release-secrets.env"
  local keystore="$ROOT_DIR/secrets/vibepub-release.keystore"

  if [[ ! -f "$secrets_env" || ! -f "$keystore" ]]; then
    echo "Stable Android signing files not found; Gradle will use default debug signing." >&2
    echo "Install over CI-signed APK may fail with signature mismatch." >&2
    return 0
  fi

  set -a
  # shellcheck disable=SC1090
  source "$secrets_env"
  set +a

  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_STORE_FILE="$keystore"
  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_STORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:?missing ANDROID_KEYSTORE_PASSWORD}"
  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_KEY_ALIAS="${ANDROID_KEY_ALIAS:?missing ANDROID_KEY_ALIAS}"
  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:?missing ANDROID_KEY_PASSWORD}"

  echo "Using stable Android signing from git-ignored secrets."
}

build_local() {
  local task="$1"
  load_stable_signing
  case "$task" in
    test)
      scripts/build-android-local.sh all
      ;;
    assemble)
      scripts/build-android-local.sh assemble
      ;;
  esac
}

local_apk() {
  echo "$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
}

serial_args=()
if [[ -n "$SERIAL" ]]; then
  serial_args=(--serial "$SERIAL")
fi

case "$MODE" in
  build)
    build_local assemble
    ;;
  test)
    build_local test
    ;;
  install)
    build_local assemble
    REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-true}" \
      scripts/install-android-local-apk.sh "${serial_args[@]}" --skip-build
    ;;
  smoke)
    build_local test
    apk="${APK_PATH:-$(local_apk)}"
    REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-true}" \
      scripts/run-android-device-smoke.sh "$apk"
    ;;
  release-install)
    if [[ -n "$APK_PATH" ]]; then
      REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-true}" \
        scripts/install-latest-android-apk.sh "$APK_PATH" "${serial_args[@]}"
    else
      REQUIRE_UNLOCKED="${REQUIRE_UNLOCKED:-true}" \
        scripts/install-latest-android-apk.sh "${serial_args[@]}"
    fi
    ;;
esac
