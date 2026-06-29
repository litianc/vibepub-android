#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-}"
PACKAGE_NAME="${PACKAGE_NAME:-cn.litianc.vibepub}"

usage() {
  cat <<EOF
Usage:
  scripts/audit-android-device-smoke.sh artifacts/android-device-visual/<run-id>

Checks that a real-device smoke run proved the current recording-to-transcript
flow instead of passing on stale UI, pending backend state, raw HTML, duplicate
local rows, or mismatched duration text.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || -z "$OUT_DIR" ]]; then
  usage
  exit 0
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

xml_contains_text() {
  local text="$1"
  grep -Fq "text=\"$text\"" "$OUT_DIR/window.xml"
}

adb_cmd() {
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    adb -s "$ANDROID_SERIAL" "$@"
  else
    adb "$@"
  fi
}

[[ -d "$OUT_DIR" ]] || fail "not a directory: $OUT_DIR"

require_file "$OUT_DIR/checklist.md"
require_file "$OUT_DIR/window.xml"
require_file "$OUT_DIR/latest-recording-filename.txt"
require_file "$OUT_DIR/expected-duration-text.txt"
require_file "$OUT_DIR/backend-recording-status.txt"
require_file "$OUT_DIR/mining-run-id.txt"
require_file "$OUT_DIR/mining-run-url.txt"
require_file "$OUT_DIR/recordings-api.json"
require_file "$OUT_DIR/debug-device-test-status.json"
require_file "$OUT_DIR/appops-record-audio.txt"
require_file "$OUT_DIR/package-after-permissions.txt"

filename="$(cat "$OUT_DIR/latest-recording-filename.txt")"
duration_text="$(cat "$OUT_DIR/expected-duration-text.txt")"
backend_status="$(cat "$OUT_DIR/backend-recording-status.txt")"
run_id="$(cat "$OUT_DIR/mining-run-id.txt")"

[[ -n "$filename" ]] || fail "latest recording filename is empty"
[[ -n "$duration_text" ]] || fail "expected duration text is empty"
[[ "$backend_status" == "COMPLETED" ]] || fail "backend status is not COMPLETED: $backend_status"
pass "backend marked $filename COMPLETED"

grep -Fq "$filename" "$OUT_DIR/debug-device-test-status.json" \
  || fail "debug status does not reference latest filename"
grep -Fq "$filename" "$OUT_DIR/recordings-api.json" \
  || fail "recordings API evidence does not reference latest filename"
grep -Fq "\"status\": \"COMPLETED\"" "$OUT_DIR/recordings-api.json" \
  || fail "recordings API evidence does not contain COMPLETED status"
pass "debug status and recordings API reference latest filename"

grep -Fq "Transcript detail status: \`completed\`" "$OUT_DIR/checklist.md" \
  || fail "checklist did not record completed detail assertion"
grep -Fq "Backend recording status: \`COMPLETED\`" "$OUT_DIR/checklist.md" \
  || fail "checklist did not record COMPLETED backend status"
grep -Fq "$run_id" "$OUT_DIR/checklist.md" \
  || fail "checklist did not record mining run id/url"
pass "checklist recorded completed UI, backend, and mining evidence"

grep -Fq "原始识别结果" "$OUT_DIR/window.xml" \
  || fail "UI dump does not show raw transcript preview"
grep -Eq "&lt;/?(p|h[1-6]|br|div|ul|ol|li)([[:space:]][^&]*)?&gt;" "$OUT_DIR/window.xml" \
  && fail "UI dump still contains raw HTML tags"
xml_contains_text "$duration_text" \
  || fail "UI dump does not contain expected duration text: $duration_text"
grep -Fq "正在获取云端转录" "$OUT_DIR/window.xml" \
  && fail "UI dump still shows pending transcript state"
grep -Fq "正在转录" "$OUT_DIR/window.xml" \
  && fail "UI dump still shows processing transcript state"
grep -Fq "转录失败" "$OUT_DIR/window.xml" \
  && fail "UI dump shows transcript failure"
pass "UI dump shows transcript content, no raw HTML, and expected duration $duration_text"

grep -Fq "公众号草稿审核" "$OUT_DIR/window.xml" \
  || fail "UI dump does not show article review card"
grep -Fq "公众号草稿" "$OUT_DIR/window.xml" \
  || fail "UI dump does not show WeChat draft review item"
grep -Fq "导出材料包" "$OUT_DIR/window.xml" \
  || fail "UI dump does not show export package action"
grep -Fq "查看处理进度说明" "$OUT_DIR/window.xml" \
  || fail "UI dump does not expose status lifecycle help"
pass "UI dump shows review card, WeChat draft readiness, export action, and status help"

grep -Eq "RECORD_AUDIO: (allow|foreground)" "$OUT_DIR/appops-record-audio.txt" \
  || fail "RECORD_AUDIO appops was not allow/foreground"
grep -Fq "android.permission.RECORD_AUDIO: granted=true" "$OUT_DIR/package-after-permissions.txt" \
  || fail "RECORD_AUDIO runtime permission was not granted"
pass "microphone permission and appops were granted"

if command -v gh >/dev/null 2>&1; then
  conclusion="$(gh run view "$run_id" --json conclusion --jq '.conclusion' 2>/dev/null || true)"
  [[ "$conclusion" == "success" ]] || fail "mining workflow run is not success: ${conclusion:-unknown}"
  pass "mining workflow $run_id succeeded"
fi

if command -v adb >/dev/null 2>&1 && adb devices | awk -v serial="${ANDROID_SERIAL:-}" 'NR > 1 && $2 == "device" && (serial == "" || $1 == serial) { found=1 } END { exit found ? 0 : 1 }'; then
  tmp_dir="$(mktemp -d "$ROOT_DIR/artifacts/android-db-inspect/audit-XXXXXX")"
  adb_cmd exec-out run-as "$PACKAGE_NAME" cat databases/vibepub_database > "$tmp_dir/vibepub_database"
  adb_cmd exec-out run-as "$PACKAGE_NAME" cat databases/vibepub_database-wal > "$tmp_dir/vibepub_database-wal" 2>/dev/null || true
  adb_cmd exec-out run-as "$PACKAGE_NAME" cat databases/vibepub_database-shm > "$tmp_dir/vibepub_database-shm" 2>/dev/null || true
  if command -v sqlite3 >/dev/null 2>&1; then
    row="$(sqlite3 "$tmp_dir/vibepub_database" \
      "select count(*), coalesce(max(durationMs), 0), group_concat(distinct status) from recordings where filename='$filename';")"
    count="$(printf '%s' "$row" | awk -F'|' '{ print $1 }')"
    duration_ms="$(printf '%s' "$row" | awk -F'|' '{ print $2 }')"
    statuses="$(printf '%s' "$row" | awk -F'|' '{ print $3 }')"
    [[ "$count" == "1" ]] || fail "local DB has $count rows for $filename"
    [[ "$duration_ms" -gt 0 ]] || fail "local DB duration is zero for $filename"
    [[ "$statuses" == "COMPLETED" ]] || fail "local DB status is not COMPLETED: $statuses"
    pass "local DB has one non-zero COMPLETED row for latest filename"
  else
    echo "SKIP: sqlite3 not installed; local DB duplicate check skipped"
  fi
else
  echo "SKIP: no authorized adb device; local DB duplicate check skipped"
fi

echo
echo "Android device smoke audit passed:"
echo "  $OUT_DIR"
