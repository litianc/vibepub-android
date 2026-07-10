package cn.litianc.vibepub

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale

fun transcriptFileNameForRecording(filename: String): String {
    val baseName = filename.substringBeforeLast('.', filename)
    return "$baseName.json"
}

fun coverImageFileNameForRecording(filename: String): String {
    val baseName = filename.substringBeforeLast('.', filename)
    return "$baseName-cover.png"
}

fun audioContentTypeForFilename(filename: String): String {
    return when (filename.substringAfterLast('.', "").lowercase(Locale.US)) {
        "mp3" -> "audio/mpeg"
        "m4a", "mp4" -> "audio/mp4"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }
}

fun remoteRecordingDeleteUrl(apiBaseUrl: String, filename: String): URL {
    val encodedFilename = URLEncoder.encode(filename, "UTF-8").replace("+", "%20")
    return URL("${apiBaseUrl.trimEnd('/')}/api/recordings/$encodedFilename")
}

suspend fun deleteRemoteRecording(preferences: AppPreferences, filename: String): Boolean {
    if (preferences.accessToken.isBlank()) return false

    return runCatching {
        val response = AuthenticatedHttpClient.request(
            preferences = preferences,
            url = remoteRecordingDeleteUrl(preferences.apiBaseUrl, filename),
            method = "DELETE",
            connectTimeoutMs = 15_000,
            readTimeoutMs = 30_000,
        )
        response.statusCode in 200..206
    }.getOrDefault(false)
}

fun deleteRemoteRecording(apiBaseUrl: String, filesToken: String, filename: String): Boolean {
    val token = filesToken.trim()
    if (token.isBlank()) return false

    val connection = (remoteRecordingDeleteUrl(apiBaseUrl, filename).openConnection() as HttpURLConnection).apply {
        requestMethod = "DELETE"
        setRequestProperty("Authorization", "Bearer $token")
        connectTimeout = 15_000
        readTimeout = 30_000
    }

    return try {
        connection.responseCode in 200..206
    } finally {
        connection.disconnect()
    }
}

internal fun shouldAuthorizeVibePubFileUrl(url: URL, apiBaseUrl: String): Boolean {
    val base = runCatching { URL(apiBaseUrl.trimEnd('/')) }.getOrNull() ?: return false
    return url.path.startsWith("/api/files/") &&
        url.host.equals(base.host, ignoreCase = true) &&
        url.protocol.equals(base.protocol, ignoreCase = true)
}
