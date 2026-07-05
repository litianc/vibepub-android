package cn.litianc.vibepub

import android.content.Context
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.onStart

class AppPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)

    var apiBaseUrl: String
        get() = prefs.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL) ?: DEFAULT_API_BASE_URL
        set(value) = prefs.edit().putString(KEY_API_BASE_URL, value.trim()).apply()

    var filesToken: String
        get() = prefs.getString(KEY_FILES_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FILES_TOKEN, value.trim()).apply()

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
        private const val KEY_API_BASE_URL = "api_base_url"
        private const val KEY_FILES_TOKEN = "files_token"
        private const val KEY_TRANSCRIBED_FILES = "transcribed_files"
        private const val KEY_LAST_SYNC_AT_MS = "last_sync_at_ms"
        private const val KEY_SELECTED_STYLE_PROFILE_ID = "selected_style_profile_id"
        private const val KEY_SELECTED_STYLE_PROFILE_VERSION = "selected_style_profile_version"
        private const val KEY_SELECTED_LAYOUT_PROFILE_ID = "selected_layout_profile_id"
        private const val KEY_SELECTED_LAYOUT_PROFILE_VERSION = "selected_layout_profile_version"
        private const val KEY_CUSTOM_WRITING_STYLE_PROFILES = "custom_writing_style_profiles"
        private const val KEY_REMOTE_WRITING_STYLE_PROFILES = "remote_writing_style_profiles"
        private val lastSyncAtMsUpdates = MutableSharedFlow<Long>(extraBufferCapacity = 1)
    }
}
