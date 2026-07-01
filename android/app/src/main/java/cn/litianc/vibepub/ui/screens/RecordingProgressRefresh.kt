package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.asRecordingStatus

internal const val ACTIVE_RECORDING_AUTO_REFRESH_INTERVAL_MS = 30_000L
private const val ACTIVE_RECORDING_AUTO_REFRESH_RECENT_SYNC_MS = 15_000L

internal fun recordingHasActiveCloudWork(recording: RecordingEntity?): Boolean {
    return when (recording?.status?.asRecordingStatus()) {
        RecordingStatus.UPLOADING,
        RecordingStatus.UPLOADED,
        RecordingStatus.PROCESSING -> true
        RecordingStatus.LOCAL_RECORDED,
        RecordingStatus.COMPLETED,
        RecordingStatus.FAILED,
        null -> false
    }
}

internal fun recordingsHaveActiveCloudWork(recordings: List<RecordingEntity>): Boolean {
    return recordings.any(::recordingHasActiveCloudWork)
}

internal fun shouldAutoRefreshActiveRecordings(
    recordings: List<RecordingEntity>,
    lastSyncAtMs: Long,
    lastAutoRefreshRequestAtMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): Boolean {
    return shouldAutoRefreshActiveWork(
        hasActiveCloudWork = recordingsHaveActiveCloudWork(recordings),
        lastSyncAtMs = lastSyncAtMs,
        lastAutoRefreshRequestAtMs = lastAutoRefreshRequestAtMs,
        nowMs = nowMs,
    )
}

internal fun shouldAutoRefreshActiveRecording(
    recording: RecordingEntity?,
    lastSyncAtMs: Long,
    lastAutoRefreshRequestAtMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): Boolean {
    return shouldAutoRefreshActiveWork(
        hasActiveCloudWork = recordingHasActiveCloudWork(recording),
        lastSyncAtMs = lastSyncAtMs,
        lastAutoRefreshRequestAtMs = lastAutoRefreshRequestAtMs,
        nowMs = nowMs,
    )
}

private fun shouldAutoRefreshActiveWork(
    hasActiveCloudWork: Boolean,
    lastSyncAtMs: Long,
    lastAutoRefreshRequestAtMs: Long,
    nowMs: Long,
): Boolean {
    if (!hasActiveCloudWork) return false

    val syncAgeMs = (nowMs - lastSyncAtMs).coerceAtLeast(0L)
    if (lastSyncAtMs > 0L && syncAgeMs < ACTIVE_RECORDING_AUTO_REFRESH_RECENT_SYNC_MS) {
        return false
    }

    val requestAgeMs = (nowMs - lastAutoRefreshRequestAtMs).coerceAtLeast(0L)
    return lastAutoRefreshRequestAtMs <= 0L ||
        requestAgeMs >= ACTIVE_RECORDING_AUTO_REFRESH_INTERVAL_MS
}
