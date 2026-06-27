package cn.litianc.vibepub

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.activity.ComponentActivity
import cn.litianc.vibepub.ui.screens.SettingsScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppHealthCheckTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun testPreferencesTwoWayBinding() {
        val context = composeTestRule.activity
        val prefs = AppPreferences(context)
        val testToken = "TEST_TOKEN_${System.currentTimeMillis()}"
        
        composeTestRule.setContent {
            SettingsScreen(onBackClick = {})
        }

        // Click FILES_TOKEN row to open dialog
        composeTestRule.onNodeWithTag("FilesTokenItem").performClick()
        
        composeTestRule.waitUntil(timeoutMillis = 5000) {
            composeTestRule.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty()
        }
        
        // Clear and type into the dialog's text field
        composeTestRule.onNode(hasSetTextAction()).performTextClearance()
        composeTestRule.onNode(hasSetTextAction()).performTextInput(testToken)
        
        // Click save
        composeTestRule.onNodeWithText("保存").performClick()
        
        // Wait until dialog closes
        composeTestRule.waitUntil(timeoutMillis = 5000) {
            composeTestRule.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isEmpty()
        }
        
        // Assert that the AppPreferences instance reflects the typed token
        assertEquals(testToken, prefs.filesToken)
    }
}
