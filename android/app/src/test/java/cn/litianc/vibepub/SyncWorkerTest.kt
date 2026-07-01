package cn.litianc.vibepub

import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.RecordingEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
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
    fun transcriptArticleTitleOnlyUsesRealArticleTitleFields() {
        assertEquals(
            "整理好的标题",
            transcriptArticleTitleOrNull(JSONObject("""{"articleTitle":"整理好的标题"}""")),
        )
        assertEquals(
            "后端字段标题",
            transcriptArticleTitleOrNull(JSONObject("""{"article_title":"后端字段标题"}""")),
        )
        assertEquals(null, transcriptArticleTitleOrNull(JSONObject("""{"rawText":"只有原始转录"}""")))
        assertEquals(null, transcriptArticleTitleOrNull(JSONObject("""{"articleTitle":"   "}""")))
        assertEquals(null, transcriptArticleTitleOrNull(null))
    }

    @Test
    fun transcriptRawTextAcceptsCamelAndSnakeCaseFields() {
        assertEquals(
            "原始转录",
            transcriptRawTextOrNull(JSONObject("""{"rawText":"原始转录"}""")),
        )
        assertEquals(
            "后端原始转录",
            transcriptRawTextOrNull(JSONObject("""{"raw_text":"后端原始转录"}""")),
        )
        assertEquals(null, transcriptRawTextOrNull(JSONObject("""{"rawText":"   "}""")))
        assertEquals(null, transcriptRawTextOrNull(null))
    }

    @Test
    fun blankToNullValueTreatsJsonNullStringAsMissing() {
        assertEquals("草稿ID", " 草稿ID ".blankToNullValue())
        assertEquals(null, "null".blankToNullValue())
        assertEquals(null, " NULL ".blankToNullValue())
        assertEquals(null, "   ".blankToNullValue())
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

    @Test
    fun remoteArticleReadyRecordingKeepsArticleConsumableBeforeDraftCompletes() {
        val remote = JSONObject(
            """
            {
              "filename": "VibePub-20260630-055501-0m18s-Article-Ready.m4a",
              "status": "PROCESSING",
              "created_at": "2026-06-30T05:55:01Z",
              "updated_at": "2026-06-30T05:56:20Z",
              "duration_ms": 18480,
              "article_title": "把口述想法变成公众号文章",
              "raw_text_preview": "今天我想说一下如何减少写作成本",
              "processing_stage": "ARTICLE_READY",
              "wechat_draft_id": null,
              "wechat_url": null,
              "error_message": null
            }
            """.trimIndent(),
        )

        val recording = mergeRemoteRecordingFromListItem(
            recObj = remote,
            existing = null,
            nowMs = 1_782_806_000_000L,
        )

        requireNotNull(recording)
        assertEquals("VibePub-20260630-055501-0m18s-Article-Ready.m4a", recording.filename)
        assertEquals(18_480L, recording.durationMs)
        assertEquals(RecordingStatus.PROCESSING.value, recording.status)
        assertEquals("把口述想法变成公众号文章", recording.articleTitle)
        assertEquals("今天我想说一下如何减少写作成本", recording.rawTextPreview)
        assertEquals("ARTICLE_READY", recording.processingStage)
        assertEquals("2026-06-30T05:56:20Z", recording.remoteStatusUpdatedAt)
        assertEquals(null, recording.completedAt)
        assertEquals(null, recording.lastError)
    }

    @Test
    fun remoteDraftFailureKeepsGeneratedArticleAndErrorForRecovery() {
        val existing = RecordingEntity(
            filename = "VibePub-20260630-055501-0m18s-Article-Ready.m4a",
            durationMs = 18_480L,
            timestamp = 1_782_800_000_000L,
            status = RecordingStatus.PROCESSING.value,
            processingStage = "ARTICLE_READY",
            articleTitle = "旧标题",
            rawTextPreview = "旧识别",
        )
        val remote = JSONObject(
            """
            {
              "filename": "VibePub-20260630-055501-0m18s-Article-Ready.m4a",
              "status": "COMPLETED",
              "updated_at": "2026-06-30T05:57:30Z",
              "article_title": "把口述想法变成公众号文章",
              "raw_text_preview": "今天我想说一下如何减少写作成本",
              "processing_stage": "DRAFT_FAILED",
              "error_message": "公众号草稿创建失败：cover generation timeout"
            }
            """.trimIndent(),
        )

        val recording = mergeRemoteRecordingFromListItem(
            recObj = remote,
            existing = existing,
            nowMs = 1_782_806_000_000L,
        )

        requireNotNull(recording)
        assertEquals(RecordingStatus.COMPLETED.value, recording.status)
        assertEquals("DRAFT_FAILED", recording.processingStage)
        assertEquals("把口述想法变成公众号文章", recording.articleTitle)
        assertEquals("今天我想说一下如何减少写作成本", recording.rawTextPreview)
        assertEquals("公众号草稿创建失败：cover generation timeout", recording.lastError)
        assertEquals(1_782_806_000_000L, recording.completedAt)
    }

    @Test
    fun remoteProcessingUpdateDoesNotDowngradeCompletedLocalRecording() {
        val existing = RecordingEntity(
            filename = "VibePub-done.m4a",
            durationMs = 18_000L,
            timestamp = 1L,
            status = RecordingStatus.COMPLETED.value,
            articleTitle = "已经完成",
            processingStage = "COMPLETED",
        )
        val remote = JSONObject(
            """
            {
              "filename": "VibePub-done.m4a",
              "status": "PROCESSING",
              "processing_stage": "ASR"
            }
            """.trimIndent(),
        )

        assertEquals(null, mergeRemoteRecordingFromListItem(remote, existing))
    }
}
