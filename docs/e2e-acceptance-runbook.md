# E2E Acceptance Runbook

This runbook defines the evidence required before calling the VibePub Android
recording-to-transcript flow fully debugged.

## Current Blocker

The Android recording and upload path is working, but production ASR is not
authorized.

Observed production ASR failure:

- Workflow: `Smoke External Services`
- Step: `Check Volcengine BigModel ASR v3 credentials`
- HTTP status: `401`
- API status code: `45000010`
- API message: `load grant: requested grant not found in SaaS storage`

Required account action:

1. Open the Volcengine console for the app/key behind `VOLC_ASR_APPID` and
   `VOLC_ASR_ACCESS_TOKEN`.
2. Grant or subscribe it to BigModel ASR / 大模型录音文件识别.
3. Confirm the resource ID. The app defaults to `volc.bigasr.auc`; if the
   console shows a different ID, set GitHub secret `VOLC_ASR_RESOURCE_ID`.

## Required Gates

All gates must pass before declaring the flow complete.

1. External service smoke:

   ```bash
   gh workflow run smoke-services.yml --ref main
   ```

   Required evidence: `Check GLM chat completions`,
   `Check Volcengine BigModel ASR v3 credentials`, and
   `Check WeChat Proxy and Token` all pass.

2. Mining job:

   ```bash
   gh workflow run mining-job.yml --ref main
   ```

   Required evidence: the job processes the uploaded inbox object, writes
   `transcripts/<recording>.json`, updates D1 status to `COMPLETED`, and exits
   successfully. A job that marks the recording `FAILED` is not acceptable.

3. Real-device Android smoke:

   ```bash
   SKIP_INSTALL=true RESET_APP_DATA=false \
     scripts/run-android-device-smoke.sh artifacts/apk/latest/app-debug.apk
   ```

   Required evidence in `artifacts/android-device-visual/<run>/`:

   - `debug-device-test-status.json` shows one stopped recording with non-zero
     duration.
   - `window.xml` and `checklist.md` report `Transcript detail status:
     completed`.
   - `02-after-record.png` or `final.png` shows only one new item for the
     recording attempt.
   - `logcat.txt` has no obvious upload, sync, transcript, database, or crash
     errors.

4. Production API state:

   ```bash
   curl -H "Authorization: Bearer $FILES_TOKEN" \
     https://vibepub.litianc.cn/api/recordings
   ```

   Required evidence: the tested filename has status `COMPLETED`.

## Anti-False-Success Rules

- Do not accept a green Android test as proof of end-to-end success; Android CI
  does not exercise production ASR.
- Do not accept a completed mining workflow if it handled a file failure by
  marking the recording `FAILED`.
- Do not accept a visual smoke run that exits before `Transcript detail status`
  is `completed`.
- Do not accept old transcript fixtures or dummy recordings as proof for a new
  recording attempt.
