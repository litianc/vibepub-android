package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HomeScreenInteractionTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun recordButtonShortClickStartsRecording() {
        var recordClicks = 0
        composeTestRule.setContent {
            HomeScreen(
                recordingsFlow = flowOf(emptyList()),
                lastSyncAtMs = 0L,
                onSettingsClick = {},
                onRefresh = {},
                onAutoRefresh = {},
                onRetryUpload = {},
                onDeleteRecording = {},
                onRecordClick = { recordClicks += 1 },
                onImportAudioClick = {},
                onRecordingClick = {},
            )
        }

        composeTestRule.onNodeWithTag("RecordButton").performClick()

        assertEquals(1, recordClicks)
    }

    @Test
    fun recordButtonLongClickOpensAudioImportSheet() {
        composeTestRule.setContent {
            HomeScreen(
                recordingsFlow = flowOf(emptyList()),
                lastSyncAtMs = 0L,
                onSettingsClick = {},
                onRefresh = {},
                onAutoRefresh = {},
                onRetryUpload = {},
                onDeleteRecording = {},
                onRecordClick = {},
                onImportAudioClick = {},
                onRecordingClick = {},
            )
        }

        composeTestRule.onNodeWithTag("RecordButton").performTouchInput { longClick() }

        composeTestRule.onNodeWithTag("AudioImportSheet").assertIsDisplayed()
        composeTestRule.onNodeWithTag("ChooseAudioImportButton").assertIsDisplayed()
    }
}
