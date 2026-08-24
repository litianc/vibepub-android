#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

required_tracked=(
  ".codex/skills/vibepub-android-dogfood/SKILL.md"
  "AGENTS.md"
  "CONTEXT.md"
  "docs/agents/domain.md"
  "docs/agents/issue-tracker.md"
  "docs/agents/triage-labels.md"
  "docs/android-release-manifest.md"
  "docs/release-batch-extraction.md"
  "skills-lock.json"
)

for path in "${required_tracked[@]}"; do
  if ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "Required project file is not tracked: $path" >&2
    exit 1
  fi
done

forbidden_tracked_regex='^(\.agents/skills/|artifacts/|outputs/|test-artifacts/|secrets/)|(^|/)(\.env($|\.)|(screenshot|screen[-_]?capture).*\.(png|jpe?g|webp)|ui[-_]?dump.*\.xml|window[-_]?dump.*\.xml|credentials?.*\.(json|txt)|private[-_]?key.*|tokens?.*\.txt|[^/]+\.(apk|log|hprof|jks|keystore|p12|p8|pem|key|token))$'
forbidden_tracked="$(git ls-files | grep -E "$forbidden_tracked_regex" | grep -Ev '(^|/)\.env\.(example|template)$' || true)"
if [[ -n "$forbidden_tracked" ]]; then
  echo "Generated or external files are tracked:" >&2
  echo "$forbidden_tracked" >&2
  exit 1
fi

ignored_samples=(
  ".agents/skills/example/SKILL.md"
  "artifacts/device/screenshot.png"
  "outputs/candidate.apk"
  "test-artifacts/raw-output.txt"
  "candidate.apk"
  "debug.log"
  "heap.hprof"
  "screenshot-device.png"
  "screenshot_device.png"
  "screenshot.jpg"
  "screen-capture.png"
  "ui-dump.xml"
  "ui_dump.xml"
  "window-dump.xml"
  "window_dump.xml"
  "credentials.json"
  "private.key"
  "token.txt"
  "secrets/test.env"
  ".env.production"
  "android/release.jks"
  "android/release.keystore"
  "android/release.p12"
)

for path in "${ignored_samples[@]}"; do
  if ! git check-ignore -q "$path"; then
    echo "Expected generated or private path is not ignored: $path" >&2
    exit 1
  fi
done

jq -e 'type == "object" and .version == 1 and (.skills | type == "object")' skills-lock.json >/dev/null

echo "Repository hygiene checks passed."
