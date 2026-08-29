package cn.litianc.vibepub

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ArticleFeedbackSubmissionTest {
    private lateinit var context: Context

    @Before
    fun clearStoredEvents() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(ArticleFeedbackEventStore.PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    @Test
    fun networkRetryReusesTheEventThenReturnsTheServerConfirmedChoice() = runBlocking {
        val submittedIds = mutableListOf<String>()
        var failFirst = true
        val client = object : ArticleFeedbackClient {
            override suspend fun submit(
                filename: String,
                versionId: String,
                action: ArticleFeedbackAction,
                clientEventId: String,
            ) {
                submittedIds += clientEventId
                if (failFirst) {
                    failFirst = false
                    error("synthetic response loss")
                }
            }

            override suspend fun load(filename: String) = ArticleFeedbackState(
                currentVersion = CurrentArticleVersion("version_1", 1),
                currentAction = ArticleFeedbackAction.NOT_ADOPTED,
            )
        }
        val key = ArticleFeedbackEventKey(
            userId = "usr_a",
            filename = "voice.m4a",
            versionId = "version_1",
            action = ArticleFeedbackAction.NOT_ADOPTED,
        )
        val store = ArticleFeedbackEventStore(context)

        runCatching { submitAndConfirmArticleFeedback(client, store, key) }
        val confirmed = submitAndConfirmArticleFeedback(client, store, key)

        assertEquals(2, submittedIds.size)
        assertEquals(submittedIds[0], submittedIds[1])
        assertEquals(ArticleFeedbackAction.NOT_ADOPTED, confirmed.currentAction)
    }
}
