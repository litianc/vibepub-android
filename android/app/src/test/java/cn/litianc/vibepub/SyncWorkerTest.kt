package cn.litianc.vibepub

import org.junit.Assert.assertEquals
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
}
