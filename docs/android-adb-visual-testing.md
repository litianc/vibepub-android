# Android ADB Visual Testing

This is the lightweight real-device testing path. It uses a USB-connected
Android phone as the visual test runner. It does not require Android Studio,
the full Android SDK, or an emulator on the Mac.

## One-Time Mac Setup

Install Android Platform Tools:

```bash
brew install --cask android-platform-tools
```

Check:

```bash
adb version
```

## Phone Setup

On the Android phone:

1. Open Settings.
2. Enable Developer options.
3. Enable USB debugging.
4. Connect the phone to the Mac by USB.
5. Accept the "Allow USB debugging" prompt.

Check from the Mac:

```bash
adb devices
```

The device should show as `device`, not `unauthorized`.

The default automated path uses a debug-only broadcast receiver and does not
require simulated tap permission. If you explicitly use `AUTOMATION_MODE=ui-tap`,
also check:

```bash
adb shell input tap 1 1
```

If this fails with an `INJECT_EVENTS` permission error, enable the extra
developer option on the phone. On Xiaomi, MIUI, or HyperOS this is usually
called "USB debugging (Security settings)" or `USB 调试（安全设置）` /
`允许通过 USB 调试修改权限或模拟点击`.

If APK install fails with `INSTALL_FAILED_USER_RESTRICTED`, enable `USB 安装`
or "Install via USB" in Developer options.
If reset/uninstall fails with `DELETE_FAILED_INTERNAL_ERROR`, manually remove
the app on the phone or enable the same USB install/security options.

## Run A Visual Test

Download `app-debug.apk` from GitHub Actions, or use an APK already on disk.
Then run:

```bash
scripts/android-device-visual-test.sh /path/to/app-debug.apk
```

To download the latest successful debug APK automatically:

```bash
scripts/download-latest-android-apk.sh
```

For the standard VibePub smoke test, prefer:

```bash
scripts/run-android-device-smoke.sh
```

To check whether the phone is ready before a full run:

```bash
scripts/check-android-device-ready.sh /path/to/app-debug.apk
```

If the phone blocks ADB installation, manually install the debug APK and run:

```bash
SKIP_INSTALL=true RESET_APP_DATA=false scripts/run-android-device-smoke.sh /path/to/app-debug.apk
```

The script will:

- install the APK
- grant runtime permissions where possible
- force the `RECORD_AUDIO` appops back to `allow` when the device supports it
- start VibePub
- capture a launch screenshot
- record the real phone screen
- capture a final screenshot
- export a UI dump
- export logcat
- write `timing.tsv` with phase-level duration data

Evidence is written to:

```text
artifacts/android-device-visual/<timestamp>/
```

## Fully Automated Audio Flow

The default real-device smoke path uses debug-only audio fixture import. It
keeps the test visual and end-to-end while avoiding Mac speaker, microphone, and
room-noise flakiness:

1. ADB copies your prepared audio file into the app's private storage.
2. The debug APK imports it as one local recording.
3. The app enqueues the normal upload path.
4. The standard wrapper waits for the upload to appear in the backend, triggers
   `mining-job.yml` with the exact latest recording filename, and waits for the
   recording to become `COMPLETED`.
5. ADB captures the home screen, opens the latest recording, captures detail,
   records the screen, and exports logcat.

Run:

```bash
set -a
source secrets/device-test.env
set +a

AUDIO_FILE=/path/to/prepared-audio.wav \
AUTOMATION_MODE=debug-broadcast \
DEBUG_AUDIO_MODE=import \
RESET_APP_DATA=true \
RECORD_SECONDS=15 \
scripts/android-device-visual-test.sh /path/to/app-debug.apk
```

For the one-command smoke path, `scripts/run-android-device-smoke.sh` enables
that mining wait by default. Direct `android-device-visual-test.sh` runs keep
`TRIGGER_MINING_JOB=false` unless you opt in:

```bash
TRIGGER_MINING_JOB=true \
AUDIO_FILE=/path/to/prepared-audio.wav \
scripts/android-device-visual-test.sh /path/to/app-debug.apk
```

If you specifically want an acoustic microphone test, set
`DEBUG_AUDIO_MODE=speaker`, use a quiet room, put the phone near the Mac
speaker, and make sure the Mac speaker volume is high enough.

For fast UI-only iteration against an already installed APK, skip cloud mining:

```bash
SKIP_INSTALL=true \
RESET_APP_DATA=false \
TRIGGER_MINING_JOB=false \
scripts/run-android-device-smoke.sh /path/to/app-debug.apk
```

This keeps real-device import and screenshot evidence but does not require the
recording-to-WeChat pipeline to finish. Use the default full smoke before
declaring end-to-end acceptance.

If the default tap coordinates do not match a device and you intentionally use
`AUTOMATION_MODE=ui-tap`, override them:

```bash
RECORD_TAP_X=610 RECORD_TAP_Y=2390 \
STOP_TAP_X=610 STOP_TAP_Y=2360 \
FIRST_ITEM_TAP_X=610 FIRST_ITEM_TAP_Y=720 \
AUTOMATION_MODE=ui-tap \
AUDIO_FILE=/path/to/prepared-audio.wav \
scripts/android-device-visual-test.sh /path/to/app-debug.apk
```

## VibePub Bug Acceptance Checks

For the duplicate-recording/transcript issue, review the generated screenshots
and video:

- one recording attempt creates one visible list item
- no duplicate 0-second rows appear for the same time
- opening the recording detail page shows transcript or article content after
  cloud processing has completed
- `logcat.txt` has no obvious upload, sync, or transcript fetch errors

## Useful Options

Record a longer test session:

```bash
RECORD_SECONDS=60 scripts/android-device-visual-test.sh /path/to/app-debug.apk
```

Write evidence somewhere else:

```bash
OUT_DIR=/tmp/vibepub-adb-test scripts/android-device-visual-test.sh /path/to/app-debug.apk
```

If multiple phones are connected:

```bash
ANDROID_SERIAL=<device-id> scripts/android-device-visual-test.sh /path/to/app-debug.apk
```
