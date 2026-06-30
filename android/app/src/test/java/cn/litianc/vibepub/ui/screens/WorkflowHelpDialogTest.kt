package cn.litianc.vibepub.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertEquals
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
        composeTestRule.onNodeWithText("下一步建议").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("下一步：等待云端转录；如果长时间没有更新，点同步刷新。")
            .performScrollTo()
            .assertIsDisplayed()
        composeTestRule.onNodeWithText("完整流程周期").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("保存录音 → 上传音频 → 云端排队 → 语音识别 → 文章改写 → 公众号草稿 → 人工发布确认")
            .performScrollTo()
            .assertIsDisplayed()
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
        composeTestRule.onNodeWithText("需要关注").assertIsDisplayed()
        composeTestRule.onNodeWithText("需要处理：到设置页更新 FILES_TOKEN，并用“测试后端连接”确认授权。").assertIsDisplayed()
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
                    remoteStatusUpdatedAt = "2026-06-30T03:00:00Z",
                ),
                lastSyncAtMs = 1_000L,
                onClick = {},
                onRetryUpload = {},
                onRefresh = {},
                onDeleteRecording = {},
            )
        }

        composeTestRule.onNodeWithText("转录中").assertIsDisplayed()
        composeTestRule.onNodeWithText("第 4/7 步").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("当前阶段更新：", substring = true).assertCountEquals(1)
        composeTestRule.onAllNodesWithTag("WorkflowHelpButton").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("云端正在进行语音识别。").assertCountEquals(0)
    }

    @Test
    fun recordingCardShowsRetryableUploadProblemInline() {
        composeTestRule.setContent {
            RecordingCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.UPLOADING.value,
                    lastError = "网络异常，稍后自动重试",
                ),
                lastSyncAtMs = 1_000L,
                onClick = {},
                onRetryUpload = {},
                onRefresh = {},
                onDeleteRecording = {},
            )
        }

        composeTestRule.onNodeWithText("上传中").assertIsDisplayed()
        composeTestRule.onNodeWithText("最近上传问题：网络异常，稍后自动重试。").assertIsDisplayed()
    }

    @Test
    fun recordingCardShowsActionableAttentionCalloutForLocalRecordings() {
        composeTestRule.setContent {
            RecordingCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.LOCAL_RECORDED.value,
                ),
                lastSyncAtMs = 1_000L,
                onClick = {},
                onRetryUpload = {},
                onRefresh = {},
                onDeleteRecording = {},
            )
        }

        composeTestRule.onAllNodesWithTag("WorkflowAttentionCallout", useUnmergedTree = true).assertCountEquals(1)
        composeTestRule.onAllNodesWithText("需要上传").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("录音只在本机，点上传后才会进入云端转录和成文流程。").assertCountEquals(1)
    }

    @Test
    fun recordingCardRequiresConfirmationBeforeDeleting() {
        var deleteCount = 0
        composeTestRule.setContent {
            RecordingCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.COMPLETED.value,
                    articleTitle = "一篇已经成文的录音",
                ),
                lastSyncAtMs = 1_000L,
                onClick = {},
                onRetryUpload = {},
                onRefresh = {},
                onDeleteRecording = { deleteCount++ },
            )
        }

        composeTestRule.onNodeWithTag("DeleteRecordingButton").performClick()
        composeTestRule.onNodeWithTag("DeleteRecordingDialog").assertIsDisplayed()
        composeTestRule.onNodeWithText("删除这条录音？").assertIsDisplayed()
        composeTestRule.onNodeWithTag("CancelDeleteRecordingButton").performClick()

        composeTestRule.runOnIdle {
            assertEquals(0, deleteCount)
        }

        composeTestRule.onNodeWithTag("DeleteRecordingButton").performClick()
        composeTestRule.onNodeWithTag("ConfirmDeleteRecordingButton").performClick()

        composeTestRule.runOnIdle {
            assertEquals(1, deleteCount)
        }
    }

    @Test
    fun recordingCardRecoveryButtonUsesUploadOnlyForUploadFailures() {
        var retryCount = 0
        var refreshCount = 0
        composeTestRule.setContent {
            RecordingCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.FAILED.value,
                    lastError = "FILES_TOKEN 无效",
                ),
                lastSyncAtMs = 1_000L,
                onClick = {},
                onRetryUpload = { retryCount++ },
                onRefresh = { refreshCount++ },
                onDeleteRecording = {},
            )
        }

        composeTestRule.onNodeWithTag("RecordingRecoveryButton").performClick()

        composeTestRule.runOnIdle {
            assertEquals(1, retryCount)
            assertEquals(0, refreshCount)
        }
    }

    @Test
    fun recordingCardRecoveryButtonSyncsCloudStageFailures() {
        var retryCount = 0
        var refreshCount = 0
        composeTestRule.setContent {
            RecordingCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.FAILED.value,
                    processingStage = "ASR_FAILED",
                    lastError = "语音识别失败",
                ),
                lastSyncAtMs = 1_000L,
                onClick = {},
                onRetryUpload = { retryCount++ },
                onRefresh = { refreshCount++ },
                onDeleteRecording = {},
            )
        }

        composeTestRule.onNodeWithText("同步状态").assertIsDisplayed()
        composeTestRule.onNodeWithTag("RecordingRecoveryButton").performClick()

        composeTestRule.runOnIdle {
            assertEquals(0, retryCount)
            assertEquals(1, refreshCount)
        }
    }

    @Test
    fun detailStatusCardKeepsTimelineBehindHelpIcon() {
        composeTestRule.setContent {
            DetailStatusCardPreview(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.PROCESSING.value,
                    processingStage = "DRAFTING",
                    remoteStatusUpdatedAt = "2026-06-30T03:00:00Z",
                ),
            )
        }

        composeTestRule.onNodeWithText("生成草稿中").assertIsDisplayed()
        composeTestRule.onNodeWithText("第 6/7 步").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("当前阶段更新：", substring = true).assertCountEquals(2)
        composeTestRule.onNodeWithTag("DetailWorkflowHelpButton").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("文章改写 · 已完成").assertCountEquals(0)
        composeTestRule.onAllNodesWithText("公众号草稿 · 当前").assertCountEquals(0)
        composeTestRule.onAllNodesWithText("人工发布确认 · 等待").assertCountEquals(0)

        composeTestRule.onNodeWithTag("DetailWorkflowHelpButton").performClick()

        composeTestRule.onAllNodesWithText("文章改写 · 已完成").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("公众号草稿 · 当前").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("人工发布确认 · 等待").assertCountEquals(1)
        composeTestRule.onNodeWithText("更新时间").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun detailStatusCardSeparatesArticleReadyFromDraftReady() {
        composeTestRule.setContent {
            DetailStatusCardPreview(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.PROCESSING.value,
                    articleTitle = "文章已生成",
                    rawTextPreview = "原始识别结果",
                    processingStage = "ARTICLE_READY",
                ),
            )
        }

        composeTestRule.onNodeWithText("文章已生成").assertIsDisplayed()
        composeTestRule.onNodeWithText("第 6/7 步").assertIsDisplayed()
        composeTestRule.onNodeWithText("文章可用").assertIsDisplayed()
        composeTestRule.onNodeWithText("正文已经生成，可以先阅读、复制或分享；后台会继续同步草稿状态。").assertIsDisplayed()
        composeTestRule.onNodeWithText("下一步：可以先查看、复制或分享正文；点同步等待公众号草稿状态。").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("生成草稿中").assertCountEquals(0)
    }

    @Test
    fun detailStatusCardShowsBlockedStepOnlyInHelpDialog() {
        composeTestRule.setContent {
            DetailStatusCardPreview(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.FAILED.value,
                    lastError = "FILES_TOKEN 无效",
                ),
            )
        }

        composeTestRule.onAllNodesWithText("需要处理").assertCountEquals(2)
        composeTestRule.onNodeWithText("第 2/7 步").assertIsDisplayed()
        composeTestRule.onNodeWithText("到设置页更新 FILES_TOKEN，并用“测试后端连接”确认授权。").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("上传音频 · 需处理").assertCountEquals(0)

        composeTestRule.onNodeWithTag("DetailWorkflowHelpButton").performClick()

        composeTestRule.onAllNodesWithText("上传音频 · 需处理").assertCountEquals(1)
    }

    @Test
    fun detailStatusCardUsesSyncActionForDraftFailure() {
        var retryCount = 0
        var refreshCount = 0
        composeTestRule.setContent {
            StatusCard(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.COMPLETED.value,
                    articleTitle = "文章已生成",
                    processingStage = "DRAFT_FAILED",
                    lastError = "公众号草稿创建失败",
                ),
                lastSyncAtMs = 0L,
                onRefresh = { refreshCount++ },
                onRetryUpload = { retryCount++ },
            )
        }

        composeTestRule.onAllNodesWithText("草稿需处理").assertCountEquals(2)
        composeTestRule.onNodeWithText("第 6/7 步").assertIsDisplayed()
        composeTestRule.onNodeWithText("文章已可用，可以先复制正文；修复公众号草稿问题后再同步。").assertIsDisplayed()
        composeTestRule.onNodeWithText("同步草稿").assertIsDisplayed()
        composeTestRule.onNodeWithTag("DetailRecoveryButton").performClick()

        composeTestRule.runOnIdle {
            assertEquals(0, retryCount)
            assertEquals(1, refreshCount)
        }
    }

    @Test
    fun detailStatusHelpShowsCompletedDraftFailureAsBlockedStep() {
        composeTestRule.setContent {
            DetailStatusCardPreview(
                recording = RecordingEntity(
                    filename = "VibePub-test.m4a",
                    durationMs = 42_000L,
                    timestamp = 1L,
                    status = RecordingStatus.COMPLETED.value,
                    articleTitle = "文章已生成",
                    processingStage = "DRAFT_FAILED",
                    lastError = "公众号草稿创建失败",
                ),
            )
        }

        composeTestRule.onAllNodesWithText("草稿需处理").assertCountEquals(2)
        composeTestRule.onAllNodesWithText("公众号草稿 · 需处理").assertCountEquals(0)

        composeTestRule.onNodeWithTag("DetailWorkflowHelpButton").performClick()

        composeTestRule.onAllNodesWithText("文章改写 · 已完成").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("公众号草稿 · 需处理").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("人工发布确认 · 等待").assertCountEquals(1)
    }

    @Composable
    private fun DetailStatusCardPreview(recording: RecordingEntity) {
        StatusCard(
            recording = recording,
            lastSyncAtMs = 0L,
            onRefresh = {},
            onRetryUpload = {},
        )
    }
}
