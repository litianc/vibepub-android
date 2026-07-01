---
name: vibepub-android-dogfood
description: Build, install, and verify the VibePub Android app on a real Android phone or tablet. Use when working on VibePub Android dogfood loops, ADB device setup, stable-signed local APK installation, visual smoke tests, recording-to-article validation, GitHub Release APK installation, or troubleshooting HyperOS/MIUI install, lock screen, signing, token, and wireless debugging issues.
---

# VibePub Android Dogfood

## Purpose

Run the fastest reliable Android dogfood loop for this repo: build locally when possible, install with the same internal signing key as CI, preserve app data by default, collect evidence, and only fall back to GitHub Actions release APKs when a shared build is needed.

This skill is project-local. Resolve paths from the repository root.

## Default Loop

1. Inspect current repo and device state:
   ```bash
   git status --short --branch
   adb devices -l
   ```
2. Prefer stable-signed local build for fast iteration. Use a saved profile when WiFi changes often:
   ```bash
   .codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh \
     --profile <device-profile> \
     --mode install
   ```
3. If the user asked for full flow verification, run the real-device smoke lane:
   ```bash
   .codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh \
     --profile <device-profile> \
     --mode smoke
   ```
4. Read the generated evidence summary under `artifacts/android-install-local/<timestamp>/` or `artifacts/android-device-visual/<timestamp>/` before reporting success.
5. If the change should be shared, commit and push after verification. Use the repo's Lore commit protocol.

## Build Modes

- `--mode build`: stable-signed local `:app:assembleDebug` only.
- `--mode test`: stable-signed unit tests plus assemble.
- `--mode install`: stable-signed build, install, and launch.
- `--mode smoke`: run `scripts/run-android-device-smoke.sh` with the standard audio fixture.
- `--mode release-install`: install the latest GitHub Release APK instead of local build.

Use local `install` for most UI/resource/code edits. Use `smoke` when the recording, upload, status, detail, playback, cover image, token, or backend pipeline behavior matters.

## Device Profiles

Use profiles instead of hard-coded IP serials when the same tablet moves across WiFi networks.

1. Copy `references/android-device-profiles.example.env` to `secrets/android-device-profiles.env`.
2. Add one profile per network or connection type:
   ```bash
   VIBEPUB_DEVICE_REDMI_HOME_SERIAL="192.168.1.42:43201"
   VIBEPUB_DEVICE_REDMI_HOME_CONNECT_TARGETS="192.168.1.42:43201"
   ```
3. Invoke the script with `--profile redmi-home`.

When wireless debugging ports change on the same WiFi, add candidates instead of replacing history:

```bash
VIBEPUB_DEVICE_REDMI_HOME_SERIALS="192.168.1.42:43201 192.168.1.42:42327"
```

The script attempts `adb connect` for host:port candidates and selects the first currently connected serial. Profile names are normalized to uppercase and dashes become underscores. `--serial` can still override a profile for one-off runs.

## Stable Signing

Do not use an unsigned/default local debug APK when the tablet already has a CI APK installed. It will fail with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

The local stable-signing material is git-ignored under:

- `secrets/android-release-secrets.env`
- `secrets/vibepub-release.keystore`

The bundled script reads those files if present and passes Gradle signing values through `ORG_GRADLE_PROJECT_*` environment variables. Do not print secret values.

If signing files are missing, local build can still compile, but installing over a CI-signed APK will not work without uninstalling. Preserve app data unless the user explicitly accepts data loss.

## Device Rules

- Prefer `--profile` for known devices and networks. Pass `--serial` for one-off runs or to override the profile.
- When multiple `adb devices -l` rows refer to the same Xiaomi/Redmi device through mDNS and direct IP, choose the profile/serial that points at the explicit direct host:port.
- Prefer USB for reliable installs. Wireless ADB is fine for normal automation when install is already working.
- Do not assume the device is unlocked. Let readiness checks fail fast and report what the user needs to do.
- Do not automatically uninstall on signature mismatch unless the user explicitly says clearing app data is acceptable.

## Evidence Contract

Before claiming success, cite concrete evidence:

- Build command and result.
- Install/readiness summary path.
- Device serial used.
- Whether app data was preserved.
- For smoke tests: screenshot/UI dump/logcat/audit summary paths and the final status observed.

Keep generated evidence out of commits unless the user explicitly asks to archive it.

## Failure Playbook

Read `references/failure-playbook.md` when ADB, install, signing, token, mining, or smoke verification fails.
