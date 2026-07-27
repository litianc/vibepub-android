# WeChat Publishing Adapter

This private Worker is callable only through the main Worker service binding. It accepts the dedicated `WECHAT_PUBLISHING_TOKEN`, decrypts the local `publishing_accounts` credential, and retains provider intent/result evidence in its private R2 bucket and Durable Object.

Required secrets are `WECHAT_PUBLISHING_TOKEN` and `CREDENTIAL_ENCRYPTION_KEY`. `WECHAT_DRAFT_SYNC_V3` defaults to `false`; its owner allowlist, the account-binding allowlist, `WECHAT_PROVIDER_BASE_URL_ALLOWLIST`, and `WECHAT_MEDIA_URL_HOST_ALLOWLIST` must all be configured before an operation can select a Durable Object. The provider allowlist is an exact normalized HTTPS/443 origin-plus-base-path list; the media allowlist is an exact HTTPS/443 host list for WeChat-returned images. Account `proxy_url` values that differ by host, base path, credentials, query, fragment, localhost, or private-like alias are rejected before decryption, intent, R2, or provider access. The currently supplied HTTP gateway remains a production blocker until it is fronted by TLS and the account secret is rotated.

Wave 2E renders this adapter as a private staging target only
(`workers_dev=false`, `preview_urls=false`). Synthetic validation and Wrangler
dry-runs never contact WeChat or deploy a Worker. An approved protected
Environment bootstrap and final explicit-config deployment set secrets only in
the platform secret store; `GET /health` exposes service and non-secret
commit/ref/timestamp evidence.
