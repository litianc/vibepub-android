package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

class SettingsScreenTest {
    @Test
    fun settingsLastSyncLabelShowsUninitializedStatePlainly() {
        assertEquals("尚未同步", settingsLastSyncValue(0L))
        assertEquals("还没有从云端同步过录音状态", settingsLastSyncDetail(0L))
    }

    @Test
    fun settingsLastSyncLabelShowsConcreteTimestamp() {
        val timestamp = 1_782_804_000_000L
        val timeZone = TimeZone.getTimeZone("Asia/Shanghai")

        assertEquals("06-30 15:20", settingsLastSyncValue(timestamp, Locale.US, timeZone))
        assertEquals(
            "上次从云端同步录音和成文状态：2026-06-30 15:20:00",
            settingsLastSyncDetail(timestamp, Locale.US, timeZone),
        )
    }

    @Test
    fun connectionResultSummarizesHealthyBackendAndToken() {
        val result = buildConnectionResult(
            healthStatusCode = 200,
            tokenProvided = true,
            recordingsStatusCode = 200,
            recordingCount = 7,
            errorMessage = null,
        )

        assertTrue(result.success)
        assertEquals("连接正常", result.summary)
        assertTrue(result.nextAction.contains("继续录音"))
        assertEquals(ConnectionCheckState.PASSED, result.checks[0].state)
        assertEquals("后端网络", result.checks[0].label)
        assertEquals(ConnectionCheckState.PASSED, result.checks[1].state)
        assertEquals(ConnectionCheckState.PASSED, result.checks[2].state)
        assertTrue(result.checks[2].detail.contains("云端 7 条录音"))
    }

    @Test
    fun autoConnectionTestRunsOnlyWhenNormalizedConfigChanges() {
        val tested = SettingsConnectionConfig(
            apiBaseUrl = "https://api.example.com",
            filesToken = "TOKEN",
        )

        assertFalse(
            shouldAutoTestSettingsConnection(
                lastTestedConfig = tested,
                currentConfig = SettingsConnectionConfig(" https://api.example.com ", " TOKEN "),
            ),
        )
        assertTrue(
            shouldAutoTestSettingsConnection(
                lastTestedConfig = tested,
                currentConfig = SettingsConnectionConfig("https://api.example.com", "NEW_TOKEN"),
            ),
        )
        assertTrue(
            shouldAutoTestSettingsConnection(
                lastTestedConfig = tested,
                currentConfig = SettingsConnectionConfig("https://other.example.com", "TOKEN"),
            ),
        )
    }

    @Test
    fun connectionResultSeparatesBackendFailureFromTokenFailure() {
        val result = buildConnectionResult(
            healthStatusCode = 503,
            tokenProvided = true,
            recordingsStatusCode = null,
            recordingCount = null,
            errorMessage = null,
        )

        assertFalse(result.success)
        assertEquals("后端不可达", result.summary)
        assertTrue(result.nextAction.contains("API Base URL"))
        assertEquals(ConnectionCheckState.FAILED, result.checks[0].state)
        assertEquals(ConnectionCheckState.SKIPPED, result.checks[1].state)
        assertEquals(ConnectionCheckState.SKIPPED, result.checks[2].state)
    }

    @Test
    fun connectionResultShowsMissingTokenAsConfigurationProblem() {
        val result = buildConnectionResult(
            healthStatusCode = 200,
            tokenProvided = false,
            recordingsStatusCode = null,
            recordingCount = null,
            errorMessage = null,
        )

        assertFalse(result.success)
        assertEquals("缺少 FILES_TOKEN", result.summary)
        assertTrue(result.nextAction.contains("粘贴 FILES_TOKEN"))
        assertEquals(ConnectionCheckState.PASSED, result.checks[0].state)
        assertEquals(ConnectionCheckState.FAILED, result.checks[1].state)
        assertEquals("未填写，无法读取云端录音", result.checks[1].detail)
        assertEquals(ConnectionCheckState.SKIPPED, result.checks[2].state)
    }

    @Test
    fun connectionResultCallsOutInvalidToken() {
        val result = buildConnectionResult(
            healthStatusCode = 200,
            tokenProvided = true,
            recordingsStatusCode = 403,
            recordingCount = null,
            errorMessage = null,
        )

        assertFalse(result.success)
        assertEquals("FILES_TOKEN 无效", result.summary)
        assertTrue(result.nextAction.contains("更新 FILES_TOKEN"))
        assertEquals(ConnectionCheckState.PASSED, result.checks[0].state)
        assertEquals(ConnectionCheckState.FAILED, result.checks[1].state)
        assertEquals(ConnectionCheckState.FAILED, result.checks[2].state)
    }

    @Test
    fun connectionResultReportsRecordingsApiFailureAfterHealthyAuthInputs() {
        val result = buildConnectionResult(
            healthStatusCode = 200,
            tokenProvided = true,
            recordingsStatusCode = 500,
            recordingCount = null,
            errorMessage = null,
        )

        assertFalse(result.success)
        assertEquals("录音列表接口异常", result.summary)
        assertTrue(result.nextAction.contains("复制诊断信息"))
        assertEquals(ConnectionCheckState.PASSED, result.checks[0].state)
        assertEquals(ConnectionCheckState.SKIPPED, result.checks[1].state)
        assertTrue(result.checks[1].detail.contains("暂未确认权限"))
        assertEquals(ConnectionCheckState.FAILED, result.checks[2].state)
        assertTrue(result.checks[2].detail.contains("HTTP 500"))
    }

    @Test
    fun connectionResultKeepsBackendReachableWhenRecordingsRequestThrows() {
        val result = buildConnectionResult(
            healthStatusCode = 200,
            tokenProvided = true,
            recordingsStatusCode = null,
            recordingCount = null,
            errorMessage = null,
            recordingsErrorMessage = "timeout waiting for /api/recordings",
        )

        assertFalse(result.success)
        assertEquals("录音列表接口异常", result.summary)
        assertEquals(ConnectionCheckState.PASSED, result.checks[0].state)
        assertEquals("/health HTTP 200", result.checks[0].detail)
        assertEquals(ConnectionCheckState.SKIPPED, result.checks[1].state)
        assertTrue(result.checks[1].detail.contains("暂未确认权限"))
        assertEquals(ConnectionCheckState.FAILED, result.checks[2].state)
        assertEquals("timeout waiting for /api/recordings", result.checks[2].detail)
    }

    @Test
    fun diagnosticsTextIncludesSupportFields() {
        val text = formatDiagnostics(
            appVersion = "0.1.0-debug (1)",
            deviceId = "device-123",
            deviceName = "Redmi Tablet",
            androidVersion = "15 / SDK 35",
            apiBaseUrl = "https://api.example.com",
            tokenConfigured = true,
            lastSyncText = "2026-06-29 16:00:00",
            recordingCount = 3,
            latest = RecordingEntity(
                filename = "VibePub-20260629.m4a",
                durationMs = 18_000L,
                timestamp = 1L,
                status = RecordingStatus.FAILED.value,
                lastError = "服务返回空转录结果",
                articleTitle = "一次发布前的想法",
                rawTextPreview = "原始识别片段",
                remoteStatusUpdatedAt = "2026-06-29T08:00:00Z",
                localAudioPath = "/tmp/VibePub-20260629.m4a",
                processingStage = "ASR",
            ),
            latestLocalAudioExists = false,
        )

        assertTrue(text.contains("App: VibePub 0.1.0-debug (1)"))
        assertTrue(text.contains("Device ID: device-123"))
        assertTrue(text.contains("Device: Redmi Tablet"))
        assertTrue(text.contains("API host: https://api.example.com"))
        assertTrue(text.contains("Token: 已配置"))
        assertTrue(text.contains("Recording count: 3"))
        assertTrue(text.contains("Latest recording: VibePub-20260629.m4a"))
        assertTrue(text.contains("Latest status: FAILED"))
        assertTrue(text.contains("Latest title: 一次发布前的想法"))
        assertTrue(text.contains("Latest status label: 需要处理"))
        assertTrue(text.contains("Latest status detail: 服务返回空转录结果"))
        assertTrue(text.contains("Latest processing stage: ASR"))
        assertTrue(text.contains("Latest workflow: 当前节点：4. 语音识别 · 需处理"))
        assertTrue(text.contains("Latest workflow progress: 第 4/7 步"))
        assertTrue(text.contains("Latest workflow freshness: 失败时间："))
        assertTrue(text.contains("Latest workflow detail: 把口述音频转成原始文字"))
        assertTrue(text.contains("Latest next action: 下一步：点同步或重试"))
        assertTrue(text.contains("Latest remote update: 2026-06-29T08:00:00Z"))
        assertTrue(text.contains("Latest local audio path: /tmp/VibePub-20260629.m4a"))
        assertTrue(text.contains("Latest local audio exists: 否"))
        assertTrue(text.contains("Latest article title: 一次发布前的想法"))
        assertTrue(text.contains("Latest raw text: 已同步"))
        assertTrue(text.contains("Latest WeChat draft: 无"))
        assertTrue(text.contains("Latest error: 服务返回空转录结果"))
    }

    @Test
    fun diagnosticsTextShowsMissingConfigurationPlainly() {
        val text = formatDiagnostics(
            appVersion = "0.1.0-debug (1)",
            deviceId = "",
            deviceName = "unknown",
            androidVersion = "unknown",
            apiBaseUrl = "",
            tokenConfigured = false,
            lastSyncText = "尚未同步",
            recordingCount = 0,
            latest = null,
        )

        assertTrue(text.contains("API host: 未配置"))
        assertTrue(text.contains("Token: 未配置"))
        assertTrue(text.contains("Latest recording: 无"))
        assertTrue(text.contains("Latest processing stage: 无"))
        assertTrue(text.contains("Latest workflow: 无"))
        assertTrue(text.contains("Latest workflow freshness: 无"))
        assertTrue(text.contains("Latest next action: 无"))
        assertTrue(text.contains("Latest local audio path: 无"))
        assertTrue(text.contains("Latest local audio exists: 未知"))
        assertTrue(text.contains("Latest article title: 无"))
        assertTrue(text.contains("Latest raw text: 无"))
        assertTrue(text.contains("Latest WeChat draft: 无"))
        assertTrue(text.contains("Latest error: 无"))
    }

    @Test
    fun diagnosticsTextIncludesCompletedDraftReference() {
        val text = formatDiagnostics(
            appVersion = "0.1.0-debug (1)",
            deviceId = "device-123",
            deviceName = "Redmi Tablet",
            androidVersion = "15 / SDK 35",
            apiBaseUrl = "https://api.example.com",
            tokenConfigured = true,
            lastSyncText = "2026-06-29 16:00:00",
            recordingCount = 1,
            latest = RecordingEntity(
                filename = "VibePub-done.m4a",
                durationMs = 48_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
                articleTitle = "整理好的文章",
                rawTextPreview = "原始识别",
                wechatUrl = "https://mp.weixin.qq.com/draft",
                localAudioPath = "/tmp/VibePub-done.m4a",
                processingStage = "COMPLETED",
            ),
            latestLocalAudioExists = true,
        )

        assertTrue(text.contains("Latest status label: 草稿已就绪"))
        assertTrue(text.contains("Latest processing stage: COMPLETED"))
        assertTrue(text.contains("Latest workflow: 当前节点：7. 人工发布确认 · 当前"))
        assertTrue(text.contains("Latest workflow progress: 第 7/7 步"))
        assertTrue(text.contains("Latest workflow freshness: 完成时间："))
        assertTrue(text.contains("Latest next action: 下一步：打开公众号草稿"))
        assertTrue(text.contains("Latest local audio path: /tmp/VibePub-done.m4a"))
        assertTrue(text.contains("Latest local audio exists: 是"))
        assertTrue(text.contains("Latest WeChat draft: https://mp.weixin.qq.com/draft"))
    }

    @Test
    fun diagnosticsTextTreatsNullLikeDraftReferencesAsMissing() {
        val text = formatDiagnostics(
            appVersion = "0.1.0-debug (1)",
            deviceId = "device-123",
            deviceName = "Redmi Tablet",
            androidVersion = "15 / SDK 35",
            apiBaseUrl = "https://api.example.com",
            tokenConfigured = true,
            lastSyncText = "2026-06-29 16:00:00",
            recordingCount = 1,
            latest = RecordingEntity(
                filename = "VibePub-done.m4a",
                durationMs = 48_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
                articleTitle = "整理好的文章",
                rawTextPreview = "原始识别",
                wechatDraftId = "undefined",
                wechatUrl = "null",
                processingStage = "COMPLETED",
            ),
            latestLocalAudioExists = true,
        )

        assertTrue(text.contains("Latest WeChat draft: 无"))
        assertFalse(text.contains("Latest WeChat draft: null"))
        assertFalse(text.contains("Latest WeChat draft: undefined"))
    }
}
