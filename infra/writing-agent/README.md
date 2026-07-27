# WritingAgent

WritingAgent is the standalone rewrite platform for VibePub. It owns writing style profiles, compatibility layout profiles, and the versioned formatting Skill contract described in `../../docs/writing-agent-protocol.md`.

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
- `GET /v1/formatting-skills`
- `GET /v1/formatting-skills/:id`
- `POST /v1/rewrite-jobs`
- `POST /v1/revision-jobs`

Rewrite and revision jobs can reference a built-in `style_profile_id`, a D1-backed distilled profile, or provide an inline private `style_profile_body` from Android local custom templates.

Formatting defaults to `md_to_wechat@1.0.0`. The legacy
`layout_profile_id=wechat_clean_article` and version `2026-07-05` resolve to
that canonical Skill, so existing Mining and Android requests keep working.
An explicit `formatting_skill_id` must include `formatting_skill_version`.
Unknown IDs, unavailable versions, and incompatible new/legacy selections fail
before the GLM request; there is no silent fallback. Formatting Skills are a
code registry plus a trusted adapter, not executable `SKILL.md` files or
dynamic user configuration.

Each registry entry binds its public manifest to a complete adapter that owns
prompt instructions, heading behavior, inline styles, and complex-content
fallbacks. Rewrite and revision use the same resolver/adapter pipeline; adding
another reviewed Skill requires only its registry entry, adapter, and tests.
The shared normalizer keeps the non-bypassable HTML safety floor and does not
choose `md_to_wechat` presentation rules for other adapters.

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

## Deployment

Wave 2E staging renders this private adapter from the protected staging
resource manifest. The adapter has `workers_dev=false` and `preview_urls=false`;
the manual deployment path bootstraps that private target, syncs
`WRITING_AGENT_TOKEN` and `GLM_API_KEY` only through the protected Environment,
then performs a final commit/ref/timestamp-stamped deploy using an explicit
generated `--config`. The default CI path only validates and runs
`wrangler deploy --dry-run`; it does not deploy, set secrets, or apply remote
D1 migrations.

Then configure VibePub Worker and mining callers:

```text
WRITING_AGENT_BASE_URL=https://<writing-agent-host>
WRITING_AGENT_TOKEN=<same service token>
WRITING_AGENT_STYLE_PROFILE_ID=style_litianc_default
WRITING_AGENT_LAYOUT_PROFILE_ID=wechat_clean_article
```

If `WRITING_AGENT_BASE_URL` is not configured, VibePub mining continues using its embedded rewrite prompt.

`GET /health` returns only the service name and non-secret deploy
commit/ref/timestamp evidence; it never exposes credentials or model responses.
