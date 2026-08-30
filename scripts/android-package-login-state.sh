#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/platform-tools/adb}"
ANDROID_SERIAL=""
PACKAGE_NAME=""
ANDROID_USER=""

usage() {
  echo "Usage: scripts/android-package-login-state.sh --serial adb-serial --user android-user --package package-name"
}

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
    --package)
      PACKAGE_NAME="${2:?--package requires a value}"
      shift 2
      ;;
    --package=*)
      PACKAGE_NAME="${1#--package=}"
      shift
      ;;
    --user)
      ANDROID_USER="${2:?--user requires a value}"
      shift 2
      ;;
    --user=*)
      ANDROID_USER="${1#--user=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ANDROID_SERIAL" || -z "$PACKAGE_NAME" || ! "$ANDROID_USER" =~ ^[0-9]+$ ]]; then
  usage >&2
  exit 1
fi
if [[ ! -x "$ADB" ]]; then
  echo "Android adb not found." >&2
  exit 1
fi

current_user="$($ADB -s "$ANDROID_SERIAL" shell am get-current-user 2>/dev/null | tr -d '\r')"
if [[ "$current_user" != "$ANDROID_USER" ]]; then
  echo "Selected Android user is not active." >&2
  exit 1
fi

read -r -d '' remote_login_check <<'EOF' || true
set -eu
preferences=shared_prefs/vibepub.xml
test -r "$preferences"
grep -Eq '<string name="access_token">[^<]+</string>' "$preferences"
grep -Eq '<string name="user_id">[^<]+</string>' "$preferences"
printf 'authenticated\n'
EOF

if ! login_state="$($ADB -s "$ANDROID_SERIAL" exec-out run-as "$PACKAGE_NAME" --user "$ANDROID_USER" sh -c \
  "$remote_login_check" 2>/dev/null)" || [[ "${login_state//$'\r'/}" != "authenticated" ]]; then
  echo "Package login state is missing or unreadable." >&2
  exit 1
fi

echo "authenticated"
