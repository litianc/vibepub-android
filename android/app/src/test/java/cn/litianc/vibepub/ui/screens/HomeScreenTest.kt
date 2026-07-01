package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HomeScreenTest {
    @Test
    fun shouldFinishHomeRefreshOnlyWhenSyncTimestampChangesToValidValue() {
        assertEquals(false, shouldFinishHomeRefresh(null, lastSyncAtMs = 10_000L))
        assertEquals(false, shouldFinishHomeRefresh(10_000L, lastSyncAtMs = 10_000L))
        assertEquals(false, shouldFinishHomeRefresh(10_000L, lastSyncAtMs = 0L))
        assertEquals(true, shouldFinishHomeRefresh(10_000L, lastSyncAtMs = 12_000L))
    }

    @Test
    fun lastSyncLabelShowsMissingSyncPlainly() {
        assertEquals("最近同步：尚未同步", lastSyncLabel(0L, nowMs = 10_000L))
    }

    @Test
    fun lastSyncLabelRoundsRecentSyncToNow() {
        assertEquals("最近同步：刚刚", lastSyncLabel(9_950L, nowMs = 10_000L))
    }

    @Test
    fun lastSyncLabelShowsMinutesHoursAndDays() {
        assertEquals("最近同步：5 分钟前", lastSyncLabel(700_000L, nowMs = 1_000_000L))
        assertEquals("最近同步：2 小时前", lastSyncLabel(1_000_000L, nowMs = 8_200_000L))
        assertEquals("最近同步：3 天前", lastSyncLabel(1_000_000L, nowMs = 260_200_000L))
    }

    @Test
    fun lastSyncLabelHandlesDeviceClockMovingBackwards() {
        assertEquals("最近同步：刚刚", lastSyncLabel(20_000L, nowMs = 10_000L))
    }

    @Test
    fun homeSyncNoticeStaysHiddenForEmptyHome() {
        assertNull(homeSyncNotice(emptyList(), lastSyncAtMs = 0L, nowMs = 1_000L))
    }

    @Test
    fun homeSyncNoticeExplainsNeverSyncedRecordings() {
        val notice = homeSyncNotice(
            recordings = listOf(recording(status = RecordingStatus.UPLOADED)),
            lastSyncAtMs = 0L,
            nowMs = 1_000L,
        )

        assertEquals("还没有和云端同步过，点同步检查上传和处理进度。", notice?.message)
    }

    @Test
    fun homeSyncNoticePrioritizesLocalUploadRecovery() {
        val notice = homeSyncNotice(
            recordings = listOf(recording(status = RecordingStatus.LOCAL_RECORDED)),
            lastSyncAtMs = 0L,
            nowMs = 1_000L,
        )

        assertEquals("有本机录音还没上传，先点录音卡片上的上传；反复失败时检查 FILES_TOKEN。", notice?.message)
    }

    @Test
    fun homeSyncNoticeFlagsStaleActiveCloudWork() {
        val notice = homeSyncNotice(
            recordings = listOf(recording(status = RecordingStatus.PROCESSING)),
            lastSyncAtMs = 0L,
            nowMs = 11L * 60L * 1000L,
        )

        assertEquals("还没有和云端同步过，点同步检查上传和处理进度。", notice?.message)

        val staleNotice = homeSyncNotice(
            recordings = listOf(recording(status = RecordingStatus.PROCESSING)),
            lastSyncAtMs = 1_000L,
            nowMs = 11L * 60L * 1000L + 1_000L,
        )

        assertEquals("云端状态已 11 分钟 没有更新，点同步确认处理是否完成。", staleNotice?.message)
    }

    @Test
    fun homeSyncNoticeIgnoresCompletedOrFreshWork() {
        assertNull(
            homeSyncNotice(
                recordings = listOf(recording(status = RecordingStatus.PROCESSING)),
                lastSyncAtMs = 1_000L,
                nowMs = 9L * 60L * 1000L + 1_000L,
            )
        )
        assertNull(
            homeSyncNotice(
                recordings = listOf(recording(status = RecordingStatus.COMPLETED)),
                lastSyncAtMs = 1_000L,
                nowMs = 30L * 60L * 1000L + 1_000L,
            )
        )
    }

    @Test
    fun homeFocusRecordingPrioritizesActionableWorkflow() {
        val completedDraft = recording(
            status = RecordingStatus.COMPLETED,
            filename = "completed-draft.m4a",
            timestamp = 300L,
            wechatDraftId = "MEDIA_ID_123",
        )
        val processing = recording(
            status = RecordingStatus.PROCESSING,
            filename = "processing.m4a",
            timestamp = 100L,
        )
        val failed = recording(
            status = RecordingStatus.FAILED,
            filename = "failed.m4a",
            timestamp = 200L,
        )

        val focus = homeFocusRecording(listOf(completedDraft, processing, failed))

        assertEquals("failed.m4a", focus?.filename)
    }

    @Test
    fun homeFocusRecordingDoesNotPinCompletedArticleWaitingForDraft() {
        val completedDraft = recording(
            status = RecordingStatus.COMPLETED,
            filename = "completed-draft.m4a",
            timestamp = 200L,
            wechatDraftId = "MEDIA_ID_123",
        )
        val articleOnly = recording(
            status = RecordingStatus.COMPLETED,
            filename = "article-only.m4a",
            timestamp = 100L,
        )

        val focus = homeFocusRecording(listOf(completedDraft, articleOnly))

        assertNull(focus)
    }

    @Test
    fun homeFocusRecordingDoesNotPinCompletedArticleWithPlaceholderDraftReferences() {
        val completedDraft = recording(
            status = RecordingStatus.COMPLETED,
            filename = "completed-draft.m4a",
            timestamp = 200L,
            wechatDraftId = "MEDIA_ID_123",
        )
        val placeholderDraft = recording(
            status = RecordingStatus.COMPLETED,
            filename = "placeholder-draft.m4a",
            timestamp = 100L,
            wechatDraftId = " undefined ",
            wechatUrl = "null",
        )

        val focus = homeFocusRecording(listOf(completedDraft, placeholderDraft))

        assertNull(focus)
    }

    @Test
    fun homeFocusRecordingPinsCompletedArticleOnlyWhenDraftExplicitlyFailed() {
        val completedDraft = recording(
            status = RecordingStatus.COMPLETED,
            filename = "completed-draft.m4a",
            timestamp = 200L,
            wechatDraftId = "MEDIA_ID_123",
        )
        val draftFailed = recording(
            status = RecordingStatus.COMPLETED,
            filename = "draft-failed.m4a",
            timestamp = 100L,
            processingStage = "DRAFT_FAILED",
            lastError = "公众号草稿创建失败",
        )

        val focus = homeFocusRecording(listOf(completedDraft, draftFailed))

        assertEquals("draft-failed.m4a", focus?.filename)
    }

    @Test
    fun homeFocusRecordingUsesNewestWithinSamePriority() {
        val olderProcessing = recording(
            status = RecordingStatus.PROCESSING,
            filename = "older-processing.m4a",
            timestamp = 100L,
        )
        val newerProcessing = recording(
            status = RecordingStatus.UPLOADED,
            filename = "newer-processing.m4a",
            timestamp = 200L,
        )

        val focus = homeFocusRecording(listOf(olderProcessing, newerProcessing))

        assertEquals("newer-processing.m4a", focus?.filename)
    }

    @Test
    fun homeActiveCloudWorkOnlyIncludesCloudPipelineStatuses() {
        assertEquals(false, recordingsHaveActiveCloudWork(emptyList()))
        assertEquals(false, recordingsHaveActiveCloudWork(listOf(recording(status = RecordingStatus.LOCAL_RECORDED))))
        assertEquals(false, recordingsHaveActiveCloudWork(listOf(recording(status = RecordingStatus.COMPLETED))))
        assertEquals(false, recordingsHaveActiveCloudWork(listOf(recording(status = RecordingStatus.FAILED))))
        assertEquals(true, recordingsHaveActiveCloudWork(listOf(recording(status = RecordingStatus.UPLOADING))))
        assertEquals(true, recordingsHaveActiveCloudWork(listOf(recording(status = RecordingStatus.UPLOADED))))
        assertEquals(true, recordingsHaveActiveCloudWork(listOf(recording(status = RecordingStatus.PROCESSING))))
    }

    @Test
    fun recordingCardSyncFreshnessExplainsStateSpecificFreshness() {
        assertEquals(
            "最近同步：5 分钟前",
            recordingCardSyncFreshnessLabel(
                status = RecordingStatus.PROCESSING,
                lastSyncAtMs = 700_000L,
                nowMs = 1_000_000L,
            ),
        )
        assertEquals(
            "本机已保存，等待上传",
            recordingCardSyncFreshnessLabel(
                status = RecordingStatus.LOCAL_RECORDED,
                lastSyncAtMs = 700_000L,
                nowMs = 1_000_000L,
            ),
        )
        assertEquals(
            "云端结果已同步",
            recordingCardSyncFreshnessLabel(
                status = RecordingStatus.COMPLETED,
                lastSyncAtMs = 700_000L,
                nowMs = 1_000_000L,
            ),
        )
        assertEquals(
            "已停止自动等待，请按提示处理",
            recordingCardSyncFreshnessLabel(
                status = RecordingStatus.FAILED,
                lastSyncAtMs = 700_000L,
                nowMs = 1_000_000L,
            ),
        )
    }

    @Test
    fun autoRefreshActiveWorkSkipsWhenNothingIsRunningOrSyncIsFresh() {
        assertEquals(
            false,
            shouldAutoRefreshActiveRecordings(
                recordings = listOf(recording(status = RecordingStatus.COMPLETED)),
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 0L,
                nowMs = 60_000L,
            ),
        )

        assertEquals(
            false,
            shouldAutoRefreshActiveRecordings(
                recordings = listOf(recording(status = RecordingStatus.PROCESSING)),
                lastSyncAtMs = 50_000L,
                lastAutoRefreshRequestAtMs = 0L,
                nowMs = 60_000L,
            ),
        )
    }

    @Test
    fun autoRefreshActiveWorkRunsInitiallyAndThenWaitsForInterval() {
        val active = listOf(recording(status = RecordingStatus.PROCESSING))

        assertEquals(
            true,
            shouldAutoRefreshActiveRecordings(
                recordings = active,
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 0L,
                nowMs = 60_000L,
            ),
        )
        assertEquals(
            false,
            shouldAutoRefreshActiveRecordings(
                recordings = active,
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 45_000L,
                nowMs = 60_000L,
            ),
        )
        assertEquals(
            true,
            shouldAutoRefreshActiveRecordings(
                recordings = active,
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 30_000L,
                nowMs = 60_000L,
            ),
        )
    }

    private fun recording(status: RecordingStatus): RecordingEntity {
        return recording(
            status = status,
            filename = "${status.value}.m4a",
            timestamp = 1L,
        )
    }

    private fun recording(
        status: RecordingStatus,
        filename: String,
        timestamp: Long,
        wechatDraftId: String? = null,
        wechatUrl: String? = null,
        processingStage: String? = null,
        lastError: String? = null,
    ): RecordingEntity {
        return RecordingEntity(
            filename = filename,
            durationMs = 1_000L,
            timestamp = timestamp,
            status = status.value,
            wechatDraftId = wechatDraftId,
            wechatUrl = wechatUrl,
            processingStage = processingStage,
            lastError = lastError,
        )
    }
}
