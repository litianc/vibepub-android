#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/platform-tools/adb}"
ANDROID_SERIAL=""
PACKAGE_NAME=""
ANDROID_USER=""

usage() {
  echo "Usage: scripts/android-package-data-digest.sh --serial adb-serial --user android-user --package package-name"
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

redacted_manifest="$(mktemp)"
trap 'rm -f "$redacted_manifest"' EXIT

read -r -d '' remote_digest_command <<'EOF' || true
set -eu
set -o pipefail
for root in shared_prefs databases files no_backup; do
  if [ -e "$root" ]; then
    find "$root" -type f -print
  fi
done | LC_ALL=C sort | while IFS= read -r file; do
  path_hash="$(printf '%s' "$file" | sha256sum | cut -d ' ' -f 1)"
  content_hash="$(sha256sum "$file" | cut -d ' ' -f 1)"
  printf '%s %s\n' "$path_hash" "$content_hash"
done
EOF

if ! "$ADB" -s "$ANDROID_SERIAL" exec-out run-as "$PACKAGE_NAME" --user "$ANDROID_USER" sh -c \
  "$remote_digest_command" > "$redacted_manifest" 2>/dev/null; then
  echo "Could not read package data for digest." >&2
  exit 1
fi
if [[ ! -s "$redacted_manifest" ]]; then
  echo "Package data digest returned no readable data." >&2
  exit 1
fi

if ! awk '
  NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^[0-9a-f]{64}$/ { exit 1 }
' "$redacted_manifest"; then
  echo "Package data digest returned invalid redacted data." >&2
  exit 1
fi

LC_ALL=C shasum -a 256 "$redacted_manifest" | awk '{ print $1 }'
