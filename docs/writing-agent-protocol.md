# WritingAgent Rewrite Protocol v1

WritingAgent 是独立于 VibePub 的文章改写平台。VibePub 负责录音、ASR、状态追踪、公众号草稿创建和 App 展示；WritingAgent 负责根据用户选择的写作风格画像和公众号排版要求，把原始文字改写成公众号文章包。

## 设计目标

- VibePub 不再硬编码写作风格和公众号排版要求，只传入 `style_profile_id` 和 `layout_profile_id`。
- WritingAgent 管理用户可配置、可版本化的写作风格画像和排版模板。
- 两个系统可以共用身份体系；服务间调用使用 bearer token，用户级权限由 token 中的 `user_id/workspace_id/scope` 或上游网关保证。
- 协议先支持同步返回 `article_ready`，后续可无破坏扩展为异步 job + webhook。

## 身份验证

所有 `/v1/*` 接口都要求认证：

```http
Authorization: Bearer <service-or-user-token>
```

推荐 scope：

```text
rewrite.jobs:create
rewrite.jobs:read
rewrite.profiles:read
```

Webhook 回调后续增加时，需要 `X-WritingAgent-Signature` 和 `X-WritingAgent-Timestamp`。

## Profile 接口

### `GET /v1/style-profiles`

返回当前用户或 workspace 可用的写作风格画像列表。

```json
{
  "style_profiles": [
    {
      "id": "style_litianc_default",
      "name": "litianc 默认写作风格",
      "version": "2026-07-05",
      "description": "真实、理性、结构化、有个人判断但不浮夸。"
    }
  ]
}
```

### `GET /v1/layout-profiles`

返回可用的公众号排版模板列表。

```json
{
  "layout_profiles": [
    {
      "id": "wechat_clean_article",
      "name": "微信公众号克制长文排版",
      "version": "2026-07-05",
      "description": "使用微信兼容 HTML 片段、短段落、小标题和必要表格。"
    }
  ]
}
```

## 创建改写任务

### `POST /v1/rewrite-jobs`

请求：

```json
{
  "protocol_version": "vibepub.rewrite.v1",
  "client_job_id": "VibePub-2026-07-05-010101-Text-abcd1234.txt",
  "idempotency_key": "VibePub-2026-07-05-010101-Text-abcd1234.txt",
  "user": {
    "user_id": "default_user",
    "workspace_id": "vibepub-dogfood"
  },
  "input": {
    "source_type": "audio_transcript",
    "raw_text": "这是 ASR 或用户输入得到的原始文字。",
    "title_hint": "可选标题提示",
    "language": "zh-CN"
  },
  "profiles": {
    "style_profile_id": "style_litianc_default",
    "style_profile_version": "2026-07-05",
    "layout_profile_id": "wechat_clean_article",
    "layout_profile_version": "2026-07-05"
  },
  "output_contract": {
    "format": "wechat_article_package",
    "content_format": "html_fragment",
    "require_cover_fields": true
  }
}
```

成功响应：

```json
{
  "protocol_version": "vibepub.rewrite.v1",
  "job_id": "rw_01abcdef",
  "status": "article_ready",
  "result": {
    "title": "文章标题",
    "content_html": "<section><p>公众号正文 HTML 片段</p></section>",
    "summary": "可选摘要",
    "cover": {
      "cover_title": ["第一行", "第二行"],
      "cover_subtitle": "可选副标题",
      "image_prompt": "English image prompt, no text, no logo"
    },
    "warnings": []
  },
  "profile_versions": {
    "style_profile_id": "style_litianc_default",
    "style_profile_version": "2026-07-05",
    "layout_profile_id": "wechat_clean_article",
    "layout_profile_version": "2026-07-05"
  }
}
```

失败响应：

```json
{
  "error": {
    "code": "invalid_profile",
    "message": "写作风格画像不存在或没有权限"
  }
}
```

## 状态枚举

WritingAgent 对外状态：

```text
accepted
queued
rewriting
article_ready
failed
cancelled
```

VibePub mining 当前 MVP 使用同步 `article_ready`；如果后续切到异步模式，VibePub 将 `accepted/queued/rewriting` 映射到 `REWRITING`，将 `article_ready` 映射到 `ARTICLE_READY`。

## VibePub 接入环境变量

`infra/mining` 通过以下环境变量接入 WritingAgent：

```text
WRITING_AGENT_BASE_URL
WRITING_AGENT_TOKEN
WRITING_AGENT_STYLE_PROFILE_ID
WRITING_AGENT_STYLE_PROFILE_VERSION
WRITING_AGENT_LAYOUT_PROFILE_ID
WRITING_AGENT_LAYOUT_PROFILE_VERSION
```

如果 `WRITING_AGENT_BASE_URL` 未配置，VibePub 保留原来的内置 GLM 改写路径作为 fallback。
