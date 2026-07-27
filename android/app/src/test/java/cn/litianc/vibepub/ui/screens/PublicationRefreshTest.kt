package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PublicationRefreshTest {
    @Test
    fun activeAndRetryingPublicationRunsUseTheExistingThirtySecondRefreshCadence() {
        val active = v3Recording(runStatus = "active")
        val retrying = v3Recording(runStatus = "retrying")

        assertTrue(recordingHasActiveCloudWork(active))
        assertTrue(recordingHasActiveCloudWork(retrying))
        assertTrue(
            shouldAutoRefreshActiveRecording(
                active,
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 30_000L,
                nowMs = 60_000L,
            ),
        )
    }

    @Test
    fun terminalOrHumanActionPublicationRunsStopAutoRefreshWhileLegacyFallbackRemainsActive() {
        listOf("ready", "needs_action", "failed", "cancelled").forEach { status ->
            assertFalse(recordingHasActiveCloudWork(v3Recording(runStatus = status)))
        }
        assertFalse(
            recordingHasActiveCloudWork(
                v3Recording(runStatus = "active").copy(publicationState = "cancelled"),
            ),
        )
        val legacy = RecordingEntity(
            filename = "legacy.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
        )
        assertTrue(recordingHasActiveCloudWork(legacy))
    }

    private fun v3Recording(runStatus: String): RecordingEntity {
        val state = when (runStatus) {
            "ready" -> "draft_ready"
            "needs_action", "failed", "cancelled" -> runStatus
            "retrying" -> "retrying"
            else -> "writing"
        }
        return RecordingEntity(
            filename = "$runStatus.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
            publicationRunId = "run-$runStatus",
            publicationState = state,
            publicationRunStatus = runStatus,
            publicationStage = "writing",
            publicationStateRevision = 1L,
            publicationProgressPercent = 28,
            publicationLastSuccessfulState = "writing",
            publicationLastSuccessfulProgressPercent = 28,
            publicationRetryCount = 0,
            publicationRunCreatedAt = "2026-07-22T00:00:00.000Z",
            publicationUpdatedAt = "2026-07-22T00:00:01.000Z",
        )
    }
}
