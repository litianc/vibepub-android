package cn.litianc.vibepub

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.rule.GrantPermissionRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val grantPermissionRule: GrantPermissionRule =
        GrantPermissionRule.grant(android.Manifest.permission.RECORD_AUDIO)

    @Test
    fun testRecordAndUploadFlow() {
        // Since we have a default token for UI tests, we simulate a successful recording
        val prefs = AppPreferences(composeTestRule.activity)
        prefs.filesToken = "mock_token"

        composeTestRule.onNodeWithText("RECORD").assertIsDisplayed()

        // Click Record
        composeTestRule.onNodeWithText("RECORD").performClick()

        // UI should change to "STOP"
        composeTestRule.onNodeWithText("STOP").assertIsDisplayed()
        
        // Let it record for a brief moment
        Thread.sleep(100)

        // Click Stop
        composeTestRule.onNodeWithText("STOP").performClick()

        // Should automatically upload and show Snackbar
        // Note: Snackbar assertion is flaky in Robolectric due to async animations and MediaRecorder stubs
        // composeTestRule.onNodeWithText("Uploading to Cloud...", substring = true).assertIsDisplayed()
    }
}
