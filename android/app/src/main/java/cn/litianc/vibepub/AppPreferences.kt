package cn.litianc.vibepub

import android.content.Context
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.onStart
import java.util.UUID

internal data class AuthSessionSnapshot(
    val sessionId: String,
    val userId: String,
    val accessToken: String,
    val refreshToken: String,
)

class AppPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)

    var apiBaseUrl: String
        get() = prefs.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL) ?: DEFAULT_API_BASE_URL
        set(value) = prefs.edit().putString(KEY_API_BASE_URL, value.trim()).apply()

    var accessToken: String
        get() = prefs.getString(KEY_ACCESS_TOKEN, "") ?: ""
        set(value) {
            val normalized = value.trim()
            prefs.edit()
                .putString(KEY_ACCESS_TOKEN, normalized)
                .putString(KEY_FILES_TOKEN, normalized)
                .apply()
            authStateUpdates.tryEmit(authStateVersion)
        }

    var refreshToken: String
        get() = prefs.getString(KEY_REFRESH_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_REFRESH_TOKEN, value.trim()).apply()

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
        get() = accessToken.isNotBlank() && userId.isNotBlank()

    val canUseCloudFeatures: Boolean
        get() = isAuthenticated && emailVerified

    val authStateVersion: Long
        get() = prefs.getLong(KEY_AUTH_STATE_VERSION, 0L)

    /**
     * A login receives a stable local identity that survives token rotation but
     * changes on logout or a fresh login. It prevents cross-account retries.
     */
    internal fun currentAuthSessionSnapshot(): AuthSessionSnapshot = synchronized(authSessionLock) {
        val accessToken = prefs.getString(KEY_ACCESS_TOKEN, "").orEmpty().trim()
        val refreshToken = prefs.getString(KEY_REFRESH_TOKEN, "").orEmpty().trim()
        val userId = prefs.getString(KEY_USER_ID, "").orEmpty().trim()
        val storedSessionId = prefs.getString(KEY_AUTH_SESSION_ID, "").orEmpty().trim()
        val sessionId = if (storedSessionId.isBlank() && accessToken.isNotBlank() && userId.isNotBlank()) {
            UUID.randomUUID().toString().also {
                prefs.edit().putString(KEY_AUTH_SESSION_ID, it).apply()
            }
        } else {
            storedSessionId
        }
        AuthSessionSnapshot(
            sessionId = sessionId,
            userId = userId,
            accessToken = accessToken,
            refreshToken = refreshToken,
        )
    }

    fun authStateFlow(): Flow<Long> = authStateUpdates
        .onStart { emit(authStateVersion) }
        .distinctUntilChanged()

    fun saveAuthSession(session: AuthSession) {
        val nextVersion = synchronized(authSessionLock) {
            writeAuthSessionLocked(session, UUID.randomUUID().toString())
        }
        authStateUpdates.tryEmit(nextVersion)
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
            writeAuthSessionLocked(session, expectedSession.sessionId)
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
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, session.accessToken.trim())
            .putString(KEY_REFRESH_TOKEN, session.refreshToken.trim())
            .putString(KEY_FILES_TOKEN, session.accessToken.trim())
            .putString(KEY_USER_ID, session.user.id.trim())
            .putString(KEY_USER_EMAIL, session.user.email.trim())
            .putString(KEY_USER_ROLE, session.user.role.trim().ifBlank { "user" })
            .putBoolean(KEY_EMAIL_VERIFIED, session.user.emailVerified)
            .putString(KEY_AUTH_SESSION_ID, sessionId)
            .putLong(KEY_AUTH_STATE_VERSION, nextVersion)
            .apply()
        return nextVersion
    }

    private fun clearAuthSessionLocked(): Long {
        val nextVersion = nextAuthStateVersionLocked()
        prefs.edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_FILES_TOKEN)
            .remove(KEY_USER_ID)
            .remove(KEY_USER_EMAIL)
            .remove(KEY_USER_ROLE)
            .remove(KEY_EMAIL_VERIFIED)
            .remove(KEY_AUTH_SESSION_ID)
            .putLong(KEY_AUTH_STATE_VERSION, nextVersion)
            .apply()
        return nextVersion
    }

    private fun matchesSessionLocked(expectedSession: AuthSessionSnapshot): Boolean {
        if (expectedSession.sessionId.isBlank() || expectedSession.userId.isBlank()) return false
        return prefs.getString(KEY_AUTH_SESSION_ID, "").orEmpty().trim() == expectedSession.sessionId &&
            prefs.getString(KEY_USER_ID, "").orEmpty().trim() == expectedSession.userId
    }

    private fun nextAuthStateVersionLocked(): Long = maxOf(
        System.currentTimeMillis(),
        prefs.getLong(KEY_AUTH_STATE_VERSION, 0L) + 1L,
    )

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
