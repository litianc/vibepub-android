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
- Storage/API: Cloudflare Worker + R2
- ASR: Volcengine
- LLM: GLM-5.2
- Publishing: WeChat Official Account draft publishing

## Layout

- `android/` - Kotlin + Jetpack Compose Android app
- `infra/worker/` - Cloudflare Worker upload API backed by R2
- `docs/resources-android.md` - external services and remaining account inputs
- `docs/wechat-setup.md` - WeChat Official Account setup checklist
- `.github/workflows/android-internal-build.yml` - internal APK build
- `.github/workflows/deploy-worker.yml` - Worker deploy

## Local Android Build

This workspace currently does not include a local Android SDK/Gradle install. CI is configured to install Android SDK packages and Gradle.

When Android Studio is installed locally:

```bash
gradle -p android :app:assembleDebug
```

The APK will be under:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

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

## Current Blockers

Cloudflare is not logged in on this machine. Run `npx wrangler login` interactively, or provide a scoped `CLOUDFLARE_API_TOKEN` for Worker/R2/DNS deployment.
