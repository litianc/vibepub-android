# Image Generation Adapter

This Worker is the only component allowed to hold `GPT_IMAGE_API_KEY`. The
main Worker calls it only through the `IMAGE_GENERATION_ADAPTER` service
binding with `VISUAL_PRODUCTION_TOKEN`; the token is a Wrangler secret, never
a var. The adapter also uses the private `VISUAL_RESULTS_BUCKET` for
append-only operation intents and results, and the required `VISUAL_OPERATION`
Durable Object for the per-operation/attempt transaction claim. Without that
binding the adapter returns `service_unconfigured` before provider access.

`IMAGE_PROVIDER_URL` and `IMAGE_PROVIDER_HOST` are deployment configuration,
not request input. The URL must be a fixed HTTPS URL on port 443 whose host
exactly equals `IMAGE_PROVIDER_HOST`, with no credentials, query, or fragment
and the exact `/v1/images/generations` path. They are checked in empty until
deployment has an approved TLS front. The current HTTP gateway is a
production blocker and is rejected before any provider call. Production also
requires rotation of the previously exposed provider key before this adapter
is enabled. There is no main Worker URL fallback.

Each operation requires a stable `operation_id` and attempt `1..3`. An intent
is written before the provider call; a success or known failure is written and
read back before response. Same operation/attempt replays the stored result,
an intent without an outcome is reconciliation-required, and a later attempt
is allowed only after a durable retryable failure. No provider response body
or credential is logged.

The main Worker may send `reconcile_only=true` while recovering an inflight
operation. That path only reads the operation's immutable R2 result and
returns the stored result through the normal response; its result
reference/hash evidence remains inside the adapter-owned Durable Object and
is not exposed as a separate response field. It does not create an intent,
claim an attempt, or call the provider. If the result cannot be proved, it
returns `external_side_effect_unknown` and remains on hold.

Wave 2E renders this adapter only as a private staging target
(`workers_dev=false`, `preview_urls=false`). Synthetic CI and a Wrangler
dry-run do not deploy it or contact the image provider. An approved staging
bootstrap precedes secret synchronization and a final explicit-config deploy;
`GET /health` exposes only service plus non-secret commit/ref/timestamp
evidence.
