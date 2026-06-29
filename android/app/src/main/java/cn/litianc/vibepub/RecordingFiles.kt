package cn.litianc.vibepub

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
