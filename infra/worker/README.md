# VibePub Worker

Cloudflare Worker API for Android audio uploads.

## Endpoints

- `GET /health` - public health check
- `POST /api/uploads` - upload audio; requires `Authorization: Bearer <FILES_TOKEN>`
- `GET /api/uploads` - list recent `inbox/` objects; requires token
- `GET /api/files/:key` - fetch an R2 object; requires token

## Setup

```bash
npm install
npx wrangler r2 bucket create vibepub-files
npx wrangler secret put FILES_TOKEN
npx wrangler deploy
```

The Worker route is configured for `vibepub.litianc.cn`.
