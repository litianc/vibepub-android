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
isolated staging D1 backups, the additive main `0001` through `0011` and
Writing `0001` migration lists, and schema-evidence hashes. It records the
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

The currently supplied image gateway is HTTP and therefore cannot satisfy the
Image adapter's HTTPS/443 provider contract. Full visual staging canary remains
externally blocked until a TLS front is available and the corresponding provider
key is rotated.

Neither synthetic rendering nor any Wrangler dry-run creates, changes, or
deploys a Cloudflare resource.
