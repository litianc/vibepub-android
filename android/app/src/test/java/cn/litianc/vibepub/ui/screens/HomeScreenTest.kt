package cn.litianc.vibepub.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

class HomeScreenTest {
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
}
