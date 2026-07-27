# Editorial Review Agent

This Worker is the controlled Wave 2A review adapter. It accepts an internal
service token and a transient, schema-checked draft payload. It returns only a
versioned `ReviewReport`; it does not persist or log article text, prompts,
provider responses, tokens, or cookies.

The review rules are pinned to `dbs-ai-check@1.0.0` and
`humanizer-zh@1.0.0`. They are implemented in VibePub code. The Worker does
not read `SKILL.md`, load `.env`, execute scripts, call a third-party review
service, or call a model.

Configure `REVIEW_AGENT_TOKEN` with the platform secret store. The value is
intentionally absent from this repository.

Wave 2E staging renders this adapter as a private `workers_dev=false`,
`preview_urls=false` target. The normal CI job only performs synthetic rendering
and `wrangler deploy --dry-run`; an approved protected Environment bootstrap
and final explicit-config deployment stamps `/health` with non-secret
commit/ref/timestamp metadata.
