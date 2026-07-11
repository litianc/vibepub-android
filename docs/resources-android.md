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
- `WORKFLOW_DISPATCH_PAT` secret for Worker-triggered mining dispatch
- `MINING_SERVICE_TOKEN` secret for internal mining status callbacks
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

Status: Wrangler is available through `npx`, but the repository does not prove an active local Cloudflare login or deployment credential. Treat Cloudflare access as unverified until `npx wrangler whoami` or the explicit deployment workflow succeeds in the integration environment.

Needed from account:

- Cloudflare login or API token
- Account ID
- Zone containing `litianc.cn`
- R2 bucket `vibepub-files`
- Worker `vibepub-api`
- custom domain route `vibepub.litianc.cn`
- DNS record managed through Cloudflare, if not already

### Android Signing

Status: CI supports stable signing for the internal debug APK when Android
signing secrets are configured. Without these secrets, GitHub Actions falls
back to the runner debug key, but APKs from different runs may not update over
each other on a real device.

For a stable internal dogfood channel, generate and keep:

- release keystore
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The Android build maps these secrets into `VIBEPUB_RELEASE_*` Gradle
properties and signs `assembleDebug` with that key when present. Keep using the
same keystore for all internal APKs so ADB can install updates in place.

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

- `GLM_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4/`
- `GLM_API_KEY`
- `GLM_MODEL=glm-5.2`

Implementation notes:

- Production GLM-5.2 uses `https://open.bigmodel.cn/api/coding/paas/v4/` with OpenAI-compatible `POST /chat/completions`; configure the GitHub `GLM_BASE_URL` secret to this Coding endpoint.
- GLM-5.2 defaults to Thinking mode. For deterministic short outputs in the mining job, pass `thinking: { "type": "disabled" }`; otherwise allocate enough `max_tokens` for reasoning plus final content.
- If a future GLM endpoint is vendor-specific, add a thin adapter in the mining job rather than changing Android or Worker code.

Cover background drafts:

- Normal mining uses local assets from `infra/mining/assets/cover-backgrounds/` and does not call an image model per article.
- `npm run generate:cover-background` can be run manually with `GPT_IMAGE_API_KEY`, `GPT_IMAGE_BASE_URL`, and optional `GPT_IMAGE_MODEL=gpt-image-2` to create reusable no-text background drafts for the local template library.

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

The current product uses invite-only VibePub accounts instead of a shared
client token. Android stores account session tokens, refreshes access tokens,
and scopes recordings, style templates, drafts, and WeChat publishing bindings
to the authenticated user.

Identity decisions for this stage:

- First version is invite-only, not public self-registration.
- Existing content is bootstrapped to the initial admin user.
- Each user can bind at most one WeChat publishing account.
- Admin user management lives in Android settings for now; there is no separate
  web admin console yet.

If the product later needs public onboarding or community features, add that on
top of this account model instead of reintroducing a shared upload token.

## Remaining User Inputs

The repository cannot by itself prove that external secrets, Cloudflare credentials, service access, or production deployment are current. Verify them through the deployment and production-health gates in `docs/e2e-acceptance-runbook.md` before treating an internal installation as release-ready.

Everything else in this repo has been defaulted for Android internal installation.
