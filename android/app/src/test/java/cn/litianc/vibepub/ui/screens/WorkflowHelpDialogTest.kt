package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WorkflowHelpDialogTest {
    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun showsTranscriptionStepAndLifecycle() {
        composeTestRule.setContent {
            WorkflowHelpDialog(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.PROCESSING.value,
                ),
                onDismiss = {},
            )
        }

        composeTestRule.onNodeWithText("当前状态：转录中").assertIsDisplayed()
        composeTestRule.onNodeWithText("当前状态说明").assertIsDisplayed()
        composeTestRule.onNodeWithText("当前节点").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("当前节点：4. 语音识别 · 当前", substring = true).assertCountEquals(2)
        composeTestRule.onNodeWithText("完整流程周期").assertIsDisplayed()
        composeTestRule.onNodeWithText("保存录音 → 上传音频 → 云端排队 → 语音识别 → 文章改写 → 公众号草稿 → 人工发布确认").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("语音识别 · 当前").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("文章改写 · 等待").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("公众号草稿 · 等待").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("人工发布确认 · 等待").assertCountEquals(1)
    }

    @Test
    fun showsArticleRewriteStepWhenRawTextExists() {
        composeTestRule.setContent {
            WorkflowHelpDialog(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.PROCESSING.value,
                    rawTextPreview = "已经识别出的原始文字",
                ),
                onDismiss = {},
            )
        }

        composeTestRule.onNodeWithText("当前状态：正在成文").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("语音识别 · 已完成").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("文章改写 · 当前").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("公众号草稿 · 等待").assertCountEquals(1)
    }

    @Test
    fun showsFailureRecoveryHint() {
        composeTestRule.setContent {
            WorkflowHelpDialog(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.FAILED.value,
                    lastError = "FILES_TOKEN 无效",
                ),
                onDismiss = {},
            )
        }

        composeTestRule.onAllNodesWithText("上传音频 · 需处理").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("失败后可以先重试；如果仍失败，到设置页检查后端连接和 FILES_TOKEN。").assertCountEquals(1)
    }

    @Test
    fun recordingCardKeepsProcessingStateCompactUntilHelpIsOpened() {
        composeTestRule.setContent {
            RecordingCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.PROCESSING.value,
                    processingStage = "ASR",
                ),
                onClick = {},
                onRetryUpload = {},
                onDeleteRecording = {},
            )
        }

        composeTestRule.onNodeWithText("转录中").assertIsDisplayed()
        composeTestRule.onNodeWithText("第 4/7 步").assertIsDisplayed()
        composeTestRule.onNodeWithTag("WorkflowHelpButton").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("云端正在进行语音识别。").assertCountEquals(0)
    }
}
