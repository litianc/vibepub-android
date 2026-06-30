# VibePub Worker

Cloudflare Worker API for Android audio uploads.

## Endpoints

- `GET /health` - public health check
- `POST /api/uploads` - upload audio; requires `Authorization: Bearer <FILES_TOKEN>`
- `GET /api/uploads` - list recent `inbox/` objects; requires token
- `GET /api/recordings` - list recording statuses and display metadata; requires token
- `PUT /api/internal/status` - update mining pipeline status; requires token
- `GET /api/files/:key` - fetch an R2 object; requires token

`/api/recordings` returns the Android display contract: `filename`, `status`,
`created_at`, `updated_at`, `duration_ms`, optional `article_title`, `raw_text_preview`,
`processing_stage`, `wechat_url`, `wechat_draft_id`, and `error_message`.
`duration_ms` is preserved from storage when present, otherwise derived from the
standard VibePub filename duration segment such as `0m18s`.
`processing_stage` is a narrow progress hint for the current pipeline step:
`QUEUED`, `ASR`, `REWRITING`, `DRAFTING`, `ARTICLE_READY`,
`COMPLETED`, or `FAILED`.
`ARTICLE_READY` means the article has been generated and saved for Android
review while the WeChat draft step is still pending.
`DRAFT_FAILED` means the article is ready and consumable but WeChat draft
creation failed after article generation.

## Setup

```bash
npm install
npx wrangler r2 bucket create vibepub-files
npx wrangler secret put FILES_TOKEN
# Optional but recommended: lets /api/uploads immediately dispatch mining-job.yml.
npx wrangler secret put GITHUB_PAT
npx wrangler deploy
```

The Worker route is configured for `vibepub.litianc.cn`.
`GITHUB_PAT` must be able to create workflow dispatch events for
`litianc/vibepub-android`; otherwise uploads still succeed, but processing waits
for the scheduled mining workflow.

## Production Update Checklist

Run validation before deploying:

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

Apply D1 migrations before or alongside Worker deploys when the Android display
contract changes:

```bash
npm run migrate:remote
npm run deploy
```

If `/api/recordings` has `COMPLETED` rows with empty `article_title` after a
schema or Worker deploy, backfill display metadata from existing transcript JSON:

```bash
FILES_TOKEN=... npm run backfill:recordings
```

Verify the public contract after deploy:

```bash
curl -H "Authorization: Bearer $FILES_TOKEN" \
  https://vibepub.litianc.cn/api/recordings
```
