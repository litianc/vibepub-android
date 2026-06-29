package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsScreenTest {
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
                lastError = "FILES_TOKEN 无效或没有权限",
                articleTitle = "一次发布前的想法",
                rawTextPreview = "原始识别片段",
                remoteStatusUpdatedAt = "2026-06-29T08:00:00Z",
            ),
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
        assertTrue(text.contains("Latest status detail: FILES_TOKEN 无效或没有权限"))
        assertTrue(text.contains("Latest workflow: 当前节点：2. 上传音频 · 需处理"))
        assertTrue(text.contains("Latest workflow progress: 第 2/7 步"))
        assertTrue(text.contains("Latest workflow detail: 把录音上传到云端"))
        assertTrue(text.contains("Latest remote update: 2026-06-29T08:00:00Z"))
        assertTrue(text.contains("Latest article title: 一次发布前的想法"))
        assertTrue(text.contains("Latest raw text: 已同步"))
        assertTrue(text.contains("Latest WeChat draft: 无"))
        assertTrue(text.contains("Latest error: FILES_TOKEN 无效或没有权限"))
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
        assertTrue(text.contains("Latest workflow: 无"))
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
            ),
        )

        assertTrue(text.contains("Latest status label: 草稿已就绪"))
        assertTrue(text.contains("Latest workflow: 当前节点：7. 人工发布确认 · 当前"))
        assertTrue(text.contains("Latest workflow progress: 第 7/7 步"))
        assertTrue(text.contains("Latest WeChat draft: https://mp.weixin.qq.com/draft"))
    }
}
