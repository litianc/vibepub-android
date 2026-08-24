#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-environments/$RUN_ID}"
SIGNING_ENV_FILE="${VIBEPUB_SIGNING_ENV_FILE:-$ROOT_DIR/secrets/android-release-secrets.env}"
KEYSTORE_FILE="${VIBEPUB_KEYSTORE_FILE:-$ROOT_DIR/secrets/vibepub-release.keystore}"
APK_PATH="$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
STAGING_API_BASE_URL="${STAGING_PUBLIC_BASE_URL:-}"

canonical_api_host() {
  local authority="${1#https://}"
  printf '%s' "${authority%%:*}" | tr '[:upper:]' '[:lower:]' | sed 's/\.*$//'
}
staging_api_host="$(canonical_api_host "$STAGING_API_BASE_URL")"

if [[ ! "$STAGING_API_BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
  [[ "$staging_api_host" == "vibepub.litianc.cn" ]] ||
  [[ "$staging_api_host" == "invalid" || "$staging_api_host" == *.invalid ]]; then
  echo "STAGING_PUBLIC_BASE_URL must be the real isolated Staging HTTPS API URL." >&2
  exit 1
fi

load_stable_signing() {
  if [[ ! -f "$SIGNING_ENV_FILE" || ! -f "$KEYSTORE_FILE" ]]; then
    echo "Stable Android signing files are required for environment APKs." >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$SIGNING_ENV_FILE"
  set +a

  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_STORE_FILE="$KEYSTORE_FILE"
  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_STORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:?missing ANDROID_KEYSTORE_PASSWORD}"
  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_KEY_ALIAS="${ANDROID_KEY_ALIAS:?missing ANDROID_KEY_ALIAS}"
  export ORG_GRADLE_PROJECT_VIBEPUB_RELEASE_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:?missing ANDROID_KEY_PASSWORD}"
}

build_environment() {
  local environment="$1"
  local arguments=(assemble "-PVIBEPUB_ENVIRONMENT=$environment")
  if [[ "$environment" == "staging" ]]; then
    arguments+=("-PVIBEPUB_STAGING_API_BASE_URL=$STAGING_API_BASE_URL")
  fi
  "$ROOT_DIR/scripts/build-android-local.sh" "${arguments[@]}"
  cp "$APK_PATH" "$OUT_DIR/vibepub-$environment.apk"
}

mkdir -p "$OUT_DIR"
load_stable_signing
build_environment production
build_environment staging

"$ROOT_DIR/scripts/verify-android-environment-apks.sh" \
  "$OUT_DIR/vibepub-production.apk" \
  "$OUT_DIR/vibepub-staging.apk" \
  "$STAGING_API_BASE_URL"

LC_ALL=C shasum -a 256 "$OUT_DIR"/*.apk > "$OUT_DIR/sha256.txt"
cat > "$OUT_DIR/summary.md" <<EOF
# Android Environment APKs

- Production: \`$OUT_DIR/vibepub-production.apk\`
- Staging: \`$OUT_DIR/vibepub-staging.apk\`
- Signing: stable internal key
- Identity check: passed
EOF

echo "Android environment APK build passed."
echo "Summary: $OUT_DIR/summary.md"
