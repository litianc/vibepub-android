package cn.litianc.vibepub

import android.Manifest
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = TestApplication::class)
class AppHealthCheckTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val grantPermissionRule: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    @Test
    fun testPreferencesTwoWayBinding() {
        val testToken = "test_token_123"
        val prefs = AppPreferences(composeTestRule.activity)
        
        // Open Settings
        composeTestRule.onNodeWithContentDescription("Settings").performClick()
        
        composeTestRule.waitUntil(timeoutMillis = 5000) {
            composeTestRule.onAllNodesWithTag("FilesTokenItem").fetchSemanticsNodes().isNotEmpty()
        }

        // Click FILES_TOKEN row to open dialog
        composeTestRule.onNodeWithTag("FilesTokenItem").performClick()
        
        composeTestRule.waitUntil(timeoutMillis = 5000) {
            composeTestRule.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty()
        }
        
        // Clear and type into the dialog's text field
        composeTestRule.onNode(hasSetTextAction()).performTextClearance()
        composeTestRule.onNode(hasSetTextAction()).performTextInput(testToken)
        
        // Click Save
        composeTestRule.onNodeWithText("保存").performClick()
        
        // Assert that the underlying SharedPreferences got updated
        assertEquals(testToken, prefs.filesToken)
    }
}
