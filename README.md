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
- D1 database: `vibepub-db`
- Worker name: `vibepub-api`
- Custom domain: `vibepub.litianc.cn`
- Invite-based user accounts with access/refresh session tokens.
- Runtime secrets for GitHub workflow dispatch, WritingAgent access, credential encryption, and email sending.

Local development:

```bash
cd infra/worker
npm install
npx wrangler dev
```

Production deployment is not a local default. Wave 2E first renders a complete,
isolated staging configuration from a protected Environment manifest, validates
it synthetically, and performs five explicit `wrangler deploy --dry-run`
checks. A dry-run is validation only, not a staging deployment. See
[`infra/staging/README.md`](infra/staging/README.md) before any approved
staging operation.

## Current Ops Notes

Cloudflare is logged in on this machine and Worker deployment is available with `npx wrangler`.

## Release States And Staging Safety

- **Code complete** means local source and tests are ready; it does not create a
  Cloudflare resource or enable a feature.
- **CI validated** means synthetic manifest rendering and local Wrangler
  dry-runs passed; it is not a staging deployment.
- **Staging data prepared** requires protected evidence of isolated main and
  Writing D1 backups, additive migration lists through main `0011` and Writing
  `0001`, and schema verification hashes; the workflow never performs remote
  migrations itself.
- **Staging deployed** requires the protected `vibepub-staging` GitHub
  Environment, a real protected resource manifest, explicit `deploy=true`,
  a separately protected exact `STAGING_PUBLIC_BASE_URL` proven by the
  account-scoped Cloudflare Workers subdomain API, serial private adapters
  before the main Worker, one 100-percent active deploy-version/rollback
  evidence per service, and all V3 flags and allowlists still disabled. Main
  has no custom production route but does expose its isolated `workers.dev`
  staging entry.
- **Mining readiness attested** confirms the isolated unscheduled Mining
  config, retried main/adapter health versions, the unauthenticated handoff
  boundary, and two authenticated no-write token probes; it never starts
  Mining. **Mining launched** is a
  separate protected authorization after this attestation.
- **Production released** is a separately approved operation after staging
  canary evidence. Do not infer it from CI, dry-runs, or a staging health
  response.

The staging rollout begins with one exact tenant/account allowlist after flags
are explicitly enabled, exercises both audio and text V3 handoffs, verifies
retry and unknown-side-effect reconciliation, and stops WeChat at a draft.
Rollback first clears the main Worker tenant flags and allowlists while keeping
V3 status reconciliation available, then rolls back the main Worker and private
adapters. Never turn the Mining client gate off to send an already-marked V3
recording back through legacy work. D1 and Durable Object changes are forward
fixes only: never drop or down-migrate a protected data store.

Before a device can be called staging-ready, reconcile the reviewed source SHA
with the APK SHA and signing identity, select the explicit staging API profile,
assert the production endpoint is rejected, verify main plus four adapter
health/version evidence, complete the D1 data-prepared gate, and use a
synthetic staging publishing account. Use `adb install -r` to preserve local
data. The current HTTP image gateway remains an external blocker for a complete
visual staging canary until a TLS front and key rotation are complete.

Uploads wake the GitHub Actions mining workflow immediately through a
Cloudflare Worker secret named `GITHUB_PAT`. GitHub Actions repository secrets
cannot use the `GITHUB_` prefix, so `.github/workflows/deploy-worker.yml` reads
the token from `WORKFLOW_DISPATCH_PAT` and writes it into the Worker as
`GITHUB_PAT`.

```bash
cd infra/worker
npx wrangler secret put GITHUB_PAT
```

`GITHUB_WORKFLOW_REF` is set to `main` in `infra/worker/wrangler.toml`, so
upload-triggered mining runs the same workflow definition as scheduled fallback
processing. Mining serializes workflow runs and atomically claims each R2 input
before draft creation, so an immediate dispatch and the scheduled fallback cannot
create duplicate drafts for the same object. Worker and WritingAgent GitHub Actions are named
`Validate / Deploy ...`: PR and push runs validate only, while production deploys
require a manual `workflow_dispatch` with `deploy=true` after validation passes.
The Worker deploy injects commit/ref metadata that can be checked through
`GET /health`.
