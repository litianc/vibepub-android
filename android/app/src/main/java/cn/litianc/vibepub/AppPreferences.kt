package cn.litianc.vibepub

import android.content.Context

class AppPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("vibepub", Context.MODE_PRIVATE)

    var apiBaseUrl: String
        get() = prefs.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL) ?: DEFAULT_API_BASE_URL
        set(value) = prefs.edit().putString(KEY_API_BASE_URL, value.trim()).apply()

    var filesToken: String
        get() = prefs.getString(KEY_FILES_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FILES_TOKEN, value.trim()).apply()

    var transcribedFiles: Set<String>
        get() = prefs.getStringSet(KEY_TRANSCRIBED_FILES, emptySet()) ?: emptySet()
        set(value) = prefs.edit().putStringSet(KEY_TRANSCRIBED_FILES, value).apply()

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
    }
}
