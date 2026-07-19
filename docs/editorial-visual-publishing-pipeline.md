# Editorial Visual Publishing Pipeline

Phase 1 establishes the durable content contract for the review and visual publishing pipeline. It does not change the existing ASR, image generation, or WeChat draft side effects yet.

## Immutable Records

`article_versions` stores a complete snapshot: title, body, cover metadata, ordered `blocks`, title candidates, claim ledger, visual plan, formatting skill metadata, HTML hash, warnings, source, and timestamps. A revision appends a child row with `parent_version_id`; it never updates the parent. `legacy_snapshot` is reserved for imported historical content and is not treated as a real initial version or review outcome.

`editorial_reviews` stores findings only. Findings use `P0`, `P1`, or `P2`, include an optional `block_id`, evidence summary, suggested action, and `requires_human`. P0 requires `decision=block`; P1 requires `revise` or `block`. The review does not mutate an article version.

`visual_plans` stores block-bound cover, illustration, and chart intents. Chart entries require `data_provenance`; generated images are planned only after content is frozen. The final renderer and WeChat uploader are responsible for replacing planned references with audited CDN metadata in later phases.

All three tables have composite ownership foreign keys and append-only update/delete triggers. The existing `recordings` row remains the latest-result projection and now carries `workspace_id` for new uploads and version ownership checks.

Deleting a recording keeps the Android/Worker delete contract: the `recordings` projection and associated R2 objects are removed, so the item disappears from the user's list. `editorial_recording_scopes` deliberately has no FK back to `recordings`; its retained row is the recording audit tombstone that keeps ArticleVersion, Review, VisualPlan, run, and transition ownership valid after deletion. Those editorial rows remain append-only and are never deleted as a side effect of recording cleanup.

## State Machine

The fast path is:

`queued -> asr -> draft_generated -> review_pending -> reviewed -> content_frozen -> rendering -> visual_qa -> draft_sync -> completed`

Low-risk content can omit `asr`, `visuals_generating`, or image work according to later policy decisions. A P1 review may enter `revision_pending` and then append a new version; a P0 review enters `failed`/blocked handling. Once `content_frozen` is reached, a draft rewrite cannot move the same version back to `draft_generated`.

The transition contract is exported from `infra/worker/src/editorialContracts.ts` so Mining and later review jobs use one allowlist rather than independent string comparisons.

## API

These authenticated endpoints use the caller's `user_id` and `workspace_id`; request bodies cannot claim another owner. Snapshot and review creation are intentionally internal-only so a user cannot impersonate Writing or Editorial Review.

```text
GET  /api/editorial/articles/{article_id}/versions
GET  /api/editorial/versions/{version_id}
GET  /api/editorial/versions/{version_id}/reviews
POST /api/editorial/versions/{version_id}/visual-plan

Internal service routes, protected by the existing service authorization, are:

```text
POST /api/internal/editorial/versions
POST /api/internal/editorial/versions/{version_id}/reviews
POST /api/internal/editorial/versions/{version_id}/transition
```

The runtime assigns `writing.worker.v1`, `editorial-review.worker.v1`, and
`editorial-coordinator.worker.v1`; producer role/version fields in a request body are rejected. Only the five runtime agents are allowed: Coordinator, Writing, Review, Illustration, and Cover.
```

Version creation assigns the next version number from the scoped append-only history. Every write requires `idempotency_key` in JSON or the standard `Idempotency-Key` header. The same key and canonical payload return the existing object with `replayed=true`; the same key with another payload returns `409 idempotency_conflict`. A version or review belonging to another user is indistinguishable from not found.

The initial request must include `article_id`, `recording_id`, `source=initial`, title, body, and a complete snapshot payload. Revisions must include `source=revision` and the parent version ID. A chart visual must include stable `block_id`, `aspect_ratio`, `alt`, and `data_provenance`.

`generation_status` is server-owned and starts at `generated`; it cannot be supplied by a caller. The durable state row starts at `draft_generated`. Coordinator transitions require the current `state_revision`, validate the allowlisted state machine, and use a D1 batch CAS. The CAS update writes an opaque `transition_request_id` marker into the state row; the transition insert is conditional on that exact marker and the final batch statement clears it. A stale update therefore cannot insert a transition merely because another request already reached the target state, and the D1 batch keeps the state and transition write atomic. Replaying the same transition key/payload returns the original result; changing the payload returns `409 idempotency_conflict`. Frozen content cannot transition back to a draft state.

The minimal `RunManifest` and `ArtifactEnvelope` contracts pin workflow, policy, agent, and skill versions. They are schema/types only in this phase; no arbitrary scripts or dynamic agents are executed.

## Migration and Compatibility

`infra/worker/migrations/0010_editorial_visual_pipeline.sql` is additive and re-runnable. It does not `ALTER TABLE recordings`; instead, `editorial_recording_scopes` backfills a `(recording_id, user_id, workspace_id)` scope from the existing `users.workspace_id`, defaulting to `vibepub-dogfood` when no workspace is available. This avoids a duplicate-column failure when the canonical schema already has `recordings.workspace_id`, while old schemas without that column remain readable. New uploads try the workspace-aware insert and fall back to the old recording columns, then backfill the scope when the new table exists. Older Workers ignore all new editorial tables and continue using the recording projection. SQLite tests cover canonical fresh + repeated apply and a legacy schema first + repeated apply; before production rollout, apply the migration with the normal D1 migration command and verify the table/index/trigger list.

Rollback is a stop-write operation for the new `/api/editorial/*` routes followed by a Worker rollback to the previous version. The additive tables are retained for forward-fix; they are never dropped as part of rollback. Re-enable the routes only after the migration and Worker that understand the same contract are both verified.

Phase 1 intentionally does not create a draft, publish to WeChat, download an image, or call a new external service. Those side effects belong to later phases after review, content freeze, visual QA, and idempotent draft synchronization are connected.

## Phase 2 Durable Editorial Orchestration

Phase 2 adds an isolated Cloudflare Agents SDK runtime behind the existing
internal service-token boundary. The five registered Durable Object classes are
`EditorialCoordinatorAgent`, `EditorialWritingAgent`, `EditorialReviewAgent`,
`EditorialIllustrationAgent`, and `EditorialCoverAgent`; Formatting, VisualQA,
ImageGeneration, and Publisher remain Skills or pipeline steps, not Agents.

`EditorialCoordinatorAgent` is selected by a SHA-256 opaque name derived from
`user_id`, `workspace_id`, `article_id`, and `run_id`. There is no global
coordinator. The Agent stores only redacted run metadata, version pins, artifact
hashes, step results, human action categories, and append-only event rows in its
own SQLite storage. Article text, prompts, tokens, image bytes, and external
payloads are never written by this phase.

The `editorial-workflow-v2` AgentWorkflow uses stable step names and keys with
finite exponential retries. It writes synthetic `ArticleBrief`, `ArticleDraft`,
`ReviewReport`, `FrozenArticleVersion`, `IllustrationPlan`, and `CoverPlan`
envelopes. Duplicate step/artifact keys replay the original result; a different
payload returns an idempotency conflict. Artifact parents must already exist or
be created in the same step. `transactionSync()` first atomically prepares the
DO artifact, durable outbox, and immutable step. The stable Workflow step then
mirrors the outbox to the existing Phase 1 `editorial_runs`/`editorial_artifacts`
D1 tables and only after that succeeds performs the state CAS and event append.
Append-only triggers protect artifacts, steps, events, human-action history,
outbox rows, and D1 receipt metadata. A step or human confirmation is never
edited in place; retries create no replacement row.

The D1 mirror stores only ownership, version pins, hashes, and `storage_ref`;
it never stores article text, prompts, tokens, or image bytes. A D1 batch
failure leaves the DO state at its prior revision and keeps the outbox row
pending. A later stable-step retry rechecks the same run/artifact hash and
ownership, inserts at most one D1 row, records one DO receipt, and then permits
the next state. Frozen/visual plans therefore cannot reach the human wait or
approval state without a reconciled D1 mirror. No new D1 table or migration is
introduced by Phase 2.

The D1 `editorial_runs` row is a mutable projection with an immutable identity:
only `status` and a strictly increasing `updated_at` may change. Its trigger
allows a compare-and-swap transition from `planned`/`running` to `completed` or
`failed` (and same-status timestamp refresh), but rejects terminal rollback,
completed/failed swaps, pin changes, ownership changes, payload changes, and
idempotency changes. Migration `0010` drops and recreates the old full
append-only update trigger so reapply forward-fixes an existing local database;
the canonical schema contains the same trigger contract for fresh installs.

Approval, rejection, timeout, P0, second-P1, and workflow-error terminals all
use the same durable terminal step and intent: DO append, D1 artifact/hash and
run-status CAS, DO terminal receipt, then DO state/event CAS. If D1 succeeds
but the receipt or final CAS is interrupted, the pending intent replays against
the already-target terminal D1 status and creates no duplicate artifact,
receipt, or event. Existing D1 rows are fail-closed unless every ownership,
producer, input-artifact, schema/workflow/policy/skill pin, kind, hash,
storage-ref, and stable artifact identity matches.
Each run has one unique terminal intent; competing completed/failed attempts
therefore yield one legal terminal outcome and a stale/conflict response.

The D1 artifact mirror is an exact set for the run: extra, missing, or
mismatched rows (including `schema_version`) block the awaiting and terminal
transitions. The pre-write check rejects extras before any INSERT; a successful
replay performs a post-write count and identity reconciliation. Public
`d1_mirrored_artifact_count` is queried from D1, while the DO receipt count and
pending count remain separate diagnostics. Immutable D1 rows are quarantined
by restoring the same stable artifact identity into the DO outbox; they are
never edited or deleted as a recovery shortcut.

The server-owned state path is:

`queued -> draft_generated -> review_pending/revision_pending -> reviewed -> content_frozen -> awaiting_human_confirmation -> approved_for_phase3`

P0 and a second failed P1 review end in `failed` with
`human_action_required`; a single P1 revision creates a new draft artifact and
re-enters review. Human approval is durable and concurrent confirmation is
accepted once. Approval only authorizes a later phase and has no publication
side effect. User human actions are valid only while the server-owned state is
`awaiting_human_confirmation`; the Workflow's internal await step is the only
path that establishes that state. Eviction/restart resumes from the stored
run/step/outbox ledger.

The `EDITORIAL_WORKFLOW_V2` flag defaults to `false`. Even when enabled, a run
must match the server-side `EDITORIAL_WORKFLOW_V2_ALLOWLIST` pair
`user_id:workspace_id`; clients cannot set the flag, ownership, role, producer,
or state. Flag-off requests return `editorial_workflow_disabled` before a DO is
resolved, so legacy Mining and Android behavior creates no Phase 2 artifact or
Workflow. This phase adds no D1 migration. Wrangler adds the new
`v2-editorial-agents` SQLite migration tag for the five DO classes; it has not
been applied remotely.

Rollback is a stop-write/flag-off operation followed by Worker version rollback;
DO histories are retained for forward-fix and are never deleted. No GLM, ASR,
image, WeChat, CDN, R2, or other network call is made by the Phase 2 synthetic
workflow. Production enablement requires a later detached review of the
bindings, allowlist, workflow retries, and evidence before any migration or
deployment.
