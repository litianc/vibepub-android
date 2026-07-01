# VibePub Android

Android-first VoiceDrop-style recorder and publishing pipeline.

This repo is scoped for internal Android installation first. The Apple-specific pieces from the original VoiceDrop direction are intentionally out of scope:

- no Apple Developer account
- no TestFlight
- no iCloud entitlement
- no Sign in with Apple
- no iOS signing or Fastlane Match

## Product Defaults

- App name: `VibePub`
- Android package: `cn.litianc.vibepub`
- Public API host: `https://vibepub.litianc.cn`
- Distribution: internal APK artifact from GitHub Actions
- API service: Cloudflare Worker `vibepub-api`
- Database: Cloudflare D1 `vibepub-db`
- File storage: Cloudflare R2 `vibepub-files`
- Background processing: GitHub Actions `mining-job.yml`
- ASR: Volcengine
- LLM: GLM-5.2
- Publishing: WeChat Official Account draft publishing

## Layout

- `android/` - Kotlin + Jetpack Compose Android app
- `infra/worker/` - Cloudflare Worker upload API backed by R2
- `docs/android-product-requirements.md` - Android product requirements and scope
- `docs/resources-android.md` - external services and remaining account inputs
- `docs/wechat-setup.md` - WeChat Official Account setup checklist
- `.github/workflows/android-internal-build.yml` - internal APK build
- `.github/workflows/deploy-worker.yml` - Worker deploy

## Runtime Topology

The Android app talks to the Cloudflare Worker API. The Worker stores upload
metadata and pipeline status in D1, stores audio/transcript objects in R2, and
dispatches the GitHub Actions mining workflow for the long ASR/article/draft
pipeline. GitHub Actions is therefore the async job runner, not the production
database or API host.

## Local Android Build

This Mac has the local Android toolchain configured for faster dogfood loops:

- Android SDK command-line tools: `/opt/homebrew/share/android-commandlinetools`
- JDK 21: `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`
- SDK packages: `platforms;android-36`, `build-tools;36.0.0`, `platform-tools;37.0.0`
- Local SDK path: `android/local.properties` (git-ignored)

Run tests or build locally with the wrapper script so Robolectric uses JDK 21:

```bash
scripts/build-android-local.sh test
scripts/build-android-local.sh assemble
```

The APK will be under:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install to a connected ADB device:

```bash
scripts/install-android-local-apk.sh --skip-build
```

For repeated real-device dogfood loops, use the project skill:

```text
$vibepub-android-dogfood
```

The skill lives at `.codex/skills/vibepub-android-dogfood/` and includes a
direct script entry for stable-signed local build/install:

```bash
.codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh --mode install --serial <adb-serial>
```

If the Android device moves across WiFi networks, record local profiles in
`secrets/android-device-profiles.env` and use:

```bash
.codex/skills/vibepub-android-dogfood/scripts/run-device-dogfood.sh --mode install --profile <profile-name>
```

Profiles can keep multiple wireless debugging candidates, so changing WiFi or
rotating ADB ports does not require editing the command itself.

## Cloudflare Worker

The Worker expects:

- R2 bucket: `vibepub-files`
- Worker name: `vibepub-api`
- Custom domain: `vibepub.litianc.cn`
- Secret: `FILES_TOKEN`

Local development:

```bash
cd infra/worker
npm install
npx wrangler dev
```

Deploy after Cloudflare auth is configured:

```bash
cd infra/worker
npx wrangler r2 bucket create vibepub-files
npx wrangler secret put FILES_TOKEN
npx wrangler deploy
```

## Current Ops Notes

Cloudflare is logged in on this machine and Worker deployment is available with `npx wrangler`.

Uploads wake the GitHub Actions mining workflow immediately through a
Cloudflare Worker secret named `GITHUB_PAT`. GitHub Actions repository secrets
cannot use the `GITHUB_` prefix, so `.github/workflows/deploy-worker.yml` reads
the token from `WORKFLOW_DISPATCH_PAT` and writes it into the Worker as
`GITHUB_PAT`.

```bash
cd infra/worker
npx wrangler secret put GITHUB_PAT
```

`GITHUB_WORKFLOW_REF` is currently set to `codex/android-experience-v1` in
`infra/worker/wrangler.toml` because that branch contains the targeted
`mining-job.yml` input. Switch it back to `main` after the workflow input lands
there.
