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
`created_at`, `updated_at`, optional `article_title`, `raw_text_preview`,
`processing_stage`, `wechat_url`, `wechat_draft_id`, and `error_message`.
`processing_stage` is a narrow progress hint for the current pipeline step:
`QUEUED`, `ASR`, `REWRITING`, `DRAFTING`, `COMPLETED`, or `FAILED`.

## Setup

```bash
npm install
npx wrangler r2 bucket create vibepub-files
npx wrangler secret put FILES_TOKEN
npx wrangler deploy
```

The Worker route is configured for `vibepub.litianc.cn`.
