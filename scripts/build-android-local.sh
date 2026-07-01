#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
JDK21_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
JAVA_HOME="${ANDROID_LOCAL_JAVA_HOME:-$JDK21_HOME}"
TASK="${1:-all}"
if [[ $# -gt 0 ]]; then
  shift
fi
GRADLE_ARGS=("$@")

usage() {
  cat <<EOF
Usage:
  scripts/build-android-local.sh [test|assemble|all] [gradle args...]

Runs Android Gradle tasks with the local minimal SDK and JDK 21, matching the
GitHub Actions Android test environment without requiring Android Studio or an
emulator.

Examples:
  scripts/build-android-local.sh test --tests cn.litianc.vibepub.data.RecordingPresentationTest
  scripts/build-android-local.sh assemble --rerun-tasks

Environment:
  ANDROID_HOME             Default: /opt/homebrew/share/android-commandlinetools
  ANDROID_SDK_ROOT         Default: ANDROID_HOME
  ANDROID_LOCAL_JAVA_HOME  Default: /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
EOF
}

case "$TASK" in
  -h|--help)
    usage
    exit 0
    ;;
  test|assemble|all)
    ;;
  *)
    echo "Unknown task: $TASK" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ ! -d "$ANDROID_HOME/platforms/android-36" ]]; then
  echo "Missing Android platform: $ANDROID_HOME/platforms/android-36" >&2
  echo "Install with: sdkmanager \"platforms;android-36\" \"build-tools;36.0.0\"" >&2
  exit 1
fi

if [[ ! -d "$ANDROID_HOME/build-tools/36.0.0" ]]; then
  echo "Missing Android build tools: $ANDROID_HOME/build-tools/36.0.0" >&2
  echo "Install with: sdkmanager \"build-tools;36.0.0\"" >&2
  exit 1
fi

if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "Missing JDK 21 java: $JAVA_HOME/bin/java" >&2
  echo "Install with: HOMEBREW_NO_AUTO_UPDATE=1 brew install openjdk@21" >&2
  exit 1
fi

export ANDROID_HOME ANDROID_SDK_ROOT JAVA_HOME

run_gradle() {
  gradle -p "$ROOT_DIR/android" "$@"
}

case "$TASK" in
  test)
    run_gradle :app:testDebugUnitTest "${GRADLE_ARGS[@]}"
    ;;
  assemble)
    run_gradle :app:assembleDebug "${GRADLE_ARGS[@]}"
    ;;
  all)
    run_gradle :app:testDebugUnitTest :app:assembleDebug "${GRADLE_ARGS[@]}"
    ;;
esac
