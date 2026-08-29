package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DetailScreenVersionUiTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun currentArticleVersionIsDisplayedOnTheDetailScreen() {
        composeTestRule.setContent {
            MaterialTheme {
                ArticleVersionIndicator("v1")
            }
        }

        composeTestRule.onNodeWithTag("ArticleVersionLabel")
            .assertIsDisplayed()
            .assertTextEquals("v1")
    }

    @Test
    fun oldArticleWithoutVersionDoesNotShowAPlaceholder() {
        composeTestRule.setContent {
            MaterialTheme {
                ArticleVersionIndicator("")
            }
        }

        composeTestRule.onAllNodesWithTag("ArticleVersionLabel").assertCountEquals(0)
    }

    @Test
    fun revisionVersionGuardKeepsLegacyPathAndDetectsStaleArticle() {
        assertEquals(
            ArticleRevisionVersionStatus.LEGACY,
            articleRevisionVersionStatus("", "", serverVersionLoaded = false),
        )
        assertEquals(
            ArticleRevisionVersionStatus.CURRENT,
            articleRevisionVersionStatus("version_1", "version_1", serverVersionLoaded = true),
        )
        assertEquals(
            ArticleRevisionVersionStatus.STALE,
            articleRevisionVersionStatus("version_1", "version_2", serverVersionLoaded = true),
        )
        assertEquals(
            ArticleRevisionVersionStatus.UNAVAILABLE,
            articleRevisionVersionStatus(
                "version_1",
                "",
                serverVersionLoaded = false,
                serverVersionFailed = true,
            ),
        )
    }

    @Test
    fun staleArticleRevisionShowsRefreshInsteadOfSubmitButtons() {
        composeTestRule.setContent {
            MaterialTheme {
                ArticleRevisionCard(
                    enabled = true,
                    versionStatus = ArticleRevisionVersionStatus.STALE,
                    state = ArticleRevisionUiState.IDLE,
                    intent = ArticleRevisionIntent.EDIT,
                    message = "",
                    elapsedLabel = "0:00",
                    onStartEdit = {},
                    onStartIllustration = {},
                    onStop = {},
                    onRefresh = {},
                )
            }
        }

        composeTestRule.onNodeWithText("文章已有新版本，请刷新后再修改").assertIsDisplayed()
        composeTestRule.onAllNodesWithTag("StartArticleRevisionButton").assertCountEquals(0)
        composeTestRule.onNodeWithTag("RefreshStaleArticleRevisionButton")
            .assertIsDisplayed()
            .assertIsEnabled()
    }
}
