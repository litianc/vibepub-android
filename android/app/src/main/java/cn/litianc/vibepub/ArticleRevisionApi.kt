package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class ArticleRevisionSubmitResult(
    val revisionId: String,
    val status: String,
)

object ArticleRevisionApi {
    suspend fun submitVoiceRevision(
        apiBaseUrl: String,
        filesToken: String,
        filename: String,
        audioFile: File,
    ): ArticleRevisionSubmitResult = withContext(Dispatchers.IO) {
        require(filesToken.isNotBlank()) { "请先在设置中配置 FILES_TOKEN" }
        require(audioFile.exists() && audioFile.length() > 0L) { "修改语音文件为空" }

        val connection = (articleRevisionEndpoint(apiBaseUrl, filename).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 60_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer $filesToken")
            setRequestProperty("Content-Type", "audio/mp4")
            setRequestProperty("X-Revision-Instruction-File-Name", audioFile.name)
            setFixedLengthStreamingMode(audioFile.length())
        }

        audioFile.inputStream().use { input ->
            connection.outputStream.use { output ->
                input.copyTo(output)
            }
        }

        val responseCode = connection.responseCode
        val responseBody = if (responseCode in 200..299) {
            connection.inputStream.bufferedReader().use { it.readText() }
        } else {
            connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
        }

        if (responseCode !in 200..299) {
            throw ArticleRevisionSubmitException(
                userMessage = articleRevisionFailureMessage(responseCode, responseBody),
                responseCode = responseCode,
            )
        }

        val json = JSONObject(responseBody)
        ArticleRevisionSubmitResult(
            revisionId = json.optString("revision_id", ""),
            status = json.optString("status", "QUEUED"),
        )
    }
}

class ArticleRevisionSubmitException(
    val userMessage: String,
    val responseCode: Int,
) : Exception(userMessage)

internal fun articleRevisionEndpoint(apiBaseUrl: String, filename: String): URL {
    val encodedFilename = URLEncoder.encode(filename, "UTF-8").replace("+", "%20")
    return URL("${apiBaseUrl.trimEnd('/')}/api/recordings/$encodedFilename/revisions")
}

internal fun articleRevisionFailureMessage(responseCode: Int, responseBody: String): String {
    return when (responseCode) {
        401, 403 -> "FILES_TOKEN 无效或没有权限，无法提交修改"
        409 -> "文章还没生成完成，暂不能说话修改"
        else -> {
            val error = articleRevisionResponseMessage(responseBody)
            if (error.isBlank()) "提交修改失败 HTTP $responseCode" else "提交修改失败：$error"
        }
    }
}

internal fun articleRevisionResponseMessage(responseBody: String): String {
    val jsonMessage = runCatching {
        val json = JSONObject(responseBody)
        json.optString("message")
            .blankToMissingRevisionValue()
            .ifBlank { json.optString("error").blankToMissingRevisionValue() }
    }.getOrDefault("")
    if (jsonMessage.isNotBlank()) return jsonMessage

    return Regex(""""(?:message|error)"\s*:\s*"([^"]+)"""")
        .find(responseBody)
        ?.groupValues
        ?.getOrNull(1)
        ?.blankToMissingRevisionValue()
        .orEmpty()
}

private fun String.blankToMissingRevisionValue(): String {
    val value = trim()
    return if (
        value.isBlank() ||
        value.equals("null", ignoreCase = true) ||
        value.equals("undefined", ignoreCase = true)
    ) {
        ""
    } else {
        value
    }
}
