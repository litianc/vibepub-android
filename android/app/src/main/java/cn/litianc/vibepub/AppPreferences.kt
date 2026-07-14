package cn.litianc.vibepub

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.onStart
import java.util.UUID
import java.security.MessageDigest

internal data class AuthSessionSnapshot(
    val sessionId: String,
    val userId: String,
    val accessToken: String,
    val refreshToken: String,
    val serverSessionId: String,
    val generation: Int,
    val accessExpiresAt: String,
    val idleExpiresAt: String,
    val refreshExpiresAt: String,
    val contractVersion: Int,
)

class AppPreferences internal constructor(
    context: Context,
    private val tokenStore: AuthTokenStore = AndroidKeystoreAuthTokenStore(context.applicationContext),
    private val authMetadataCommit: (SharedPreferences.Editor) -> Boolean = { it.commit() },
) {
    private val prefs = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)

    init {
        migratePlainAuthTokens()
    }

    var apiBaseUrl: String
        get() = prefs.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL) ?: DEFAULT_API_BASE_URL
        set(value) = prefs.edit().putString(KEY_API_BASE_URL, value.trim()).apply()

    var accessToken: String
        get() = synchronized(authSessionLock) { readSecretsLocked().accessToken }
        set(value) {
            val normalized = value.trim()
            synchronized(authSessionLock) {
                tokenStore.write(readSecretsLocked().copy(accessToken = normalized))
            }
            authStateUpdates.tryEmit(authStateVersion)
        }

    var refreshToken: String
        get() = synchronized(authSessionLock) { readSecretsLocked().refreshToken }
        set(value) = synchronized(authSessionLock) {
            tokenStore.write(readSecretsLocked().copy(refreshToken = value.trim()))
        }

    var userId: String
        get() = prefs.getString(KEY_USER_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_ID, value.trim()).apply()

    var userEmail: String
        get() = prefs.getString(KEY_USER_EMAIL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_EMAIL, value.trim()).apply()

    var userRole: String
        get() = prefs.getString(KEY_USER_ROLE, "user") ?: "user"
        set(value) = prefs.edit().putString(KEY_USER_ROLE, value.trim().ifBlank { "user" }).apply()

    var emailVerified: Boolean
        get() = prefs.getBoolean(KEY_EMAIL_VERIFIED, false)
        set(value) = prefs.edit().putBoolean(KEY_EMAIL_VERIFIED, value).apply()

    val effectiveUserId: String
        get() = userId.ifBlank { DEFAULT_USER_ID }

    val isAuthenticated: Boolean
        get() = currentAuthSessionSnapshot().let {
            it.accessToken.isNotBlank() && it.userId.isNotBlank() && it.sessionId.isNotBlank()
        }

    val canUseCloudFeatures: Boolean
        get() = isAuthenticated && emailVerified

    val authStateVersion: Long
        get() = prefs.getLong(KEY_AUTH_STATE_VERSION, 0L)

    val lastAuthFailureReason: String
        get() = prefs.getString(KEY_LAST_AUTH_FAILURE_REASON, "").orEmpty()

    /**
     * A login receives a stable local identity that survives token rotation but
     * changes on logout or a fresh login. It prevents cross-account retries.
     */
    internal fun currentAuthSessionSnapshot(): AuthSessionSnapshot = synchronized(authSessionLock) {
        val secrets = readSecretsLocked()
        val accessToken = secrets.accessToken.trim()
        val refreshToken = secrets.refreshToken.trim()
        val metadataUserId = prefs.getString(KEY_USER_ID, "").orEmpty().trim()
        val metadataSessionId = prefs.getString(KEY_AUTH_SESSION_ID, "").orEmpty().trim()
        if (
            secrets.userId.isNotBlank() &&
            (secrets.userId != metadataUserId || secrets.localSessionId != metadataSessionId)
        ) {
            failClosedAuthLocked("secure_storage_unavailable")
            return@synchronized emptyAuthSnapshot()
        }
        AuthSessionSnapshot(
            sessionId = secrets.localSessionId,
            userId = secrets.userId,
            accessToken = accessToken,
            refreshToken = refreshToken,
            serverSessionId = secrets.serverSessionId,
            generation = secrets.generation,
            accessExpiresAt = secrets.accessExpiresAt,
            idleExpiresAt = secrets.idleExpiresAt,
            refreshExpiresAt = secrets.refreshExpiresAt,
            contractVersion = secrets.contractVersion,
        )
    }

    internal fun getOrCreateRefreshRequestId(expectedSession: AuthSessionSnapshot): String =
        synchronized(authSessionLock) {
            check(matchesSessionLocked(expectedSession)) { "Authentication session changed" }
            val secrets = readSecretsLocked()
            val tokenDigest = tokenDigest(expectedSession.refreshToken)
            if (
                secrets.pendingRefreshSessionId == expectedSession.sessionId &&
                secrets.pendingRefreshTokenDigest == tokenDigest &&
                secrets.pendingRefreshGeneration == expectedSession.generation &&
                secrets.pendingRefreshRequestId.isNotBlank()
            ) {
                return@synchronized secrets.pendingRefreshRequestId
            }
            UUID.randomUUID().toString().also { requestId ->
                tokenStore.write(secrets.copy(
                    pendingRefreshRequestId = requestId,
                    pendingRefreshSessionId = expectedSession.sessionId,
                    pendingRefreshTokenDigest = tokenDigest,
                    pendingRefreshGeneration = expectedSession.generation,
                ))
            }
        }

    fun authStateFlow(): Flow<Long> = authStateUpdates
        .onStart { emit(authStateVersion) }
        .distinctUntilChanged()

    fun saveAuthSession(session: AuthSession) {
        check(trySaveAuthSession(session)) { "Unable to persist authentication session" }
    }

    internal fun trySaveAuthSession(session: AuthSession): Boolean {
        val nextVersion = synchronized(authSessionLock) {
            runCatching { writeAuthSessionLocked(session, UUID.randomUUID().toString()) }.getOrNull()
        } ?: return false
        authStateUpdates.tryEmit(nextVersion)
        return true
    }

    /** Returns false when logout or another login replaced the expected session. */
    internal fun saveRefreshedAuthSession(
        session: AuthSession,
        expectedSession: AuthSessionSnapshot,
    ): Boolean {
        val nextVersion = synchronized(authSessionLock) {
            if (!matchesSessionLocked(expectedSession) || session.user.id.trim() != expectedSession.userId) {
                return@synchronized null
            }
            runCatching { writeAuthSessionLocked(session, expectedSession.sessionId) }.getOrNull()
        } ?: return false
        authStateUpdates.tryEmit(nextVersion)
        return true
    }

    fun updateCurrentUser(user: AuthUser) {
        val nextVersion = synchronized(authSessionLock) {
            val nextUserId = user.id.trim()
            val currentUserId = prefs.getString(KEY_USER_ID, "").orEmpty().trim()
            val sessionId = if (nextUserId.isNotBlank() && nextUserId == currentUserId) {
                prefs.getString(KEY_AUTH_SESSION_ID, "").orEmpty().trim()
                    .ifBlank { UUID.randomUUID().toString() }
            } else {
                UUID.randomUUID().toString()
            }
            val version = nextAuthStateVersionLocked()
            prefs.edit()
                .putString(KEY_USER_ID, nextUserId)
                .putString(KEY_USER_EMAIL, user.email.trim())
                .putString(KEY_USER_ROLE, user.role.trim().ifBlank { "user" })
                .putBoolean(KEY_EMAIL_VERIFIED, user.emailVerified)
                .putString(KEY_AUTH_SESSION_ID, sessionId)
                .putLong(KEY_AUTH_STATE_VERSION, version)
                .apply()
            version
        }
        authStateUpdates.tryEmit(nextVersion)
    }

    fun clearAuthSession() {
        val nextVersion = synchronized(authSessionLock) { clearAuthSessionLocked() }
        authStateUpdates.tryEmit(nextVersion)
    }

    /** Clears only the session that initiated a refresh, never a newer login. */
    internal fun clearAuthSessionIfMatches(expectedSession: AuthSessionSnapshot): Boolean {
        val nextVersion = synchronized(authSessionLock) {
            if (!matchesSessionLocked(expectedSession)) {
                return@synchronized null
            }
            clearAuthSessionLocked()
        } ?: return false
        authStateUpdates.tryEmit(nextVersion)
        return true
    }

    private fun writeAuthSessionLocked(session: AuthSession, sessionId: String): Long {
        val nextVersion = nextAuthStateVersionLocked()
        try {
            tokenStore.write(StoredAuthSecrets(
                accessToken = session.accessToken.trim(),
                refreshToken = session.refreshToken.trim(),
                userId = session.user.id.trim(),
                localSessionId = sessionId,
                serverSessionId = session.serverSessionId.trim(),
                generation = session.generation,
                accessExpiresAt = session.accessExpiresAt.trim(),
                idleExpiresAt = session.idleExpiresAt.trim(),
                refreshExpiresAt = session.refreshExpiresAt.trim(),
                contractVersion = session.contractVersion,
            ))
        } catch (error: SecureStorageException) {
            failClosedAuthLocked("secure_storage_unavailable")
            throw error
        }
        val committed = authMetadataCommit(prefs.edit()
            .putString(KEY_USER_ID, session.user.id.trim())
            .putString(KEY_USER_EMAIL, session.user.email.trim())
            .putString(KEY_USER_ROLE, session.user.role.trim().ifBlank { "user" })
            .putBoolean(KEY_EMAIL_VERIFIED, session.user.emailVerified)
            .putString(KEY_AUTH_SESSION_ID, sessionId)
            .putLong(KEY_AUTH_STATE_VERSION, nextVersion)
            .remove(KEY_LAST_AUTH_FAILURE_REASON))
        if (!committed) {
            failClosedAuthLocked("secure_storage_unavailable")
            throw SecureStorageException()
        }
        return nextVersion
    }

    private fun clearAuthSessionLocked(): Long {
        val nextVersion = nextAuthStateVersionLocked()
        runCatching { tokenStore.clear() }
        val committed = prefs.edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_FILES_TOKEN)
            .remove(KEY_USER_ID)
            .remove(KEY_USER_EMAIL)
            .remove(KEY_USER_ROLE)
            .remove(KEY_EMAIL_VERIFIED)
            .remove(KEY_AUTH_SESSION_ID)
            .putLong(KEY_AUTH_STATE_VERSION, nextVersion)
            .commit()
        if (!committed) throw SecureStorageException()
        return nextVersion
    }

    private fun matchesSessionLocked(expectedSession: AuthSessionSnapshot): Boolean {
        if (expectedSession.sessionId.isBlank() || expectedSession.userId.isBlank()) return false
        val secrets = readSecretsLocked()
        return secrets.localSessionId == expectedSession.sessionId &&
            secrets.userId == expectedSession.userId &&
            secrets.accessToken == expectedSession.accessToken &&
            secrets.refreshToken == expectedSession.refreshToken &&
            secrets.generation == expectedSession.generation
    }

    private fun nextAuthStateVersionLocked(): Long = maxOf(
        System.currentTimeMillis(),
        prefs.getLong(KEY_AUTH_STATE_VERSION, 0L) + 1L,
    )

    private fun migratePlainAuthTokens() = synchronized(authSessionLock) {
        val legacyAccess = prefs.getString(KEY_ACCESS_TOKEN, "").orEmpty().trim()
            .ifBlank { prefs.getString(KEY_FILES_TOKEN, "").orEmpty().trim() }
        val legacyRefresh = prefs.getString(KEY_REFRESH_TOKEN, "").orEmpty().trim()
        val current = runCatching { tokenStore.read() }.getOrElse {
            failClosedAuthLocked("secure_storage_unavailable")
            return@synchronized
        }
        if ((legacyAccess.isNotBlank() || legacyRefresh.isNotBlank()) &&
            current.accessToken.isBlank() && current.refreshToken.isBlank()
        ) {
            val legacyUserId = prefs.getString(KEY_USER_ID, "").orEmpty().trim()
            val legacySessionId = prefs.getString(KEY_AUTH_SESSION_ID, "").orEmpty().trim()
                .ifBlank { if (legacyUserId.isNotBlank()) UUID.randomUUID().toString() else "" }
            try {
                tokenStore.write(current.copy(
                    accessToken = legacyAccess,
                    refreshToken = legacyRefresh,
                    userId = legacyUserId,
                    localSessionId = legacySessionId,
                ))
                if (legacySessionId.isNotBlank() && !authMetadataCommit(
                        prefs.edit().putString(KEY_AUTH_SESSION_ID, legacySessionId)
                    )
                ) {
                    failClosedAuthLocked("secure_storage_unavailable")
                    return@synchronized
                }
            } catch (_: SecureStorageException) {
                failClosedAuthLocked("secure_storage_unavailable")
                return@synchronized
            }
        }
        if (!removePlainTokensLocked()) {
            failClosedAuthLocked("secure_storage_unavailable")
        }
    }

    private fun removePlainTokensLocked(): Boolean = authMetadataCommit(prefs.edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_FILES_TOKEN))

    private fun readSecretsLocked(): StoredAuthSecrets = try {
        tokenStore.read()
    } catch (_: SecureStorageException) {
        failClosedAuthLocked("secure_storage_unavailable")
        StoredAuthSecrets()
    }

    private fun failClosedAuthLocked(reason: String) {
        runCatching { tokenStore.clear() }
        val editor = prefs.edit()
            .remove(KEY_USER_ID)
            .remove(KEY_USER_EMAIL)
            .remove(KEY_USER_ROLE)
            .remove(KEY_EMAIL_VERIFIED)
            .remove(KEY_AUTH_SESSION_ID)
            .putString(KEY_LAST_AUTH_FAILURE_REASON, reason)
            .putLong(KEY_AUTH_STATE_VERSION, nextAuthStateVersionLocked())
        editor.remove(KEY_ACCESS_TOKEN).remove(KEY_REFRESH_TOKEN).remove(KEY_FILES_TOKEN)
        editor.commit()
    }

    private fun emptyAuthSnapshot() = AuthSessionSnapshot("", "", "", "", "", 0, "", "", "", 0)

    internal fun pendingRefreshRequestIdForTest(): String = synchronized(authSessionLock) {
        readSecretsLocked().pendingRefreshRequestId
    }

    private fun tokenDigest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    @Deprecated("Use accessToken. This remains only for old local preferences and tests.")
    var filesToken: String
        get() = accessToken
        set(value) {
            accessToken = value
        }

    var lastSyncAtMs: Long
        get() = prefs.getLong(KEY_LAST_SYNC_AT_MS, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SYNC_AT_MS, value).commit()
            lastSyncAtMsUpdates.tryEmit(value)
        }

    fun lastSyncAtMsFlow(): Flow<Long> = lastSyncAtMsUpdates
        .onStart { emit(lastSyncAtMs) }
        .distinctUntilChanged()

    var transcribedFiles: Set<String>
        get() = prefs.getStringSet(KEY_TRANSCRIBED_FILES, emptySet()) ?: emptySet()
        set(value) = prefs.edit().putStringSet(KEY_TRANSCRIBED_FILES, value).apply()

    var selectedStyleProfileId: String
        get() = prefs.getString(
            KEY_SELECTED_STYLE_PROFILE_ID,
            WritingStyleProfiles.DEFAULT_STYLE_PROFILE_ID,
        ) ?: WritingStyleProfiles.DEFAULT_STYLE_PROFILE_ID
        set(value) = prefs.edit().putString(KEY_SELECTED_STYLE_PROFILE_ID, value.trim()).apply()

    var selectedStyleProfileVersion: String
        get() = prefs.getString(
            KEY_SELECTED_STYLE_PROFILE_VERSION,
            WritingStyleProfiles.DEFAULT_STYLE_PROFILE_VERSION,
        ) ?: WritingStyleProfiles.DEFAULT_STYLE_PROFILE_VERSION
        set(value) = prefs.edit().putString(KEY_SELECTED_STYLE_PROFILE_VERSION, value.trim()).apply()

    var selectedLayoutProfileId: String
        get() = prefs.getString(
            KEY_SELECTED_LAYOUT_PROFILE_ID,
            WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_ID,
        ) ?: WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_ID
        set(value) = prefs.edit().putString(KEY_SELECTED_LAYOUT_PROFILE_ID, value.trim()).apply()

    var selectedLayoutProfileVersion: String
        get() = prefs.getString(
            KEY_SELECTED_LAYOUT_PROFILE_VERSION,
            WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_VERSION,
        ) ?: WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_VERSION
        set(value) = prefs.edit().putString(KEY_SELECTED_LAYOUT_PROFILE_VERSION, value.trim()).apply()

    var customWritingStyleProfiles: List<WritingStyleProfileOption>
        get() = WritingStyleProfiles.decodeCustomProfiles(
            prefs.getString(KEY_CUSTOM_WRITING_STYLE_PROFILES, "").orEmpty(),
        )
        set(value) = prefs.edit()
            .putString(KEY_CUSTOM_WRITING_STYLE_PROFILES, WritingStyleProfiles.encodeCustomProfiles(value))
            .apply()

    var remoteWritingStyleProfiles: List<WritingStyleProfileOption>
        get() = WritingStyleProfiles.decodeRemoteProfiles(
            prefs.getString(KEY_REMOTE_WRITING_STYLE_PROFILES, "").orEmpty(),
        )
        set(value) = prefs.edit()
            .putString(KEY_REMOTE_WRITING_STYLE_PROFILES, WritingStyleProfiles.encodeRemoteProfiles(value))
            .apply()

    fun allWritingStyleProfiles(): List<WritingStyleProfileOption> {
        return WritingStyleProfiles.builtIn + customWritingStyleProfiles + remoteWritingStyleProfiles
    }

    fun selectedWritingStyleProfile(): WritingStyleProfileOption {
        return WritingStyleProfiles.optionFor(
            selectedStyleProfileId,
            customWritingStyleProfiles,
            remoteWritingStyleProfiles,
        )
    }

    fun selectedStyleProfileBody(): String {
        return selectedWritingStyleProfile().body.orEmpty()
    }

    fun upsertRemoteWritingStyleProfile(profile: WritingStyleProfileOption) {
        val normalized = profile.copy(
            name = profile.name.trim().ifBlank { "云端写作风格" },
            description = profile.description.trim(),
            remote = true,
            custom = false,
        )
        val current = remoteWritingStyleProfiles.toMutableList()
        val index = current.indexOfFirst { it.id == normalized.id }
        if (index >= 0) {
            current[index] = normalized
        } else {
            current.add(normalized)
        }
        remoteWritingStyleProfiles = current
    }

    fun selectWritingStyleProfile(profile: WritingStyleProfileOption) {
        selectedStyleProfileId = profile.id
        selectedStyleProfileVersion = profile.version
        selectedLayoutProfileId = WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_ID
        selectedLayoutProfileVersion = WritingStyleProfiles.DEFAULT_LAYOUT_PROFILE_VERSION
    }

    fun upsertAndSelectRemoteWritingStyleProfile(profile: WritingStyleProfileOption) {
        upsertRemoteWritingStyleProfile(profile)
        selectWritingStyleProfile(profile)
    }

    fun upsertCustomWritingStyleProfile(profile: WritingStyleProfileOption) {
        val normalized = profile.copy(
            name = profile.name.trim().ifBlank { "我的写作风格" },
            description = profile.description.trim(),
            body = WritingStyleProfiles.trimCustomProfileBody(profile.body.orEmpty()),
            custom = true,
        )
        val current = customWritingStyleProfiles.toMutableList()
        val index = current.indexOfFirst { it.id == normalized.id }
        if (index >= 0) {
            current[index] = normalized
        } else {
            current.add(normalized)
        }
        customWritingStyleProfiles = current
    }

    fun markAsTranscribed(filename: String) {
        val current = transcribedFiles.toMutableSet()
        current.add(filename)
        transcribedFiles = current
    }

    companion object {
        const val DEFAULT_API_BASE_URL = "https://vibepub.litianc.cn"
        const val DEFAULT_USER_ID = "default_user"
        private const val KEY_API_BASE_URL = "api_base_url"
        private const val KEY_FILES_TOKEN = "files_token"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_USER_ROLE = "user_role"
        private const val KEY_EMAIL_VERIFIED = "email_verified"
        private const val KEY_AUTH_STATE_VERSION = "auth_state_version"
        private const val KEY_AUTH_SESSION_ID = "auth_session_id"
        private const val KEY_LAST_AUTH_FAILURE_REASON = "last_auth_failure_reason"
        private const val KEY_TRANSCRIBED_FILES = "transcribed_files"
        private const val KEY_LAST_SYNC_AT_MS = "last_sync_at_ms"
        private const val KEY_SELECTED_STYLE_PROFILE_ID = "selected_style_profile_id"
        private const val KEY_SELECTED_STYLE_PROFILE_VERSION = "selected_style_profile_version"
        private const val KEY_SELECTED_LAYOUT_PROFILE_ID = "selected_layout_profile_id"
        private const val KEY_SELECTED_LAYOUT_PROFILE_VERSION = "selected_layout_profile_version"
        private const val KEY_CUSTOM_WRITING_STYLE_PROFILES = "custom_writing_style_profiles"
        private const val KEY_REMOTE_WRITING_STYLE_PROFILES = "remote_writing_style_profiles"
        private val lastSyncAtMsUpdates = MutableSharedFlow<Long>(extraBufferCapacity = 1)
        private val authStateUpdates = MutableSharedFlow<Long>(extraBufferCapacity = 1)
        private val authSessionLock = Any()
    }
}
