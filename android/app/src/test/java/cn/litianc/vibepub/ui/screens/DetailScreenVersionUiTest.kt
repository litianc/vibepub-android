package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
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
}
