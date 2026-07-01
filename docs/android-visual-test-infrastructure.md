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
5. Copy a prepared audio sample into the debug app's private storage.
6. Import it as one local recording through the debug-only ADB control receiver.
7. Enqueue the normal upload path from the app.
8. Wait for the upload to appear in `/api/recordings`.
9. Trigger and wait for `mining-job.yml` when `TRIGGER_MINING_JOB=true`.
   The smoke script passes the latest recording filename to the workflow so the
   mining job processes only this run's R2 inbox object instead of the whole
   shared queue.
10. Reopen the latest recording detail page, then capture screenshots, UI dump,
    and logcat.
11. Store evidence under `artifacts/android-device-visual/`.
12. Inspect `timing.tsv` when a run feels slow; it records elapsed and total
    seconds for install, import, upload/mining, detail assertion, and log
    collection phases.

For a quick install-only dogfood update, use:

```bash
ANDROID_SERIAL=192.168.31.72:42327 scripts/install-latest-android-apk.sh
```

That command downloads the latest internal GitHub Release APK when no path is
passed, runs the same readiness checks, installs the APK, launches VibePub, and
writes evidence under `artifacts/android-install/`.

Final end-to-end acceptance is stricter than producing visual evidence. Use
`docs/e2e-acceptance-runbook.md` before declaring the recording-to-transcript
flow fully debugged.

Before a full real-device run, use the source readiness audit to confirm that
the Android, Worker, mining, release, and smoke-test evidence is wired up:

```bash
scripts/audit-android-experience-readiness.sh
```

This is a pre-E2E gate. It can pass while still reporting manual/device-gated
items when no authorized ADB device is connected.

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
- For optional `DEBUG_AUDIO_MODE=speaker` runs, keep it near the Mac speaker.

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
On HyperOS 3 tablets, the long "允许通过 USB 调试修改权限或模拟点击" wording can be
the summary under the `USB调试（安全设置）` row. The install scripts also
auto-confirm the timed `USB安装提示` dialog by tapping `继续安装` while `adb install`
is running.
Wireless debugging can still return `INSTALL_FAILED_USER_RESTRICTED` on HyperOS
even when those switches are enabled, and some HyperOS builds can leave
`adb install` waiting behind a device-side prompt. The readiness script fails
with diagnostics after `ADB_INSTALL_TIMEOUT_SECONDS` instead of hanging forever.
If that happens, use a USB data cable for the install step, or install the APK
manually and rerun with `SKIP_INSTALL=true RESET_APP_DATA=false`.
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
`AUDIO_FILE=/path/to/file.wav`. The default `DEBUG_AUDIO_MODE=import` pushes the
fixture into the debug app and uploads it as a single recording without using Mac
audio output.

### 4. Backend Test Credentials

Required for upload/transcript checks:

- `FILES_TOKEN`
- `API_BASE_URL`, normally `https://vibepub.litianc.cn`

Required for fully automated transcript completion checks:

- `gh` logged in to GitHub.
- A token with `workflow` permission for `litianc/vibepub-android`.
- GitHub Actions secrets configured for the mining job.

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

Recommended full end-to-end smoke test:

```bash
scripts/run-android-device-smoke.sh
```

It loads `secrets/device-test.env` when present, otherwise it falls back to
`secrets/files-token.txt` and `https://vibepub.litianc.cn`. It downloads the
latest successful debug APK unless an APK path is passed as the first argument.
It also runs `scripts/check-android-device-ready.sh` before recording. By
default it sets `TRIGGER_MINING_JOB=true`, so after the phone upload appears in
the backend it dispatches `mining-job.yml` with `target_filename`, waits for
completion, and only then asserts the Android detail page. The mining dispatch
uses the current git branch by default so branch-local workflow inputs and mining
code are exercised; set `MINING_WORKFLOW_REF=main` when intentionally testing
the production workflow. The wrapper no longer installs the APK during preflight
by default, so the APK is installed at most once by the main smoke script.

Fast UI-only iteration, when the APK is already installed and you are not
verifying ASR/LLM/WeChat:

```bash
SKIP_INSTALL=true \
RESET_APP_DATA=false \
TRIGGER_MINING_JOB=false \
scripts/run-android-device-smoke.sh /path/to/app-debug.apk
```

This still imports the prepared audio and captures real device evidence, but it
does not require the detail page to reach `COMPLETED`.

Check the connected phone without running the full smoke:

```bash
scripts/check-android-device-ready.sh /path/to/app-debug.apk
```

If the phone blocks ADB installation but you manually install the debug APK on
the phone first, run the smoke against the installed app:

```bash
SKIP_INSTALL=true RESET_APP_DATA=false scripts/run-android-device-smoke.sh /path/to/app-debug.apk
```

Expanded form:

```bash
set -a
source secrets/device-test.env
set +a

APK_PATH="$(scripts/download-latest-android-apk.sh)"

AUDIO_FILE="/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3" \
AUTOMATION_MODE=debug-broadcast \
DEBUG_AUDIO_MODE=import \
RESET_APP_DATA=true \
RECORD_SECONDS=15 \
scripts/android-device-visual-test.sh "$APK_PATH"
```

For import-mode automation, the default screen recording length is short because
the audio fixture is copied into the app rather than played in real time. Use a
longer `RECORD_SECONDS` only when you are explicitly capturing a manual or
speaker-based recording flow.

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
- `timing.tsv`
- `latest-recording-filename.txt`
- `expected-duration-text.txt`
- `backend-recording-status.txt`
- `mining-run-url.txt`

Before accepting a run, execute:

```bash
scripts/audit-android-device-smoke.sh artifacts/android-device-visual/<timestamp>
```

The audit rejects stale or weak evidence, including pending transcript state,
raw HTML tags on the detail page, mismatched duration text, missing backend
`COMPLETED` status, missing mining workflow evidence, missing next-stage detail
UI such as the lifecycle help entry, publish-readiness review card, export
package action, or duplicate/zero-duration local rows when the phone is still
connected.

## Infrastructure Policy

- Treat screenshots, videos, and logs as development artifacts.
- Do not commit generated evidence unless it is needed for a bug report.
- Keep tokens and private voice samples out of git.
- Use `RESET_APP_DATA=true` for deterministic acceptance runs.
- Use the same prepared audio file across before/after comparisons.
- Keep generated evidence and downloaded APKs under ignored `artifacts/`
  subdirectories unless a specific run needs to be attached to a bug report.
