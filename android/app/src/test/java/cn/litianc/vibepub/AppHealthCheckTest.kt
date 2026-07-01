package cn.litianc.vibepub

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cn.litianc.vibepub.ui.screens.SettingsScreen
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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

    @Test
    fun lastSyncAtMsFlowEmitsPreferenceUpdates() = runBlocking {
        val context = composeTestRule.activity
        val prefs = AppPreferences(context)
        prefs.lastSyncAtMs = 0L

        val update = async(start = CoroutineStart.UNDISPATCHED) {
            prefs.lastSyncAtMsFlow().drop(1).first()
        }

        prefs.lastSyncAtMs = 123_456L

        assertEquals(123_456L, withTimeout(2_000L) { update.await() })
    }
}
