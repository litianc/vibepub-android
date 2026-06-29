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
   ANDROID_SERIAL=<device-serial> SKIP_INSTALL=true RESET_APP_DATA=false \
     scripts/run-android-device-smoke.sh artifacts/apk/latest/app-debug.apk
   ```

   Required evidence in `artifacts/android-device-visual/<run>/`:

   - `acceptance-report.txt` has every line checked (`[x]`).
   - `debug-device-test-status.json` shows one imported recording with non-zero
     duration.
   - `local-recording-row.json` shows exactly one Room row for the tested
     filename, non-zero duration, status `COMPLETED`, title, raw-text preview,
     and a terminal processing stage (`COMPLETED`, `DRAFT_FAILED`, or
     `ARTICLE_READY`).
   - `recordings-api.json` has exactly one object for the tested filename, with
     status `COMPLETED`, `article_title`, `raw_text_preview`, and
     terminal `processing_stage` (`COMPLETED` with a draft reference, or
     `DRAFT_FAILED` with `error_message`, or `ARTICLE_READY` with generated
     article metadata).
   - `local-transcript.json` has `articleTitle`, `rawText`, `articleContent`,
     and a terminal processing stage (`COMPLETED`, `DRAFT_FAILED`, or
     `ARTICLE_READY`). When the stage is `COMPLETED`, it must include a WeChat
     draft reference.
   - `window.xml` and `checklist.md` report `Transcript detail status:
     completed`.
   - `window-all.xml` shows the review card, copy/share/export actions, status
     help entry, expected duration, and no escaped raw HTML tags.
   - `debug-detail-actions.json` proves the detail page actions are functional:
     local audio playback advanced past 0 ms, copying article text matched the
     clipboard, the system share intent was sent, and the export package file
     was created before launching the share sheet.
   - `logcat.txt` has no obvious upload, sync, transcript, database, or crash
     errors.

4. Production API state:

   ```bash
   curl -H "Authorization: Bearer $FILES_TOKEN" \
     https://vibepub.litianc.cn/api/recordings
   ```

   Required evidence: the tested filename has status `COMPLETED`, plus
   `article_title`, `raw_text_preview`, and terminal `processing_stage`.
   `COMPLETED` requires a draft reference; `DRAFT_FAILED` requires a visible
   draft failure/error field; `ARTICLE_READY` requires generated article
   metadata and means the article is consumable while the draft step is still
   pending.

## Anti-False-Success Rules

- Do not accept a green Android test as proof of end-to-end success; Android CI
  does not exercise production ASR.
- Do not accept a completed mining workflow if it handled a file failure by
  marking the recording `FAILED`.
- Do not accept a visual smoke run that exits before `Transcript detail status`
  is `completed`.
- Do not accept a visual smoke run whose `Acceptance status` is not `passed`.
- Do not accept a run that only proves buttons are visible; playback, clipboard,
  share, and export behavior must be present in `debug-detail-actions.json`.
- Do not accept old transcript fixtures or dummy recordings as proof for a new
  recording attempt.
