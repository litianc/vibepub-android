package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

data class AuthenticatedHttpResponse(
    val statusCode: Int,
    val body: String,
)

data class AuthenticatedHttpBinaryResponse(
    val statusCode: Int,
    val body: ByteArray,
)

class AuthenticatedRequestException(
    message: String,
    val retryable: Boolean,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

object AuthenticatedHttpClient {
    private val refreshMutex = Mutex()

    suspend fun request(
        preferences: AppPreferences,
        url: URL,
        method: String = "GET",
        body: ByteArray? = null,
        contentType: String? = null,
        connectTimeoutMs: Int = 15_000,
        readTimeoutMs: Int = 60_000,
        configure: (HttpURLConnection) -> Unit = {},
    ): AuthenticatedHttpResponse = execute(preferences) { accessToken ->
        (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            setRequestProperty("Authorization", "Bearer $accessToken")
            configure(this)
            if (body != null) {
                doOutput = true
                if (!contentType.isNullOrBlank()) {
                    setRequestProperty("Content-Type", contentType)
                }
                setFixedLengthStreamingMode(body.size)
                outputStream.use { it.write(body) }
            }
        }
    }

    suspend fun requestBytes(
        preferences: AppPreferences,
        url: URL,
        method: String = "GET",
        connectTimeoutMs: Int = 15_000,
        readTimeoutMs: Int = 60_000,
        configure: (HttpURLConnection) -> Unit = {},
    ): AuthenticatedHttpBinaryResponse = executeBytes(preferences) { accessToken ->
        (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            setRequestProperty("Authorization", "Bearer $accessToken")
            configure(this)
        }
    }

    suspend fun execute(
        preferences: AppPreferences,
        openConnection: (accessToken: String) -> HttpURLConnection,
    ): AuthenticatedHttpResponse = withContext(Dispatchers.IO) {
        val initialToken = preferences.accessToken.trim()
        if (initialToken.isBlank()) {
            throw AuthenticatedRequestException(
                message = "登录信息不完整，请重新登录",
                retryable = false,
            )
        }

        val first = perform(openConnection, initialToken)
        if (first.statusCode != HttpURLConnection.HTTP_UNAUTHORIZED) {
            return@withContext first
        }

        if (!refreshAccessToken(preferences, failedAccessToken = initialToken)) {
            return@withContext first
        }

        retryAfterRefresh { perform(openConnection, preferences.accessToken.trim()) }
    }

    suspend fun executeBytes(
        preferences: AppPreferences,
        openConnection: (accessToken: String) -> HttpURLConnection,
    ): AuthenticatedHttpBinaryResponse = withContext(Dispatchers.IO) {
        val initialToken = preferences.accessToken.trim()
        if (initialToken.isBlank()) {
            throw AuthenticatedRequestException(
                message = "登录信息不完整，请重新登录",
                retryable = false,
            )
        }

        val first = performBytes(openConnection, initialToken)
        if (first.statusCode != HttpURLConnection.HTTP_UNAUTHORIZED) {
            return@withContext first
        }

        if (!refreshAccessToken(preferences, failedAccessToken = initialToken)) {
            return@withContext first
        }

        retryAfterRefresh { performBytes(openConnection, preferences.accessToken.trim()) }
    }

    private fun perform(
        openConnection: (accessToken: String) -> HttpURLConnection,
        accessToken: String,
    ): AuthenticatedHttpResponse {
        val connection = openConnection(accessToken)
        return try {
            val status = connection.responseCode
            val body = if (status in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
            }
            AuthenticatedHttpResponse(status, body)
        } finally {
            connection.disconnect()
        }
    }

    private fun performBytes(
        openConnection: (accessToken: String) -> HttpURLConnection,
        accessToken: String,
    ): AuthenticatedHttpBinaryResponse {
        val connection = openConnection(accessToken)
        return try {
            val status = connection.responseCode
            val body = if (status in 200..299) {
                connection.inputStream.use { it.readBytes() }
            } else {
                connection.errorStream?.use { it.readBytes() } ?: ByteArray(0)
            }
            AuthenticatedHttpBinaryResponse(status, body)
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun refreshAccessToken(
        preferences: AppPreferences,
        failedAccessToken: String,
    ): Boolean = refreshMutex.withLock {
        val currentAccessToken = preferences.accessToken.trim()
        if (currentAccessToken.isBlank()) {
            throw AuthenticatedRequestException(
                message = "登录信息不完整，请重新登录",
                retryable = false,
            )
        }
        if (currentAccessToken != failedAccessToken) return@withLock true

        val currentRefreshToken = preferences.refreshToken.trim()
        if (currentRefreshToken.isBlank()) {
            throw AuthenticatedRequestException(
                message = "登录信息不完整，请重新登录",
                retryable = false,
            )
        }

        runCatching {
            AuthApi.refresh(preferences.apiBaseUrl, currentRefreshToken)
        }.fold(
            onSuccess = { session ->
                if (session.accessToken.isBlank() || session.refreshToken.isBlank()) {
                    throw AuthenticatedRequestException(
                        message = "会话刷新返回不完整的登录信息，请稍后重试",
                        retryable = true,
                    )
                }
                preferences.saveAuthSession(session)
                true
            },
            onFailure = { error ->
                if (error is CancellationException) {
                    throw error
                }
                if (error is AuthApiException && error.statusCode in INVALID_REFRESH_TOKEN_STATUS_CODES) {
                    preferences.clearAuthSession()
                    return@fold false
                }
                if (error is AuthenticatedRequestException) {
                    throw error
                }
                throw AuthenticatedRequestException(
                    message = "会话刷新暂时失败，请稍后重试",
                    retryable = true,
                    cause = error,
                )
            },
        )
    }

    private fun <T> retryAfterRefresh(request: () -> T): T = try {
        request()
    } catch (error: Throwable) {
        if (error is CancellationException) {
            throw error
        }
        throw AuthenticatedRequestException(
            message = "会话已恢复，但原请求重试失败，请重试",
            retryable = true,
            cause = error,
        )
    }

    private val INVALID_REFRESH_TOKEN_STATUS_CODES = setOf(
        HttpURLConnection.HTTP_BAD_REQUEST,
        HttpURLConnection.HTTP_UNAUTHORIZED,
        HttpURLConnection.HTTP_FORBIDDEN,
    )
}
