#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${REPO:-litianc/vibepub-android}"
WORKFLOW="${WORKFLOW:-Android Build & Release}"
ARTIFACT_NAME="${ARTIFACT_NAME:-vibepub-debug-apk}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/artifacts/apk/latest}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"

usage() {
  cat <<EOF
Usage:
  scripts/download-latest-android-apk.sh

Environment:
  REPO           GitHub repo. Default: litianc/vibepub-android.
  WORKFLOW       Workflow name. Default: Android Build & Release.
  ARTIFACT_NAME  Artifact name. Default: vibepub-debug-apk.
  OUT_DIR        Destination directory. Default: artifacts/apk/latest.
  MAX_ATTEMPTS   GitHub API/download attempts. Default: 3.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing command: gh" >&2
  echo "Install GitHub CLI or download the APK artifact manually." >&2
  exit 1
fi

run_with_retries() {
  local attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" != "$MAX_ATTEMPTS" ]]; then
      sleep "$attempt"
    fi
  done
  return 1
}

run_id="$(
  run_with_retries gh run list \
    --repo "$REPO" \
    --workflow "$WORKFLOW" \
    --status success \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
)"

if [[ -z "$run_id" || "$run_id" == "null" ]]; then
  echo "No successful workflow run found for $WORKFLOW in $REPO" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "Downloading artifact '$ARTIFACT_NAME' from run $run_id..."
run_with_retries gh run download "$run_id" \
  --repo "$REPO" \
  --name "$ARTIFACT_NAME" \
  --dir "$OUT_DIR"

apk_path="$(find "$OUT_DIR" -type f -name '*.apk' | head -n 1)"
if [[ -z "$apk_path" ]]; then
  echo "No APK found in downloaded artifact: $OUT_DIR" >&2
  exit 1
fi

echo "$apk_path"
