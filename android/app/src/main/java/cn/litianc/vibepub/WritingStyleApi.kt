package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class StyleSourceImportResult(
    val id: String,
    val status: String,
    val title: String?,
)

data class StyleSourceImportSummary(
    val id: String,
    val sourceType: String,
    val title: String?,
    val status: String,
    val textPreview: String,
    val createdAt: String,
)

data class StyleDistillationResult(
    val jobId: String,
    val profile: WritingStyleProfileOption,
    val body: String,
)

object WritingStyleApi {
    suspend fun listStyleProfiles(
        apiBaseUrl: String,
        filesToken: String,
    ): List<WritingStyleProfileOption> = withContext(Dispatchers.IO) {
        require(filesToken.isNotBlank()) { "请先登录后同步写作风格" }
        val response = requestJson(
            apiBaseUrl = apiBaseUrl,
            filesToken = filesToken,
            path = "/api/style-profiles",
            method = "GET",
        )
        parseStyleProfilesResponse(response)
    }

    suspend fun listStyleProfiles(
        preferences: AppPreferences,
    ): List<WritingStyleProfileOption> = withContext(Dispatchers.IO) {
        require(preferences.accessToken.isNotBlank()) { "请先登录后同步写作风格" }
        parseStyleProfilesResponse(
            requestJson(
                preferences = preferences,
                path = "/api/style-profiles",
                method = "GET",
            ),
        )
    }

    suspend fun getStyleProfile(
        apiBaseUrl: String,
        filesToken: String,
        profileId: String,
        includeBody: Boolean = true,
    ): WritingStyleProfileOption = withContext(Dispatchers.IO) {
        require(filesToken.isNotBlank()) { "请先登录后查看写作风格" }
        val encodedId = URLEncoder.encode(profileId.trim(), "UTF-8")
        val response = requestJson(
            apiBaseUrl = apiBaseUrl,
            filesToken = filesToken,
            path = "/api/style-profiles/$encodedId?include_body=$includeBody",
            method = "GET",
        )
        parseStyleProfileResponse(response)
    }

    suspend fun getStyleProfile(
        preferences: AppPreferences,
        profileId: String,
        includeBody: Boolean = true,
    ): WritingStyleProfileOption = withContext(Dispatchers.IO) {
        require(preferences.accessToken.isNotBlank()) { "请先登录后查看写作风格" }
        val encodedId = URLEncoder.encode(profileId.trim(), "UTF-8")
        parseStyleProfileResponse(
            requestJson(
                preferences = preferences,
                path = "/api/style-profiles/$encodedId?include_body=$includeBody",
                method = "GET",
            ),
        )
    }

    suspend fun listStyleSources(
        apiBaseUrl: String,
        filesToken: String,
    ): List<StyleSourceImportSummary> = withContext(Dispatchers.IO) {
        require(filesToken.isNotBlank()) { "请先登录后同步风格素材" }
        val response = requestJson(
            apiBaseUrl = apiBaseUrl,
            filesToken = filesToken,
            path = "/api/style-source-imports",
            method = "GET",
        )
        parseStyleSourceImportsResponse(response)
    }

    suspend fun listStyleSources(
        preferences: AppPreferences,
    ): List<StyleSourceImportSummary> = withContext(Dispatchers.IO) {
        require(preferences.accessToken.isNotBlank()) { "请先登录后同步风格素材" }
        parseStyleSourceImportsResponse(
            requestJson(
                preferences = preferences,
                path = "/api/style-source-imports",
                method = "GET",
            ),
        )
    }

    suspend fun importStyleSource(
        apiBaseUrl: String,
        filesToken: String,
        sourceType: String,
        title: String?,
        url: String?,
        text: String?,
    ): StyleSourceImportResult = withContext(Dispatchers.IO) {
        require(filesToken.isNotBlank()) { "请先登录后导入风格素材" }
        val payload = buildStyleSourceImportBody(
            sourceType = sourceType,
            title = title,
            url = url,
            text = text,
        )
        val response = requestJson(
            apiBaseUrl = apiBaseUrl,
            filesToken = filesToken,
            path = "/api/style-source-imports",
            method = "POST",
            body = payload,
        )
        parseStyleSourceImportResponse(response)
    }

    suspend fun importStyleSource(
        preferences: AppPreferences,
        sourceType: String,
        title: String?,
        url: String?,
        text: String?,
    ): StyleSourceImportResult = withContext(Dispatchers.IO) {
        require(preferences.accessToken.isNotBlank()) { "请先登录后导入风格素材" }
        parseStyleSourceImportResponse(
            requestJson(
                preferences = preferences,
                path = "/api/style-source-imports",
                method = "POST",
                body = buildStyleSourceImportBody(
                    sourceType = sourceType,
                    title = title,
                    url = url,
                    text = text,
                ),
            ),
        )
    }

    suspend fun distillStyleProfile(
        apiBaseUrl: String,
        filesToken: String,
        sourceImportIds: List<String>,
        profileId: String?,
        name: String?,
        description: String?,
    ): StyleDistillationResult = withContext(Dispatchers.IO) {
        require(filesToken.isNotBlank()) { "请先登录后生成风格模板" }
        val payload = buildStyleDistillationBody(
            sourceImportIds = sourceImportIds,
            profileId = profileId,
            name = name,
            description = description,
        )
        val response = requestJson(
            apiBaseUrl = apiBaseUrl,
            filesToken = filesToken,
            path = "/api/style-distillation-jobs",
            method = "POST",
            body = payload,
        )
        parseStyleDistillationResponse(response)
    }

    suspend fun distillStyleProfile(
        preferences: AppPreferences,
        sourceImportIds: List<String>,
        profileId: String?,
        name: String?,
        description: String?,
    ): StyleDistillationResult = withContext(Dispatchers.IO) {
        require(preferences.accessToken.isNotBlank()) { "请先登录后生成风格模板" }
        parseStyleDistillationResponse(
            requestJson(
                preferences = preferences,
                path = "/api/style-distillation-jobs",
                method = "POST",
                body = buildStyleDistillationBody(
                    sourceImportIds = sourceImportIds,
                    profileId = profileId,
                    name = name,
                    description = description,
                ),
            ),
        )
    }
}

internal fun parseStyleSourceImportsResponse(responseBody: String): List<StyleSourceImportSummary> {
    val array = JSONObject(responseBody).optJSONArray("source_imports") ?: JSONArray()
    return buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString("id").trim()
            if (id.isBlank()) continue
            add(
                StyleSourceImportSummary(
                    id = id,
                    sourceType = item.optString("source_type").trim().ifBlank { "text" },
                    title = item.optCleanOptionalString("title"),
                    status = item.optString("status").trim().ifBlank { "ready" },
                    textPreview = item.optCleanOptionalString("text_preview").orEmpty(),
                    createdAt = item.optString("created_at").trim(),
                ),
            )
        }
    }
}

internal fun buildStyleSourceImportBody(
    sourceType: String,
    title: String?,
    url: String?,
    text: String?,
): String {
    return JSONObject().apply {
        put("source_type", sourceType.trim().ifBlank { "text" })
        putOptionalString("title", title)
        putOptionalString("url", url)
        putOptionalString("text", text)
    }.toString()
}

internal fun buildStyleDistillationBody(
    sourceImportIds: List<String>,
    profileId: String?,
    name: String?,
    description: String?,
): String {
    return JSONObject().apply {
        put("source_import_ids", JSONArray(sourceImportIds.map { it.trim() }.filter { it.isNotBlank() }))
        put(
            "profile",
            JSONObject().apply {
                putOptionalString("id", profileId)
                putOptionalString("name", name)
                putOptionalString("description", description)
            },
        )
    }.toString()
}

internal fun parseStyleProfilesResponse(responseBody: String): List<WritingStyleProfileOption> {
    val array = JSONObject(responseBody).optJSONArray("style_profiles") ?: JSONArray()
    return buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            parseStyleProfileObject(item, fallbackName = null)?.let { add(it) }
        }
    }
}

internal fun parseStyleProfileResponse(responseBody: String): WritingStyleProfileOption {
    val profile = JSONObject(responseBody).getJSONObject("style_profile")
    return parseStyleProfileObject(profile, fallbackName = "我的写作风格")
        ?: throw IllegalArgumentException("风格模板响应缺少有效 id")
}

internal fun parseStyleSourceImportResponse(responseBody: String): StyleSourceImportResult {
    val source = JSONObject(responseBody).getJSONObject("source_import")
    return StyleSourceImportResult(
        id = source.getString("id"),
        status = source.optString("status").ifBlank { "ready" },
        title = source.optCleanOptionalString("title"),
    )
}

internal fun parseStyleDistillationResponse(responseBody: String): StyleDistillationResult {
    val root = JSONObject(responseBody)
    val job = root.getJSONObject("distillation_job")
    val profile = root.getJSONObject("style_profile")
    val body = profile.optString("body").trim()
    return StyleDistillationResult(
        jobId = job.getString("id"),
        profile = parseStyleProfileObject(profile, fallbackName = "我的写作风格")
            ?: throw IllegalArgumentException("风格画像生成结果缺少有效 id"),
        body = body,
    )
}

private fun parseStyleProfileObject(
    item: JSONObject,
    fallbackName: String?,
): WritingStyleProfileOption? {
    val id = item.optString("id").trim()
    val name = item.optString("name").trim().ifBlank { fallbackName.orEmpty() }
    if (id.isBlank() || name.isBlank()) return null
    return WritingStyleProfileOption(
        id = id,
        version = item.optString("version").trim().ifBlank { WritingStyleProfiles.DEFAULT_STYLE_PROFILE_VERSION },
        name = name,
        description = item.optString("description").trim(),
        body = item.optString("body").trim().takeIf { it.isNotBlank() },
        remote = true,
    )
}

private fun JSONObject.putOptionalString(name: String, value: String?) {
    val normalized = value?.trim().orEmpty()
    if (normalized.isNotBlank()) {
        put(name, normalized)
    }
}

private fun JSONObject.optCleanOptionalString(name: String): String? {
    val normalized = optString(name).trim()
    if (normalized.isBlank()) return null
    val lower = normalized.lowercase()
    if (lower == "null" || lower == "(null)" || lower == "undefined") return null
    return normalized
}

private fun requestJson(
    apiBaseUrl: String,
    filesToken: String,
    path: String,
    method: String,
    body: String? = null,
): String {
    val connection = (URL("${apiBaseUrl.trimEnd('/')}$path").openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = 15_000
        readTimeout = 60_000
        setRequestProperty("Authorization", "Bearer $filesToken")
        if (body != null) {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setFixedLengthStreamingMode(body.toByteArray(Charsets.UTF_8).size)
        }
    }

    if (body != null) {
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    }

    val status = connection.responseCode
    val responseBody = if (status in 200..299) {
        connection.inputStream.bufferedReader().use { it.readText() }
    } else {
        connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
    }
    if (status !in 200..299) {
        throw IllegalStateException(writingStyleApiFailureMessage(status, responseBody))
    }
    return responseBody
}

private suspend fun requestJson(
    preferences: AppPreferences,
    path: String,
    method: String,
    body: String? = null,
): String {
    val response = AuthenticatedHttpClient.request(
        preferences = preferences,
        url = URL("${preferences.apiBaseUrl.trimEnd('/')}$path"),
        method = method,
        body = body?.toByteArray(Charsets.UTF_8),
        contentType = if (body != null) "application/json; charset=utf-8" else null,
    )
    if (response.statusCode !in 200..299) {
        throw IllegalStateException(writingStyleApiFailureMessage(response.statusCode, response.body))
    }
    return response.body
}

internal fun writingStyleApiFailureMessage(responseCode: Int, responseBody: String): String {
    return when (responseCode) {
        401, 403 -> "登录已失效或没有权限，请重新登录"
        503 -> "WritingAgent 尚未配置，请先部署风格服务"
        in 500..599 -> "风格服务暂时不可用，请稍后重试"
        else -> runCatching { JSONObject(responseBody.ifBlank { "{}" }).optString("message") }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: "写作风格请求失败 HTTP $responseCode"
    }
}
