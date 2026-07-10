package cn.litianc.vibepub

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.InetSocketAddress
import java.io.IOException
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthenticatedHttpClientTest {
    private lateinit var preferences: AppPreferences
    private var server: HttpServer? = null
    private var serverExecutor: ExecutorService? = null

    @Before
    fun setUp() {
        preferences = AppPreferences(RuntimeEnvironment.getApplication())
        preferences.clearAuthSession()
    }

    @After
    fun tearDown() {
        server?.stop(0)
        serverExecutor?.shutdownNow()
        preferences.clearAuthSession()
    }

    @Test
    fun requestRefreshesAccessTokenOnUnauthorizedAndRetriesOnce() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val response = AuthenticatedHttpClient.request(
            preferences = preferences,
            url = URL("$baseUrl/api/protected"),
            method = "GET",
        )

        assertEquals(200, response.statusCode)
        assertEquals("""{"ok":true}""", response.body)
        assertEquals("fresh-access", preferences.accessToken)
        assertEquals("fresh-refresh", preferences.refreshToken)
        assertEquals(2, protectedHits.get())
        assertEquals(1, refreshHits.get())
        assertTrue(preferences.isAuthenticated)
    }

    @Test
    fun concurrentUnauthorizedRequestsShareOneRefreshAndRetryWithFreshToken() = runBlocking {
        val requestCount = 6
        val protectedHits = AtomicInteger(0)
        val expiredHits = AtomicInteger(0)
        val freshHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val expiredLatch = CountDownLatch(requestCount)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
            onProtected = { authHeader ->
                when (authHeader) {
                    "Bearer expired-access" -> {
                        expiredHits.incrementAndGet()
                        expiredLatch.countDown()
                        expiredLatch.await(2, TimeUnit.SECONDS)
                        401 to """{"error":"unauthorized"}"""
                    }
                    "Bearer fresh-access" -> {
                        freshHits.incrementAndGet()
                        200 to """{"ok":true}"""
                    }
                    else -> 401 to """{"error":"unexpected token"}"""
                }
            },
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val responses = (1..requestCount)
            .map {
                async(Dispatchers.IO) {
                    AuthenticatedHttpClient.request(
                        preferences = preferences,
                        url = URL("$baseUrl/api/protected"),
                        method = "GET",
                    )
                }
            }
            .awaitAll()

        assertTrue(responses.all { it.statusCode == 200 })
        assertEquals("fresh-access", preferences.accessToken)
        assertEquals("fresh-refresh", preferences.refreshToken)
        assertEquals(requestCount, expiredHits.get())
        assertEquals(requestCount, freshHits.get())
        assertEquals(requestCount * 2, protectedHits.get())
        assertEquals(1, refreshHits.get())
        assertTrue(preferences.isAuthenticated)
    }

    @Test
    fun requestDoesNotReplayWithAnotherAccountsSessionAfterAccountSwitch() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
            onProtected = {
                preferences.saveAuthSession(
                    testSession(
                        accessToken = "account-b-access",
                        refreshToken = "account-b-refresh",
                        userId = "usr_account_b",
                    ),
                )
                401 to """{"error":"unauthorized"}"""
            },
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(
            testSession(
                accessToken = "account-a-expired",
                refreshToken = "account-a-refresh",
                userId = "usr_account_a",
            ),
        )

        val error = expectAuthenticatedFailure {
            AuthenticatedHttpClient.request(
                preferences = preferences,
                url = URL("$baseUrl/api/protected"),
            )
        }

        assertFalse(error.retryable)
        assertTrue(error.message.orEmpty().contains("已切换"))
        assertEquals(1, protectedHits.get())
        assertEquals(0, refreshHits.get())
        assertEquals("usr_account_b", preferences.userId)
        assertEquals("account-b-access", preferences.accessToken)
        assertEquals("account-b-refresh", preferences.refreshToken)
    }

    @Test
    fun requestDoesNotReplayAfterLogoutDuringUnauthorizedResponse() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
            onProtected = {
                preferences.clearAuthSession()
                401 to """{"error":"unauthorized"}"""
            },
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(
            testSession(accessToken = "account-a-expired", refreshToken = "account-a-refresh"),
        )

        val error = expectAuthenticatedFailure {
            AuthenticatedHttpClient.request(
                preferences = preferences,
                url = URL("$baseUrl/api/protected"),
            )
        }

        assertFalse(error.retryable)
        assertEquals(1, protectedHits.get())
        assertEquals(0, refreshHits.get())
        assertFalse(preferences.isAuthenticated)
    }

    @Test
    fun refreshCompletionDoesNotOverwriteAnotherAccountThatLoggedInDuringRefresh() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
            onRefresh = {
                preferences.saveAuthSession(
                    testSession(
                        accessToken = "account-b-access",
                        refreshToken = "account-b-refresh",
                        userId = "usr_account_b",
                    ),
                )
            },
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(
            testSession(
                accessToken = "account-a-expired",
                refreshToken = "account-a-refresh",
                userId = "usr_account_a",
            ),
        )

        val error = expectAuthenticatedFailure {
            AuthenticatedHttpClient.request(
                preferences = preferences,
                url = URL("$baseUrl/api/protected"),
            )
        }

        assertFalse(error.retryable)
        assertEquals(1, protectedHits.get())
        assertEquals(1, refreshHits.get())
        assertEquals("usr_account_b", preferences.userId)
        assertEquals("account-b-access", preferences.accessToken)
        assertEquals("account-b-refresh", preferences.refreshToken)
    }

    @Test
    fun requestClearsSessionWhenRefreshTokenIsRejected() = runBlocking {
        listOf(400, 401, 403).forEach { refreshStatus ->
            server?.stop(0)
            serverExecutor?.shutdownNow()
            val baseUrl = startServer(
                protectedHits = AtomicInteger(0),
                refreshHits = AtomicInteger(0),
                refreshStatus = refreshStatus,
            )
            preferences.apiBaseUrl = baseUrl
            preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "expired-refresh"))

            val response = AuthenticatedHttpClient.request(
                preferences = preferences,
                url = URL("$baseUrl/api/protected"),
                method = "GET",
            )

            assertEquals(401, response.statusCode)
            assertFalse(preferences.isAuthenticated)
            assertEquals("", preferences.accessToken)
            assertEquals("", preferences.refreshToken)
        }
    }

    @Test
    fun refreshRateLimitAndServerErrorsDoNotClearSession() = runBlocking {
        listOf(429, 500, 503).forEach { refreshStatus ->
            server?.stop(0)
            serverExecutor?.shutdownNow()
            val protectedHits = AtomicInteger(0)
            val refreshHits = AtomicInteger(0)
            val baseUrl = startServer(
                protectedHits = protectedHits,
                refreshHits = refreshHits,
                refreshStatus = refreshStatus,
            )
            preferences.apiBaseUrl = baseUrl
            preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

            val error = expectRetryableFailure {
                AuthenticatedHttpClient.request(
                    preferences = preferences,
                    url = URL("$baseUrl/api/protected"),
                    method = "GET",
                )
            }

            assertTrue(error.retryable)
            assertTrue(error.message.orEmpty().contains("会话刷新"))
            assertEquals("expired-access", preferences.accessToken)
            assertEquals("refresh-token", preferences.refreshToken)
            assertTrue(preferences.isAuthenticated)
            assertEquals(1, protectedHits.get())
            assertEquals(1, refreshHits.get())
        }
    }

    @Test
    fun refreshNetworkErrorDoesNotClearSession() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = null,
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val error = expectRetryableFailure {
            AuthenticatedHttpClient.request(
                preferences = preferences,
                url = URL("$baseUrl/api/protected"),
                method = "GET",
            )
        }

        assertTrue(error.retryable)
        assertTrue(error.message.orEmpty().contains("会话刷新"))
        assertEquals("expired-access", preferences.accessToken)
        assertEquals("refresh-token", preferences.refreshToken)
        assertTrue(preferences.isAuthenticated)
        assertEquals(1, protectedHits.get())
        assertEquals(1, refreshHits.get())
    }

    @Test
    fun requestDoesNotRetryMoreThanOnceAfterRefresh() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
            onProtected = { 401 to """{"error":"still unauthorized"}""" },
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val response = AuthenticatedHttpClient.request(
            preferences = preferences,
            url = URL("$baseUrl/api/protected"),
            method = "GET",
        )

        assertEquals(401, response.statusCode)
        assertEquals("fresh-access", preferences.accessToken)
        assertEquals("fresh-refresh", preferences.refreshToken)
        assertEquals(2, protectedHits.get())
        assertEquals(1, refreshHits.get())
    }

    @Test
    fun binaryRequestRefreshesAndUsesRotatedToken() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val response = AuthenticatedHttpClient.requestBytes(
            preferences = preferences,
            url = URL("$baseUrl/api/protected"),
        )

        assertEquals(200, response.statusCode)
        assertEquals("{\"ok\":true}", response.body.decodeToString())
        assertEquals("fresh-access", preferences.accessToken)
        assertEquals("fresh-refresh", preferences.refreshToken)
        assertEquals(2, protectedHits.get())
        assertEquals(1, refreshHits.get())
    }

    @Test
    fun incompleteRefreshSessionPreservesExistingSessionAndIsRetryable() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
            refreshBody = """
                {
                  "user": {
                    "id": "usr_current",
                    "email": "current@example.test",
                    "role": "user",
                    "workspace_id": "ws_current",
                    "email_verified": true
                  },
                  "tokens": {
                    "access_token": "fresh-access",
                    "refresh_token": ""
                  }
                }
            """.trimIndent(),
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val error = try {
            AuthenticatedHttpClient.request(
                preferences = preferences,
                url = URL("$baseUrl/api/protected"),
            )
            throw AssertionError("Expected a refresh failure")
        } catch (expected: AuthenticatedRequestException) {
            expected
        }

        assertTrue(error.retryable)
        assertTrue(error.message.orEmpty().contains("不完整"))
        assertEquals("expired-access", preferences.accessToken)
        assertEquals("refresh-token", preferences.refreshToken)
        assertTrue(preferences.isAuthenticated)
        assertEquals(1, protectedHits.get())
        assertEquals(1, refreshHits.get())
    }

    @Test
    fun replayNetworkFailureIsRetryableAndPreservesRotatedSession() = runBlocking {
        val protectedHits = AtomicInteger(0)
        val refreshHits = AtomicInteger(0)
        val baseUrl = startServer(
            protectedHits = protectedHits,
            refreshHits = refreshHits,
            refreshStatus = 200,
        )
        preferences.apiBaseUrl = baseUrl
        preferences.saveAuthSession(testSession(accessToken = "expired-access", refreshToken = "refresh-token"))

        val error = try {
            AuthenticatedHttpClient.execute(preferences) { accessToken ->
                if (accessToken == "fresh-access") {
                    throw IOException("replay connection refused")
                }
                URL("$baseUrl/api/protected").openConnection() as java.net.HttpURLConnection
            }
            throw AssertionError("Expected a replay failure")
        } catch (expected: AuthenticatedRequestException) {
            expected
        }

        assertTrue(error.retryable)
        assertTrue(error.message.orEmpty().contains("重试失败"))
        assertTrue(error.cause is IOException)
        assertEquals("fresh-access", preferences.accessToken)
        assertEquals("fresh-refresh", preferences.refreshToken)
        assertTrue(preferences.isAuthenticated)
        assertEquals(1, protectedHits.get())
        assertEquals(1, refreshHits.get())
    }

    private fun startServer(
        protectedHits: AtomicInteger,
        refreshHits: AtomicInteger,
        refreshStatus: Int?,
        refreshBody: String? = null,
        onRefresh: () -> Unit = {},
        onProtected: (authHeader: String?) -> Pair<Int, String> = { authHeader ->
            if (authHeader == "Bearer fresh-access") {
                200 to """{"ok":true}"""
            } else {
                401 to """{"error":"unauthorized"}"""
            }
        },
    ): String {
        val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val executor = Executors.newCachedThreadPool()
        httpServer.executor = executor
        httpServer.createContext("/api/protected") { exchange ->
            protectedHits.incrementAndGet()
            val (status, text) = onProtected(exchange.requestHeaders.getFirst("Authorization"))
            val body = text.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        httpServer.createContext("/api/auth/refresh") { exchange ->
            refreshHits.incrementAndGet()
            exchange.requestBody.use { it.readBytes() }
            onRefresh()
            if (refreshStatus == null) {
                exchange.close()
                return@createContext
            }
            val body = refreshBody?.toByteArray() ?: if (refreshStatus in 200..299) {
                """
                {
                  "user": {
                    "id": "usr_current",
                    "email": "current@example.test",
                    "role": "user",
                    "workspace_id": "ws_current",
                    "email_verified": true
                  },
                  "tokens": {
                    "access_token": "fresh-access",
                    "refresh_token": "fresh-refresh"
                  }
                }
                """.trimIndent().toByteArray()
            } else {
                """{"error":"refresh failed"}""".toByteArray()
            }
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(refreshStatus, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        httpServer.start()
        server = httpServer
        serverExecutor = executor
        return "http://127.0.0.1:${httpServer.address.port}"
    }

    private fun testSession(
        accessToken: String,
        refreshToken: String,
        userId: String = "usr_current",
    ) = AuthSession(
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

    private suspend fun <T> expectRetryableFailure(block: suspend () -> T): AuthenticatedRequestException {
        val error = expectAuthenticatedFailure(block)
        assertTrue("Expected a retryable authentication request failure", error.retryable)
        return error
    }

    private suspend fun <T> expectAuthenticatedFailure(block: suspend () -> T): AuthenticatedRequestException {
        return try {
            block()
            throw AssertionError("Expected an authentication request failure")
        } catch (expected: AuthenticatedRequestException) {
            expected
        }
    }
}
