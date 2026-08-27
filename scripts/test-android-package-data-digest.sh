#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PACKAGE_ROOT="$TMP_DIR/package"
mkdir -p "$PACKAGE_ROOT/shared_prefs" "$PACKAGE_ROOT/databases" "$PACKAGE_ROOT/files" "$PACKAGE_ROOT/no_backup"
printf 'first-state\n' > "$PACKAGE_ROOT/shared_prefs/vibepub.xml"
printf 'first-private-state\n' > "$PACKAGE_ROOT/no_backup/session-state"

FAKE_ADB="$TMP_DIR/adb"
cat > "$FAKE_ADB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${FAKE_ADB_FAIL:-false}" == "true" ]]; then
  echo "permission denied: shared_prefs/private-account.xml" >&2
  exit 13
fi
if [[ "${FAKE_ADB_EMPTY:-false}" == "true" ]]; then
  exit 0
fi

[[ "$1" == "-s" && "$3" == "exec-out" && "$4" == "run-as" && "$5" == "--user" && "$6" == "10" && "$8" == "sh" && "$9" == "-c" ]]
remote_command="${10}"
cd "${FAKE_PACKAGE_ROOT:?}"
/bin/bash -c "$remote_command"
EOF
chmod +x "$FAKE_ADB"

digest() {
  ADB="$FAKE_ADB" \
  FAKE_PACKAGE_ROOT="$PACKAGE_ROOT" \
    "$ROOT_DIR/scripts/android-package-data-digest.sh" \
      --serial synthetic-device \
      --user 10 \
      --package cn.litianc.vibepub
}

before="$(digest)"
[[ "$before" =~ ^[0-9a-f]{64}$ ]]

printf 'second-state\n' > "$PACKAGE_ROOT/shared_prefs/vibepub.xml"
after="$(digest)"
[[ "$after" =~ ^[0-9a-f]{64}$ ]]
[[ "$before" != "$after" ]] || {
  echo "Production digest did not change with Production data." >&2
  exit 1
}

before_no_backup="$after"
printf 'second-private-state\n' > "$PACKAGE_ROOT/no_backup/session-state"
after_no_backup="$(digest)"
[[ "$before_no_backup" != "$after_no_backup" ]] || {
  echo "Production digest did not change with no_backup data." >&2
  exit 1
}

error_output="$TMP_DIR/error-output.txt"
if ADB="$FAKE_ADB" \
  FAKE_PACKAGE_ROOT="$PACKAGE_ROOT" \
  FAKE_ADB_FAIL=true \
    "$ROOT_DIR/scripts/android-package-data-digest.sh" \
      --serial synthetic-device \
      --user 10 \
      --package cn.litianc.vibepub > "$error_output" 2>&1; then
  echo "Production digest unexpectedly passed after a read error." >&2
  exit 1
fi

if grep -Eq 'private-account|shared_prefs/' "$error_output"; then
  echo "Production digest exposed a private filename." >&2
  exit 1
fi
if grep -Eq '^[0-9a-f]{64}$' "$error_output"; then
  echo "Production digest returned an empty passing digest after an error." >&2
  exit 1
fi

empty_output="$TMP_DIR/empty-output.txt"
if ADB="$FAKE_ADB" \
  FAKE_PACKAGE_ROOT="$PACKAGE_ROOT" \
  FAKE_ADB_EMPTY=true \
    "$ROOT_DIR/scripts/android-package-data-digest.sh" \
      --serial synthetic-device \
      --user 10 \
      --package cn.litianc.vibepub > "$empty_output" 2>&1; then
  echo "Production digest accepted an empty ADB result." >&2
  exit 1
fi
if grep -Eq '^[0-9a-f]{64}$' "$empty_output"; then
  echo "Production digest returned an empty passing digest." >&2
  exit 1
fi

echo "Android package data digest tests passed."
