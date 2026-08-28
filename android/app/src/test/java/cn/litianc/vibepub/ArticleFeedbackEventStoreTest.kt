package cn.litianc.vibepub

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ArticleFeedbackEventStoreTest {
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
    fun pendingEventSurvivesRetriesAndProcessRestart() {
        val firstStore = ArticleFeedbackEventStore(context)
        val event = ArticleFeedbackEventKey(
            userId = "usr_a",
            filename = "voice.m4a",
            versionId = "version_1",
            action = ArticleFeedbackAction.ADOPTED,
        )
        val first = firstStore.getOrCreatePending(event)

        val retry = firstStore.getOrCreatePending(event)
        val afterRestart = ArticleFeedbackEventStore(context).getOrCreatePending(event)

        assertEquals(first, retry)
        assertEquals(first, afterRestart)
    }

    @Test
    fun completedChoiceRotatesOnlyWhenTheUserChoosesThatActionAgainLater() {
        val store = ArticleFeedbackEventStore(context)
        val event = ArticleFeedbackEventKey(
            userId = "usr_a",
            filename = "voice.m4a",
            versionId = "version_1",
            action = ArticleFeedbackAction.ADOPTED,
        )
        val first = store.getOrCreatePending(event)
        store.markCompleted(
            event = event,
            clientEventId = first,
        )

        val later = store.getOrCreatePending(event)

        assertNotEquals(first, later)
        assertEquals(
            later,
            ArticleFeedbackEventStore(context).getOrCreatePending(event),
        )
    }

    @Test
    fun accountsAndActionsNeverShareAnEventId() {
        val store = ArticleFeedbackEventStore(context)
        val adoptedA = store.getOrCreatePending(event("usr_a", ArticleFeedbackAction.ADOPTED))
        val notAdoptedA = store.getOrCreatePending(event("usr_a", ArticleFeedbackAction.NOT_ADOPTED))
        val adoptedB = store.getOrCreatePending(event("usr_b", ArticleFeedbackAction.ADOPTED))

        assertNotEquals(adoptedA, notAdoptedA)
        assertNotEquals(adoptedA, adoptedB)
    }

    private fun event(userId: String, action: ArticleFeedbackAction) = ArticleFeedbackEventKey(
        userId = userId,
        filename = "voice.m4a",
        versionId = "version_1",
        action = action,
    )
}
