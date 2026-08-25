#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$#" -lt 3 || "$#" -gt 4 || ( "$#" -eq 4 && "$4" != "--skip-release-certificate" ) ]]; then
  echo "Usage: scripts/verify-android-environment-apks.sh production.apk staging.apk staging-api-base-url [--skip-release-certificate]" >&2
  exit 1
fi

PRODUCTION_APK="$1"
STAGING_APK="$2"
STAGING_API_BASE_URL="${3%/}"
AAPT="${AAPT:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/build-tools/36.0.0/aapt}"
APKSIGNER="${APKSIGNER:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/build-tools/36.0.0/apksigner}"
CERTIFICATE_FILE="${VIBEPUB_ANDROID_CERTIFICATE_FILE:-$ROOT_DIR/android/release-certificate.sha256}"
VERIFY_RELEASE_CERTIFICATE=true
if [[ "${4:-}" == "--skip-release-certificate" ]]; then
  VERIFY_RELEASE_CERTIFICATE=false
fi

canonical_api_host() {
  local authority="${1#https://}"
  printf '%s' "${authority%%:*}" | tr '[:upper:]' '[:lower:]' | sed 's/\.*$//'
}

if [[ ! -x "$AAPT" ]]; then
  echo "Android aapt not found: $AAPT" >&2
  exit 1
fi
if [[ "$VERIFY_RELEASE_CERTIFICATE" == true && ! -x "$APKSIGNER" ]]; then
  echo "Android apksigner not found: $APKSIGNER" >&2
  exit 1
fi
if [[ "$VERIFY_RELEASE_CERTIFICATE" == true && ! -f "$CERTIFICATE_FILE" ]]; then
  echo "Pinned Android release certificate not found: $CERTIFICATE_FILE" >&2
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
  case "$field" in
    package)
      "$AAPT" dump badging "$apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -n 1
      ;;
    versionCode|versionName)
      "$AAPT" dump badging "$apk" | sed -n "s/^package: .*${field}='\([^']*\)'.*/\1/p" | head -n 1
      ;;
    *)
      "$AAPT" dump badging "$apk" | sed -n "s/^${field}:'\([^']*\)'.*/\1/p" | head -n 1
      ;;
  esac
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

apk_git_commit() {
  local apk="$1"
  "$AAPT" dump xmltree "$apk" AndroidManifest.xml |
    awk '/cn\.litianc\.vibepub\.GIT_COMMIT/{found=1; next} found && /android:value/{sub(/^.*Raw: "/, ""); sub(/"\).*$/, ""); print; exit}'
}

apk_certificate_fingerprint() {
  local apk="$1"
  "$APKSIGNER" verify --print-certs "$apk" |
    sed -n 's/^Signer #[0-9][0-9]* certificate SHA-256 digest:[[:space:]]*//p' |
    tr '[:upper:]' '[:lower:]'
}

production_package="$(apk_field "$PRODUCTION_APK" package)"
staging_package="$(apk_field "$STAGING_APK" package)"
production_label="$(apk_field "$PRODUCTION_APK" application-label)"
staging_label="$(apk_field "$STAGING_APK" application-label)"
production_auth_schemes="$(apk_auth_schemes "$PRODUCTION_APK")"
staging_auth_schemes="$(apk_auth_schemes "$STAGING_APK")"
production_api_base_url="$(apk_default_api_base_url "$PRODUCTION_APK")"
staging_api_base_url="$(apk_default_api_base_url "$STAGING_APK")"
production_version_name="$(apk_field "$PRODUCTION_APK" versionName)"
staging_version_name="$(apk_field "$STAGING_APK" versionName)"
production_version_code="$(apk_field "$PRODUCTION_APK" versionCode)"
staging_version_code="$(apk_field "$STAGING_APK" versionCode)"
production_git_commit="$(apk_git_commit "$PRODUCTION_APK")"
staging_git_commit="$(apk_git_commit "$STAGING_APK")"

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

if [[ -z "$production_version_name" || -z "$production_version_code" ||
  "$production_version_name" != "$staging_version_name" ||
  "$production_version_code" != "$staging_version_code" ]]; then
  echo "Production and Staging APKs must have the same Android version." >&2
  exit 1
fi
if [[ ! "$production_git_commit" =~ ^[0-9a-f]{7,40}$ ||
  "$production_git_commit" != "$staging_git_commit" ]]; then
  echo "Production and Staging APKs must embed the same Git commit." >&2
  exit 1
fi

if [[ "$VERIFY_RELEASE_CERTIFICATE" == true ]]; then
  expected_fingerprint="$(tr -d '[:space:]' < "$CERTIFICATE_FILE" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$expected_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Pinned Android release certificate must contain one SHA-256 fingerprint." >&2
    exit 1
  fi
  production_fingerprint="$(apk_certificate_fingerprint "$PRODUCTION_APK")"
  staging_fingerprint="$(apk_certificate_fingerprint "$STAGING_APK")"
  if [[ "$production_fingerprint" != "$expected_fingerprint" ||
    "$staging_fingerprint" != "$expected_fingerprint" ]]; then
    echo "Both APKs must use the pinned release certificate." >&2
    exit 1
  fi
fi

echo "Android environment APK identity checks passed."
