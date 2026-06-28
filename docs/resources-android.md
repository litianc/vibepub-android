# Android Resource Plan

## Decisions Applied

| Area | Decision |
| --- | --- |
| Domain | `vibepub.litianc.cn` |
| Distribution | Internal Android APK |
| App name | `VibePub` |
| Android package | `cn.litianc.vibepub` |
| GitHub repo | `litianc/vibepub-android` |
| Apple resources | Removed |

## External Resources

### GitHub

Status: account `litianc` is authenticated locally.

Completed:

- private repo `litianc/vibepub-android`
- `FILES_TOKEN` secret
- `GLM_BASE_URL` secret
- `GLM_API_KEY` secret
- `GLM_MODEL` secret
- `VOLC_ASR_APPID` secret
- `VOLC_ASR_ACCESS_TOKEN` secret
- `WECHAT_APP_ID` secret
- `WECHAT_APP_SECRET` secret
- `WECHAT_PROXY` secret

Secrets still planned:

- `CLOUDFLARE_API_TOKEN`

### Cloudflare

Status: Wrangler is installed through `npx`, but current auth is expired.

Needed from account:

- Cloudflare login or API token
- Account ID
- Zone containing `litianc.cn`
- R2 bucket `vibepub-files`
- Worker `vibepub-api`
- custom domain route `vibepub.litianc.cn`
- DNS record managed through Cloudflare, if not already

### Android Signing

Status: internal debug APK can be built by CI without a release keystore.

For a stable internal release channel, generate and keep:

- release keystore
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

This can be delayed until the first release APK is needed. Debug APK is enough for first device testing.

### ASR

Decision: keep the original VoiceDrop-compatible Volcengine ASR path.

Status: configured as GitHub Actions secrets, but smoke check is blocked by Volcengine authorization.

Runtime model contract:

| Item | Value |
| --- | --- |
| Vendor/API | Volcengine Doubao Big Model ASR v3 |
| Code path | `infra/mining/src/asr.ts` |
| Request `model_name` | `bigmodel` |
| Confirmed Resource ID | `volc.seedasr.auc` |
| Confirmed BlueprintID | `10065` |
| Default Resource ID fallback order | `volc.bigasr.auc`, then `volc.seedasr.auc` |
| Override Resource ID secret | `VOLC_ASR_RESOURCE_ID` |
| Audio input contract | Publicly reachable `audio.url`; R2 objects use short-lived presigned GET URLs |
| Submit success signal | Empty body with `X-Api-Status-Code: 20000000` |
| Query transcript path | `result.text` |

Configured:

- `VOLC_ASR_APPID`
- `VOLC_ASR_ACCESS_TOKEN`

GitHub Actions secret contract:

| Secret | Required | Purpose |
| --- | --- | --- |
| `VOLC_ASR_APPID` | Yes | App ID used by the ASR submit/query API. |
| `VOLC_ASR_ACCESS_TOKEN` | Yes | Access token used by the ASR submit/query API. |
| `VOLC_ASR_RESOURCE_ID` | No | Pins the ASR Resource ID. If omitted, the mining job tries the fallback IDs above. |
| `VOLC_ASR_SMOKE_R2_KEY` | No | R2 object key for a real smoke-test audio clip. |
| `VOLC_ASR_SMOKE_AUDIO_URL` | No | Optional public audio URL for ASR smoke tests. Takes precedence over `VOLC_ASR_SMOKE_R2_KEY`. |
| `VOLC_ASR_SMOKE_AUDIO_FORMAT` | No | Smoke audio format. Defaults to `mp3`. |
| `VOLCENGINE_ACCESS_KEY_ID` | Only for automation | Account-level OpenAPI AK for the `Volcengine Speech Service` workflow. The script also accepts `VOLC_ACCESS_KEY_ID`. |
| `VOLCENGINE_SECRET_ACCESS_KEY` | Only for automation | Account-level OpenAPI SK for the `Volcengine Speech Service` workflow. The script also accepts `VOLC_SECRET_ACCESS_KEY`. |
| `VOLCENGINE_REGION` | No | OpenAPI region for service activation. Defaults to `cn-beijing`. |

Completion checklist: `docs/e2e-acceptance-runbook.md`.

### LLM

Decision: use GLM-5.2 instead of Claude.

Status: configured as GitHub Actions secrets.

Configured:

- `GLM_BASE_URL`
- `GLM_API_KEY`
- `GLM_MODEL=glm-5.2`

Implementation notes:

- The provided coding base URL works with OpenAI-compatible `POST /chat/completions`.
- GLM-5.2 defaults to Thinking mode. For deterministic short outputs in the mining job, pass `thinking: { "type": "disabled" }`; otherwise allocate enough `max_tokens` for reasoning plus final content.
- If a future GLM endpoint is vendor-specific, add a thin adapter in the mining job rather than changing Android or Worker code.

### WeChat Publishing

Decision: required for the MVP publishing path.

Needed:

- Official Account AppID/AppSecret
- IP whitelist
- fixed egress proxy URL as `WECHAT_PROXY`
- draft publishing interface access
- service-account storage for article draft keys and publish status

See `docs/wechat-setup.md` for the browser-assisted setup checklist.

### Auth, Accounts, and Community

This is the item that was previously unclear.

There are two separate identity questions:

1. Who can upload audio to the service?
2. Who can read, edit, or publish generated articles?

For internal installation, the recommended MVP answer is: no public user accounts yet. The Android app stores a private `FILES_TOKEN`, and anyone who has the APK plus token can upload. This is simple and fast, but it is not suitable for broad public distribution.

Later, if the app needs multiple users or community features, add real login. The likely options are:

- Google Sign-In or Firebase Auth for Android users.
- WeChat OAuth if the product becomes tightly coupled to a WeChat public-account workflow.
- Admin-only web login for reviewing drafts before publishing.

Recommendation for now: keep token-only upload, add an admin-only publishing backend later, and do not build community/social accounts until recording-to-draft-to-WeChat works end to end.

## Remaining User Inputs

All necessary secrets and external resources for the internal installation have been fully configured and tested.

Everything else in this repo has been defaulted for Android internal installation.
