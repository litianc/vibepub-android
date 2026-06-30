# VibePub Android Experience Progress - 2026-06-30

记录时间：2026-06-30 17:14 CST  
分支：`codex/android-experience-v1`  
当前已推送提交：`94b2291 Persist recording duration in the Worker contract`

## 已验证

### Android 最新 APK 渠道
- GitHub Release：`build-20260630-084824-ae943af`
- APK：<https://github.com/litianc/vibepub-android/releases/download/build-20260630-084824-ae943af/app-debug.apk>
- SHA-256：`83dd84ab3a74f0f856baff02a0e6178370e5f0d19cd0356650ca95703d4bd7d2`
- Manifest 已指向该 Release：`artifacts/MANIFEST.md`
- Android Tests：GitHub Actions run `28431850416` 成功
- Android Build & Release：GitHub Actions run `28431850259` 成功

### Android 端已落地能力
- 录音/首页/详情页已有体验优先版主干：
  - 首页真实工作台、状态、进度、失败重试、删除、本地/云端同步提示。
  - 详情页 Media3 本地播放、进度条、seek、标题/正文/原始识别展示。
  - 复制标题、复制正文、系统分享、导出材料包。
  - 状态提示 icon 可打开完整流程说明：保存录音 → 上传音频 → 云端排队 → 语音识别 → 文章改写 → 公众号草稿 → 人工发布确认。
  - 状态模型覆盖 `LOCAL_RECORDED`、`UPLOADING`、`UPLOADED`、`PROCESSING`、`COMPLETED`、`FAILED`。
- placeholder 草稿引用修复已验证并发布到 APK：
  - Android 提交：`ae943af Keep draft readiness from trusting placeholder values`
  - `"null"` / `"undefined"` 不再让详情/导出/诊断误判公众号草稿已就绪。

### Worker/API 契约
- placeholder 草稿引用在 Worker 层已过滤：
  - 提交：`030dcef Stop worker from publishing placeholder draft refs`
  - Worker validate：GitHub Actions run `28432662949` 成功
  - 未部署生产，只做 validate-only。
- `duration_ms` 已进入 Worker D1 契约：
  - 提交：`94b2291 Persist recording duration in the Worker contract`
  - 新增迁移：`infra/worker/migrations/0004_recording_duration_ms.sql`
  - `/api/uploads` 会从 VibePub 文件名解析时长并写入 D1。
  - `/api/recordings` 会读取 `duration_ms`，并兼容只有 `processing_stage` 或更旧 schema 的 D1。
  - 本地验证：`npm run typecheck`、`npm test`、`git diff --check` 均通过。
  - Worker validate：GitHub Actions run `28433259609` 成功
  - 未部署生产，只做 validate-only。

### 真机/ADB
- 当前红米平板 ADB 在线：
  - `10.161.2.96:43355`
  - 状态：`device`
- 当前 APK 先前已可安装并启动；后续真机自动化仍以这台设备为目标。

## 待验证

### Android 未验证 WIP
- 当前工作区有两个未提交 Android 小改动：
  - `android/app/src/main/java/cn/litianc/vibepub/ui/screens/HomeScreen.kt`
  - `android/app/src/test/java/cn/litianc/vibepub/ui/screens/HomeScreenTest.kt`
- 目的：让首页重点进度卡也复用 placeholder 草稿引用过滤，避免 `"null"` / `"undefined"` 被当成草稿已就绪。
- 状态：未提交、未验证。
- 阻塞原因：本机当前没有可用 Android SDK 配置；`gradle :app:testDebugUnitTest ...` 因缺少 `ANDROID_HOME` / `android/local.properties` 失败。
- 建议：下一轮先恢复 Android SDK 路径，再跑 `HomeScreenTest` 和完整 `:app:testDebugUnitTest`；通过后再提交。

### 生产环境待验证
- Worker `duration_ms` 迁移尚未部署到生产 D1。
- 需要在明确部署窗口执行 Worker deploy/migration 后验证：
  - `/api/recordings` 返回 `duration_ms`。
  - 新上传录音在 D1 中有稳定时长。
  - Android 首页与详情页时长显示不依赖文件名兜底。

### 真机端到端待验证
- 需要使用准备好的音频 `/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3` 跑完整流程：
  - 一次录音只生成一条非零秒记录。
  - 首页状态从上传/处理中推进到完成。
  - 详情页显示标题、正文、时长，且正文无 raw HTML 标签。
  - 播放按钮可播放本地录音，进度变化。
  - 复制/分享/导出入口可点击。
  - Token 错误时显示配置错误和可恢复路径。

### 产品体验待完善
- 继续按体验优先版计划推进：
  - 后端/Worker 生产部署后补真实进度字段验证。
  - 设置页诊断信息与连接测试继续作为 dogfood 基础设施检查点。
  - 自动化测试产物需要稳定保存截图、UI dump、logcat、audit 结果。

## 当前注意事项
- 不要把当前未提交 Android WIP 当作已完成能力。
- 目前最新可安装 APK 仍是 `ae943af` 对应 Release。
- `artifacts/` 下存在多批历史安装/CI 调试产物，当前记录未整理或删除它们。
