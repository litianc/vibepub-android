package cn.litianc.vibepub.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PublicationSnapshotTest {
    @Test
    fun parsesNestedSummaryAndKeepsOnlyThePublicSnapshot() {
        val snapshot = parsePublicationSnapshot(
            JSONObject(summaryJson("run-2", revision = 2, progress = 74).replace("\"error_code\":null", "\"error_code\":\"provider_internal_error_500\"")),
        )

        requireNotNull(snapshot)
        assertEquals("run-2", snapshot.runId)
        assertEquals("visual_generating", snapshot.state)
        assertEquals(2L, snapshot.stateRevision)
        assertEquals(74, snapshot.progressPercent)
        assertEquals("2026-07-22T00:00:00.000Z", snapshot.createdAt)
        assertNull(snapshot.errorCode)
    }

    @Test
    fun acceptsTheFlatCompatibilitySubsetOnlyWhenRunIdIsPresent() {
        val flat = JSONObject(
            """{"run_id":"legacy-run","publication_stage":"writing","state_revision":3,"progress_percent":28,"retry_count":0,"error_code":"provider_internal_error_500"}""",
        )

        val parsed = parsePublicationSnapshot(flat)
        requireNotNull(parsed)
        assertEquals("legacy-run", parsed.runId)
        assertEquals("writing", parsed.state)
        assertEquals("active", parsed.runStatus)
        assertNull(parsed.errorCode)

        assertNull(parsePublicationSnapshot(JSONObject("""{"publication_stage":"writing","state_revision":3,"progress_percent":28,"retry_count":0}""")))
    }

    @Test
    fun rejectsMalformedOrOutOfRangeSummaryFields() {
        assertNull(parsePublicationSnapshot(JSONObject(summaryJson("run", revision = -1, progress = 28))))
        assertNull(parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 1, progress = 101))))
        assertNull(parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 1, progress = 28).replace("\"created_at\":\"2026-07-22T00:00:00.000Z\"", "\"created_at\":\"not-a-date\""))))
    }

    @Test
    fun sameRunOnlyAdvancesByRevisionAndEqualRevisionCannotOverwrite() {
        val existing = parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 4, progress = 50, nextAction = "retry")))!!
        val lower = parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 3, progress = 36, nextAction = "other")))!!
        val equalConflict = parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 4, progress = 50, nextAction = "other")))!!
        val higher = parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 5, progress = 56, nextAction = null)))!!

        assertEquals(existing, mergePublicationSnapshot(existing, lower))
        assertEquals("retry", mergePublicationSnapshot(existing, equalConflict)?.nextAction)
        assertEquals(5L, mergePublicationSnapshot(existing, higher)?.stateRevision)
    }

    @Test
    fun differentRunsUseCreatedAtThenLexicalRunIdAndNeverReplaceWithInvalidTimestamp() {
        val older = parsePublicationSnapshot(JSONObject(summaryJson("run-a", revision = 2, progress = 28, createdAt = "2026-07-22T00:00:00.000Z")))!!
        val newer = parsePublicationSnapshot(JSONObject(summaryJson("run-b", revision = 0, progress = 0, createdAt = "2026-07-22T00:01:00.000Z")))!!
        val equalLaterId = parsePublicationSnapshot(JSONObject(summaryJson("run-z", revision = 0, progress = 0, createdAt = "2026-07-22T00:00:00.000Z")))!!

        assertEquals("run-b", mergePublicationSnapshot(older, newer)?.runId)
        assertEquals("run-z", mergePublicationSnapshot(older, equalLaterId)?.runId)
        assertEquals(older, mergePublicationSnapshot(older, older.copy(runId = "run-invalid", createdAt = null)))
    }

    @Test
    fun entityRoundTripsAndLeavesLegacyRecordingsWithoutSnapshotsUntouched() {
        val snapshot = parsePublicationSnapshot(JSONObject(summaryJson("run", revision = 1, progress = 28)))!!
        val legacy = RecordingEntity(
            filename = "legacy.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
        )

        assertNull(legacy.publicationSnapshotOrNull())
        assertEquals(snapshot, legacy.withPublicationSnapshot(snapshot).publicationSnapshotOrNull())
        assertTrue(legacy.withPublicationSnapshot(snapshot).publicationErrorCode == null)
    }

    private fun summaryJson(
        runId: String,
        revision: Long,
        progress: Int,
        nextAction: String? = null,
        createdAt: String = "2026-07-22T00:00:00.000Z",
    ): String {
        val next = nextAction?.let { "\"$it\"" } ?: "null"
        return """
            {
              "publication_summary": {
                "run_id":"$runId",
                "state":"visual_generating",
                "run_status":"active",
                "publication_stage":"visual",
                "state_revision":$revision,
                "progress_percent":$progress,
                "last_successful_state":"visual_generating",
                "last_successful_progress_percent":$progress,
                "retry_count":0,
                "next_action":$next,
                "error_code":null,
                "created_at":"$createdAt",
                "updated_at":"2026-07-22T00:00:01.000Z"
              }
            }
        """.trimIndent()
    }
}
