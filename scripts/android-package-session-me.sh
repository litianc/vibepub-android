#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/platform-tools/adb}"
CURL="${CURL:-curl}"
JQ="${JQ:-jq}"
ANDROID_SERIAL=""
PACKAGE_NAME=""
ANDROID_USER=""
EXPECTED_API_BASE_URL=""
session_data=""
access_token=""
stored_user_id=""
http_body=""
trap 'unset session_data access_token stored_user_id http_body' EXIT

usage() {
  echo "Usage: scripts/android-package-session-me.sh --serial adb-serial --user android-user --package package-name --expected-api-base-url https-url"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --serial) ANDROID_SERIAL="${2:?--serial requires a value}"; shift 2 ;;
    --serial=*) ANDROID_SERIAL="${1#--serial=}"; shift ;;
    --package) PACKAGE_NAME="${2:?--package requires a value}"; shift 2 ;;
    --package=*) PACKAGE_NAME="${1#--package=}"; shift ;;
    --user) ANDROID_USER="${2:?--user requires a value}"; shift 2 ;;
    --user=*) ANDROID_USER="${1#--user=}"; shift ;;
    --expected-api-base-url) EXPECTED_API_BASE_URL="${2:?--expected-api-base-url requires a value}"; shift 2 ;;
    --expected-api-base-url=*) EXPECTED_API_BASE_URL="${1#--expected-api-base-url=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

EXPECTED_API_BASE_URL="${EXPECTED_API_BASE_URL%/}"
if [[ -z "$ANDROID_SERIAL" || -z "$PACKAGE_NAME" || ! "$ANDROID_USER" =~ ^[0-9]+$ || ! "$EXPECTED_API_BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  usage >&2
  exit 1
fi
if { [[ "$ADB" == */* ]] && [[ ! -x "$ADB" ]]; } ||
  { [[ "$ADB" != */* ]] && ! command -v "$ADB" >/dev/null 2>&1; } ||
  ! command -v "$CURL" >/dev/null 2>&1 || ! command -v "$JQ" >/dev/null 2>&1; then
  echo "Session validation tools are unavailable." >&2
  exit 1
fi

read -r -d '' remote_session_read <<'EOF' || true
set -eu
preferences=shared_prefs/vibepub.xml
test -r "$preferences"
read_value() {
  key="$1"
  value="$(sed -n "s@.*<string name=\"$key\">\([^<][^<]*\)</string>.*@\1@p" "$preferences")"
  test -n "$value"
  test "$(printf '%s\n' "$value" | wc -l | tr -d ' ')" = 1
  printf '%s\n' "$value"
}
read_value api_base_url
read_value access_token
read_value user_id
EOF

if ! session_data="$({ "$ADB" -s "$ANDROID_SERIAL" exec-out run-as --user "$ANDROID_USER" "$PACKAGE_NAME" sh -c "$remote_session_read"; } 2>/dev/null)"; then
  echo "Stored session is missing or unreadable." >&2
  exit 1
fi
if [[ "$(printf '%s\n' "$session_data" | wc -l | tr -d ' ')" != 3 ]]; then
  echo "Stored session is invalid." >&2
  exit 1
fi
stored_api_base_url="$(printf '%s\n' "$session_data" | sed -n '1p')"
access_token="$(printf '%s\n' "$session_data" | sed -n '2p')"
stored_user_id="$(printf '%s\n' "$session_data" | sed -n '3p')"
session_data=""
if [[ "$stored_api_base_url" != "$EXPECTED_API_BASE_URL" || ! "$access_token" =~ ^[A-Za-z0-9._~+/=-]+$ || -z "$stored_user_id" ]]; then
  echo "Stored session does not match the expected environment." >&2
  exit 1
fi

if ! http_body="$(
  printf 'url = "%s/api/me"\nheader = "Authorization: Bearer %s"\nsilent\nshow-error\nfail-with-body\n' \
    "$EXPECTED_API_BASE_URL" "$access_token" |
    "$CURL" -q --config - 2>/dev/null
)"; then
  echo "Stored session could not be validated." >&2
  exit 1
fi
access_token=""
if ! printf '%s' "$http_body" | "$JQ" -e --arg expected_user_id "$stored_user_id" \
  '(.user.id | tostring) == $expected_user_id' >/dev/null 2>&1; then
  echo "Stored session could not be validated." >&2
  exit 1
fi
http_body=""
stored_user_id=""
echo "validated"
