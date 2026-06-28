# Android Visual Test Infrastructure

This document defines what must be provided to make real-device visual testing a
standard part of VibePub development.

## Goal

Every user-facing Android change should be verifiable on a real phone without
installing Android Studio, the full Android SDK, or an emulator on the Mac.

The standard test path is:

1. Build or download an APK from GitHub Actions.
2. Install it on a USB-connected Android test phone.
3. Inject test backend settings.
4. Start screen recording.
5. Start recording through the debug-only ADB control receiver.
6. Play a prepared audio sample from the Mac speaker.
7. Stop recording through the debug-only ADB control receiver.
8. Capture home/detail screenshots, UI dump, and logcat.
9. Store evidence under `artifacts/android-device-visual/`.

## What You Need To Provide

### 1. A Dedicated Android Test Phone

Required:

- USB debugging enabled.
- USB debugging security settings enabled, if the phone requires it.
- USB install enabled, if the phone restricts ADB-installed APKs.
- The Mac authorized in the phone's USB debugging prompt.
- Permission to install debug APKs.
- Permission to clear VibePub app data during deterministic test runs.

Recommended:

- Keep this as a test device, not a personal production phone.
- Keep it unlocked while tests run.
- Keep it near the Mac speaker for audio playback tests.

### 2. A Reliable USB Setup

Required:

- USB cable that supports data, not charge-only.
- `adb devices -l` shows the device as `device`.
- For `AUTOMATION_MODE=ui-tap`, `adb shell input tap 1 1` must run without
  `INJECT_EVENTS` security errors.

On Xiaomi, MIUI, or HyperOS phones, this usually requires enabling the extra
Developer options item named "USB debugging (Security settings)" or
`USB 调试（安全设置）` / `允许通过 USB 调试修改权限或模拟点击`.
If install fails with `INSTALL_FAILED_USER_RESTRICTED`, also enable `USB 安装`
or "Install via USB".
If uninstall/reset fails with `DELETE_FAILED_INTERNAL_ERROR`, remove the app
manually on the phone or enable the same USB install/security options before
running deterministic tests.

The default `AUTOMATION_MODE=debug-broadcast` does not require simulated tap
permission. It uses debug-only test receivers that are not packaged into release
builds.

### 3. Test Audio Files

Required:

- At least one short speech audio file, ideally 8-30 seconds.
- Clear spoken content that is easy to recognize in the transcript.
- Stable filename and location.

Current standard sample:

```text
/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3
```

Do not commit private voice samples unless you are comfortable keeping them in
the repo. If the sample is private, keep it outside the repo and pass it through
`AUDIO_FILE=/path/to/file.wav`.

### 4. Backend Test Credentials

Required for upload/transcript checks:

- `FILES_TOKEN`
- `API_BASE_URL`, normally `https://vibepub.litianc.cn`

Recommended:

- Store local secrets outside git, for example `secrets/device-test.env`.
- Source that file before running the script.

Example:

```bash
set -a
source secrets/device-test.env
set +a
```

`secrets/device-test.env`:

```bash
API_BASE_URL=https://vibepub.litianc.cn
FILES_TOKEN=...
```

### 5. APK Source

Required:

- A debug APK from GitHub Actions or a release candidate APK.

Recommended:

- For bug reproduction, keep the old APK evidence.
- For fix verification, always test an APK built from the fix commit.

Download the latest successful internal debug APK:

```bash
scripts/download-latest-android-apk.sh
```

The script prints the downloaded APK path under:

```text
artifacts/apk/latest/
```

### 6. Acceptance Criteria

For the current recording/transcript regression:

- One recording attempt creates one visible home-list item.
- No duplicate 0-second rows appear for the same recording time.
- The detail page can show transcript/article content after cloud processing.
- `logcat.txt` contains no obvious upload, sync, transcript, database, or crash
  errors.

## Standard Command

Recommended one-command smoke test:

```bash
scripts/run-android-device-smoke.sh
```

It loads `secrets/device-test.env` when present, otherwise it falls back to
`secrets/files-token.txt` and `https://vibepub.litianc.cn`. It downloads the
latest successful debug APK unless an APK path is passed as the first argument.
It also runs `scripts/check-android-device-ready.sh` before recording.

Check the connected phone without running the full smoke:

```bash
scripts/check-android-device-ready.sh /path/to/app-debug.apk
```

Expanded form:

```bash
set -a
source secrets/device-test.env
set +a

APK_PATH="$(scripts/download-latest-android-apk.sh)"

AUDIO_FILE="/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3" \
AUTOMATION_MODE=debug-broadcast \
RESET_APP_DATA=true \
RECORD_SECONDS=60 \
scripts/android-device-visual-test.sh "$APK_PATH"
```

## Evidence Directory

Each run writes:

```text
artifacts/android-device-visual/<timestamp>/
```

Important files:

- `01-launch.png`
- `02-after-record.png`
- `03-detail.png`
- `final.png`
- `vibepub-visual-test.mp4`
- `window.xml`
- `logcat.txt`
- `checklist.md`

## Infrastructure Policy

- Treat screenshots, videos, and logs as development artifacts.
- Do not commit generated evidence unless it is needed for a bug report.
- Keep tokens and private voice samples out of git.
- Use `RESET_APP_DATA=true` for deterministic acceptance runs.
- Use the same prepared audio file across before/after comparisons.
- Keep generated evidence and downloaded APKs under ignored `artifacts/`
  subdirectories unless a specific run needs to be attached to a bug report.
