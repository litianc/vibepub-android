package cn.litianc.vibepub

import android.content.Context
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadWorkerTest {
    private lateinit var context: Context
    private lateinit var preferences: AppPreferences
    private var server: HttpServer? = null
    private val filesToDelete = mutableListOf<File>()
    private val recordingsToDelete = mutableListOf<Pair<String, String>>()

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        preferences = AppPreferences(context)
        preferences.clearAuthSession()
    }

    @After
    fun tearDown() = runBlocking {
        server?.stop(0)
        filesToDelete.forEach(File::delete)
        val dao = AppDatabase.getDatabase(context).recordingDao()
        recordingsToDelete.forEach { (userId, filename) ->
            dao.deleteByFilename(userId, filename)
        }
        preferences.clearAuthSession()
    }

    @Test
    fun nonRetryableAuthenticationFailureStopsTheUploadRetryLoop() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val baseUrl = startServer(uploadHits, refreshStatus = null)
        val userId = "usr_upload_terminal"
        val file = createUploadFile("terminal")
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(
            testSession(
                userId = userId,
                accessToken = "access-terminal",
                refreshToken = "",
            ),
        )
        insertUploadingRecording(userId, file)

        val result = runWorker(file, userId, baseUrl)
        val recording = AppDatabase.getDatabase(context).recordingDao()
            .getRecordingByFilename(userId, file.name)

        assertTrue(result is ListenableWorker.Result.Failure)
        assertEquals(1, uploadHits.get())
        requireNotNull(recording)
        assertEquals(RecordingStatus.FAILED.value, recording.status)
        assertTrue(recording.lastError.orEmpty().contains("重新登录"))
    }

    @Test
    fun temporaryRefreshFailureKeepsTheUploadRetryable() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val baseUrl = startServer(uploadHits, refreshStatus = 503)
        val userId = "usr_upload_retry"
        val file = createUploadFile("retry")
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(
            testSession(
                userId = userId,
                accessToken = "access-retry",
                refreshToken = "refresh-retry",
            ),
        )
        insertUploadingRecording(userId, file)

        val result = runWorker(file, userId, baseUrl)
        val recording = AppDatabase.getDatabase(context).recordingDao()
            .getRecordingByFilename(userId, file.name)

        assertTrue(result is ListenableWorker.Result.Retry)
        assertEquals(1, uploadHits.get())
        requireNotNull(recording)
        assertEquals(RecordingStatus.UPLOADING.value, recording.status)
        assertTrue(recording.lastError.orEmpty().contains("会话刷新"))
    }

    private fun createUploadFile(label: String): File {
        val file = File(context.cacheDir, "upload-worker-$label-${System.nanoTime()}.m4a")
        file.writeBytes(byteArrayOf(1, 2, 3, 4))
        filesToDelete += file
        return file
    }

    private suspend fun insertUploadingRecording(userId: String, file: File) {
        AppDatabase.getDatabase(context).recordingDao().insert(
            RecordingEntity(
                userId = userId,
                filename = file.name,
                durationMs = 4_000L,
                timestamp = System.currentTimeMillis(),
                status = RecordingStatus.UPLOADING.value,
                localAudioPath = file.absolutePath,
            ),
        )
        recordingsToDelete += userId to file.name
    }

    private suspend fun runWorker(file: File, userId: String, apiBaseUrl: String): ListenableWorker.Result {
        val worker = TestListenableWorkerBuilder<UploadWorker>(context)
            .setInputData(
                workDataOf(
                    UploadWorker.KEY_FILE_PATH to file.absolutePath,
                    UploadWorker.KEY_API_BASE_URL to apiBaseUrl,
                    UploadWorker.KEY_ACCESS_TOKEN to preferences.accessToken,
                    UploadWorker.KEY_USER_ID to userId,
                ),
            )
            .build()
        return worker.doWork()
    }

    private fun startServer(uploadHits: AtomicInteger, refreshStatus: Int?): String {
        val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        httpServer.executor = Executors.newCachedThreadPool()
        httpServer.createContext("/api/uploads") { exchange ->
            uploadHits.incrementAndGet()
            exchange.requestBody.use { it.readBytes() }
            val body = """{"error":"unauthorized"}""".toByteArray()
            exchange.sendResponseHeaders(401, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        httpServer.createContext("/api/auth/refresh") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            if (refreshStatus == null) {
                exchange.close()
                return@createContext
            }
            val body = """{"error":"refresh unavailable"}""".toByteArray()
            exchange.sendResponseHeaders(refreshStatus, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        httpServer.start()
        server = httpServer
        return "http://127.0.0.1:${httpServer.address.port}"
    }

    private fun testSession(userId: String, accessToken: String, refreshToken: String) = AuthSession(
        user = AuthUser(
            id = userId,
            email = "$userId@example.test",
            role = "user",
            workspaceId = "ws_$userId",
            emailVerified = true,
        ),
        accessToken = accessToken,
        refreshToken = refreshToken,
    )
}
