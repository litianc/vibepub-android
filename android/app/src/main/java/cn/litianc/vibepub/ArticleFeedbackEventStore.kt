package cn.litianc.vibepub

import android.content.Context
import java.security.MessageDigest
import java.util.UUID

enum class ArticleFeedbackAction(val wireValue: String) {
    ADOPTED("adopted"),
    NOT_ADOPTED("not_adopted"),
}

data class ArticleFeedbackEventKey(
    val userId: String,
    val filename: String,
    val versionId: String,
    val action: ArticleFeedbackAction,
)

class ArticleFeedbackEventStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun getOrCreatePending(event: ArticleFeedbackEventKey): String {
        val storageKey = storageKey(event)
        val stored = preferences.getString("$storageKey.client", null)?.trim().orEmpty()
        val completed = preferences.getBoolean("$storageKey.completed", false)
        if (stored.isNotBlank() && !completed) return stored

        return UUID.randomUUID().toString().also { clientEventId ->
            val saved = preferences.edit()
                .putString("$storageKey.client", clientEventId)
                .putBoolean("$storageKey.completed", false)
                .commit()
            check(saved) { "无法保存反馈事件编号，请重试" }
        }
    }

    fun markCompleted(
        event: ArticleFeedbackEventKey,
        clientEventId: String,
    ) {
        val storageKey = storageKey(event)
        if (preferences.getString("$storageKey.client", null) != clientEventId) return
        val saved = preferences.edit()
            .putBoolean("$storageKey.completed", true)
            .commit()
        check(saved) { "无法确认反馈事件，请重试" }
    }

    private fun storageKey(event: ArticleFeedbackEventKey): String {
        val raw = listOf(event.userId, event.filename, event.versionId, event.action.wireValue).joinToString("\u0000")
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(raw.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return "event_$digest"
    }

    companion object {
        internal const val PREFERENCES_NAME = "vibepub_article_feedback_events"
    }
}
