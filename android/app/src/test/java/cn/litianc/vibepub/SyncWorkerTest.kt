package cn.litianc.vibepub

import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
