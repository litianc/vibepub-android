# VibePub Android Experience Progress - 2026-06-30

记录时间：2026-06-30 19:19 CST
分支：`codex/android-experience-v1`  
本次记录基线提交：`c70bb25 Document the remaining Worker dispatch secret`

## 已验证

### Android 最新 APK 渠道
- GitHub Release：`build-20260630-092807-1054cc1`
- APK：<https://github.com/litianc/vibepub-android/releases/download/build-20260630-092807-1054cc1/app-debug.apk>
- SHA-256：`ac0082bb489ae2cc5c29fdcf765bb43848918c424e3adc983539148e673d7d94`
- Manifest 已指向该 Release：`artifacts/MANIFEST.md`
- Android Tests：GitHub Actions run `28433787330` 成功
- Android Build & Release：GitHub Actions run `28434107458` 成功

### Android 端已落地能力
- 录音/首页/详情页已有体验优先版主干：
  - 首页真实工作台、状态、进度、失败重试、删除、本地/云端同步提示。
  - 详情页 Media3 本地播放、进度条、seek、标题/正文/原始识别展示。
  - 复制标题、复制正文、系统分享、导出材料包。
  - 状态提示 icon 可打开完整流程说明：保存录音 → 上传音频 → 云端排队 → 语音识别 → 文章改写 → 公众号草稿 → 人工发布确认。
  - 详情页“公众号草稿审核”现在显示短阶段结果：`草稿已就绪`、`文章可用 · 草稿待同步`、`文章可用 · 草稿需处理`、`生成中 · 未到发布检查`、`结果不完整 · 建议刷新`。
  - 设置页配置中心可直接看到最近一次云端同步状态；未同步时显示 `尚未同步`，已同步时显示具体时间。
  - 重试上传时会根据真实排队结果反馈：只有实际进入 WorkManager 上传队列才显示 `已重新加入上传队列`；缺少 `FILES_TOKEN` 时提示先配置后重试。
  - 录音停止保存失败时不再停留在“仍在录音”的假状态；会回到首页并提示重新开始录音。
  - 首页同步提示会优先识别本机待上传录音，提示先上传/检查 `FILES_TOKEN`，而不是让用户误以为同步能解决上传前问题。
  - 设置页诊断信息会列出最近录音摘要，包含文件名、时长、状态、阶段和错误，方便排查同一时间多条记录或零秒录音。
  - 设置页诊断弹窗支持长内容滚动，并保留一键复制，避免最近录音摘要变长后在真机上看不到底部错误信息。
  - 状态模型覆盖 `LOCAL_RECORDED`、`UPLOADING`、`UPLOADED`、`PROCESSING`、`COMPLETED`、`FAILED`。
- placeholder 草稿引用修复已验证并发布到 APK：
  - Android 提交：`ae943af Keep draft readiness from trusting placeholder values`
  - `"null"` / `"undefined"` 不再让详情/导出/诊断误判公众号草稿已就绪。
- 首页重点进度卡也已复用 placeholder 草稿引用过滤：
  - Android 提交：`ec43c84 Keep home focus from trusting placeholder draft refs`
  - 新增 `HomeScreenTest` 回归用例，避免 `"null"` / `"undefined"` 把未完成草稿误判成已就绪。
  - Android Tests：GitHub Actions run `28433787330` 成功。

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
  - 生产 D1 已应用 `0004_recording_duration_ms.sql`，`npx wrangler d1 migrations list vibepub-db --remote` 显示无待应用迁移。
  - 生产 Worker 已部署，当前版本 ID：`8e4bf574-827e-49dc-be7b-f1027c086fe0`。
  - 生产验证：`GET https://vibepub.litianc.cn/health` 返回 `ok: true`；授权 `GET /api/recordings` 返回 30 条记录，字段包含 `duration_ms`，第一条 `duration_ms` 为 number。
- Worker 上传后会把刚上传的文件名传给 GitHub Actions mining workflow：
  - `/api/uploads` 触发 `mining-job.yml` 时带上 `inputs.target_filename`。
  - mining workflow 已支持 `TARGET_FILENAME`，因此后台可以优先点名处理本次录音，减少等待定时扫描和处理整个 inbox 的延迟。
  - 本地验证：`infra/worker` 下 `npm test`、`npm run typecheck` 均通过。
  - GitHub Actions secret 已配置为 `WORKFLOW_DISPATCH_PAT`；Cloudflare Worker secret 已配置为 `GITHUB_PAT`。
  - 生产 Worker 当前 `GITHUB_WORKFLOW_REF` 指向 `codex/android-experience-v1`，因为该分支的 `mining-job.yml` 已支持 `target_filename`；合入 main 后应切回 `main`。
  - 生产验证：上传 `VibePub-20260630111621-0m0s-Codex-Dispatch-Smoke.m4a` 后触发 GitHub Actions run `28440265834`，事件为 `workflow_dispatch`，分支为 `codex/android-experience-v1`，日志显示 `TARGET_FILENAME` 与目标文件名匹配。
  - 该 smoke 文件因无效音频被 mining job 从 R2 清理；D1 测试记录已手动删除，授权 `/api/recordings` 复查 `smoke_record_count=0`。
- mining job 现在会在文章生成并保存后先回写 `ARTICLE_READY`：
  - App 可以先显示“文章已生成，可以阅读/复制/分享”，再等待微信公众号草稿阶段。
  - 封面生成或草稿发布失败时，会保留已生成文章并以 `DRAFT_FAILED` 回写，而不是把整条录音标记为不可用失败。

### 真机/ADB
- 当前 ADB 检查无设备在线：
  - 命令：`/opt/homebrew/share/android-commandlinetools/platform-tools/adb devices -l`
  - 输出：`List of devices attached` 后无设备。
  - 下一次真机验证需要重新连接 USB 或重新打开无线调试配对/连接。
- 当前最新 APK 已安装并启动：
  - 安装证据：`artifacts/android-install/20260630-1054cc1/install/summary.md`
  - readiness：`artifacts/android-install/20260630-1054cc1/install/readiness/readiness.md`
  - 包版本：`versionName=0.1.0-debug`，`versionCode=1`
  - 签名摘要：`18a43bae`
  - 设备进程：`cn.litianc.vibepub` 已运行。

## 待验证

### 本机 Android 测试环境
- 本地开发闭环全景图：`artifacts/android-local-build-flow-2026-06-30.html`
  - 记录从“等 GitHub Release APK”改为“本地测试/打包/ADB 安装/真机验证”的流程。
  - 同步记录 Cloudflare Worker 上传后携带 `target_filename` 触发 GitHub Actions mining job 的后端链路。
  - 该 HTML 是当前可视化主交付；旧 PNG 快照不再作为最新证据。
- `android-commandlinetools` 已安装到 `/opt/homebrew/share/android-commandlinetools`。
- Android SDK 包已安装：
  - `platforms;android-36`
  - `build-tools;36.0.0`
  - `platform-tools;37.0.0`
- JDK 21 已安装到 `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`。
- 本地配置已写入被 git 忽略的 `android/local.properties`。
- 新增本地构建脚本：`scripts/build-android-local.sh`
- 新增本地构建并安装脚本：`scripts/install-android-local-apk.sh`
- `scripts/build-android-local.sh` 已加固为默认强制 JDK 21；如需覆盖必须用 `ANDROID_LOCAL_JAVA_HOME`，避免外层 `JAVA_HOME` 指向 JDK 26 时触发 Robolectric class parsing 失败。
- 本地验证已通过：
  - `scripts/build-android-local.sh test` 等价环境下，`gradle -p android :app:testDebugUnitTest` 成功，热启动后约 37 秒。
  - `gradle -p android :app:assembleDebug` 成功，首次本地打包约 1 分 22 秒。
  - `scripts/build-android-local.sh assemble` 成功，增量约 16 秒。
  - `scripts/install-android-local-apk.sh --help` 和 shell 语法检查通过。
  - 本轮详情页阶段结果改动后，`DetailScreenTest`、`RecordingPresentationTest` 和 `scripts/build-android-local.sh test` 均通过；全量 Android 单测约 33 秒。
  - 本轮设置页最近同步状态改动后，`SettingsScreenTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble` 均通过。
  - 本轮重试上传反馈改动后，`RecordingFilesTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble` 均通过。
  - 本轮录音停止失败恢复改动后，`RecordingFilesTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble` 均通过。
  - 本轮首页本机待上传恢复提示改动后，`HomeScreenTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble`、`git diff --check` 均通过。
  - 本轮诊断最近录音摘要改动后，`SettingsScreenTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble`、`git diff --check` 均通过。
  - 本轮诊断弹窗滚动改动后，`SettingsScreenTest`、`SettingsDiagnosticsDialogTest`、`git diff --check` 均通过。
  - 本轮真机自动化脚本改动后，`scripts/android-device-visual-test.sh` 默认等待 Worker 自动创建的 `workflow_dispatch` run；acceptance 和 audit 都会校验 `mining-run.log` 引用了本次录音文件名。`bash -n`、脚本 `--help`、`git diff --check` 均通过。
  - 本轮 mining 进度回写改动后，`infra/mining` 下 `npm test`、`npm exec tsc -- --noEmit`、`git diff --check` 均通过。
- GitHub Actions Android Tests 可用并已通过。
- 注意：本地单测必须使用 JDK 21；JDK 26 会导致 Robolectric 4.12 shadow class 解析失败。

### 生产环境待验证
- 需要下一次真机/上传流程验证：
  - 新上传录音在 D1 中写入稳定 `duration_ms`。
  - 真机上传新录音后 GitHub Actions mining run 接收到对应 `target_filename`，而不是只等待 10 分钟定时扫描。
  - Android 首页与详情页时长显示不依赖文件名兜底。
  - `target_filename` 支持合入 `main` 后，将 Worker `GITHUB_WORKFLOW_REF` 切回 `main` 并重新部署。

### 真机端到端待验证
- 需要使用准备好的音频 `/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3` 跑完整流程：
  - 一次录音只生成一条非零秒记录。
  - 首页状态从上传/处理中推进到完成。
  - 详情页显示标题、正文、时长，且正文无 raw HTML 标签。
  - 播放按钮可播放本地录音，进度变化。
  - 复制/分享/导出入口可点击。
  - Token 错误时显示配置错误和可恢复路径。
- 本地 APK 已生成：`android/app/build/outputs/apk/debug/app-debug.apk`
  - 当前本地 APK SHA-256：`54204f02b75e56858b509bcd9c9dd2598d6a2e805c332a1631f202229946c4a6`
- 待恢复 ADB 后安装本地 APK：当前 `adb devices -l` 无设备在线，需要重新连接 USB，或重新打开平板无线调试页面获取新端口。
- ADB 恢复后可直接运行：
  - `scripts/install-android-local-apk.sh --serial <new-adb-serial> --skip-build`
  - 或 `scripts/install-android-local-apk.sh --serial <new-adb-serial> --test`
  - 完整 dogfood E2E：`scripts/run-android-device-smoke.sh android/app/build/outputs/apk/debug/app-debug.apk`

### 产品体验待完善
- 继续按体验优先版计划推进：
  - mining `ARTICLE_READY` 进度回写需要随分支进入生产 workflow 后，用真机新录音验证首页/详情是否先显示“文章已生成”再进入草稿阶段。
  - 设置页诊断信息与连接测试继续作为 dogfood 基础设施检查点。
  - 自动化测试产物需要稳定保存截图、UI dump、logcat、audit 结果。

## 当前注意事项
- 目前最新可安装 APK 是 `1054cc1` 对应 Release。
- `artifacts/` 下存在多批历史安装/CI 调试产物，当前记录未整理或删除它们。
