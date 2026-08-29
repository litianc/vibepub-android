#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PACKAGE_ROOT="$TMP_DIR/package"
mkdir -p "$PACKAGE_ROOT/shared_prefs"
cat > "$PACKAGE_ROOT/shared_prefs/vibepub.xml" <<'EOF'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="access_token">private-test-token</string>
    <string name="user_id">private-test-user</string>
</map>
EOF

FAKE_ADB="$TMP_DIR/adb"
cat > "$FAKE_ADB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${FAKE_ADB_FAIL:-false}" == "true" ]]; then
  echo "permission denied: shared_prefs/vibepub.xml" >&2
  exit 13
fi

[[ "$1" == "-s" && "$3" == "exec-out" && "$4" == "run-as" && "$5" == "cn.litianc.vibepub" && "$6" == "--user" && "$7" == "10" && "$8" == "sh" && "$9" == "-c" ]]
remote_command="${10}"
cd "${FAKE_PACKAGE_ROOT:?}"
/bin/sh -c "$remote_command"
EOF
chmod +x "$FAKE_ADB"

check_login() {
  ADB="$FAKE_ADB" \
  FAKE_PACKAGE_ROOT="$PACKAGE_ROOT" \
    "$ROOT_DIR/scripts/android-package-login-state.sh" \
      --serial synthetic-device \
      --user 10 \
      --package cn.litianc.vibepub
}

login_output="$(check_login)"
[[ "$login_output" == "authenticated" ]]
[[ "$login_output" != *"private-test-token"* ]]
[[ "$login_output" != *"private-test-user"* ]]

grep -v 'access_token' "$PACKAGE_ROOT/shared_prefs/vibepub.xml" > "$TMP_DIR/logged-out.xml"
mv "$TMP_DIR/logged-out.xml" "$PACKAGE_ROOT/shared_prefs/vibepub.xml"
missing_output="$TMP_DIR/missing-output.txt"
if check_login > "$missing_output" 2>&1; then
  echo "Login-state check passed without an access token." >&2
  exit 1
fi
if grep -Eq 'private-test|shared_prefs/' "$missing_output"; then
  echo "Login-state check exposed private preference data." >&2
  exit 1
fi

error_output="$TMP_DIR/error-output.txt"
if ADB="$FAKE_ADB" \
  FAKE_PACKAGE_ROOT="$PACKAGE_ROOT" \
  FAKE_ADB_FAIL=true \
    "$ROOT_DIR/scripts/android-package-login-state.sh" \
      --serial synthetic-device \
      --user 10 \
      --package cn.litianc.vibepub > "$error_output" 2>&1; then
  echo "Login-state check passed after a read error." >&2
  exit 1
fi
if grep -Eq 'vibepub.xml|shared_prefs/' "$error_output"; then
  echo "Login-state error exposed a private filename." >&2
  exit 1
fi

echo "Android package login-state tests passed."
