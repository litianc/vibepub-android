package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class TextSubmissionResult(
    val filename: String,
    val status: String,
    val processingStage: String?,
)

object TextSubmissionApi {
    suspend fun submitText(
        apiBaseUrl: String,
        filesToken: String,
        text: String,
        titleHint: String?,
    ): TextSubmissionResult = withContext(Dispatchers.IO) {
        val normalizedText = text.trim()
        require(filesToken.isNotBlank()) { "请先在设置中配置 FILES_TOKEN" }
        require(normalizedText.length >= MIN_TEXT_SUBMISSION_CHARS) { "文字太短，请再补充一些想法" }

        val body = JSONObject().apply {
            put("text", normalizedText)
            val normalizedTitleHint = titleHint?.trim().orEmpty()
            if (normalizedTitleHint.isNotBlank()) {
                put("title_hint", normalizedTitleHint)
            }
            put("source", "android_text")
        }.toString()

        val connection = (URL("${apiBaseUrl.trimEnd('/')}/api/text-submissions").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 60_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer $filesToken")
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setFixedLengthStreamingMode(body.toByteArray(Charsets.UTF_8).size)
        }

        connection.outputStream.use { output ->
            output.write(body.toByteArray(Charsets.UTF_8))
        }

        val responseCode = connection.responseCode
        val responseBody = if (responseCode in 200..299) {
            connection.inputStream.bufferedReader().use { it.readText() }
        } else {
            connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
        }

        if (responseCode !in 200..299) {
            throw IllegalStateException(textSubmissionFailureMessage(responseCode, responseBody))
        }

        val json = JSONObject(responseBody)
        TextSubmissionResult(
            filename = json.optString("filename")
                .ifBlank { json.optString("name") }
                .takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("后端没有返回文字任务文件名"),
            status = json.optString("status").ifBlank { "PROCESSING" },
            processingStage = json.optString("processing_stage")
                .ifBlank { json.optString("processingStage") }
                .takeIf { it.isNotBlank() },
        )
    }
}

internal fun textSubmissionFailureMessage(responseCode: Int, responseBody: String): String {
    return when (responseCode) {
        400 -> runCatching { JSONObject(responseBody.ifBlank { "{}" }).optString("message") }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: "文字内容不符合要求"
        401, 403 -> "FILES_TOKEN 无效或没有权限"
        in 500..599 -> "服务器暂时不可用，请稍后重试"
        else -> "文字提交失败 HTTP $responseCode"
    }
}

internal const val MIN_TEXT_SUBMISSION_CHARS = 10
