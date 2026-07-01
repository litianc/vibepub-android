package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsDiagnosticsDialogTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun diagnosticsDialogKeepsLongContentScrollableAndCopyable() {
        var dismissCount = 0
        var copyCount = 0
        val diagnostics = buildString {
            appendLine("App: VibePub 0.1.0-debug (1)")
            appendLine("Device: Redmi Tablet")
            appendLine("API host: https://vibepub.litianc.cn")
            appendLine("Recent recordings:")
            repeat(80) { index ->
                appendLine("${index + 1}. VibePub-long-diagnostic-$index.m4a | 0m18s | PROCESSING | 转录中")
            }
            append("Latest error: final line stays reachable after scrolling")
        }

        composeTestRule.setContent {
            DiagnosticsDialog(
                diagnostics = diagnostics,
                onDismiss = { dismissCount++ },
                onCopy = { copyCount++ },
            )
        }

        composeTestRule.onNodeWithTag("DiagnosticsDialog").assertIsDisplayed()
        composeTestRule.onNodeWithTag("DiagnosticsDialogText")
            .assertIsDisplayed()
            .assert(hasScrollAction())
        composeTestRule.onNodeWithText("复制诊断").performClick()
        composeTestRule.runOnIdle {
            assertEquals(1, copyCount)
            assertEquals(0, dismissCount)
        }
        composeTestRule.onNodeWithText("关闭").performClick()
        composeTestRule.runOnIdle {
            assertEquals(1, dismissCount)
        }
    }
}
