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

        composeTestRule.onNodeWithTag("FilesTokenField").performTextClearance()
        composeTestRule.onNodeWithTag("FilesTokenField").performTextInput(testToken)
        
        assertEquals(testToken, prefs.filesToken)
    }
}
