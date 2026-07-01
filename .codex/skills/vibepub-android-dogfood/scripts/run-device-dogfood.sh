#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MODE="install"
SERIAL=""
PROFILE=""
APK_PATH=""
DEVICE_PROFILES_FILE="${DEVICE_PROFILES_FILE:-}"

usage() {
  cat <<EOF
Usage:
  .codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh [options]

Options:
  --mode build|test|install|smoke|release-install
  --profile name                    Use a saved device profile.
  --serial adb-serial
  --apk path/to/app-debug.apk      Use this APK for install/release-install.
  --test                          Alias for --mode test.

Environment:
  DEVICE_PROFILES_FILE             Default: secrets/android-device-profiles.env.
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
    --profile)
      PROFILE="${2:?--profile requires a value}"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
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

DEVICE_PROFILES_FILE="${DEVICE_PROFILES_FILE:-$ROOT_DIR/secrets/android-device-profiles.env}"

load_device_profile() {
  local profile="$1"
  local normalized
  normalized="$(printf '%s' "$profile" | tr '[:lower:]-' '[:upper:]_')"

  if [[ ! -f "$DEVICE_PROFILES_FILE" ]]; then
    echo "Device profile file not found: $DEVICE_PROFILES_FILE" >&2
    echo "Create it from .codex/skills/vibepub-android-dogfood/references/android-device-profiles.example.env." >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$DEVICE_PROFILES_FILE"
  set +a

  local serial_var="VIBEPUB_DEVICE_${normalized}_SERIAL"
  local serials_var="VIBEPUB_DEVICE_${normalized}_SERIALS"
  local connect_var="VIBEPUB_DEVICE_${normalized}_CONNECT_TARGETS"
  local profile_serial="${!serial_var:-}"
  local profile_serials="${!serials_var:-}"
  local connect_targets="${!connect_var:-}"

  if [[ -z "$profile_serial" && -z "$profile_serials" && -z "$connect_targets" ]]; then
    echo "Profile '$profile' has no $serial_var, $serials_var, or $connect_var in $DEVICE_PROFILES_FILE." >&2
    exit 1
  fi

  local candidates="$profile_serial $profile_serials $connect_targets"
  export WIRELESS_ADB_CONNECT_TARGETS="$connect_targets"

  local target
  for target in ${candidates//,/ }; do
    if [[ "$target" == *:* ]]; then
      adb connect "$target" >/dev/null 2>&1 || true
    fi
  done

  if [[ -z "$SERIAL" ]]; then
    local devices_output
    devices_output="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')"

    for target in ${candidates//,/ }; do
      if [[ -n "$target" ]] && grep -Fxq "$target" <<<"$devices_output"; then
        SERIAL="$target"
        break
      fi
    done
  fi

  if [[ -z "$SERIAL" ]]; then
    for target in ${candidates//,/ }; do
      if [[ -n "$target" ]]; then
        SERIAL="$target"
        break
      fi
    done
  fi

  if [[ -z "$SERIAL" ]]; then
    echo "Profile '$profile' did not resolve an adb serial. Set $serial_var or $serials_var." >&2
    exit 1
  fi

  echo "Using Android device profile '$profile' with serial '$SERIAL'."
}

if [[ -n "$PROFILE" ]]; then
  load_device_profile "$PROFILE"
fi

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
