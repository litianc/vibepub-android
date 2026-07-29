# WeChat Publishing Adapter

This private Worker is callable only through the main Worker service binding. It accepts the dedicated `WECHAT_PUBLISHING_TOKEN`, resolves the owner-scoped `publishing_accounts` credential, and retains provider intent/result evidence in its private R2 bucket and Durable Object.

Production uses `PUBLISHING_ACCOUNT_RESOLVER_TOKEN` to request the decrypted credential from the main Worker without copying `CREDENTIAL_ENCRYPTION_KEY` into this service. Direct D1 decryption remains available for isolated environments and requires `CREDENTIAL_ENCRYPTION_KEY`. `WECHAT_DRAFT_SYNC_V3` defaults to `false`; an explicit `V3_TENANT_SCOPE=all` is the only configuration that bypasses tenant and account-binding lists. The provider allowlist remains an exact normalized HTTPS/443 origin-plus-base-path list, and the media allowlist remains an exact HTTPS/443 host list for WeChat-returned images. Account `proxy_url` values that differ by host, base path, credentials, query, fragment, localhost, or private-like alias are rejected before credential resolution, intent, R2, or provider access.

Wave 2E renders this adapter as a private staging target only
(`workers_dev=false`, `preview_urls=false`). Synthetic validation and Wrangler
dry-runs never contact WeChat or deploy a Worker. An approved protected
Environment bootstrap and final explicit-config deployment set secrets only in
the platform secret store; `GET /health` exposes service and non-secret
commit/ref/timestamp evidence.
