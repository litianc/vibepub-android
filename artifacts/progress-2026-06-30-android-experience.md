# VibePub Android Experience Progress - 2026-06-30

记录时间：2026-06-30 21:50 CST
分支：`codex/android-experience-v1`  
本次记录基线提交：`8f43de6 Make workflow stalls visible in the Android app`

## 已验证

### Android 最新 APK 渠道
- GitHub Release：`build-20260630-132053-8f43de6`
- APK：<https://github.com/litianc/vibepub-android/releases/download/build-20260630-132053-8f43de6/app-debug.apk>
- SHA-256：`3d73eee55cb6626cace70d04f3a3e32766d70ca48edb5e38ca9d84ec8bcf4610`
- Release Commit：`8f43de6254190be2294a93753ed26a42c4cf53e1`
- Manifest 已指向该 Release：`artifacts/MANIFEST.md`
- Android Tests：GitHub Actions run `28447258290` 成功
- Android Build & Release：GitHub Actions run `28447258407` 成功

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
  - Android 同步 `/api/recordings` 时会把 `ARTICLE_READY`、`DRAFT_FAILED` 等远端阶段稳定映射进本地 Room 字段，避免端上看不到文章已生成/草稿失败的中间态。
  - 首页/详情页活跃录音的自动同步请求会替换旧的 one-time sync work，避免旧请求卡住时新的进度刷新被 WorkManager `KEEP` 吞掉。
  - 首页重点卡、列表卡、详情状态卡和状态说明弹窗现在共用 `workflowAttention`，对本机待上传、失败、文章已可用、草稿待同步、草稿失败和长时间无进展状态显示一致的“需要关注”提示。
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
- 红米真机已恢复为可自动化测试状态：
  - 指定 serial：`10.161.2.96:45117`
  - 设备型号：`25079RPDCC`
  - readiness：`artifacts/android-device-readiness/20260630-android-provided-single/readiness.md` 通过。
- 真机端到端 smoke 已通过：
  - 证据目录：`artifacts/android-device-visual/20260630-android-provided-smoke-rerun`
  - 测试音频：`/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3`
  - APK：`android/app/build/outputs/apk/debug/app-debug.apk`
  - 录音文件：`VibePub-2026-06-30-214139-0m30s-Debug-Audio-Import.mp3`
  - GitHub Actions mining run：`28448860756` 成功。
  - 后端状态：`COMPLETED`，`processing_stage=COMPLETED`，有 `article_title` 和 `wechat_draft_id`。
  - App 验收：`Transcript detail assertion: completed`，`Acceptance assertion: passed`。
  - audit：`scripts/audit-android-device-smoke.sh artifacts/android-device-visual/20260630-android-provided-smoke-rerun` 通过。
- 真机验证覆盖：
  - debug import 只创建一条非零录音。
  - 本地 Room 对同 filename 只有一条非零 `COMPLETED` 记录。
  - 后端 `/api/recordings` 返回完成态和文章元数据。
  - mining 日志引用本次目标 filename。
  - 详情页显示标题、原始识别、正文、时长 `0:30`、公众号草稿审核、状态说明入口。
  - 详情页正文无 raw HTML 标签。
  - 播放、复制正文、分享正文、导出材料包、打开公众号草稿动作均通过自动化断言。
- 本轮发现并修复了真机自动化脚本的竞态误判：
  - 现象：Worker 触发 mining 太快，脚本在上传记录出现后才读取 `previous_run_id`，会把本次 run 误当作旧 run，报 `Could not find a Worker-dispatched mining workflow run`。
  - 修复：`scripts/android-device-visual-test.sh` 会按当前 workflow ref 扫描最近的 `workflow_dispatch` runs，并用目标 filename 命中 mining 日志来确认本次 run。
- 用户手动刷新证据：
  - 证据目录：`artifacts/android-device-visual/20260630-manual-refresh-evidence`
  - 手动刷新后详情页显示 `草稿已就绪`、`第 7/7 步`、标题和公众号草稿审核。

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
  - 本轮 Android 同步映射改动后，`SyncWorkerTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble`、`git diff --check` 均通过。
  - 本轮活跃进度同步调度改动后，`RecordingFilesTest`、`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble`、`git diff --check` 均通过。
  - 本轮 ADB readiness 自动连接诊断改动后，`bash -n scripts/check-android-device-ready.sh scripts/install-latest-android-apk.sh scripts/run-android-device-smoke.sh`、`CHECK_APK_INSTALL=false scripts/check-android-device-ready.sh`、`RecordingFilesTest`、`scripts/build-android-local.sh test`、`git diff --check` 均通过；preflight 正确记录当前无线调试端口 `Connection refused`。
  - 本轮体验版完成度审计脚本 `scripts/audit-android-experience-readiness.sh` 已新增；它会检查需求文档、Android 状态/Room/UI/设置证据、Worker/mining 字段、Release manifest、真机 smoke 脚本，并把当前无 ADB 的真机门禁标为 `[~]`。本地运行结果：自动源代码/测试/发布失败数 `0`，设备门禁项 `2`，报告见 `artifacts/android-experience-readiness/latest/readiness.md`。
  - 本轮 DAO 写入保护改动后，`RecordingDao.upsertBest` 会在同 filename 新记录竞争时保留更高质量记录，避免 0 秒或更差状态覆盖已有非零/已完成记录；显式携带已有 id 的状态更新仍可正常更新。`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble`、`scripts/audit-android-experience-readiness.sh`、`git diff --check` 均通过。
  - 本轮流程关注提示改动后，`RecordingPresentationTest` 覆盖可行动状态和长时间无进展提示，`WorkflowHelpDialogTest` 覆盖列表/详情/弹窗可见性；`scripts/build-android-local.sh` 已支持透传 `--tests`，避免定向测试误跑全量。`scripts/build-android-local.sh test`、`scripts/build-android-local.sh assemble`、`scripts/audit-android-experience-readiness.sh`、`git diff --check` 均通过。
  - 本轮真机自动化 run 识别竞态修复后，`bash -n scripts/android-device-visual-test.sh scripts/run-android-device-smoke.sh scripts/audit-android-device-smoke.sh scripts/audit-android-experience-readiness.sh`、目标 run 日志搜索验证、真机 smoke rerun、`scripts/audit-android-device-smoke.sh`、`git diff --check` 均通过。
- GitHub Actions Android Tests 可用并已通过。
- 最新 GitHub Actions Android Tests run `28447258290` 已覆盖提交 `8f43de6` 并成功。
- 最新 GitHub Actions Android Build & Release run `28447258407` 已覆盖提交 `8f43de6` 并成功创建 Release `build-20260630-132053-8f43de6`。
- GitHub Actions `mining-tests.yml` 文件目前不在默认分支，GitHub API 暂不能直接对该 workflow 发起 `workflow_dispatch`；本轮 mining 改动已用本地 `infra/mining` 测试和 typecheck 验证，后续合入默认分支后再补云端 mining-tests。
- 注意：本地单测必须使用 JDK 21；JDK 26 会导致 Robolectric 4.12 shadow class 解析失败。

### 生产环境待验证
- 已用真机新录音验证：
  - 新上传录音在 D1 中写入稳定 `duration_ms=30000`。
  - 真机上传新录音后 GitHub Actions mining run 接收到对应 `target_filename`，而不是只等待 10 分钟定时扫描。
  - Android 详情页时长显示 `0:30`。
- 仍待后续处理：
  - `target_filename` 支持合入 `main` 后，将 Worker `GITHUB_WORKFLOW_REF` 切回 `main` 并重新部署。

### 真机端到端待验证
- 已用准备好的音频 `/Users/xyli/Documents/Code/revoice-project/.data/test_clips/speaker_boundary_18_48s.mp3` 跑通完整流程：
  - 一次录音只生成一条非零秒记录。
  - 首页状态从上传推进到完成，详情页显示 7/7 草稿就绪。
  - 详情页显示标题、正文、时长，且正文无 raw HTML 标签。
  - 播放按钮可播放本地录音，进度变化。
  - 复制/分享/导出入口可点击。
- 仍待覆盖：
  - Token 错误时显示配置错误和可恢复路径。
- 本地 APK 已生成：`android/app/build/outputs/apk/debug/app-debug.apk`
  - 当前本地 APK SHA-256：`4a5890221e4ddd36bf0a24598ba2a89d2e9a59f6519af3c0abc1a14117f0382b`
- ADB 当前可用时可直接运行：
  - `scripts/install-android-local-apk.sh --serial <new-adb-serial> --skip-build`
  - 或 `scripts/install-android-local-apk.sh --serial <new-adb-serial> --test`
  - 完整 dogfood E2E：`scripts/run-android-device-smoke.sh android/app/build/outputs/apk/debug/app-debug.apk`

### 当前运行边界
- Android App：端上录音、首页/详情状态、设置诊断、本地 Room、WorkManager、Media3 播放。
- Cloudflare Worker：生产 API `vibepub-api`，提供 `/health`、上传、录音列表、转录文件、内部状态回写。
- Cloudflare D1：生产数据库 `vibepub-db`，保存录音元数据、状态、阶段、错误和展示字段。
- Cloudflare R2：生产文件桶 `vibepub-files`，保存上传音频和 transcript/article JSON。
- GitHub Actions：`mining-job.yml` 是异步 job runner，负责 Volcengine ASR、GLM 改写、WeChat 草稿和状态回写；不是在线 API 或数据库。

### 产品体验待完善
- 继续按体验优先版计划推进：
  - mining `ARTICLE_READY` 进度回写已经在完整完成态链路中被间接验证；后续可补一个封面/草稿失败场景，专门验证“文章已生成但草稿未就绪”的中间态体验。
  - 设置页诊断信息与连接测试继续作为 dogfood 基础设施检查点。
  - 自动化测试产物需要稳定保存截图、UI dump、logcat、audit 结果。

## 当前注意事项
- 目前最新可安装 APK 是 `8f43de6` 对应 Release。
- 最新 Release asset 元数据已经给出 SHA-256；本机用 `gh release download` 复核时遇到一次 `release-assets.githubusercontent.com` 连接超时，不影响 Release 已成功生成的结论。
- `artifacts/` 下存在多批历史安装/CI 调试产物，当前记录未整理或删除它们。
