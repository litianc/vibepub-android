package cn.litianc.vibepub

import android.content.Context
import androidx.work.ListenableWorker
import androidx.work.Data
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
        preferences = AppPreferences(context, TestAuthTokenStore())
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

    @Test
    fun uploadWorkInputPersistsSessionIdentityWithoutAnyToken() {
        val file = createUploadFile("input-data")
        preferences.saveAuthSession(testSession("usr_input", "secret-access", "secret-refresh"))

        val input = RecordingUploadCoordinator.uploadWorkInputData(preferences, file)

        assertNull(input.getString(UploadWorker.KEY_ACCESS_TOKEN))
        assertFalse(input.toString().contains("secret-access"))
        assertFalse(input.toString().contains("secret-refresh"))
        assertEquals("usr_input", input.getString(UploadWorker.KEY_USER_ID))
        assertEquals(
            preferences.currentAuthSessionSnapshot().sessionId,
            input.getString(UploadWorker.KEY_LOCAL_SESSION_ID),
        )
    }

    @Test
    fun accountSwitchStopsQueuedUploadWithoutNetwork() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val baseUrl = startServer(uploadHits, refreshStatus = null)
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession("usr_account_a", "access-a", "refresh-a"))
        val queued = preferences.currentAuthSessionSnapshot()
        val file = createUploadFile("account-switch")
        insertUploadingRecording(queued.userId, file)
        preferences.saveAuthSession(testSession("usr_account_b", "access-b", "refresh-b"))

        val result = runWorker(file, queued.userId, baseUrl, queued.sessionId)

        assertTrue(result is ListenableWorker.Result.Failure)
        assertEquals(0, uploadHits.get())
    }

    @Test
    fun logoutStopsQueuedUploadWithoutNetwork() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val baseUrl = startServer(uploadHits, refreshStatus = null)
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession("usr_logout", "access", "refresh"))
        val queued = preferences.currentAuthSessionSnapshot()
        val file = createUploadFile("logout")
        insertUploadingRecording(queued.userId, file)
        preferences.clearAuthSession()

        val result = runWorker(file, queued.userId, baseUrl, queued.sessionId)

        assertTrue(result is ListenableWorker.Result.Failure)
        assertEquals(0, uploadHits.get())
    }

    @Test
    fun sameUserNewSessionStopsOldQueuedUploadWithoutNetwork() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val baseUrl = startServer(uploadHits, refreshStatus = null)
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession("usr_replaced", "old-access", "old-refresh"))
        val queued = preferences.currentAuthSessionSnapshot()
        val file = createUploadFile("session-replaced")
        insertUploadingRecording(queued.userId, file)
        preferences.saveAuthSession(testSession("usr_replaced", "new-access", "new-refresh"))

        val result = runWorker(file, queued.userId, baseUrl, queued.sessionId)

        assertTrue(result is ListenableWorker.Result.Failure)
        assertEquals(0, uploadHits.get())
    }

    @Test
    fun legacyQueuedAccessTokenIsIgnoredWithoutSessionIdentity() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val baseUrl = startServer(uploadHits, refreshStatus = null)
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession("usr_legacy_work", "current-access", "current-refresh"))
        val file = createUploadFile("legacy-work")
        insertUploadingRecording("usr_legacy_work", file)

        val result = runWorker(
            file = file,
            userId = "usr_legacy_work",
            apiBaseUrl = baseUrl,
            localSessionId = null,
            legacyAccessToken = "persisted-legacy-access",
        )

        assertTrue(result is ListenableWorker.Result.Failure)
        assertEquals(0, uploadHits.get())
    }

    @Test
    fun matchingQueuedSessionCanRefreshAndCompleteUpload() = runBlocking {
        val uploadHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startRefreshableServer(uploadHits, refreshHits)
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession("usr_upload", "expired-access", "refresh-token"))
        val queued = preferences.currentAuthSessionSnapshot()
        val file = createUploadFile("refresh-success")
        insertUploadingRecording(queued.userId, file)

        val result = runWorker(file, queued.userId, baseUrl, queued.sessionId)

        assertTrue(result is ListenableWorker.Result.Success)
        assertEquals(2, uploadHits.get())
        assertEquals(1, refreshHits.get())
        assertEquals("fresh-access", preferences.accessToken)
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

    private suspend fun runWorker(
        file: File,
        userId: String,
        apiBaseUrl: String,
        localSessionId: String? = preferences.currentAuthSessionSnapshot().sessionId,
        legacyAccessToken: String? = null,
    ): ListenableWorker.Result {
        val input = Data.Builder()
            .putString(UploadWorker.KEY_FILE_PATH, file.absolutePath)
            .putString(UploadWorker.KEY_API_BASE_URL, apiBaseUrl)
            .putString(UploadWorker.KEY_USER_ID, userId)
            .apply {
                localSessionId?.let { putString(UploadWorker.KEY_LOCAL_SESSION_ID, it) }
                legacyAccessToken?.let { putString(UploadWorker.KEY_ACCESS_TOKEN, it) }
            }
            .build()
        val worker = TestListenableWorkerBuilder<UploadWorker>(context)
            .setWorkerFactory(object : WorkerFactory() {
                override fun createWorker(
                    appContext: Context,
                    workerClassName: String,
                    workerParameters: WorkerParameters,
                ): ListenableWorker = UploadWorker(appContext, workerParameters, preferences)
            })
            .setInputData(input)
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

    private fun startRefreshableServer(uploadHits: AtomicInteger, refreshHits: AtomicInteger): String {
        val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        httpServer.executor = Executors.newCachedThreadPool()
        httpServer.createContext("/api/uploads") { exchange ->
            uploadHits.incrementAndGet()
            exchange.requestBody.use { it.readBytes() }
            val fresh = exchange.requestHeaders.getFirst("Authorization") == "Bearer fresh-access"
            val body = if (fresh) """{"ok":true}""".toByteArray() else """{"error":"unauthorized"}""".toByteArray()
            exchange.sendResponseHeaders(if (fresh) 200 else 401, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        httpServer.createContext("/api/auth/refresh") { exchange ->
            refreshHits.incrementAndGet()
            exchange.requestBody.use { it.readBytes() }
            val body = """
                {
                  "user": {"id":"usr_upload","email":"usr_upload@example.test","role":"user","workspace_id":"ws_usr_upload","email_verified":true},
                  "tokens": {
                    "access_token":"fresh-access","refresh_token":"fresh-refresh","session_id":"ses_upload",
                    "generation":1,"access_expires_at":"2026-07-14T10:00:00.000Z",
                    "idle_expires_at":"2027-01-10T00:00:00.000Z","refresh_expires_at":"2027-01-10T00:00:00.000Z",
                    "contract_version":2
                  }
                }
            """.trimIndent().toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
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
