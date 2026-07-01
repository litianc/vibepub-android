package cn.litianc.vibepub.data

import android.content.Context
import androidx.room.Room
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingDaoTest {
    private lateinit var database: AppDatabase

    @Before
    fun setUp() {
        val context: Context = RuntimeEnvironment.getApplication()
        database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun upsertBestKeepsCompletedRowOverZeroDurationDuplicate() = runBlocking {
        val dao = database.recordingDao()
        dao.upsertBest(
            RecordingEntity(
                filename = "same.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
            ),
        )
        dao.upsertBest(
            RecordingEntity(
                filename = "same.m4a",
                durationMs = 0L,
                timestamp = 2L,
                status = RecordingStatus.LOCAL_RECORDED.value,
            ),
        )

        val recordings = dao.getAllRecordings()
        assertEquals(1, recordings.size)
        assertEquals(32_000L, recordings.first().durationMs)
        assertEquals(RecordingStatus.COMPLETED.value, recordings.first().status)
    }

    @Test
    fun updatesExistingRowWhenCallerCarriesExistingId() = runBlocking {
        val dao = database.recordingDao()
        val rowId = dao.upsertBest(
            RecordingEntity(
                filename = "uploading.m4a",
                durationMs = 18_000L,
                timestamp = 1L,
                status = RecordingStatus.UPLOADING.value,
            ),
        ).toInt()

        dao.upsertBest(
            RecordingEntity(
                id = rowId,
                filename = "uploading.m4a",
                durationMs = 18_000L,
                timestamp = 1L,
                status = RecordingStatus.UPLOADED.value,
            ),
        )

        val recording = dao.getRecordingByFilename("uploading.m4a")
        assertEquals(rowId, recording?.id)
        assertEquals(RecordingStatus.UPLOADED.value, recording?.status)
    }

    @Test
    fun doesNotReplaceCompletedArticleWithLongerFailedDuplicate() = runBlocking {
        val dao = database.recordingDao()
        dao.upsertBest(
            RecordingEntity(
                filename = "article.m4a",
                durationMs = 18_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
                articleTitle = "已成文标题",
                rawTextPreview = "原始转录摘要",
            ),
        )

        dao.upsertBest(
            RecordingEntity(
                filename = "article.m4a",
                durationMs = 120_000L,
                timestamp = 2L,
                status = RecordingStatus.FAILED.value,
                lastError = "后来的坏记录",
            ),
        )

        val recording = dao.getRecordingByFilename("article.m4a")
        assertEquals(18_000L, recording?.durationMs)
        assertEquals(RecordingStatus.COMPLETED.value, recording?.status)
        assertEquals("已成文标题", recording?.articleTitle)
    }

    @Test
    fun persistsWechatDraftMetadata() = runBlocking {
        val dao = database.recordingDao()
        dao.insert(
            RecordingEntity(
                filename = "draft.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
                wechatDraftId = "MEDIA_ID_123",
                wechatUrl = "https://mp.weixin.qq.com/draft",
            ),
        )

        val recording = dao.getRecordingByFilename("draft.m4a")

        assertEquals("MEDIA_ID_123", recording?.wechatDraftId)
        assertEquals("https://mp.weixin.qq.com/draft", recording?.wechatUrl)
    }

    @Test
    fun persistsProcessingStageMetadata() = runBlocking {
        val dao = database.recordingDao()
        dao.insert(
            RecordingEntity(
                filename = "stage.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.PROCESSING.value,
                processingStage = "DRAFTING",
            ),
        )

        val recording = dao.getRecordingByFilename("stage.m4a")

        assertEquals("DRAFTING", recording?.processingStage)
    }

    @Test
    fun localDeletionHidesRecordingButKeepsTombstoneForSync() = runBlocking {
        val dao = database.recordingDao()
        dao.insert(
            RecordingEntity(
                filename = "deleted.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
            ),
        )

        dao.markDeletedByFilename("deleted.m4a", deletedAt = 123_000L)

        assertEquals(emptyList<RecordingEntity>(), dao.getAllRecordings())
        assertEquals(null, dao.getRecordingByFilename("deleted.m4a"))
        val tombstone = dao.getRecordingByFilenameIncludingDeleted("deleted.m4a")
        assertEquals(123_000L, tombstone?.deletedAt)
    }

    @Test
    fun upsertBestDoesNotResurrectDeletedTombstone() = runBlocking {
        val dao = database.recordingDao()
        dao.insert(
            RecordingEntity(
                filename = "deleted.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.FAILED.value,
                lastError = "处理失败",
            ),
        )
        dao.markDeletedByFilename("deleted.m4a", deletedAt = 123_000L)

        dao.upsertBest(
            RecordingEntity(
                filename = "deleted.m4a",
                durationMs = 32_000L,
                timestamp = 2L,
                status = RecordingStatus.COMPLETED.value,
                articleTitle = "远端同步又回来了",
            ),
        )

        assertEquals(emptyList<RecordingEntity>(), dao.getAllRecordings())
        assertEquals(null, dao.getRecordingByFilename("deleted.m4a"))
        val tombstone = dao.getRecordingByFilenameIncludingDeleted("deleted.m4a")
        assertEquals(123_000L, tombstone?.deletedAt)
        assertEquals(RecordingStatus.FAILED.value, tombstone?.status)
    }

    @Test
    fun upsertBestDoesNotResurrectDeletedTombstoneFromStaleSameIdEntity() = runBlocking {
        val dao = database.recordingDao()
        val rowId = dao.insert(
            RecordingEntity(
                filename = "deleted.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.UPLOADING.value,
            ),
        )
        val staleWorkerCopy = dao.getRecordingByFilename("deleted.m4a")
        dao.markDeletedByFilename("deleted.m4a", deletedAt = 123_000L)

        dao.upsertBest(
            requireNotNull(staleWorkerCopy).copy(
                id = rowId.toInt(),
                status = RecordingStatus.UPLOADED.value,
                lastError = null,
            ),
        )

        assertEquals(emptyList<RecordingEntity>(), dao.getAllRecordings())
        assertEquals(null, dao.getRecordingByFilename("deleted.m4a"))
        val tombstone = dao.getRecordingByFilenameIncludingDeleted("deleted.m4a")
        assertEquals(rowId.toInt(), tombstone?.id)
        assertEquals(123_000L, tombstone?.deletedAt)
        assertEquals(RecordingStatus.UPLOADING.value, tombstone?.status)
    }
}
