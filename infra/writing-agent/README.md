# WritingAgent

WritingAgent is the standalone rewrite platform for VibePub. It owns writing style profiles, WeChat layout profiles, and the rewrite protocol described in `../../docs/writing-agent-protocol.md`.

## Endpoints

- `GET /health`
- `GET /v1/style-profiles`
- `GET /v1/style-profiles/:id`
- `POST /v1/style-source-imports`
- `GET /v1/style-source-imports`
- `POST /v1/style-distillation-jobs`
- `GET /v1/style-distillation-jobs/:id`
- `GET /v1/layout-profiles`
- `GET /v1/layout-profiles/:id`
- `POST /v1/rewrite-jobs`
- `POST /v1/revision-jobs`

Rewrite and revision jobs can reference a built-in `style_profile_id`, a D1-backed distilled profile, or provide an inline private `style_profile_body` from Android local custom templates.

Style source import and distillation are the Voice Drop style distillation path:

- Android shares articles or text to VibePub, and the Worker proxies `POST /api/style-source-imports` to this service.
- WritingAgent stores imported source text in D1.
- `POST /v1/style-distillation-jobs` combines one or more source imports into a persistent style profile and profile version.
- The latest distilled profiles are returned by `GET /v1/style-profiles` alongside built-in profiles.
- WritingAgent keeps the most recent 10 versions for each distilled profile.

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

Apply D1 migrations before using source imports or distilled profiles:

```bash
npx wrangler d1 migrations apply writing-agent-db --remote
```

## Deployment

Set Cloudflare and model secrets before enabling VibePub to call this service:

```bash
npx wrangler secret put WRITING_AGENT_TOKEN
npx wrangler secret put GLM_API_KEY
npx wrangler deploy
```

Then configure VibePub Worker and mining callers:

```text
WRITING_AGENT_BASE_URL=https://<writing-agent-host>
WRITING_AGENT_TOKEN=<same service token>
WRITING_AGENT_STYLE_PROFILE_ID=style_litianc_default
WRITING_AGENT_LAYOUT_PROFILE_ID=wechat_clean_article
```

If `WRITING_AGENT_BASE_URL` is not configured, VibePub mining continues using its embedded rewrite prompt.
