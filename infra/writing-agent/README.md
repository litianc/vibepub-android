# WritingAgent

WritingAgent is the standalone rewrite platform for VibePub. It owns writing style profiles, WeChat layout profiles, and the rewrite protocol described in `../../docs/writing-agent-protocol.md`.

## Endpoints

- `GET /health`
- `GET /v1/style-profiles`
- `GET /v1/style-profiles/:id`
- `GET /v1/layout-profiles`
- `GET /v1/layout-profiles/:id`
- `POST /v1/rewrite-jobs`
- `POST /v1/revision-jobs`

Rewrite and revision jobs can either reference a built-in `style_profile_id` or provide an inline private `style_profile_body` from Android local custom templates.

All `/v1/*` endpoints require:

```http
Authorization: Bearer <WRITING_AGENT_TOKEN>
```

## Local Validation

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## Deployment

Set Cloudflare and model secrets before enabling VibePub to call this service:

```bash
npx wrangler secret put WRITING_AGENT_TOKEN
npx wrangler secret put GLM_API_KEY
npx wrangler deploy
```

Then configure VibePub mining:

```text
WRITING_AGENT_BASE_URL=https://<writing-agent-host>
WRITING_AGENT_TOKEN=<same service token>
WRITING_AGENT_STYLE_PROFILE_ID=style_litianc_default
WRITING_AGENT_LAYOUT_PROFILE_ID=wechat_clean_article
```

If `WRITING_AGENT_BASE_URL` is not configured, VibePub mining continues using its embedded rewrite prompt.
