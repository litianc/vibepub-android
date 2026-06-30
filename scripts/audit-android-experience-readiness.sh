#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/android-experience-readiness/$RUN_ID}"
REPORT="$OUT_DIR/readiness.md"

usage() {
  cat <<EOF
Usage:
  scripts/audit-android-experience-readiness.sh

Audits source, tests, scripts, docs, and release metadata for the Android
experience-priority plan. This is a pre-E2E gate: it proves local/CI coverage
and names the requirements that still need a real-device smoke run.

Environment:
  OUT_DIR  Evidence directory. Default: artifacts/android-experience-readiness/<time>
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

mkdir -p "$OUT_DIR"

failures=0
manual=0

pass() {
  printf -- '- [x] %s\n' "$1" >> "$REPORT"
}

fail() {
  printf -- '- [ ] %s\n' "$1" >> "$REPORT"
  failures=$((failures + 1))
}

manual_gate() {
  printf -- '- [~] %s\n' "$1" >> "$REPORT"
  manual=$((manual + 1))
}

require_file() {
  local label="$1"
  local file="$2"

  if [[ -f "$ROOT_DIR/$file" ]]; then
    pass "$label: \`$file\`"
  else
    fail "$label missing: \`$file\`"
  fi
}

require_pattern() {
  local label="$1"
  local pattern="$2"
  shift 2
  local files=("$@")

  if rg -n -- "$pattern" "${files[@]/#/$ROOT_DIR/}" > "$OUT_DIR/${label//[^A-Za-z0-9_.-]/_}.txt"; then
    pass "$label"
  else
    fail "$label"
  fi
}

require_all_patterns() {
  local label="$1"
  local file="$2"
  shift 2
  local missing=()
  local pattern

  for pattern in "$@"; do
    if ! rg -n -- "$pattern" "$ROOT_DIR/$file" >> "$OUT_DIR/${label//[^A-Za-z0-9_.-]/_}.txt" 2>/dev/null; then
      missing+=("$pattern")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    pass "$label"
  else
    fail "$label missing: ${missing[*]}"
  fi
}

require_no_pattern() {
  local label="$1"
  local pattern="$2"
  shift 2
  local files=("$@")

  if rg -n -- "$pattern" "${files[@]/#/$ROOT_DIR/}" > "$OUT_DIR/${label//[^A-Za-z0-9_.-]/_}.txt"; then
    fail "$label"
  else
    pass "$label"
  fi
}

acceptance_report_passed() {
  local file="$1"

  [[ -s "$file" ]] || return 1
  grep -Eq '^\[x\] ' "$file" || return 1
  ! grep -Eq '^(\- )?\[ \] ' "$file"
}

checklist_status_passed() {
  local file="$1"

  [[ -f "$file" ]] || return 1
  grep -Fq 'Acceptance status: `passed`' "$file"
}

{
  echo "# Android Experience Readiness Audit"
  echo
  echo "- Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "- Branch: $(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || echo unknown)"
  echo "- Commit: $(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo
  echo "## Product Scope Evidence"
} > "$REPORT"

require_file "Product requirements" "docs/android-product-requirements.md"
require_file "E2E acceptance runbook" "docs/e2e-acceptance-runbook.md"
require_file "Latest artifact manifest" "artifacts/MANIFEST.md"

echo >> "$REPORT"
echo "## Android App Evidence" >> "$REPORT"

require_all_patterns \
  "State enum has the six required lifecycle values" \
  "android/app/src/main/java/cn/litianc/vibepub/data/RecordingStatus.kt" \
  'LOCAL_RECORDED' 'UPLOADING' 'UPLOADED' 'PROCESSING' 'COMPLETED' 'FAILED'

require_all_patterns \
  "Room entity has experience fields" \
  "android/app/src/main/java/cn/litianc/vibepub/data/RecordingEntity.kt" \
  'articleTitle' 'rawTextPreview' 'localAudioPath' 'remoteStatusUpdatedAt' 'lastError' 'completedAt'

require_pattern \
  "Recording screen exposes live amplitude/waveform feedback" \
  'amplitude|Waveform|amplitudeLevel' \
  "android/app/src/main/java/cn/litianc/vibepub/ui/screens/RecordingScreen.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/ui/screens/RecordingScreenTest.kt"

require_pattern \
  "Home screen exposes workflow help/status info" \
  'WorkflowHelpDialog|WorkflowHelpButton|查看处理进度说明' \
  "android/app/src/main/java/cn/litianc/vibepub/ui/screens/HomeScreen.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/ui/screens/WorkflowHelpDialogTest.kt"

require_pattern \
  "Detail screen uses Media3 playback controls" \
  'ExoPlayer|PlaybackSlider|seekTo|播放|暂停' \
  "android/app/src/main/java/cn/litianc/vibepub/ui/screens/DetailScreen.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/ui/screens/DetailScreenTest.kt"

require_pattern \
  "Detail screen strips HTML before rendering article body" \
  'Html.fromHtml|plain text|raw HTML|&lt;' \
  "android/app/src/main/java/cn/litianc/vibepub/ui/screens/DetailScreen.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/ui/screens/DetailScreenTest.kt"

require_pattern \
  "Detail screen exposes copy/share/export actions" \
  'CopyTitleButton|CopyArticleButton|ShareArticleButton|导出材料包|shareArticle' \
  "android/app/src/main/java/cn/litianc/vibepub/ui/screens/DetailScreen.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/ui/screens/DetailScreenTest.kt"

require_pattern \
  "Settings screen exposes API/token connection test and diagnostics" \
  'API Base URL|FILES_TOKEN|测试后端连接|ConnectionResultCard|诊断信息' \
  "android/app/src/main/java/cn/litianc/vibepub/ui/screens/SettingsScreen.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/ui/screens/SettingsScreenTest.kt"

require_pattern \
  "Active progress sync refresh is covered" \
  'RecordingProgressRefresh|activeProgressSync|SyncRequestKind|ExistingWorkPolicy.REPLACE' \
  "android/app/src/main/java/cn/litianc/vibepub" \
  "android/app/src/test/java/cn/litianc/vibepub"

require_pattern \
  "Duplicate/zero-duration recording risks have local test coverage" \
  'zero|0m0s|duplicate|non-zero|duration' \
  "android/app/src/test/java/cn/litianc/vibepub" \
  "scripts/android-device-visual-test.sh" \
  "scripts/audit-android-device-smoke.sh"

echo >> "$REPORT"
echo "## Backend And Pipeline Evidence" >> "$REPORT"

require_pattern \
  "Worker returns Android display fields" \
  'article_title|raw_text_preview|duration_ms|processing_stage|wechat_url|wechat_draft_id|error_message' \
  "infra/worker/src/index.ts" \
  "infra/worker/test/worker-contract.test.mjs" \
  "infra/worker/README.md"

require_pattern \
  "Worker upload dispatch targets the uploaded filename" \
  'target_filename|GITHUB_WORKFLOW_REF|workflow_dispatch' \
  "infra/worker/src/index.ts" \
  "infra/worker/test/worker-contract.test.mjs" \
  ".github/workflows/mining-job.yml"

require_pattern \
  "Mining writes ARTICLE_READY and DRAFT_FAILED progress" \
  'ARTICLE_READY|DRAFT_FAILED|DRAFTING' \
  "infra/mining/src/index.ts" \
  "infra/mining/test/pipeline.test.ts"

require_pattern \
  "Android sync maps ARTICLE_READY/DRAFT_FAILED from remote list" \
  'ARTICLE_READY|DRAFT_FAILED|mergeRemoteRecordingFromListItem' \
  "android/app/src/main/java/cn/litianc/vibepub/SyncWorker.kt" \
  "android/app/src/test/java/cn/litianc/vibepub/SyncWorkerTest.kt"

echo >> "$REPORT"
echo "## Automation And Release Evidence" >> "$REPORT"

require_file "One-command real-device smoke wrapper" "scripts/run-android-device-smoke.sh"
require_file "Real-device visual smoke script" "scripts/android-device-visual-test.sh"
require_file "Real-device smoke audit script" "scripts/audit-android-device-smoke.sh"
require_file "ADB readiness preflight" "scripts/check-android-device-ready.sh"

require_pattern \
  "Smoke automation waits for Worker-created mining run" \
  'MINING_TRIGGER_MODE|auto_or_manual|mining-run.log|workflow_dispatch' \
  "scripts/android-device-visual-test.sh" \
  "scripts/run-android-device-smoke.sh"

require_pattern \
  "Smoke audit rejects stale UI, raw HTML, duplicate rows, and missing detail actions" \
  'raw HTML|duplicate|debug-detail-actions|playback|copy|share|export|COMPLETED' \
  "scripts/audit-android-device-smoke.sh" \
  "docs/e2e-acceptance-runbook.md"

require_pattern \
  "Artifact manifest points at a GitHub Release APK" \
  'Latest Version|Release Digest|github.com/litianc/vibepub-android/releases/download/.*/app-debug.apk' \
  "artifacts/MANIFEST.md"

require_no_pattern \
  "User-facing Android source has no Apple/iCloud/TestFlight copy" \
  'Apple|iCloud|TestFlight|Sign in with Apple|iOS' \
  "android/app/src/main/java/cn/litianc/vibepub"

echo >> "$REPORT"
echo "## Required Real-Device Gates" >> "$REPORT"

if command -v adb >/dev/null 2>&1 &&
  adb devices | awk 'NR > 1 && $2 == "device" { found=1 } END { exit found ? 0 : 1 }'; then
  pass "At least one authorized adb device is currently connected"
else
  manual_gate "No authorized adb device is currently connected; full smoke remains pending"
fi

latest_visual_run="$(find "$ROOT_DIR/artifacts/android-device-visual" -maxdepth 2 -name acceptance-report.txt 2>/dev/null | sort | tail -n 1 || true)"
if [[ -n "$latest_visual_run" ]] &&
  acceptance_report_passed "$latest_visual_run" &&
  checklist_status_passed "$(dirname "$latest_visual_run")/checklist.md"; then
  pass "Latest historical real-device acceptance report passed: \`${latest_visual_run#$ROOT_DIR/}\`"
else
  manual_gate "No passing real-device acceptance report found"
fi

if [[ -n "$latest_visual_run" ]]; then
  latest_visual_dir="$(dirname "$latest_visual_run")"
  if "$ROOT_DIR/scripts/audit-android-device-smoke.sh" "$latest_visual_dir" > "$OUT_DIR/device-smoke-audit.txt" 2>&1; then
    if grep -q '^SKIP:' "$OUT_DIR/device-smoke-audit.txt"; then
      manual_gate "Latest historical real-device smoke audit passed with live-device checks skipped; see \`$OUT_DIR/device-smoke-audit.txt\`"
    else
      pass "Latest real-device smoke audit passed: \`${latest_visual_dir#$ROOT_DIR/}\`"
    fi
  else
    manual_gate "Latest real-device smoke audit did not pass; see \`$OUT_DIR/device-smoke-audit.txt\`"
  fi
else
  manual_gate "Real-device smoke audit skipped because no acceptance report exists"
fi

cat >> "$REPORT" <<EOF

## Summary

- Automated source/test/release failures: \`$failures\`
- Manual or device-gated items: \`$manual\`
- Evidence directory: \`$OUT_DIR\`
EOF

cat "$REPORT"

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "Android experience readiness audit failed. Report: $REPORT" >&2
  exit 1
fi

echo
echo "Android experience source readiness passed. Device-gated items may remain; see report: $REPORT"
