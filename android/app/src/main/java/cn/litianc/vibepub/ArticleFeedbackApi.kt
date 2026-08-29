package cn.litianc.vibepub

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL

data class CurrentArticleVersion(
    val id: String,
    val versionNo: Int,
)

data class ArticleFeedbackState(
    val currentVersion: CurrentArticleVersion?,
    val currentAction: ArticleFeedbackAction?,
)

internal const val STALE_ARTICLE_VERSION_MESSAGE = "文章已有新版本，请刷新后再选择"

class ArticleFeedbackException(
    message: String,
    val responseCode: Int,
) : IllegalStateException(message)

internal interface ArticleFeedbackClient {
    suspend fun load(filename: String): ArticleFeedbackState

    suspend fun submit(
        filename: String,
        versionId: String,
        action: ArticleFeedbackAction,
        clientEventId: String,
    )
}

internal class AuthenticatedArticleFeedbackClient(
    private val preferences: AppPreferences,
) : ArticleFeedbackClient {
    override suspend fun load(filename: String): ArticleFeedbackState =
        ArticleFeedbackApi.load(preferences, filename)

    override suspend fun submit(
        filename: String,
        versionId: String,
        action: ArticleFeedbackAction,
        clientEventId: String,
    ) = ArticleFeedbackApi.submit(
        preferences = preferences,
        filename = filename,
        versionId = versionId,
        action = action,
        clientEventId = clientEventId,
    )
}

internal suspend fun submitAndConfirmArticleFeedback(
    client: ArticleFeedbackClient,
    eventStore: ArticleFeedbackEventStore,
    event: ArticleFeedbackEventKey,
): ArticleFeedbackState {
    val clientEventId = eventStore.getOrCreatePending(event)
    client.submit(
        filename = event.filename,
        versionId = event.versionId,
        action = event.action,
        clientEventId = clientEventId,
    )
    eventStore.markCompleted(
        event = event,
        clientEventId = clientEventId,
    )
    return client.load(event.filename)
}

object ArticleFeedbackApi {
    suspend fun load(
        preferences: AppPreferences,
        filename: String,
    ): ArticleFeedbackState = withContext(Dispatchers.IO) {
        val response = AuthenticatedHttpClient.request(
            preferences = preferences,
            url = articleFeedbackEndpoint(preferences.apiBaseUrl, filename),
        )
        if (response.statusCode !in 200..299) {
            throw ArticleFeedbackException(
                articleFeedbackFailureMessage(response.statusCode, response.body),
                response.statusCode,
            )
        }
        parseArticleFeedbackState(response.body)
    }

    suspend fun submit(
        preferences: AppPreferences,
        filename: String,
        versionId: String,
        action: ArticleFeedbackAction,
        clientEventId: String,
    ) = withContext(Dispatchers.IO) {
        require(versionId.isNotBlank()) { "文章版本不存在" }
        require(clientEventId.isNotBlank()) { "反馈事件编号不存在" }
        val payload = JSONObject().apply {
            put("version_id", versionId)
            put("action", action.wireValue)
            put("client_event_id", clientEventId)
        }.toString().toByteArray(Charsets.UTF_8)
        val response = AuthenticatedHttpClient.request(
            preferences = preferences,
            url = articleFeedbackEndpoint(preferences.apiBaseUrl, filename),
            method = "POST",
            body = payload,
            contentType = "application/json; charset=utf-8",
        )
        if (response.statusCode !in 200..299) {
            throw ArticleFeedbackException(
                articleFeedbackFailureMessage(response.statusCode, response.body),
                response.statusCode,
            )
        }
        val body = JSONObject(response.body)
        val feedbackId = body.optJSONObject("feedback")?.optString("id").orEmpty().trim()
        if (feedbackId.isBlank()) {
            throw ArticleFeedbackException("服务器没有返回反馈编号，请重试", response.statusCode)
        }
    }
}

internal fun articleFeedbackEndpoint(apiBaseUrl: String, filename: String): URL {
    val encodedFilename = URLEncoder.encode(filename, "UTF-8").replace("+", "%20")
    return URL("${apiBaseUrl.trimEnd('/')}/api/recordings/$encodedFilename/article-feedback")
}

internal fun parseArticleFeedbackState(responseBody: String): ArticleFeedbackState {
    val body = JSONObject(responseBody)
    val versionJson = body.optJSONObject("current_version")
    val versionId = versionJson?.optString("id").orEmpty().trim()
    val versionNo = versionJson?.optInt("version_no", 0) ?: 0
    val action = when (body.optJSONObject("current_feedback")?.optString("action")) {
        ArticleFeedbackAction.ADOPTED.wireValue -> ArticleFeedbackAction.ADOPTED
        ArticleFeedbackAction.NOT_ADOPTED.wireValue -> ArticleFeedbackAction.NOT_ADOPTED
        else -> null
    }
    return ArticleFeedbackState(
        currentVersion = if (versionId.isNotBlank() && versionNo > 0) {
            CurrentArticleVersion(versionId, versionNo)
        } else {
            null
        },
        currentAction = action,
    )
}

internal fun articleFeedbackFailureMessage(responseCode: Int, responseBody: String): String {
    val message = runCatching {
        val body = JSONObject(responseBody)
        body.optString("message").trim().ifBlank { body.optString("error").trim() }
    }.getOrDefault("")
    if (message.isNotBlank()) return message
    return when (responseCode) {
        HttpURLConnection.HTTP_UNAUTHORIZED,
        HttpURLConnection.HTTP_FORBIDDEN,
        -> "登录已失效，请重新登录"
        HttpURLConnection.HTTP_NOT_FOUND -> "文章版本不存在，请刷新"
        HttpURLConnection.HTTP_CONFLICT -> "文章状态已变化，请刷新后再选择"
        else -> "保存选择失败 HTTP $responseCode"
    }
}
