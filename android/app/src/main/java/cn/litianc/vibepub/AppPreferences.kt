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

    companion object {
        const val DEFAULT_API_BASE_URL = "https://vibepub.litianc.cn"
        private const val KEY_API_BASE_URL = "api_base_url"
        private const val KEY_FILES_TOKEN = "files_token"
    }
}
