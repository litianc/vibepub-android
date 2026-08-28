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
`editorial-coordinator.worker.v1`; producer role/version fields in a request body are rejected. Historical Phase 1 records may contain Illustration/Cover, but the Wave 1 active registry has only Coordinator, Writing, Review, VisualProduction, and WechatPublishing.
```

Version creation assigns the next version number from the scoped append-only history. Every write requires `idempotency_key` in JSON or the standard `Idempotency-Key` header. The same key and canonical payload return the existing object with `replayed=true`; the same key with another payload returns `409 idempotency_conflict`. A version or review belonging to another user is indistinguishable from not found.

The initial request must include `article_id`, `recording_id`, `source=initial`, title, body, and a complete snapshot payload. Revisions must include `source=revision` and the parent version ID. A chart visual must include stable `block_id`, `aspect_ratio`, `alt`, and `data_provenance`.

For versions created through the editorial API, `generation_status` is server-owned and starts at `generated`; it cannot be supplied by a caller. Their durable state row starts at `draft_generated`. The five-Agent publishing workflow has a separate finalization path: only after the frozen artifact is committed does it atomically create the initial `v1` snapshot with `generation_status=frozen` and state `content_frozen`. Internal drafts are not product versions. Coordinator transitions require the current `state_revision`, validate the allowlisted state machine, and use a D1 batch CAS. The CAS update writes an opaque `transition_request_id` marker into the state row; the transition insert is conditional on that exact marker and the final batch statement clears it. A stale update therefore cannot insert a transition merely because another request already reached the target state, and the D1 batch keeps the state and transition write atomic. Replaying the same transition key/payload returns the original result; changing the payload returns `409 idempotency_conflict`. Frozen content cannot transition back to a draft state.

The minimal `RunManifest` and `ArtifactEnvelope` contracts pin workflow, policy, agent, and skill versions. They are schema/types only in this phase; no arbitrary scripts or dynamic agents are executed.

## Migration and Compatibility

`infra/worker/migrations/0010_editorial_visual_pipeline.sql` is additive and re-runnable. It does not `ALTER TABLE recordings`; instead, `editorial_recording_scopes` backfills a `(recording_id, user_id, workspace_id)` scope from the existing `users.workspace_id`, defaulting to `vibepub-dogfood` when no workspace is available. This avoids a duplicate-column failure when the canonical schema already has `recordings.workspace_id`, while old schemas without that column remain readable. New uploads try the workspace-aware insert and fall back to the old recording columns, then backfill the scope when the new table exists. Older Workers ignore all new editorial tables and continue using the recording projection. SQLite tests cover canonical fresh + repeated apply and a legacy schema first + repeated apply; before production rollout, apply the migration with the normal D1 migration command and verify the table/index/trigger list.

Rollback is a stop-write operation for the new `/api/editorial/*` routes followed by a Worker rollback to the previous version. The additive tables are retained for forward-fix; they are never dropped as part of rollback. Re-enable the routes only after the migration and Worker that understand the same contract are both verified.

Phase 1 intentionally does not create a draft, publish to WeChat, download an image, or call a new external service. Those side effects belong to later phases after review, content freeze, visual QA, and idempotent draft synchronization are connected.

## Wave 2A Text Artifact Foundation

Wave 2A adds the versioned contracts used by the later five-agent runtime without
starting that runtime. The private R2 object is exactly
`{ envelope: <provenance and payload_hash>, payload: <ArticleBrief|ArticleDraft|ReviewReport|RevisionDispatch|FrozenArticleVersion> }`.
The envelope is deterministic: `created_at` must be supplied by the durable
Coordinator intent, artifact IDs and keys are derived from immutable identity,
and payload hashes use one default-code-unit key ordering shared by Worker and
Writing/Review adapters. A repeated logical write replays the same object;
different bytes under the same derived identity are an `artifact_conflict`.

The envelope and D1/DO mirror contain only ownership, hashes, storage references,
version pins, input IDs, and bounded summaries. They never contain title, body,
transcript, prompt, instruction, evidence text, or the payload. R2 writes are
conditional and are read back by hash, length, metadata, and canonical object
bytes. An unknown write or unreadable read is held as
`artifact_reconciliation_required`; it is never reported as created.

`FrozenArticleVersion` is the only semantic content input for Wave 2C and carries
the complete immutable blocks, claim ledger, title candidates, selected title,
cover title, formatting pins, and accepted artifact hashes. Its provenance is
bound by `draft_artifact_id`, `accepted_draft_payload_hash`,
`accepted_review_payload_hash`, and the RunManifest rather than duplicated in
the frozen payload. Wave 2A validates the Frozen snapshot's local invariants
but does not dereference Draft and Review artifacts for a cross-artifact
field-by-field acceptance check; that Coordinator-owned check belongs to Wave
2B before a Frozen artifact is produced. While content is frozen, `html_hash`
must remain `null`; rendered HTML hashes belong to the later
`RenderedArticlePackage`.

The controlled Writing V3 adapter accepts the existing exact
`style_litianc_default@2026-07-05` profile or a custom profile bound to an inline
body hash. Briefs pin the default without copying its registry body; custom
briefs keep the body and canonical hash only in private R2. A revision must carry and revalidate the complete draft, review report,
and Coordinator-created revision dispatch. The dispatch is a separate immutable
artifact, keyed by `run_id + source_review_artifact_id`; it names the exact target
blocks (including `@title` when applicable). It hashes each non-target block and
the protected title value. The source draft payload hash binds the complete title
metadata, which Writing compares. The Dispatch also carries the exact ordered
producer pin array for `editorial_coordinator`, `writing`, and `editorial_review`;
it permits one revision only. Writing recomputes all three
payload hashes before any model request and rejects style/profile/model changes,
malformed claims, body/block drift, and protected metadata changes. Revision
prompts pass only a transient canonical allowlist of the current title metadata,
full blocks, claim ledger, exact targets, and instruction; they exclude artifact
payload hashes, producer credentials, and authorization data and are not logged
or persisted. The model returns blocks and title metadata; the adapter computes
the body projection and each block `text_hash`, while stored/current Drafts must
still carry and verify both values.

The separate Editorial Review Worker receives a transient full Draft payload,
recomputes its input hash, and returns only a pinned ReviewReport. Its first
review with P1 and no P0 is `revise`; P0 and a second P1 result are `block`, and P2 is
non-blocking. It does not persist article text, call a provider, execute local
skills, or include a self-referential revision instruction. The Coordinator will
persist the report and create the RevisionDispatch in the next orchestration wave.

Wave 2A includes internal service-binding clients with token authentication and a
URL fallback only for local/legacy environments. Binding does not imply identity:
the corresponding service secret is still required. Unknown/auth/schema errors
are non-retryable; network, timeout, 408, and 429 responses are retryable, and
Writing 5xx responses are retryable only for the controlled 502/503/504
allowlist; 500, 501, and unknown 5xx responses are non-retryable. The clients and
artifacts are not yet wired to Coordinator/D1/DO, Mining, Android, image
generation, WeChat, or real model calls. This is an intentional 2B boundary.

## Phase 2 Durable Editorial Orchestration

Phase 2 adds an isolated Cloudflare Agents SDK runtime behind the existing
internal service-token boundary. The five active Durable Object classes are
`EditorialCoordinatorAgent`, `EditorialWritingAgent`, `EditorialReviewAgent`,
`EditorialVisualProductionAgent`, and `EditorialWechatPublishingAgent`.
`EditorialIllustrationAgent` and `EditorialCoverAgent` remain legacy namespace
compatibility bindings so old DO state and pins remain readable; they are not
active business roles and new runs never select them. Formatting, VisualQA,
ImageGeneration, and Publisher remain Skills or pipeline steps, not Agents.

`EditorialCoordinatorAgent` is selected by a SHA-256 opaque name derived from
`user_id`, `workspace_id`, `article_id`, and `run_id`. There is no global
coordinator. The Agent stores only redacted run metadata, version pins, artifact
hashes, step results, human action categories, and append-only event rows in its
own SQLite storage. Article text, prompts, tokens, image bytes, and external
payloads are never written by this phase.

The `editorial-workflow-v2` AgentWorkflow uses stable step names and keys with
finite exponential retries. Its historical synthetic fixtures remain test-only;
production Wave2B uses the Wave2A Writing and Review service adapters and
persists only redacted metadata. Duplicate step/artifact keys replay the
original result; a different payload returns an idempotency conflict. Artifact
parents must already exist or be created in the same step. `transactionSync()`
first atomically prepares the DO artifact, durable outbox, and immutable step.
The stable Workflow step then mirrors the outbox to the existing Phase 1
`editorial_runs`/`editorial_artifacts` D1 tables and only after that succeeds
performs the state CAS and event append.
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
Workflow. This phase adds no D1 migration. Wrangler retains the historical
`v2-editorial-agents` SQLite migration tag for the original namespaces and
adds the forward-only `v3-five-agent-publishing` tag for VisualProduction and
WechatPublishing; old namespaces are not renamed or deleted. These local
configuration changes have not been applied remotely.

Rollback is a stop-write/flag-off operation followed by Worker version rollback;
DO histories are retained for forward-fix and are never deleted. Production
enablement requires a later detached review of the bindings, allowlist,
workflow retries, and evidence before any migration or deployment.

## Wave 2B Text Workflow

Wave2B adds the isolated `FiveAgentPublishingWorkflow` behind the existing
`FIVE_AGENT_PUBLISHING_V3` flag and owner/workspace allowlist. The workflow
reads the owner-scoped transcript and Brief from private R2, then calls the
existing Writing and Editorial Review service adapters; it never synthesizes
production article text. Agents do not directly hold model/provider secrets;
tests and unauthorized environments do not send real model calls. Adapter responses are normalized and persisted
through the outbox -> immutable R2 readback -> redacted D1 mirror -> publication
projection CAS -> DO receipt/event sequence.

The review path has explicit durable commit steps. Initial progress is
`writing -> draft_generated -> reviewing`; a first-round P1 uses
`reviewing -> revising -> writing -> draft_generated -> reviewing` before the
second review. Phase and round are part of system event idempotency keys, so the
second Writing/Review pass cannot collide with the first pass. Each commit step
reads the complete artifact back from R2 before advancing the projection; it
never increments a revision by assumption. A P0 or second-round finding is
written as `needs_action` with a stable error and next action. An unknown or
unreconciled adapter result is also durably held as
`external_side_effect_unknown` / `reconcile_external_side_effect`; it is not
retried or turned into a fabricated artifact.

In the second-round path the DO records `revising -> writing ->
draft_generated -> reviewing`; the publication projection remains at `revising`
and records the writing and draft-generated milestones as same-state events
until the final review transition.

Workflow step results contain only artifact references, hashes, decisions, and
bounded metadata. Full draft/review payloads are read inside the step that needs
them and are not returned as durable step results. This wave remains synthetic
in tests, flag-off by default, and has no production migration or deployment.
The V3 route accepts only the dedicated `FIVE_AGENT_PUBLISHING_TOKEN`; legacy
`FILES_TOKEN`, the old internal token, and user sessions are not credentials for
this route. The five-agent adapter does not directly hold provider secrets;
tests and unauthorized environments do not send real model requests.
Successful terminal sets are exact: pass/P2 has 4 artifacts, first-round P0
has 3, a single P1 revision followed by a passing second review has 7, and a
second-round P0/P1 hold has 6. Known non-retryable adapter errors end in
`failed` with retry count 1; controlled retryable failures end in `failed` at
count 3, and the App projection retains the last successful stage/progress.
Before any Draft is prepared, the coordinator rechecks the response round and
the exact run-manifest adapter/model/style/formatting pins (including custom
style-body hash); before any Review is prepared it rechecks the bound round and
review pins. Run responses use one fixed redacted projection field set for
start, hold, repeat, and GET, while complete DO and publication event histories
are checked for contiguous revisions, explicit event allowlists, and exact
artifact identities.

Before any Workflow business step, the coordinator must confirm the immutable
`workflow_start_confirmed` event/receipt for the exact run, workflow, owner,
manifest, and payload identity. An unconfirmed Workflow stops before transcript,
R2, provider, artifact, or business D1 access. Pre-start unknown outcomes keep
the main DO run queued while the start ledger records the hold; reconciliation
persists its receipt first, then replays the three server-owned D1 CAS steps
(`needs_action` same-state reconciliation, `retrying`, and `queued`). Each step
has an independent event identity and may be retried after a lost response.
Only the known-existing Workflow path writes the single confirmation event and
then continues the same run; it never creates a second Workflow instance.

## Wave 1 Five-Agent Publishing Projection

Wave 1 keeps the Phase 1 `editorial_runs`/`editorial_artifacts` ledger and the
Coordinator DO as the only canonical durable workflow state. The new
`publication_runs`, `publication_run_events`, and `publication_run_actions`
tables are server-owned App projections, bounded event history, and action
idempotency records; they cannot create a run without a matching canonical
`editorial_runs` identity and cannot advance the canonical ledger.

New runs use exactly five active runtime roles:
`editorial_coordinator`, `writing`, `editorial_review`, `visual_production`,
and `wechat_publishing`. The old `illustration` and `cover` producer pins
remain readable historical data and are never rewritten. The new
`VisualProduction` and `WechatPublishing` Durable Object bindings are
additive; no old Durable Object namespace is renamed or deleted.

`publication_runs.run_id` is the canonical `editorial_runs.run_id` (the
`source_run_id` compatibility column is constrained to the same value).
Projection rows are owner/workspace/recording-bound with composite foreign
keys, immutable identity fields, insert-only event/action history, monotonic
state revisions, and a creation-order current-run selector. A late write from
an older run cannot replace a newer current pointer, and a run's state
revision is never compared across runs.

The App projection endpoints are:

```text
GET  /api/recordings/{recording_id}/publication-run
GET  /api/publication-runs/{run_id}/events?after_revision=-1&limit=50
POST /api/publication-runs/{run_id}/retry
POST /api/publication-runs/{run_id}/cancel
POST /api/publication-runs/{run_id}/actions
```

Event pagination is bounded to 1-100 rows. The default cursor `-1` reads the
initial revision `0`; an explicit cursor `0` skips revision `0`. Results are
strictly ascending and non-overlapping, and `next_after_revision` is the last
returned revision for every non-empty page, including the final page; an empty
page returns the supplied cursor. Mutating endpoints require a server-checked
`expected_state_revision`, an idempotency key, and the authenticated owner;
stale actions return 409 without writing an intent.

When the additive projection tables are unavailable, the recording endpoint
uses a conservative legacy response. It does not fabricate a v3 manifest,
pins, or draft readiness: legacy runs are read-only, marked
`identity_status=legacy_unpinned`, and awaiting/approved legacy states stop at
`content_frozen` with `v3_projection_required`. Only a real v3 draft
verification may expose `draft_ready`.

`FIVE_AGENT_PUBLISHING_V3` defaults to false and its allowlist defaults empty.
Flag-off behavior leaves legacy Mining and Android paths unchanged and does
not resolve a new Durable Object, read `publication_*`, or create a projection
row; the new GET routes return stable 404. Legacy fallback is available only
when the flag and owner/workspace allowlist are enabled. Migration 0011 is
an additive forward migration for environments that have not applied it; its
artifact allowlist forward-fix preserves old Illustration/Cover rows and is
validated on fresh and legacy schemas. D1 migrations are applied once by the
normal migration runner; fresh, existing, and migration-order fixtures are
covered by SQLite tests rather than promised as a rerunnable SQL script.

### Projection write and App read contract

Only the authorized Coordinator/internal service may write the publication
projection. It updates one owner-bound run with a state-revision CAS and the
complete server-generated `last_event_*` marker in the same batch as the
append-only event/action rows. Clients never supply producer roles, pins,
state, stage, or progress, and the projection cannot write back to the
canonical `editorial_runs`/Coordinator ledger.

System `retry` is allowed from `failed` or `needs_action`; system `cancel` is
allowed from any non-terminal v3 run. Human `confirm`, `abandon`, and `resume`
are intent-only and require the same `expected_state_revision`,
`state=needs_action`, `run_status=needs_action`, and exact `next_action`.
Queued, active, terminal, legacy, stale, or mismatched actions return a
conflict without an intent. Repeating the same key and payload replays one
intent; a different payload conflicts. Retry resumes the stored
`last_successful_state`, and retry/needs-action/failed/cancelled responses
retain the last successful stage and progress rather than moving the App
backwards.
A needs_action projection with next_action=reconcile_external_side_effect or
error_code=external_side_effect_unknown is a reconciliation hold: system
retry and cancel return the stable reconciliation_required conflict without
writing an action or pretending the run was cancelled; only a controlled
reconciliation writer may advance it.
When a controlled worker resumes a retrying run, it targets the stored
resume_state through the same CAS event/action batch; retrying may also be
cancelled through that batch without clearing the last successful progress.

The recordings list exposes only the agreed summary fields. The detail route
marks legacy data `legacy=true`, `identity_status=legacy_unpinned`, and
read-only capabilities; it never fabricates v3 pins or `draft_ready`.
Transient/error states show the last successful stage and a `next_action`; only
a real server-side draft verification may expose `draft_ready`. Event reads
use `after_revision=-1` to include revision zero, bounded pages, stable
ascending revisions, and a cursor equal to the last returned revision.

## Wave 2C Visual Production

Wave 2C is an additive, feature-gated continuation after `content_frozen`.
The normal and revision freeze branches call the same
`runVisualProductionPhase`; when `VISUAL_PRODUCTION_V3` is off or the exact
`user_id:workspace_id` pair is not allowlisted, the existing Wave2B result is
returned at `content_frozen` and no Wave2C binding, R2 object, D1 row, or DO
visual ledger is touched. There is no new client route and no migration or
schema-file change in this wave.

The active visual states are `visual_planning` (68), `visual_generating` (74),
and `visual_ready` (80), where this wave stops. `visual_plan.v2`, one
`visual_asset.v2` per slot, and `visual_qa_report.v2` use the independent
`editorial-wave2c.v1` envelope and `visual_production` producer. Normal plans
contain one cover plus two body slots and five logical JSON artifacts; long
plans contain one cover plus five body slots and eight logical JSON artifacts.
PNG binaries have separate canonical keys and are not mirrored as D1 rows.

Planning counts Unicode code points with `Array.from`, excludes blank blocks,
deduplicates by the first ordered `text_hash`, and selects slots with the
fixed spread formula. Fewer unique blocks produces
`needs_action/visual_plan_insufficient_unique_blocks` before any plan or image
adapter call. Every plan, asset, binary, and QA object is conditional and
read-back verified; same identity replays and different bytes conflict.
The frozen project-adapter manifests compile prompts in the fixed order
`output_contract`, `immutable_input`, `style_pins`, `content`, `slot_binding`,
`composition`, `color_material`, `text_policy`, `negative_constraints`, and
`final_check`. Both manifests pin `version=1.0.0`,
`version_source=project_adapter_manifest`,
`prompt_serialization=canonical_utf8_v1`, `output_count=1`, and
`random_style_extension=forbidden`. Cover prompts retain the exact ordered
one-to-four title lines and one deterministic punk/retro-dot-matrix metaphor.
Body prompts bind one selected block to a deterministic, per-slot unique
core idea, metaphor, concrete action, and one or two objects, plus the frozen
white-background, Xiaohei, restrained-color, no-text, and negative rules.
Normalization rebuilds these sections and hashes, so removing or drifting a
manifest rule fails closed.

The Coordinator mirror contains only redacted identity, hash, ref, slot, and
active pin metadata. D1 uses the existing `skill_id`/`skill_version` columns
for a versioned, canonical, independently decodable visual pin snapshot that
contains model, adapter, cover/body skill, cover style, formatting, and each
`version_source`; exact-set verification rejects any decoded pin drift. Full
prompts, payloads, and image bytes remain private to the relevant R2 object or
transient adapter call.

`IMAGE_GENERATION_ADAPTER` is a dedicated service binding authenticated with
`VISUAL_PRODUCTION_TOKEN`; it never accepts the old service tokens or user
sessions. The adapter fixes `gpt-image-2`, requires a deployment-configured
HTTPS provider manifest, and owns the provider key. HTTP, wildcard,
user-selected, or unconfigured endpoints fail closed. Its
`VISUAL_OPERATION` Durable Object transaction claims each operation/attempt
before provider access, while `VISUAL_RESULTS_BUCKET` stores the immutable
intent/result and readback evidence. Only explicit provider HTTP responses
408/429 and controlled 502/503/504 errors retry, with at most three attempts
per logical plan/image call. Transport and network exceptions are
`external_side_effect_unknown` and reconcile-only; unknown provider or storage
outcomes stop the chain at
`needs_action/external_side_effect_unknown/reconcile_external_side_effect`;
known contract errors are failed with a stable visual error category. Each
operation/attempt has a durable intent and outcome; a later attempt is
permitted only after the immediately preceding attempt has a durable retryable
failure. An inflight or storage-unknown result is recovered through a
read-only adapter reconciliation by operation and attempt, never by blind
regeneration. Replays use the current frozen+plan execution scope while
preserving older immutable partial artifacts from prior scopes.

Whole-Workflow re-entry reads the Coordinator and publication states plus the
current execution ledger. A visual `needs_action` hold performs only an exact,
read-only reconciliation of the existing operation first. Unknown evidence
returns the same hold without another execute; proven terminal evidence is
recorded through a same-state `visual_side_effect_reconciled` event, then D1
advances through `needs_action -> retrying -> last_successful visual state`
while the Coordinator resumes its matching visual state. Only then may the
pipeline finish missing binary, JSON, D1, projection, receipt, and event work.
Previously committed slots and provider results are not regenerated.

A completed `visual_ready` replay does not trust ledger counts alone. It
re-reads the Frozen input, rebuilds the Plan with the Plan's original
`created_at`, compares the canonical Plan payload, and revalidates every asset
JSON and scoped binary before checking the ordered QA report and the exact
DO/D1/publication event set. The QA pass is bound to freshly recomputed cover
opacity and body white-background results, not to the report's boolean claim.

Cancellation is checked before planning, generation, every adapter execute or
reconcile, each later slot, and the final QA-to-ready transition. A D1
cancellation lookup that is missing or unavailable fails closed without an
adapter call. A provider request already in flight cannot be revoked, but no
later slot or terminal visual write begins after cancellation is observed;
artifacts already committed remain immutable and are returned in the run's
artifact set, including a QA report committed before a later hold.

The QA report checks PNG signature, IHDR dimensions, metadata, ordered slot
identity, and deterministic body white-background evidence (98% opaque white
pixel threshold with at least one non-white pixel). Cover visible text is an
adapter prompt-contract evidence pin for the exact ordered frozen cover-title
lines, while body assets require an empty visible-text list; this wave does not
claim OCR. The visual chain never edits the frozen title, body, blocks, claims, or
HTML hash, and it does not enter formatting, WeChat, Android, or real-provider
production paths.

## Wave 2D WeChat Draft Preparation

Wave 2D is a second, independently gated continuation from `visual_ready`. It
is enabled only when `WECHAT_DRAFT_SYNC_V3=true`, the exact
`user_id:workspace_id` pair is allowlisted, and the opaque account binding is
also listed in `WECHAT_PUBLISHING_ACCOUNT_ALLOWLIST`. With the flag off or a
tenant miss, Wave 2B/2C returns at `visual_ready` and does not resolve the
WeChat adapter, create a Wave 2D artifact, or issue an external operation.

The private `wechat-publishing-adapter` service binding is the only Wave 2D
provider boundary. It accepts only `WECHAT_PUBLISHING_TOKEN`, looks up and
decrypts the account locally, and owns its private operation Durable Object
and R2 evidence. The main Worker never reads account credentials, proxy URLs,
or provider response bodies. A read-only account-resolution receipt is pinned
before formatting. An unavailable or unallowlisted account moves directly
from `visual_ready` to
`needs_action/wechat_publishing_account_unavailable/repair_publishing_account`
or
`needs_action/wechat_publishing_account_not_allowed/request_account_enablement`;
it does not synthesize formatting, QA, or draft-sync progress.

The adapter accepts only a deployment-owned provider base that exactly matches
the normalized `WECHAT_PROVIDER_BASE_URL_ALLOWLIST` HTTPS/443 origin and base
path; an empty allowlist, hostname/path lookalike, credential-bearing URL, or
private-like or trailing-dot alias is rejected before decryption, Durable Object selection,
R2, or provider access. It repeats the feature owner allowlist, account
binding, and receipt checks at the Durable Object boundary, then uses the
fixed WeChat token, material-upload, image-upload, draft add/update/get, and
bounded batch-get paths. The currently configured HTTP gateway remains a production blocker
until a TLS front is in place and the exposed account credential is rotated.
Provider-returned media is independently restricted by the deployment-owned,
exact `WECHAT_MEDIA_URL_HOST_ALLOWLIST`; an empty list, lookalike subdomain,
private/IP host, credentials, non-HTTPS scheme, or non-443 port fails closed
before the main Worker accepts a package, readback, or replay evidence.

After a valid receipt, the fixed state path is `formatting` (84), `visual_qa`
(90), `draft_syncing` (96), `draft_verifying` (98), and `draft_ready` (100).
The Coordinator records `draft_syncing` in both its durable state and the
publication projection before the first cover or body-image upload crosses
the adapter boundary. A repaired Wave 2D hold resumes through the server-owned
projection retry transition and returns the Coordinator to its recorded local
checkpoint; it never manufactures visual work or a new public resume action.
The deterministic formatter accepts the exact frozen article, visual plan,
ordered visual assets, and visual QA inputs; it emits inline-only WeChat HTML
with ordered HTTPS body images and a thumb-only cover. It never publishes.
The immutable `editorial-wave2d.v1` graph contains a template, render QA,
one upload receipt per visual slot, rendered package, prepublish QA, draft
receipt, and readback QA: nine logical artifacts for normal content and
twelve for long content. Every payload repeats and validates its ordered
parent chain, while Coordinator/D1 mirrors retain only redacted identities,
hashes, references, slots, operations, account receipt hashes, and versioned
pin metadata.

Each account receipt/configuration repair or reconciled readback hold creates
a hash-only immutable execution scope. Failed or partial scopes remain
historical audit evidence and cannot be overwritten; the sole passing
readback selects the active scope, whose terminal graph is exactly nine or
twelve artifacts. Global Coordinator, R2, and D1 checks require every
historical scope to be a valid no-hole parent graph tied to its own recovery
evidence, and reject duplicate passing scopes, cross-scope parents, or orphan
initial prefixes; an unresolved add remains confined to its original write
intent and bounded read-only fingerprint reconciliation.
Every non-initial scope maps one-to-one to a complete reconciled, retrying,
and resumed recovery triplet, whose resumed publication event strictly
precedes that scope's first artifact event. The source hold and its three
recovery events occupy four contiguous revisions and restore the hold's exact
preceding checkpoint. Every historical scope, including
one that reached `draft_syncing`, must be followed by the canonical hold that
anchors a later complete recovery triplet; an old checkpoint alone cannot
make an abandoned scope replayable.
There is at most one unbound initial scope; an account gate that fails before
the first artifact legitimately begins later with a recovery-bound scope.

Adapter operations use deterministic operation and attempt identities. The
adapter writes an intent before provider access and stores a verified immutable
terminal result before responding; a main-side response loss is reconciled by
the same operation rather than regenerated. Only explicit provider HTTP
responses with a durable delivery proof of
`not_forwarded` or `rejected_before_commit` may retry on 408, 429, 502,
503, or 504; transport exceptions are never retried blindly. A verified draft
mapping is scoped to the opaque account and stable article identity. A legacy
recording draft ID is read and validated before it is reused, and identical
content performs only that validation read without another draft mutation.
At verified completion, the owner-bound `recordings.wechat_draft_id` and an
optional verified HTTPS cover URL are committed in the same guarded D1 batch
as the `draft_ready` projection event. No credential, HTML, media ID, provider
body, or publishing request is written into the main Coordinator/D1 mirror.
The private draft receipt and pass readback QA retain the verified media and
cover evidence solely for exact replay comparison; a completed run fails
closed if either recording field differs from that immutable evidence.

## Wave 2E Integration And Staging Gate

Wave 2E may hand off an allowlisted legacy Mining source to the exact V3
owner-scoped transcript and publishing run without duplicating legacy writing,
images, or WeChat work. The public recording list may expose only a redacted
publication snapshot; internal error codes remain in the Coordinator/D1 audit
path and are never surfaced to Android.

Staging is prepared from a protected structured resource manifest at
`infra/staging/`, never from checked-in IDs, bucket names, routes, or secret
values. The manifest supplies only exact isolated `-staging` resources and the
main `https://<worker>.<account>.workers.dev` origin; it rejects production,
private-like, lookalike, path-bearing, and trailing-dot targets. CI performs
synthetic render plus five explicit generated-config Wrangler dry-runs only.

Before any remote bootstrap, a protected Environment attestation must prove
both isolated main/Writing D1 backup identifiers, the exact additive migration
lists (main through `0011`, Writing through `0001`), and schema evidence hashes.
Its manifest SHA-256 is passed to every later deploy/health job, which rejects
TOCTOU changes; before any adapter deploy an independent protected
`STAGING_PUBLIC_BASE_URL` must exactly equal the manifest and an account-scoped
Cloudflare Workers subdomain response must prove its account label. Protected
deploy runs serialize globally and execute Writing, Review, Image, WeChat, then
main while synthetic CI does not block. The workflow does not apply remote
migrations. Approved deployment records the current adapter/main deployment
evidence, requiring exactly one active version at 100 percent, bootstraps the
private adapters, syncs only each job's required secrets, performs final
commit/ref/timestamp deploys, and asks main to aggregate non-provider `/health`
evidence from the four private service bindings. Main has no custom production
route but retains its isolated `workers.dev` staging entry with preview URLs
disabled; all V3 flags and allowlists stay off.

Mining readiness is an unscheduled, separate attestation after bounded
five-service health convergence: it checks exact staging config, the
unauthenticated handoff boundary, and two authenticated no-write probes for
`MINING_SERVICE_TOKEN` and `MINING_V3_HANDOFF_TOKEN` without creating a marker
or starting Mining. Actual Mining launch remains separately authorized. Once a
source has a V3 marker, stopping writes means clearing the main Worker tenant
flags/allowlists, not disabling the Mining client gate and allowing a legacy
revision.

The release progression is deliberately distinct: code complete, CI validated,
staging data prepared, staging deployed, Mining readiness attested, Mining
launched, and production released. Canary one exact tenant/account pair at a
time with both audio and text handoff paths, verify retries and unknown-side-
effect reconciliation, and stop WeChat at a draft. Rollback first clears main
tenant flags/allowlists, then reverts main and adapters; D1/DO data is
forward-fixed rather than dropped or down-migrated. Device verification requires
a reviewed source SHA matched to APK SHA/signing identity, explicit staging API
profile, production-endpoint negative assertion, five-service health/version
evidence, completed D1 data gate, and a synthetic staging account. The visual
staging canary pins the approved HTTPS/443 image endpoint to one deterministic
source/user/workspace/run scope, keeps WeChat disabled, and enforces an expiring
three-operation Image ledger before provider access. It restores empty provider
configuration afterward, while the adapter-side expiry closes the provider if
runner cleanup is interrupted; production remains separately gated on key
rotation and release approval.
