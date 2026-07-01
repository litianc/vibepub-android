package cn.litianc.vibepub

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale

fun transcriptFileNameForRecording(filename: String): String {
    val baseName = filename.substringBeforeLast('.', filename)
    return "$baseName.json"
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
