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
    fun keepsOneRowPerFilenameThroughReplace() = runBlocking {
        val dao = database.recordingDao()
        dao.insert(
            RecordingEntity(
                filename = "same.m4a",
                durationMs = 32_000L,
                timestamp = 1L,
                status = RecordingStatus.COMPLETED.value,
            ),
        )
        dao.insert(
            RecordingEntity(
                filename = "same.m4a",
                durationMs = 0L,
                timestamp = 2L,
                status = RecordingStatus.LOCAL_RECORDED.value,
            ),
        )

        val recordings = dao.getAllRecordings()
        assertEquals(1, recordings.size)
        assertEquals(0L, recordings.first().durationMs)
        assertEquals(RecordingStatus.LOCAL_RECORDED.value, recordings.first().status)
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
}
