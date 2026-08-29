# Wave 2E Staging Configuration

`render-staging-config.mjs` accepts a protected
`vibepub-staging-resource-manifest.v1` JSON document and renders five complete
Wrangler target configurations for the main Worker, Writing, Review, Image, and
WeChat adapters. The checked-in fixture is synthetic and is valid only for
tests and `wrangler deploy --dry-run`.

Generated TOML is deliberately ignored. The renderer calculates every Worker
`main` path relative to the generated config directory, so a temporary CI
directory and a local ignored directory are equally valid.

```bash
node infra/staging/render-staging-config.mjs \
  --manifest infra/staging/fixtures/staging-resource-manifest.synthetic.json \
  --out-dir /tmp/vibepub-staging-config \
  --intent dry-run
```

The renderer rejects missing resources, non-`-staging` names, checked-in
production resource IDs/names, duplicate Worker/R2/Workflow identities,
inconsistent main/Writing/WeChat D1 relationships, custom main routes, enabled
V3 flags, populated allowlists, placeholders in deploy mode, and
credential-like manifest data. A real deployment manifest permits only
`https://<main-worker>.<account-subdomain>.workers.dev`: no production host,
path, credentials, port, trailing dot, localhost/private-like label, or
lookalike worker name is accepted. Only the protected `vibepub-staging` GitHub
Environment may provide a real `STAGING_RESOURCE_MANIFEST_JSON` for `--intent
deploy`. Before any adapter deployment, that manifest origin must exactly equal
the independent protected `STAGING_PUBLIC_BASE_URL`, and a read-only
account-scoped Cloudflare `workers/subdomain` response must exactly prove its
account label. The origin attestation receives no provider or internal service
tokens.

The manual workflow first requires a protected, exact attestation proving both
isolated staging D1 backups, the additive main `0001` through `0013` and
Writing `0001` migration lists, and schema-evidence hashes. Main evidence also
includes the strict `vibepub-main-d1-migration-rehearsal.v2` result described
below. It records the
approved manifest SHA-256 and serializes only protected deploy runs; every
later job rejects a changed manifest before a remote command. Writing, Review,
Image, WeChat, and main deploy strictly in that order. It never runs a remote
migration. `CLOUDFLARE_ACCOUNT_ID` is a non-secret protected Environment
value supplied to each deploy job for Wrangler's non-interactive account
selection, while credentials remain step-scoped. The workflow records the
currently active deployment/version evidence, requiring exactly one active
version at 100 percent after each deploy, bootstraps each private adapter
before syncing that adapter's own secrets, then performs the final
commit/ref/timestamp-stamped deploy. The main Worker has no custom production
route but intentionally has its isolated `workers.dev` staging entry with
`preview_urls=false`; the four adapters remain `workers_dev=false` and
`preview_urls=false`.

After main deployment, bounded health retries wait for
`GET /health?adapters=1` to show the main Worker and all four private service
bindings at the deployed commit, ref, and timestamp without provider work. The
final Mining job is only an exact unscheduled readiness attestation: it
cross-checks its staging origin and R2 bucket, confirms an unauthenticated
handoff `401`, and proves both internal tokens with authenticated no-write
probes (`invalid_claim_target` and a nonexistent handoff source). It never
starts Mining, creates a marker, or calls ASR. Actual Mining launch remains
separately authorized.

The protected image canary pins the provider to
`https://api.clawparty.cn/v1/images/generations` on HTTPS/443. It enables only
one exact staging source, user, workspace, and deterministic run for up to one
hour, keeps WeChat off, and caps the Image adapter at three distinct operations
and nine total attempts through a Durable Object ledger. It always restores the
flag-off main and empty-provider Image configurations; if the runner is
terminated before cleanup, both main and Image gates reject new work after the
same expiry. The retired HTTP exception is rejected even if its old variables
are injected. Production still requires separate approval and provider-key
rotation.

Neither synthetic rendering nor any Wrangler dry-run creates, changes, or
deploys a Cloudflare resource.

## Local Main D1 Migration Rehearsal

Run the Article Version migration rehearsal against an existing SQLite copy,
never a live D1 database:

```bash
node infra/staging/rehearse-main-d1-migrations.mjs \
  /path/to/main-before.sqlite \
  /path/to/main-migration-rehearsal.json
```

The CLI hashes and copies the source, then opens only its temporary copy for
writes. It reads `0012_article_feedback` and `0013_article_revisions` from the
candidate Git commit, applies them twice, hashes the migration bundle and
before/after schema contract, checks foreign keys, uniqueness and append-only
behavior, and proves old row values and counts are unchanged. It writes v2
evidence only after every check passes. The JSON contains fixed identifiers,
hashes, counts, and pass booleans; it contains no database path or row content.
A malformed or unsupported copy fails closed and leaves no output artifact.

`STAGING_DATA_PREPARED_EVIDENCE_JSON` uses
`vibepub-staging-data-evidence.v2`. Its main entry must include the complete
rehearsal JSON as `migration_rehearsal`, and `schema_evidence_hash` must equal
the rehearsal's `schema_evidence_sha256`. `backup_copy_sha256` must equal the
rehearsal's `source_sha256`; `backup_id` is the same content hash, so evidence
from different backup copies cannot be combined. The protected dispatch literal is
`staging_d1_backup_and_article_version_migrations_verified_v2`.

## Article Feedback Loop Evidence

After both isolated APKs finish the Staging journeys, validate the redacted
evidence before sharing it:

```bash
node infra/staging/validate-article-feedback-loop-evidence.mjs \
  /path/to/protected-staging-resource-manifest.json \
  /path/to/redacted-article-feedback-evidence.json \
  <candidate-commit-sha>
```

The validator binds the expected candidate commit and exact protected manifest origin. Account,
D1, and R2 fingerprints are SHA-256 hashes of `account:<workers-subdomain>`,
`main_d1:<database-id>`, `writing_d1:<database-id>`, `audio_r2:<bucket-name>`,
and `image_r2:<bucket-name>`. It requires one candidate commit,
hashed APK/device/resource identities, five completed Agents and one frozen
article, v1-to-v2 lineage, adopted and not-adopted journeys, retry and stale
request checks, old-client compatibility, and WeChat-only recovery. Fixed
aliases replace real trace IDs. Unknown fields and private data fail closed.
The accepted summary contains only pass counts and booleans.
