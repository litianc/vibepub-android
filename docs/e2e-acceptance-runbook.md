# E2E Acceptance Runbook

This runbook defines the evidence required before calling the VibePub Android
recording-to-transcript flow fully debugged.

## Current ASR Contract

The Android recording and upload path is working. Production ASR is configured
for Volcengine Doubao recording-file recognition 2.0:

- `AppID`: `6270463764`
- `BlueprintID`: `10065`
- `ResourceID`: `volc.seedasr.auc`
- Product doc: <https://www.volcengine.com/docs/6561/1354868?lang=zh>

Important protocol details:

- The standard HTTP submit API requires a publicly reachable audio URL in
  `audio.url`; it does not accept the prior base64 `audio.data` payload.
- A successful submit returns an empty response body. Success is indicated by
  response header `X-Api-Status-Code: 20000000`.
- Query responses return transcript text at `result.text`.
- Smoke tests must use a real audio URL. The current GitHub secret
  `VOLC_ASR_SMOKE_R2_KEY` points to the uploaded test clip in R2.

If service activation needs to be re-run, use:

   ```bash
   gh workflow run volcengine-speech-service.yml \
     --ref main \
     -f project_name=default \
     -f blueprint_id=10065 \
     -f resource_id=volc.seedasr.auc
   ```

   The workflow calls `ServiceStatus`, calls `ActivateService` only when the
   service is not already active, then runs the production ASR smoke check
   against the same `resource_id`.

Useful Volcengine references:

- Console ASR: <https://console.volcengine.com/speech/new/experience/asr>
- Cross-service auth: <https://console.volcengine.com/rtc/aigc/iam>
- `ActivateService`: <https://api.volcengine.com/api-explorer?serviceCode=speech_saas_prod&version=2025-05-20&action=ActivateService>
- `ServiceStatus`: <https://api.volcengine.com/api-explorer?serviceCode=speech_saas_prod&version=2025-05-20&action=ServiceStatus>

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
