#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: scripts/verify-android-environment-apks.sh production.apk staging.apk staging-api-base-url" >&2
  exit 1
fi

PRODUCTION_APK="$1"
STAGING_APK="$2"
STAGING_API_BASE_URL="${3%/}"
AAPT="${AAPT:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/build-tools/36.0.0/aapt}"

canonical_api_host() {
  local authority="${1#https://}"
  printf '%s' "${authority%%:*}" | tr '[:upper:]' '[:lower:]' | sed 's/\.*$//'
}

if [[ ! -x "$AAPT" ]]; then
  echo "Android aapt not found: $AAPT" >&2
  exit 1
fi

for apk in "$PRODUCTION_APK" "$STAGING_APK"; do
  if [[ ! -f "$apk" ]]; then
    echo "APK not found: $apk" >&2
    exit 1
  fi
done

apk_field() {
  local apk="$1"
  local field="$2"
  if [[ "$field" == "package" ]]; then
    "$AAPT" dump badging "$apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -n 1
  else
    "$AAPT" dump badging "$apk" | sed -n "s/^${field}:'\([^']*\)'.*/\1/p" | head -n 1
  fi
}

apk_auth_schemes() {
  local apk="$1"
  "$AAPT" dump xmltree "$apk" AndroidManifest.xml |
    sed -n 's/.*android:scheme.*Raw: "\(vibepub[^"]*\)".*/\1/p'
}

apk_default_api_base_url() {
  local apk="$1"
  "$AAPT" dump xmltree "$apk" AndroidManifest.xml |
    awk '/cn\.litianc\.vibepub\.DEFAULT_API_BASE_URL/{found=1; next} found && /android:value/{sub(/^.*Raw: "/, ""); sub(/"\).*$/, ""); print; exit}'
}

production_package="$(apk_field "$PRODUCTION_APK" package)"
staging_package="$(apk_field "$STAGING_APK" package)"
production_label="$(apk_field "$PRODUCTION_APK" application-label)"
staging_label="$(apk_field "$STAGING_APK" application-label)"
production_auth_schemes="$(apk_auth_schemes "$PRODUCTION_APK")"
staging_auth_schemes="$(apk_auth_schemes "$STAGING_APK")"
production_api_base_url="$(apk_default_api_base_url "$PRODUCTION_APK")"
staging_api_base_url="$(apk_default_api_base_url "$STAGING_APK")"

[[ "$production_package" == "cn.litianc.vibepub" ]] || {
  echo "Unexpected Production package: $production_package" >&2
  exit 1
}
[[ "$staging_package" == "cn.litianc.vibepub.staging" ]] || {
  echo "Unexpected Staging package: $staging_package" >&2
  exit 1
}
[[ "$production_label" == "VibePub" ]] || {
  echo "Unexpected Production label: $production_label" >&2
  exit 1
}
[[ "$staging_label" == "VibePub Staging" ]] || {
  echo "Unexpected Staging label: $staging_label" >&2
  exit 1
}
[[ "$production_package" != "$staging_package" ]] || {
  echo "Production and Staging packages must differ." >&2
  exit 1
}
[[ "$production_auth_schemes" == "vibepub" ]] || {
  echo "Unexpected Production auth deep-link identity." >&2
  exit 1
}
[[ "$staging_auth_schemes" == "vibepub-staging" ]] || {
  echo "Unexpected Staging auth deep-link identity." >&2
  exit 1
}
[[ "$production_api_base_url" == "https://vibepub.litianc.cn" ]] || {
  echo "Unexpected Production API default." >&2
  exit 1
}
[[ "$STAGING_API_BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  echo "Staging APK verification requires a real isolated HTTPS API URL." >&2
  exit 1
}
staging_api_host="$(canonical_api_host "$STAGING_API_BASE_URL")"
if [[ "$staging_api_host" == "vibepub.litianc.cn" ]]; then
  echo "Staging APK API default must not be Production." >&2
  exit 1
fi
if [[ "$staging_api_host" == "invalid" ]]; then
  echo "Staging APK API default must not use the exact invalid hostname." >&2
  exit 1
fi
if [[ "$staging_api_host" == *.invalid && "${ALLOW_SYNTHETIC_STAGING_API_URL:-false}" != "true" ]]; then
  echo "Synthetic Staging API URLs are allowed only in automated checks." >&2
  exit 1
fi
[[ "$staging_api_base_url" == "$STAGING_API_BASE_URL" ]] || {
  echo "Unexpected Staging API default." >&2
  exit 1
}

echo "Android environment APK identity checks passed."
