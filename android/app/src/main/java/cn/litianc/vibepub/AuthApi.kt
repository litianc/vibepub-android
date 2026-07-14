package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class AuthUser(
    val id: String,
    val email: String,
    val role: String,
    val workspaceId: String,
    val emailVerified: Boolean,
)

data class AuthSession(
    val user: AuthUser,
    val accessToken: String,
    val refreshToken: String,
    val serverSessionId: String = "",
    val generation: Int = 0,
    val accessExpiresAt: String = "",
    val idleExpiresAt: String = "",
    val refreshExpiresAt: String = "",
    val contractVersion: Int = 2,
)

data class PublishingAccount(
    val connected: Boolean,
    val appId: String?,
    val proxyUrl: String?,
    val updatedAt: String?,
)

data class AdminUserSummary(
    val id: String,
    val email: String,
    val role: String,
    val status: String,
    val emailVerified: Boolean,
)

data class AdminInvitationSummary(
    val id: String,
    val email: String,
    val role: String,
    val inviteUrl: String?,
)

data class AdminUsersResult(
    val users: List<AdminUserSummary>,
    val invitations: List<AdminInvitationSummary>,
)

data class AdminInviteResult(
    val email: String,
    val role: String,
    val inviteUrl: String?,
    val token: String?,
)

object AuthApi {
    suspend fun login(apiBaseUrl: String, email: String, password: String): AuthSession =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("email", email.trim())
                .put("password", password)
                .toString()
            parseAuthSession(requestJson(apiBaseUrl, "/api/auth/login", "POST", body = body))
        }

    suspend fun refresh(apiBaseUrl: String, refreshToken: String, refreshRequestId: String): AuthSession =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("refresh_token", refreshToken.trim())
                .put("refresh_request_id", refreshRequestId.trim())
                .put("contract_version", 2)
                .toString()
            parseAuthSession(requestJson(apiBaseUrl, "/api/auth/refresh", "POST", body = body))
        }

    suspend fun acceptInvite(apiBaseUrl: String, token: String, password: String): AuthSession =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("token", token.trim())
                .put("password", password)
                .toString()
            parseAuthSession(requestJson(apiBaseUrl, "/api/auth/accept-invite", "POST", body = body))
        }

    suspend fun requestPasswordReset(apiBaseUrl: String, email: String) =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("email", email.trim())
                .toString()
            requestJson(apiBaseUrl, "/api/auth/request-password-reset", "POST", body = body)
        }

    suspend fun resetPassword(apiBaseUrl: String, token: String, password: String) =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("token", token.trim())
                .put("password", password)
                .toString()
            requestJson(apiBaseUrl, "/api/auth/reset-password", "POST", body = body)
        }

    suspend fun logout(
        apiBaseUrl: String,
        accessToken: String,
        refreshToken: String,
        allDevices: Boolean = false,
    ) =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("refresh_token", refreshToken.trim())
                .put("scope", if (allDevices) "all" else "current")
                .toString()
            requestJson(apiBaseUrl, "/api/auth/logout", "POST", accessToken = accessToken, body = body)
        }

    suspend fun me(apiBaseUrl: String, accessToken: String): AuthUser =
        withContext(Dispatchers.IO) {
            parseUser(JSONObject(requestJson(apiBaseUrl, "/api/me", "GET", accessToken = accessToken)).getJSONObject("user"))
        }

    suspend fun me(preferences: AppPreferences): AuthUser =
        withContext(Dispatchers.IO) {
            parseUser(JSONObject(authenticatedJson(preferences, "/api/me", "GET")).getJSONObject("user"))
        }

    suspend fun getPublishingAccount(apiBaseUrl: String, accessToken: String): PublishingAccount =
        withContext(Dispatchers.IO) {
            parsePublishingAccount(
                JSONObject(requestJson(apiBaseUrl, "/api/publishing-account", "GET", accessToken = accessToken))
                    .getJSONObject("publishing_account"),
            )
        }

    suspend fun getPublishingAccount(preferences: AppPreferences): PublishingAccount =
        withContext(Dispatchers.IO) {
            parsePublishingAccount(
                JSONObject(authenticatedJson(preferences, "/api/publishing-account", "GET"))
                    .getJSONObject("publishing_account"),
            )
        }

    suspend fun updatePublishingAccount(
        apiBaseUrl: String,
        accessToken: String,
        appId: String,
        appSecret: String,
        proxyUrl: String,
    ): PublishingAccount = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("app_id", appId.trim())
            .put("proxy_url", proxyUrl.trim())
        if (appSecret.isNotBlank()) {
            body.put("app_secret", appSecret.trim())
        }
        parsePublishingAccount(
            JSONObject(
                requestJson(
                    apiBaseUrl,
                    "/api/publishing-account",
                    "PUT",
                    accessToken = accessToken,
                    body = body.toString(),
                ),
            ).getJSONObject("publishing_account"),
        )
    }

    suspend fun updatePublishingAccount(
        preferences: AppPreferences,
        appId: String,
        appSecret: String,
        proxyUrl: String,
    ): PublishingAccount = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("app_id", appId.trim())
            .put("proxy_url", proxyUrl.trim())
        if (appSecret.isNotBlank()) {
            body.put("app_secret", appSecret.trim())
        }
        parsePublishingAccount(
            JSONObject(
                authenticatedJson(
                    preferences,
                    "/api/publishing-account",
                    "PUT",
                    body = body.toString(),
                ),
            ).getJSONObject("publishing_account"),
        )
    }

    suspend fun listAdminUsers(apiBaseUrl: String, accessToken: String): AdminUsersResult =
        withContext(Dispatchers.IO) {
            parseAdminUsers(requestJson(apiBaseUrl, "/api/admin/users", "GET", accessToken = accessToken))
        }

    suspend fun listAdminUsers(preferences: AppPreferences): AdminUsersResult =
        withContext(Dispatchers.IO) {
            parseAdminUsers(authenticatedJson(preferences, "/api/admin/users", "GET"))
        }

    suspend fun inviteUser(apiBaseUrl: String, accessToken: String, email: String, role: String): AdminInviteResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("email", email.trim())
                .put("role", if (role == "admin") "admin" else "user")
                .toString()
            val json = JSONObject(requestJson(apiBaseUrl, "/api/admin/users", "POST", accessToken = accessToken, body = body))
            val invitation = json.getJSONObject("invitation")
            AdminInviteResult(
                email = invitation.optString("email"),
                role = invitation.optString("role", "user"),
                inviteUrl = invitation.optString("invite_url").blankToNull(),
                token = invitation.optString("token").blankToNull(),
            )
        }

    suspend fun inviteUser(preferences: AppPreferences, email: String, role: String): AdminInviteResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("email", email.trim())
                .put("role", if (role == "admin") "admin" else "user")
                .toString()
            val json = JSONObject(authenticatedJson(preferences, "/api/admin/users", "POST", body = body))
            val invitation = json.getJSONObject("invitation")
            AdminInviteResult(
                email = invitation.optString("email"),
                role = invitation.optString("role", "user"),
                inviteUrl = invitation.optString("invite_url").blankToNull(),
                token = invitation.optString("token").blankToNull(),
            )
        }

    private suspend fun authenticatedJson(
        preferences: AppPreferences,
        path: String,
        method: String,
        body: String? = null,
    ): String {
        val payload = body?.toByteArray(Charsets.UTF_8)
        val response = AuthenticatedHttpClient.request(
            preferences = preferences,
            url = URL("${preferences.apiBaseUrl.trimEnd('/')}$path"),
            method = method,
            body = payload,
            contentType = if (payload != null) "application/json; charset=utf-8" else null,
        )
        if (response.statusCode !in 200..299) {
            throw AuthApiException(
                statusCode = response.statusCode,
                responseBody = response.body,
                userMessage = authFailureMessage(response.statusCode, response.body),
            )
        }
        return response.body
    }

    private fun requestJson(
        apiBaseUrl: String,
        path: String,
        method: String,
        accessToken: String = "",
        body: String? = null,
    ): String {
        val payload = body?.toByteArray(Charsets.UTF_8)
        val connection = (URL("${apiBaseUrl.trimEnd('/')}$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 60_000
            if (accessToken.isNotBlank()) {
                setRequestProperty("Authorization", "Bearer ${accessToken.trim()}")
            }
            if (payload != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        if (payload != null) {
            connection.outputStream.use { it.write(payload) }
        }

        val status = connection.responseCode
        val responseBody = if (status in 200..299) {
            connection.inputStream.bufferedReader().use { it.readText() }
        } else {
            val responseStream = try {
                connection.inputStream
            } catch (_: Exception) {
                connection.errorStream
            }
            responseStream?.bufferedReader()?.use { it.readText() }.orEmpty()
        }
        connection.disconnect()
        if (status !in 200..299) {
            throw AuthApiException(
                statusCode = status,
                responseBody = responseBody,
                userMessage = authFailureMessage(status, responseBody),
            )
        }
        return responseBody
    }
}

class AuthApiException(
    val statusCode: Int,
    val responseBody: String,
    userMessage: String,
    val reason: String = parseAuthErrorField(responseBody, "reason"),
    val retryable: Boolean = parseAuthErrorBoolean(responseBody, "retryable", statusCode == 408 || statusCode == 429 || statusCode >= 500),
    val clearSession: Boolean = parseAuthErrorBoolean(responseBody, "clear_session", false),
) : IllegalStateException(userMessage)

internal fun parseAuthSession(responseBody: String): AuthSession {
    val json = JSONObject(responseBody)
    val tokens = json.getJSONObject("tokens")
    require(tokens.getInt("contract_version") == 2) { "Unsupported auth contract" }
    return AuthSession(
        user = parseUser(json.getJSONObject("user")),
        accessToken = tokens.getString("access_token"),
        refreshToken = tokens.getString("refresh_token"),
        serverSessionId = tokens.getString("session_id"),
        generation = tokens.getInt("generation"),
        accessExpiresAt = tokens.getString("access_expires_at"),
        idleExpiresAt = tokens.getString("idle_expires_at"),
        refreshExpiresAt = tokens.getString("refresh_expires_at"),
        contractVersion = tokens.getInt("contract_version"),
    )
}

private fun parseAuthErrorField(body: String, key: String): String = runCatching {
    JSONObject(body.ifBlank { "{}" }).optString(key)
}.getOrDefault("")

private fun parseAuthErrorBoolean(body: String, key: String, default: Boolean): Boolean = runCatching {
    JSONObject(body.ifBlank { "{}" }).optBoolean(key, default)
}.getOrDefault(default)

internal fun parseUser(json: JSONObject): AuthUser {
    return AuthUser(
        id = json.getString("id"),
        email = json.optString("email"),
        role = json.optString("role", "user"),
        workspaceId = json.optString("workspace_id")
            .ifBlank { json.optString("workspaceId") },
        emailVerified = json.optBoolean("email_verified", json.optBoolean("emailVerified", false)),
    )
}

internal fun parsePublishingAccount(json: JSONObject): PublishingAccount {
    return PublishingAccount(
        connected = json.optBoolean("connected", false),
        appId = json.optString("app_id").blankToNull(),
        proxyUrl = json.optString("proxy_url").blankToNull(),
        updatedAt = json.optString("updated_at").blankToNull(),
    )
}

internal fun parseAdminUsers(responseBody: String): AdminUsersResult {
    val json = JSONObject(responseBody)
    return AdminUsersResult(
        users = json.optJSONArray("users").orEmptyObjects().map { user ->
            AdminUserSummary(
                id = user.optString("id"),
                email = user.optString("email"),
                role = user.optString("role", "user"),
                status = user.optString("status", "active"),
                emailVerified = user.optString("email_verified_at").isNotBlank() ||
                    user.optBoolean("email_verified", false),
            )
        },
        invitations = json.optJSONArray("invitations").orEmptyObjects().map { invitation ->
            AdminInvitationSummary(
                id = invitation.optString("id"),
                email = invitation.optString("email"),
                role = invitation.optString("role", "user"),
                inviteUrl = invitation.optString("invite_url").blankToNull(),
            )
        },
    )
}

internal fun authFailureMessage(status: Int, responseBody: String): String {
    val message = runCatching {
        JSONObject(responseBody.ifBlank { "{}" }).optString("message")
            .ifBlank { JSONObject(responseBody.ifBlank { "{}" }).optString("error") }
    }.getOrDefault("")
    return when (status) {
        400 -> if (message.isNotBlank()) message else "请求内容不完整"
        401 -> "邮箱或密码不正确，请重新登录"
        403 -> if (message.isNotBlank()) message else "当前账号没有权限"
        404 -> "服务端暂未开通这个账号功能"
        in 500..599 -> "服务器暂时不可用，请稍后重试"
        else -> if (message.isNotBlank()) message else "账号请求失败 HTTP $status"
    }
}

private fun JSONArray?.orEmptyObjects(): List<JSONObject> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optJSONObject(index)?.let { add(it) }
        }
    }
}

private fun String.blankToNull(): String? {
    val value = trim()
    return value.takeUnless {
        it.isBlank() || it.equals("null", ignoreCase = true) || it.equals("undefined", ignoreCase = true)
    }
}
