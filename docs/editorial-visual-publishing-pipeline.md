# Editorial Visual Publishing Pipeline

Phase 1 establishes the durable content contract for the review and visual publishing pipeline. It does not change the existing ASR, image generation, or WeChat draft side effects yet.

## Immutable Records

`article_versions` stores a complete snapshot: title, body, cover metadata, ordered `blocks`, title candidates, claim ledger, visual plan, formatting skill metadata, HTML hash, warnings, source, and timestamps. A revision appends a child row with `parent_version_id`; it never updates the parent. `legacy_snapshot` is reserved for imported historical content and is not treated as a real initial version or review outcome.

`editorial_reviews` stores findings only. Findings use `P0`, `P1`, or `P2`, include an optional `block_id`, evidence summary, suggested action, and `requires_human`. P0 requires `decision=block`; P1 requires `revise` or `block`. The review does not mutate an article version.

`visual_plans` stores block-bound cover, illustration, and chart intents. Chart entries require `data_provenance`; generated images are planned only after content is frozen. The final renderer and WeChat uploader are responsible for replacing planned references with audited CDN metadata in later phases.

All three tables have composite ownership foreign keys and append-only update/delete triggers. The existing `recordings` row remains the latest-result projection and now carries `workspace_id` for new uploads and version ownership checks.

## State Machine

The fast path is:

`queued -> asr -> draft_generated -> review_pending -> reviewed -> content_frozen -> rendering -> visual_qa -> draft_sync -> completed`

Low-risk content can omit `asr`, `visuals_generating`, or image work according to later policy decisions. A P1 review may enter `revision_pending` and then append a new version; a P0 review enters `failed`/blocked handling. Once `content_frozen` is reached, a draft rewrite cannot move the same version back to `draft_generated`.

The transition contract is exported from `infra/worker/src/editorialContracts.ts` so Mining and later review jobs use one allowlist rather than independent string comparisons.

## API

These authenticated endpoints use the caller's `user_id` and `workspace_id`; request bodies cannot claim another owner.

```text
POST /api/editorial/versions
GET  /api/editorial/articles/{article_id}/versions
GET  /api/editorial/versions/{version_id}
POST /api/editorial/versions/{version_id}/reviews
GET  /api/editorial/versions/{version_id}/reviews
POST /api/editorial/versions/{version_id}/visual-plan
```

Version creation assigns the next version number from the scoped append-only history. Every write requires `idempotency_key` in JSON or the standard `Idempotency-Key` header. The same key and canonical payload return the existing object with `replayed=true`; the same key with another payload returns `409 idempotency_conflict`. A version or review belonging to another user is indistinguishable from not found.

The initial request must include `article_id`, `recording_id`, `source=initial`, title, body, and a complete snapshot payload. Revisions must include `source=revision` and the parent version ID. A chart visual must include stable `block_id`, `aspect_ratio`, `alt`, and `data_provenance`.

## Migration and Compatibility

`infra/worker/migrations/0010_editorial_visual_pipeline.sql` is additive. It backfills `recordings.workspace_id` from `users`, creates the version/review/visual tables, composite indexes, and append-only guards. Older Workers ignore the new tables and continue using the existing recording projection. Before production rollout, apply the migration with the normal D1 migration command and verify the table/index/trigger list.

Rollback is a stop-write operation for the new `/api/editorial/*` routes followed by a Worker rollback to the previous version. The additive tables are retained for forward-fix; they are never dropped as part of rollback. Re-enable the routes only after the migration and Worker that understand the same contract are both verified.

Phase 1 intentionally does not create a draft, publish to WeChat, download an image, or call a new external service. Those side effects belong to later phases after review, content freeze, visual QA, and idempotent draft synchronization are connected.
