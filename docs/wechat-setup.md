# WeChat Official Account Setup

## Goal

Enable VibePub to create WeChat Official Account draft articles after audio has been transcribed and mined into article JSON.

## Browser-Assisted Checklist

Open the WeChat Official Account Platform:

```text
https://mp.weixin.qq.com/
```

Collect or configure:

- Official Account name and type
- `WECHAT_APP_ID`
- `WECHAT_APP_SECRET`
- API IP whitelist
- confirmation that draft/article APIs are available for the account
- a fixed egress endpoint for server-side WeChat API calls, stored as `WECHAT_PROXY`

## Why a Proxy Is Needed

The WeChat Official Account API commonly checks calls against an IP whitelist. GitHub Actions and Cloudflare Workers do not provide a stable outbound IP suitable for that whitelist. Use a small VPS or proxy service with a fixed public IP, then whitelist that IP in the WeChat dashboard.

Recommended MVP:

- deploy the publishing caller on a small fixed-IP VPS, or
- run a thin `WECHAT_PROXY` service on the VPS that forwards only the required WeChat API calls

Do not put the WeChat AppSecret into the Android app.

## Secret Names

Use these names consistently:

- `WECHAT_APP_ID`
- `WECHAT_APP_SECRET`
- `WECHAT_PROXY`

## Required User Actions

These steps require the account owner or admin:

1. Log in to `mp.weixin.qq.com`.
2. Open the development/basic configuration page.
3. Copy AppID.
4. Generate or copy AppSecret.
5. Add the fixed proxy/VPS public IP to the IP whitelist.
6. Confirm the draft publishing API is available.

When a page asks to scan a QR code, enter a 2FA code, regenerate AppSecret, or change IP whitelist, the browser automation should pause and wait for the account owner.
