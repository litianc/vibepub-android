package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

data class ArticleRevisionSubmitResult(
    val revisionId: String,
    val status: String,
    val parentVersionId: String = "",
    val continueRevision: Boolean? = null,
)

data class ArticleRevisionRequestIdentity(
    val articleVersionId: String,
    val requestId: String,
    val audioSha256: String,
) {
    val headers: Map<String, String>
        get() = mapOf(
            "X-Article-Version-Id" to articleVersionId,
            "X-Revision-Request-Id" to requestId,
            "X-Revision-Audio-Sha256" to audioSha256,
        )
}

fun createArticleRevisionRequestIdentity(
    effectiveUserId: String,
    filename: String,
    parentVersionId: String,
    audioFile: File,
): ArticleRevisionRequestIdentity {
    require(effectiveUserId.isNotBlank()) { "用户编号不存在" }
    require(filename.isNotBlank()) { "录音文件名不存在" }
    require(parentVersionId.isNotBlank()) { "文章版本不存在" }
    require(audioFile.exists() && audioFile.length() > 0L) { "修改语音文件为空" }

    val audioSha256 = "sha256:${audioFile.sha256Hex()}"
    val requestDigest = listOf(
        "v1",
        effectiveUserId.trim(),
        filename,
        parentVersionId.trim(),
        audioSha256,
    ).joinToString("\n").toByteArray(Charsets.UTF_8).sha256Hex()
    return ArticleRevisionRequestIdentity(
        articleVersionId = parentVersionId.trim(),
        requestId = "revision:$requestDigest",
        audioSha256 = audioSha256,
    )
}

object ArticleRevisionApi {
    suspend fun submitVoiceRevision(
        apiBaseUrl: String,
        filesToken: String,
        effectiveUserId: String,
        filename: String,
        parentVersionId: String,
        audioFile: File,
    ): ArticleRevisionSubmitResult = withContext(Dispatchers.IO) {
        val identity = createArticleRevisionRequestIdentity(
            effectiveUserId = effectiveUserId,
            filename = filename,
            parentVersionId = parentVersionId,
            audioFile = audioFile,
        )
        submitVoiceRevisionWithToken(apiBaseUrl, filesToken, filename, audioFile, identity)
    }

    suspend fun submitVoiceRevision(
        apiBaseUrl: String,
        filesToken: String,
        filename: String,
        audioFile: File,
    ): ArticleRevisionSubmitResult = withContext(Dispatchers.IO) {
        submitVoiceRevisionWithToken(apiBaseUrl, filesToken, filename, audioFile, identity = null)
    }

    suspend fun submitVoiceRevision(
        preferences: AppPreferences,
        effectiveUserId: String,
        filename: String,
        parentVersionId: String,
        audioFile: File,
    ): ArticleRevisionSubmitResult = withContext(Dispatchers.IO) {
        val identity = createArticleRevisionRequestIdentity(
            effectiveUserId = effectiveUserId,
            filename = filename,
            parentVersionId = parentVersionId,
            audioFile = audioFile,
        )
        submitVoiceRevisionWithPreferences(preferences, filename, audioFile, identity)
    }

    suspend fun submitVoiceRevision(
        preferences: AppPreferences,
        filename: String,
        audioFile: File,
    ): ArticleRevisionSubmitResult = withContext(Dispatchers.IO) {
        submitVoiceRevisionWithPreferences(preferences, filename, audioFile, identity = null)
    }

    private fun submitVoiceRevisionWithToken(
        apiBaseUrl: String,
        filesToken: String,
        filename: String,
        audioFile: File,
        identity: ArticleRevisionRequestIdentity?,
    ): ArticleRevisionSubmitResult {
        require(filesToken.isNotBlank()) { "请先登录后提交修改" }
        require(audioFile.exists() && audioFile.length() > 0L) { "修改语音文件为空" }

        val connection = (articleRevisionEndpoint(apiBaseUrl, filename).openConnection() as HttpURLConnection).apply {
            configureArticleRevisionConnection(filesToken, audioFile, identity)
        }
        audioFile.inputStream().use { input ->
            connection.outputStream.use { output -> input.copyTo(output) }
        }
        val responseCode = connection.responseCode
        val responseBody = if (responseCode in 200..299) {
            connection.inputStream.bufferedReader().use { it.readText() }
        } else {
            connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
        }
        return parseArticleRevisionResponse(responseCode, responseBody, identity)
    }

    private suspend fun submitVoiceRevisionWithPreferences(
        preferences: AppPreferences,
        filename: String,
        audioFile: File,
        identity: ArticleRevisionRequestIdentity?,
    ): ArticleRevisionSubmitResult {
        require(preferences.accessToken.isNotBlank()) { "请先登录后提交修改" }
        require(audioFile.exists() && audioFile.length() > 0L) { "修改语音文件为空" }

        val response = AuthenticatedHttpClient.execute(preferences) { accessToken ->
            (articleRevisionEndpoint(preferences.apiBaseUrl, filename).openConnection() as HttpURLConnection).apply {
                configureArticleRevisionConnection(accessToken, audioFile, identity)
                audioFile.inputStream().use { input ->
                    outputStream.use { output -> input.copyTo(output) }
                }
            }
        }
        return parseArticleRevisionResponse(response.statusCode, response.body, identity)
    }
}

private fun HttpURLConnection.configureArticleRevisionConnection(
    accessToken: String,
    audioFile: File,
    identity: ArticleRevisionRequestIdentity?,
) {
    requestMethod = "POST"
    connectTimeout = 15_000
    readTimeout = 60_000
    doOutput = true
    setRequestProperty("Authorization", "Bearer $accessToken")
    setRequestProperty("Content-Type", "audio/mp4")
    setRequestProperty("X-Revision-Instruction-File-Name", audioFile.name)
    identity?.headers?.forEach { (name, value) -> setRequestProperty(name, value) }
    setFixedLengthStreamingMode(audioFile.length())
}

private fun parseArticleRevisionResponse(
    responseCode: Int,
    responseBody: String,
    identity: ArticleRevisionRequestIdentity?,
): ArticleRevisionSubmitResult {
    if (responseCode !in 200..299) {
        throw ArticleRevisionSubmitException(
            userMessage = articleRevisionFailureMessage(responseCode, responseBody),
            responseCode = responseCode,
        )
    }
    val result = parseArticleRevisionSubmitResult(responseBody)
    if (identity != null && result.parentVersionId.isNotBlank() && result.parentVersionId != identity.articleVersionId) {
        throw ArticleRevisionSubmitException("服务器绑定了错误的文章版本，请刷新后重试", responseCode)
    }
    if (identity != null && result.continueRevision == false) {
        throw ArticleRevisionSubmitException("服务器未接受当前文章版本，请刷新后重试", responseCode)
    }
    return result
}

fun parseArticleRevisionSubmitResult(responseBody: String): ArticleRevisionSubmitResult {
    val json = JSONObject(responseBody)
    val continueValue = json.opt("continue_revision")
    val continueRevision = if (continueValue is Boolean) {
        continueValue
    } else if (continueValue is JSONObject) {
        continueValue.optBoolean("accepted", true)
    } else {
        null
    }
    val parentVersionId = json.optString("parent_version_id", "").trim().ifBlank {
        (continueValue as? JSONObject)?.optString("parent_version_id", "")?.trim().orEmpty()
    }
    return ArticleRevisionSubmitResult(
        revisionId = json.optString("revision_id", ""),
        status = json.optString("status", "QUEUED"),
        parentVersionId = parentVersionId,
        continueRevision = continueRevision,
    )
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
        401, 403 -> "登录已失效或没有权限，无法提交修改"
        409 -> "文章已有新版本，请刷新后重新提交修改"
        else -> {
            val error = articleRevisionResponseMessage(responseBody)
            if (error.isBlank()) "提交修改失败 HTTP $responseCode" else "提交修改失败：$error"
        }
    }
}

private fun File.sha256Hex(): String {
    val digest = MessageDigest.getInstance("SHA-256")
    inputStream().use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().toHexString()
}

private fun ByteArray.sha256Hex(): String =
    MessageDigest.getInstance("SHA-256").digest(this).toHexString()

private fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it) }

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
