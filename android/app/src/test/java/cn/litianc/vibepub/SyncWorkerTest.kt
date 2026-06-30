package cn.litianc.vibepub

import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.RecordingEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SyncWorkerTest {
    @Test
    fun classifiesAuthorizationFailuresAsUserFixable() {
        assertEquals(SyncHttpFailure.AUTH, classifySyncHttpFailure(401))
        assertEquals(SyncHttpFailure.AUTH, classifySyncHttpFailure(403))
    }

    @Test
    fun keepsMissingTranscriptAsProcessingState() {
        assertEquals(SyncHttpFailure.MISSING_TRANSCRIPT, classifySyncHttpFailure(404))
    }

    @Test
    fun keepsServerAndNetworkStyleFailuresRetryable() {
        assertEquals(SyncHttpFailure.RETRYABLE, classifySyncHttpFailure(500))
        assertEquals(SyncHttpFailure.RETRYABLE, classifySyncHttpFailure(503))
    }

    @Test
    fun marksOnlyActiveNonCompletedRecordingsForSyncConfigurationFailures() {
        assertTrue(shouldMarkSyncConfigurationFailure(RecordingStatus.UPLOADING, onlyActive = true))
        assertTrue(shouldMarkSyncConfigurationFailure(RecordingStatus.UPLOADED, onlyActive = true))
        assertTrue(shouldMarkSyncConfigurationFailure(RecordingStatus.PROCESSING, onlyActive = true))

        assertFalse(shouldMarkSyncConfigurationFailure(RecordingStatus.LOCAL_RECORDED, onlyActive = true))
        assertFalse(shouldMarkSyncConfigurationFailure(RecordingStatus.COMPLETED, onlyActive = true))
    }

    @Test
    fun canMarkAllNonCompletedRecordingsWhenCallerRequestsBroadFailure() {
        assertTrue(shouldMarkSyncConfigurationFailure(RecordingStatus.LOCAL_RECORDED, onlyActive = false))
        assertFalse(shouldMarkSyncConfigurationFailure(RecordingStatus.COMPLETED, onlyActive = false))
    }

    @Test
    fun parsesD1RecordingCreatedAtAsUtc() {
        val expected = Instant.parse("2026-06-29T13:04:45Z").toEpochMilli()

        assertEquals(expected, parseRemoteRecordingCreatedAt("2026-06-29 13:04:45"))
        assertEquals(expected, parseRemoteRecordingCreatedAt("2026-06-29T13:04:45Z"))
    }

    @Test
    fun parsesDurationFromRecordingFilenameFallback() {
        assertEquals(
            30_000L,
            parseDurationMsFromRecordingFilename("VibePub-2026-06-29-210444-0m30s-Debug-Audio-Import.mp3"),
        )
        assertEquals(
            6_000L,
            parseDurationMsFromRecordingFilename("VibePub-2026-06-29-160846-0m6s-Mon-Afternoon-Beijing-Chaoyang.m4a"),
        )
    }

    @Test
    fun keepsDraftErrorWhenTranscriptDoesNotRepeatIt() {
        assertEquals(
            "公众号草稿创建失败：502",
            mergedTranscriptError(
                existingError = "公众号草稿创建失败：502",
                transcriptError = null,
                hasDraftReference = false,
            ),
        )
    }

    @Test
    fun clearsDraftErrorWhenDraftReferenceArrives() {
        assertEquals(
            null,
            mergedTranscriptError(
                existingError = "公众号草稿创建失败：502",
                transcriptError = null,
                hasDraftReference = true,
            ),
        )
    }

    @Test
    fun skipsRemoteRecordingWhenUserDeletedLocalCard() {
        val tombstone = RecordingEntity(
            filename = "deleted.m4a",
            durationMs = 18_000L,
            timestamp = 1L,
            status = RecordingStatus.COMPLETED.value,
            deletedAt = 123_000L,
        )

        assertTrue(shouldSkipRemoteRecording(tombstone))
        assertFalse(shouldSkipRemoteRecording(tombstone.copy(deletedAt = null)))
        assertFalse(shouldSkipRemoteRecording(null))
    }
}
