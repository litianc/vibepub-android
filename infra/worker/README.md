# VibePub Worker

Cloudflare Worker API for Android accounts, uploads, recording metadata, and
Publishing/WritingAgent coordination.

## Endpoints

- `GET /health` - public health check with deploy commit/ref metadata.
- `POST /api/auth/login`, `/refresh`, `/logout`, `/accept-invite`,
  `/verify-email`, and password reset endpoints - account/session lifecycle.
- `GET /api/me` - current authenticated user.
- `POST /api/uploads` - upload audio; requires `Authorization: Bearer <access token>`.
- `GET /api/uploads` - list recent user-owned `inbox/` objects; requires session auth.
- `GET /api/recordings` - list the current user's recording statuses and display metadata; requires session auth.
- `PUT /api/internal/status` - update mining pipeline status; requires `MINING_SERVICE_TOKEN`.
- `POST /api/internal/mining-claims` - claim, complete, or release one mining input; internal only.
- `GET /api/files/:key` - fetch a user-owned R2 object; requires session auth.
- `GET /api/style-profiles` - list built-in and distilled WritingAgent style profiles; requires session auth.
- `POST /api/style-source-imports` - import shared article or text sources for style distillation; requires session auth.
- `GET /api/style-source-imports` - list imported style sources; requires session auth.
- `POST /api/style-distillation-jobs` - distill imported sources into a reusable style profile; requires session auth.
- `GET /api/style-distillation-jobs/:id` - inspect a style distillation job; requires session auth.
- `GET/PUT /api/publishing-account` - read or update the current user's WeChat publishing binding; requires session auth.

`/api/recordings` returns the Android display contract: `filename`, `status`,
`created_at`, `updated_at`, `duration_ms`, optional `article_title`, `raw_text_preview`,
`processing_stage`, `wechat_url`, `wechat_draft_id`, `cover_image_url`, and `error_message`.
`duration_ms` is preserved from storage when present, otherwise derived from the
standard VibePub filename duration segment such as `0m18s`.
`processing_stage` is a narrow progress hint for the current pipeline step:
`QUEUED`, `ASR`, `REWRITING`, `DRAFTING`, `ARTICLE_READY`,
`COMPLETED`, or `FAILED`.
`ARTICLE_READY` means the article has been generated and saved for Android
review while the WeChat draft step is still pending.
`DRAFT_FAILED` means the article is ready and consumable but WeChat draft
creation failed after article generation.
`cover_image_url` points at the generated WeChat cover PNG in R2 when the mining
job has saved one; older recordings may omit it.

## Setup

```bash
npm install
npx wrangler r2 bucket create vibepub-files
npm run migrate:remote
# Runtime secret name used by the Worker.
npx wrangler secret put GITHUB_PAT
# Required when Android should sync/distill WritingAgent style profiles.
npx wrangler secret put WRITING_AGENT_TOKEN
# Required for encrypted per-user WeChat publishing credentials.
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler deploy
```

The Worker route is configured for `vibepub.litianc.cn`.
`GITHUB_PAT` must be able to create workflow dispatch events for
`litianc/vibepub-android`; otherwise uploads still succeed, but processing waits
for the scheduled mining workflow.
GitHub Actions repository secrets cannot use the `GITHUB_` prefix, so the deploy
workflow reads this token from `WORKFLOW_DISPATCH_PAT` and writes it to the
Worker as `GITHUB_PAT`.
`GITHUB_WORKFLOW_REF` controls which Git ref receives the workflow dispatch. The
dogfood deployment points at `main` so immediate upload-triggered mining uses the
same code path as scheduled mining.
`WRITING_AGENT_BASE_URL` must point at the deployed WritingAgent host before
Android can sync cloud style profiles or import shared style sources. The Worker
uses `WRITING_AGENT_TOKEN` server-side, while Android authenticates with the
current account's session token.

## Production Update Checklist

Run validation before deploying:

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

Apply D1 migrations before the Worker and mining workflow when their contract changes:

```bash
npm run migrate:remote
npm run deploy
```

For mining claims, apply migration `0009`, deploy the Worker, then deploy the
mining workflow. To roll back, restore the previous mining workflow ref first,
then the previous Worker. The added D1 table is additive and can remain in place
without affecting old code or recording data.

Verify the public contract after deploy:

```bash
curl https://vibepub.litianc.cn/health
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://vibepub.litianc.cn/api/recordings
```
