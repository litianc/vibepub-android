# VibePub Android Dogfood Failure Playbook

## ADB Device Ambiguity

Symptom: `adb devices -l` shows direct IP plus `_adb-tls-connect` rows for the same tablet.

Action:

```bash
adb devices -l
.codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh --serial <stable-host:port> --mode install
```

Use the explicit direct serial the user provided, for example `192.168.31.72:43201`.

## Locked Device

Symptom: readiness says the device is not awake/unlocked.

Action:

```bash
adb -s <serial> shell input keyevent KEYCODE_WAKEUP
```

If the device requires a PIN or biometric unlock, ask the user to unlock it. Do not claim install or visual test success until readiness passes.

## Signature Mismatch

Symptom: `INSTALL_FAILED_UPDATE_INCOMPATIBLE` or readiness says the existing package signature differs.

Cause: local default debug key differs from the CI/internal signing key.

Preferred action:

```bash
.codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh --serial <serial> --mode install
```

The skill script uses `secrets/android-release-secrets.env` and `secrets/vibepub-release.keystore` when present. If those files are missing, use the latest GitHub Release APK or ask before uninstalling.

Only use this when the user accepts data loss:

```bash
ALLOW_UNINSTALL_ON_SIGNATURE_MISMATCH=true scripts/install-android-local-apk.sh --serial <serial> --skip-build
```

## HyperOS Install Restriction

Symptom: `INSTALL_FAILED_USER_RESTRICTED`, install timeout, or a device-side install confirmation prompt.

Action:

- Prefer USB data connection for installation.
- Keep Developer Options enabled: USB debugging, Install via USB, USB debugging security settings.
- Use the existing scripts; they already attempt prompt taps and collect diagnostics.
- If wireless install remains blocked, install via USB or manually install the APK and run smoke with `SKIP_INSTALL=true RESET_APP_DATA=false`.

## Token Or Backend Failure

Symptom: app shows configuration error, stuck processing, unauthorized, or smoke fails before upload/list.

Action:

```bash
test -s secrets/files-token.txt
curl -fsS https://vibepub.litianc.cn/health
curl -fsS -H "Authorization: Bearer $(cat secrets/files-token.txt)" \
  https://vibepub.litianc.cn/api/recordings | head
```

Do not paste token values in chat or logs.

## Mining Pipeline Is Slow

Symptom: Android upload succeeds but status waits on article/draft completion.

Action:

- Confirm Worker dispatched `mining-job.yml`.
- Prefer the smoke lane's polling and evidence over manual waiting.
- Use local install/build for UI-only changes; reserve full mining verification for pipeline-affecting changes.

## What To Report

Report the smallest useful diagnosis:

- exact failing stage: build, readiness, install, launch, smoke, backend, mining
- device serial
- evidence directory
- whether app data was preserved
- next recovery step
