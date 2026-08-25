#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/package/shared_prefs"
mkdir -p "$TMP_DIR/hostile-home"
cat > "$TMP_DIR/package/shared_prefs/vibepub.xml" <<'EOF'
<map>
  <string name="api_base_url">https://staging.example.test</string>
  <string name="access_token">temporary-session-value</string>
  <string name="user_id">temporary-user-value</string>
</map>
EOF

cat > "$TMP_DIR/hostile-home/.curlrc" <<EOF
output = "$TMP_DIR/curlrc-leak.txt"
url = "https://curlrc-interference.invalid"
EOF

cat > "$TMP_DIR/adb" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-s" && "$3" == "exec-out" && "$4" == "run-as" && "$5" == "--user" && "$6" == "10" && "$8" == "sh" && "$9" == "-c" ]]
cd "${FAKE_PACKAGE_ROOT:?}"
/bin/sh -c "${10}"
EOF

cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "-q" ]]; then
  leak_path="$(sed -n 's/^output = "\(.*\)"$/\1/p' "${HOME:?}/.curlrc")"
  cat > "${leak_path:?}"
  exit 97
fi
shift
[[ "$1" == "--config" && "$2" == "-" ]]
config="$(cat)"
[[ "$config" == *'url = "https://staging.example.test/api/me"'* ]]
[[ "$config" == *'header = "Authorization: Bearer temporary-session-value"'* ]]
[[ "${FAKE_HTTP_FAIL:-false}" != "true" ]]
if [[ "${FAKE_WRONG_USER:-false}" == "true" ]]; then
  printf '%s' '{"user":{"id":"different-user"}}'
else
  printf '%s' '{"user":{"id":"temporary-user-value"}}'
fi
EOF
chmod +x "$TMP_DIR/adb" "$TMP_DIR/curl"

validate_session() {
  HOME="$TMP_DIR/hostile-home" ADB="$TMP_DIR/adb" CURL="$TMP_DIR/curl" \
  FAKE_PACKAGE_ROOT="$TMP_DIR/package" \
    "$ROOT_DIR/scripts/android-package-session-me.sh" \
      --serial synthetic-device --user 10 --package cn.litianc.vibepub.staging \
      --expected-api-base-url https://staging.example.test
}

[[ "$(validate_session)" == "validated" ]]
[[ ! -e "$TMP_DIR/curlrc-leak.txt" ]]

for mode in FAKE_HTTP_FAIL FAKE_WRONG_USER; do
  output="$TMP_DIR/$mode.txt"
  if env "$mode=true" HOME="$TMP_DIR/hostile-home" ADB="$TMP_DIR/adb" CURL="$TMP_DIR/curl" \
    FAKE_PACKAGE_ROOT="$TMP_DIR/package" \
    "$ROOT_DIR/scripts/android-package-session-me.sh" \
      --serial synthetic-device --user 10 --package cn.litianc.vibepub.staging \
      --expected-api-base-url https://staging.example.test >"$output" 2>&1; then
    echo "Session validation passed a fail-closed case." >&2
    exit 1
  fi
  if grep -Eq 'temporary-session|temporary-user|shared_prefs/' "$output"; then
    echo "Session validation exposed private data." >&2
    exit 1
  fi
done

if HOME="$TMP_DIR/hostile-home" ADB="$TMP_DIR/adb" CURL="$TMP_DIR/curl" \
  FAKE_PACKAGE_ROOT="$TMP_DIR/package" \
  "$ROOT_DIR/scripts/android-package-session-me.sh" \
    --serial synthetic-device --user 10 --package cn.litianc.vibepub.staging \
    --expected-api-base-url https://other.example.test >/dev/null 2>&1; then
  echo "Session validation accepted the wrong environment URL." >&2
  exit 1
fi
if [[ -e "$TMP_DIR/curlrc-leak.txt" ]] && grep -Fq 'temporary-session-value' "$TMP_DIR/curlrc-leak.txt"; then
  echo "A hostile curlrc captured the session token." >&2
  exit 1
fi

echo "Android package /api/me session tests passed."
