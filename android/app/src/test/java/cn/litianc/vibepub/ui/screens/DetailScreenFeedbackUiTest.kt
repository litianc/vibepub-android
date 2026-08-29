package cn.litianc.vibepub.ui.screens

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import cn.litianc.vibepub.ArticleFeedbackAction
import cn.litianc.vibepub.ArticleFeedbackClient
import cn.litianc.vibepub.ArticleFeedbackEventKey
import cn.litianc.vibepub.ArticleFeedbackEventStore
import cn.litianc.vibepub.ArticleFeedbackState
import cn.litianc.vibepub.CurrentArticleVersion
import cn.litianc.vibepub.submitAndConfirmArticleFeedback
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DetailScreenFeedbackUiTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun versionedArticleShowsTheLatestChoiceAndAllowsChangingIt() {
        var selected: ArticleFeedbackAction? = null
        val submittedActions = mutableListOf<ArticleFeedbackAction>()
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences(ArticleFeedbackEventStore.PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        val eventStore = ArticleFeedbackEventStore(context)
        val client = object : ArticleFeedbackClient {
            override suspend fun submit(
                filename: String,
                versionId: String,
                action: ArticleFeedbackAction,
                clientEventId: String,
            ) {
                submittedActions += action
            }

            override suspend fun load(filename: String) = ArticleFeedbackState(
                currentVersion = CurrentArticleVersion("version_1", 1),
                currentAction = submittedActions.last(),
            )
        }
        composeTestRule.setContent {
            var serverConfirmedAction by remember { mutableStateOf<ArticleFeedbackAction?>(ArticleFeedbackAction.ADOPTED) }
            val scope = rememberCoroutineScope()
            MaterialTheme {
                ArticleFeedbackControls(
                    displayedVersionId = "version_1",
                    serverVersionId = "version_1",
                    currentAction = serverConfirmedAction,
                    inProgress = false,
                    message = "",
                    onSelect = {
                        selected = it
                        val event = ArticleFeedbackEventKey(
                            userId = "usr_a",
                            filename = "voice.m4a",
                            versionId = "version_1",
                            action = it,
                        )
                        scope.launch {
                            serverConfirmedAction = submitAndConfirmArticleFeedback(client, eventStore, event).currentAction
                        }
                    },
                )
            }
        }

        composeTestRule.onNodeWithTag("ArticleFeedbackControls").assertIsDisplayed()
        composeTestRule.onNodeWithText("已采用当前版本").assertIsDisplayed()
        composeTestRule.onNodeWithTag("AdoptArticleVersionButton").assertIsNotEnabled()
        composeTestRule.onNodeWithTag("NotAdoptArticleVersionButton")
            .assertIsEnabled()
            .performClick()
        composeTestRule.waitForIdle()
        assertEquals(ArticleFeedbackAction.NOT_ADOPTED, selected)
        assertEquals(listOf(ArticleFeedbackAction.NOT_ADOPTED), submittedActions)
        composeTestRule.onNodeWithText("已记录暂不采用").assertIsDisplayed()
        composeTestRule.onNodeWithTag("NotAdoptArticleVersionButton").assertIsNotEnabled()
    }

    @Test
    fun oldArticleWithoutVersionShowsNoFeedbackControls() {
        composeTestRule.setContent {
            MaterialTheme {
                ArticleFeedbackControls(
                    displayedVersionId = "",
                    serverVersionId = "",
                    currentAction = null,
                    inProgress = false,
                    message = "",
                    onSelect = {},
                )
            }
        }

        composeTestRule.onAllNodesWithTag("ArticleFeedbackControls").assertCountEquals(0)
    }

    @Test
    fun stalePageCannotSubmitFeedbackForTheNewServerVersion() {
        composeTestRule.setContent {
            MaterialTheme {
                ArticleFeedbackControls(
                    displayedVersionId = "version_1",
                    serverVersionId = "version_2",
                    currentAction = null,
                    inProgress = false,
                    message = "",
                    onSelect = {},
                )
            }
        }

        composeTestRule.onNodeWithText("文章已有新版本，请刷新后再选择").assertIsDisplayed()
        composeTestRule.onNodeWithTag("AdoptArticleVersionButton").assertIsNotEnabled()
        composeTestRule.onNodeWithTag("NotAdoptArticleVersionButton").assertIsNotEnabled()
    }
}
