#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_PACKAGE="cn.litianc.vibepub"
STAGING_PACKAGE="cn.litianc.vibepub.staging"
ADB="${ADB:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/platform-tools/adb}"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT_DIR/artifacts/android-environment-isolation}"

usage() {
  cat <<EOF
Usage: scripts/verify-android-environment-isolation.sh production.apk staging.apk --serial adb-serial --staging-api-url https-url

Installs both APKs and verifies separate Android package sandboxes. The script
never clears or uninstalls Production. It clears and uninstalls only Staging.
EOF
}

if [[ "$#" -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ "$#" -lt 2 ]]; then
  usage >&2
  exit 1
fi

PRODUCTION_APK="$1"
STAGING_APK="$2"
shift 2

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --serial)
      ANDROID_SERIAL="${2:?--serial requires a value}"
      shift 2
      ;;
    --serial=*)
      ANDROID_SERIAL="${1#--serial=}"
      shift
      ;;
    --staging-api-url)
      STAGING_API_URL="${2:?--staging-api-url requires a value}"
      shift 2
      ;;
    --staging-api-url=*)
      STAGING_API_URL="${1#--staging-api-url=}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${ANDROID_SERIAL:-}" ]]; then
  echo "--serial is required for Android environment isolation checks." >&2
  exit 1
fi
STAGING_API_URL="${STAGING_API_URL:-}"
STAGING_API_URL="${STAGING_API_URL%/}"
canonical_api_host() {
  local authority="${1#https://}"
  printf '%s' "${authority%%:*}" | tr '[:upper:]' '[:lower:]' | sed 's/\.*$//'
}
staging_api_host="$(canonical_api_host "$STAGING_API_URL")"
if [[ ! "$STAGING_API_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
  [[ "$staging_api_host" == "vibepub.litianc.cn" ]] ||
  [[ "$staging_api_host" == "invalid" || "$staging_api_host" == *.invalid ]]; then
  echo "--staging-api-url must be the real isolated Staging HTTPS API URL." >&2
  exit 1
fi

"$ROOT_DIR/scripts/verify-android-environment-apks.sh" "$PRODUCTION_APK" "$STAGING_APK" "$STAGING_API_URL"

if [[ ! -x "$ADB" ]]; then
  echo "Android adb not found: $ADB" >&2
  exit 1
fi
if [[ "$("$ADB" -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)" != "device" ]]; then
  echo "The requested Android device is not authorized and ready." >&2
  exit 1
fi

RUN_ID="$(date +'%Y%m%d-%H%M%S')"
EVIDENCE_DIR="$OUTPUT_ROOT/$RUN_ID"
mkdir -p "$EVIDENCE_DIR"

adb_cmd() {
  "$ADB" -s "$ANDROID_SERIAL" "$@"
}

package_installed() {
  local package_name="$1"
  local output
  if ! output="$(adb_cmd shell cmd package list packages --user "$android_user" "$package_name" 2>/dev/null)"; then
    return 2
  fi
  if printf '%s\n' "$output" | grep -Fqx "package:$package_name"; then
    echo installed
  else
    echo absent
  fi
}

require_package_state() {
  local package_name="$1"
  local expected_state="$2"
  local description="$3"
  local actual_state
  if ! actual_state="$(package_installed "$package_name")"; then
    echo "Could not query $description for the active Android user." >&2
    return 1
  fi
  if [[ "$actual_state" != "$expected_state" ]]; then
    echo "$description must be $expected_state for the active Android user." >&2
    return 1
  fi
}

install_apk() {
  local apk="$1"
  adb_cmd install --user "$android_user" -r -t "$apk"
}

package_uid() {
  adb_cmd shell cmd package list packages -U --user "$android_user" "$1" |
    tr -d '\r' |
    awk -v target="package:$1" '$1 == target && $2 ~ /^uid:[0-9]+$/ { sub(/^uid:/, "", $2); print $2; exit }'
}

production_data_digest() {
  ADB="$ADB" "$ROOT_DIR/scripts/android-package-data-digest.sh" \
    --serial "$ANDROID_SERIAL" \
    --user "$android_user" \
    --package "$PRODUCTION_PACKAGE"
}

package_has_login_state() {
  local package_name="$1"
  ADB="$ADB" "$ROOT_DIR/scripts/android-package-login-state.sh" \
    --serial "$ANDROID_SERIAL" \
    --user "$android_user" \
    --package "$package_name" >/dev/null 2>&1
}

package_session_is_valid() {
  local package_name="$1"
  local api_base_url="$2"
  ADB="$ADB" "$ROOT_DIR/scripts/android-package-session-me.sh" \
    --serial "$ANDROID_SERIAL" \
    --user "$android_user" \
    --package "$package_name" \
    --expected-api-base-url "$api_base_url" >/dev/null 2>&1
}

package_preferences_state() {
  local package_name="$1"
  local output
  read -r -d '' preference_state_command <<'EOF' || true
if [ -e shared_prefs/vibepub.xml ]; then
  printf 'present\n'
else
  printf 'absent\n'
fi
EOF
  if ! output="$(adb_cmd exec-out run-as "$package_name" --user "$android_user" sh -c \
    "$preference_state_command" 2>/dev/null)"; then
    return 2
  fi
  output="${output//$'\r'/}"
  [[ "$output" == "present" || "$output" == "absent" ]] || return 2
  echo "$output"
}

package_cannot_read_other_preferences() {
  local source_package="$1"
  local target_package="$2"
  local target_data_dir="/data/user/$android_user/$target_package"
  local output
  if ! output="$(adb_cmd exec-out run-as "$source_package" --user "$android_user" sh -c \
    "if [ ! -r '$target_data_dir/shared_prefs/vibepub.xml' ]; then printf 'isolated\\n'; else exit 1; fi" 2>/dev/null)"; then
    return 1
  fi
  [[ "${output//$'\r'/}" == "isolated" ]]
}

if ! android_user="$(adb_cmd shell am get-current-user 2>/dev/null | tr -d '\r')"; then
  echo "Could not resolve the active Android user." >&2
  exit 1
fi
if [[ ! "$android_user" =~ ^[0-9]+$ ]]; then
  echo "Could not resolve the active Android user." >&2
  exit 1
fi

if ! production_state="$(package_installed "$PRODUCTION_PACKAGE")"; then
  echo "Could not query Production for the active Android user." >&2
  exit 1
fi
production_was_installed=false
[[ "$production_state" == "absent" ]] || production_was_installed=true

install_apk "$PRODUCTION_APK" > "$EVIDENCE_DIR/install-production.txt"
install_apk "$STAGING_APK" > "$EVIDENCE_DIR/install-staging.txt"

require_package_state "$PRODUCTION_PACKAGE" installed Production
require_package_state "$STAGING_PACKAGE" installed Staging

if ! production_uid="$(package_uid "$PRODUCTION_PACKAGE")" ||
  ! staging_uid="$(package_uid "$STAGING_PACKAGE")"; then
  echo "Could not query package UIDs for the active Android user." >&2
  exit 1
fi
if [[ -z "$production_uid" || -z "$staging_uid" || "$production_uid" == "$staging_uid" ]]; then
  echo "Production and Staging must have different Android UIDs." >&2
  exit 1
fi

if ! package_has_login_state "$PRODUCTION_PACKAGE" || ! package_has_login_state "$STAGING_PACKAGE"; then
  echo "Log into both Production and Staging on the selected device, then rerun this check." >&2
  echo "No app data was cleared or uninstalled." >&2
  exit 1
fi
if ! package_session_is_valid "$PRODUCTION_PACKAGE" "https://vibepub.litianc.cn" ||
  ! package_session_is_valid "$STAGING_PACKAGE" "$STAGING_API_URL"; then
  echo "Both apps must have valid sessions for their own /api/me endpoint; log into both and rerun." >&2
  echo "No app data was cleared or uninstalled." >&2
  exit 1
fi
if ! package_cannot_read_other_preferences "$PRODUCTION_PACKAGE" "$STAGING_PACKAGE" ||
  ! package_cannot_read_other_preferences "$STAGING_PACKAGE" "$PRODUCTION_PACKAGE"; then
  echo "Production and Staging login storage is not isolated in both directions." >&2
  exit 1
fi

adb_cmd shell am force-stop --user "$android_user" "$PRODUCTION_PACKAGE"
adb_cmd shell am force-stop --user "$android_user" "$STAGING_PACKAGE"
production_digest_before="$(production_data_digest)"

adb_cmd shell pm clear --user "$android_user" "$STAGING_PACKAGE" > "$EVIDENCE_DIR/clear-staging.txt"
if ! staging_preferences_state="$(package_preferences_state "$STAGING_PACKAGE")"; then
  echo "Could not verify Staging preferences after data clear." >&2
  exit 1
fi
if [[ "$staging_preferences_state" != "absent" ]]; then
  echo "Staging login state survived Staging data clear." >&2
  exit 1
fi
production_digest_after_clear="$(production_data_digest)"
if [[ "$production_digest_before" != "$production_digest_after_clear" ]]; then
  echo "Production data changed after clearing Staging." >&2
  exit 1
fi

adb_cmd shell pm uninstall --user "$android_user" "$STAGING_PACKAGE" > "$EVIDENCE_DIR/uninstall-staging.txt"
if ! staging_package_state="$(package_installed "$STAGING_PACKAGE")"; then
  echo "Could not query Staging after uninstall for the active Android user." >&2
  exit 1
fi
if [[ "$staging_package_state" != "absent" ]]; then
  echo "Staging remained installed after uninstall." >&2
  exit 1
fi
production_digest_after_uninstall="$(production_data_digest)"
if [[ "$production_digest_before" != "$production_digest_after_uninstall" ]]; then
  echo "Production data changed after uninstalling Staging." >&2
  exit 1
fi

install_apk "$STAGING_APK" > "$EVIDENCE_DIR/reinstall-staging.txt"
require_package_state "$PRODUCTION_PACKAGE" installed Production
require_package_state "$STAGING_PACKAGE" installed Staging

cat > "$EVIDENCE_DIR/summary.md" <<EOF
# Android Environment Isolation

- Production package: \`$PRODUCTION_PACKAGE\`
- Staging package: \`$STAGING_PACKAGE\`
- Production existed before test: \`$production_was_installed\`
- Both packages installed together: \`yes\`
- Android UIDs differ: \`yes\`
- Production login storage present before destructive checks: \`yes\`
- Staging login storage present before destructive checks: \`yes\`
- Both stored sessions validated against their environment /api/me: \`yes\`
- Login storage isolated in both directions: \`yes\`
- Production data unchanged after Staging clear: \`yes\`
- Production data unchanged after Staging uninstall: \`yes\`
- Both packages installed at end: \`yes\`
- Production cleared or uninstalled: \`no\`
- Result: \`passed\`
EOF

echo "Android environment isolation checks passed."
echo "Summary: $EVIDENCE_DIR/summary.md"
