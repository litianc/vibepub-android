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

        // Clear it first
        composeTestRule.onNodeWithText("FILES_TOKEN").performTextClearance()
        
        // Type into the UI
        composeTestRule.onNodeWithText("FILES_TOKEN").performTextInput(testToken)
        
        // Assert that the underlying SharedPreferences got updated immediately
        assertEquals(testToken, prefs.filesToken)
    }
}
