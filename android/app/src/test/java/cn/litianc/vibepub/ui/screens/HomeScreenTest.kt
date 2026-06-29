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

    private fun recording(status: RecordingStatus): RecordingEntity {
        return RecordingEntity(
            filename = "${status.value}.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = status.value,
        )
    }
}
