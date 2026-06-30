package cn.litianc.vibepub.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class RecordingPresentationTest {
    @Test
    fun normalizesLegacyStatuses() {
        assertEquals(RecordingStatus.COMPLETED, RecordingStatus.normalize("COMPLETED"))
        assertEquals(RecordingStatus.UPLOADED, RecordingStatus.normalize("TRANSCRIBED"))
        assertEquals(RecordingStatus.LOCAL_RECORDED, RecordingStatus.normalize(""))
    }

    @Test
    fun formatsRecordingDisplayFields() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 32_500L,
            timestamp = 1_771_000_000_000L,
            status = RecordingStatus.PROCESSING.value,
        )

        assertTrue(recording.displayTitle(Locale.CHINA).contains("录音片段"))
        assertEquals("0:32", recording.durationLabel())
        assertEquals("0m32s", recording.listDurationLabel())
        assertEquals("转录中", recording.statusLabel())
        assertEquals("第 4/7 步", recording.workflowProgressLabel())
        assertEquals(0.5f, recording.workflowProgressFraction(), 0.001f)
    }

    @Test
    fun prefersArticleTitleAndFailureMessage() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.FAILED.value,
            articleTitle = "整理好的标题",
            lastError = "FILES_TOKEN 无效",
        )

        assertEquals("整理好的标题", recording.displayTitle())
        assertEquals("FILES_TOKEN 无效", recording.statusDetail())
        assertEquals(RecordingRecoveryActionType.RETRY_UPLOAD, recording.primaryRecoveryAction()?.type)
        assertEquals("重试上传", recording.primaryRecoveryAction()?.label)
    }

    @Test
    fun recoveryActionDistinguishesUploadFailuresFromCloudFailures() {
        val local = RecordingEntity(
            filename = "local.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.LOCAL_RECORDED.value,
        )
        val uploadFailed = local.copy(
            status = RecordingStatus.FAILED.value,
            lastError = "FILES_TOKEN 无效",
        )
        val asrFailed = local.copy(
            status = RecordingStatus.FAILED.value,
            processingStage = "ASR_FAILED",
            lastError = "语音识别失败",
        )
        val draftFailed = local.copy(
            status = RecordingStatus.COMPLETED.value,
            processingStage = "DRAFT_FAILED",
            articleTitle = "文章已生成",
            lastError = "公众号草稿创建失败",
        )

        assertEquals(RecordingRecoveryActionType.RETRY_UPLOAD, local.primaryRecoveryAction()?.type)
        assertEquals("上传", local.primaryRecoveryAction()?.label)
        assertEquals(RecordingRecoveryActionType.RETRY_UPLOAD, uploadFailed.primaryRecoveryAction()?.type)
        assertEquals("重试上传", uploadFailed.primaryRecoveryAction()?.label)
        assertEquals(RecordingRecoveryActionType.REFRESH_SYNC, asrFailed.primaryRecoveryAction()?.type)
        assertEquals("同步状态", asrFailed.primaryRecoveryAction()?.label)
        assertEquals(RecordingRecoveryActionType.REFRESH_SYNC, draftFailed.primaryRecoveryAction()?.type)
        assertEquals("同步草稿", draftFailed.primaryRecoveryAction()?.label)
    }

    @Test
    fun explainsCurrentWorkflowStep() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
            rawTextPreview = "已经识别出的原始文字",
        )

        val steps = recording.workflowSteps()

        assertEquals("当前状态：正在成文", recording.workflowHelpTitle())
        assertTrue(recording.workflowHelpSummary().contains("5. 文章改写"))
        assertTrue(recording.workflowHelpSummary().contains("第 5/7 步"))
        assertTrue(recording.workflowHelpSummary().contains("下一步：等待文章标题和正文生成"))
        assertEquals("当前节点：5. 文章改写 · 当前", recording.workflowCurrentNodeLabel())
        assertTrue(recording.workflowNextActionLabel().contains("等待文章标题和正文生成"))
        assertTrue(recording.workflowCycleLabel().contains("保存录音 → 上传音频 → 云端排队"))
        assertEquals(WorkflowStepState.DONE, steps[0].state)
        assertEquals(WorkflowStepState.DONE, steps[1].state)
        assertEquals(WorkflowStepState.DONE, steps[2].state)
        assertEquals(WorkflowStepState.DONE, steps[3].state)
        assertEquals(WorkflowStepState.CURRENT, steps[4].state)
        assertEquals(WorkflowStepState.PENDING, steps[5].state)
    }

    @Test
    fun serverProcessingStageDrivesVisibleWorkflowPosition() {
        val drafting = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
            articleTitle = "整理好的文章",
            rawTextPreview = "原始识别结果",
            processingStage = "DRAFTING",
        )

        val steps = drafting.workflowSteps()

        assertEquals("生成草稿中", drafting.statusLabel())
        assertTrue(drafting.statusDetail().contains("微信公众号草稿"))
        assertTrue(drafting.workflowNextActionLabel().contains("等待公众号草稿创建"))
        assertEquals("第 6/7 步", drafting.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.CURRENT, steps[5].state)
    }

    @Test
    fun workflowFreshnessExplainsHowLongCurrentStageHasBeenStale() {
        val processing = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1_000L,
            status = RecordingStatus.PROCESSING.value,
            remoteStatusUpdatedAt = "2026-06-30T03:00:00Z",
            processingStage = "ASR",
        )
        val completed = processing.copy(
            status = RecordingStatus.COMPLETED.value,
            completedAt = 1_000L,
            wechatDraftId = "MEDIA_ID_123",
        )
        val failed = processing.copy(
            status = RecordingStatus.FAILED.value,
            remoteStatusUpdatedAt = "2026-06-30 02:00:00",
            lastError = "语音识别失败",
        )

        assertEquals(
            "当前阶段更新：5 分钟前",
            processing.workflowFreshnessLabel(nowMs = 1_782_788_700_000L),
        )
        assertEquals(
            "完成时间：刚刚",
            completed.workflowFreshnessLabel(nowMs = 30_000L),
        )
        assertEquals(
            "失败时间：2 小时前",
            failed.workflowFreshnessLabel(nowMs = 1_782_792_000_000L),
        )
    }

    @Test
    fun productStageAliasesDriveVisibleWorkflowPosition() {
        val article = RecordingEntity(
            filename = "VibePub-article.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
            processingStage = "article",
        )
        val articleReady = article.copy(processingStage = "ARTICLE_READY")
        val wechat = article.copy(processingStage = "wechat")
        val failed = article.copy(
            status = RecordingStatus.FAILED.value,
            processingStage = "failed",
            lastError = "云端处理失败",
        )

        assertEquals("正在成文", article.statusLabel())
        assertEquals("第 5/7 步", article.workflowProgressLabel())
        assertEquals(WorkflowStepState.CURRENT, article.workflowSteps()[4].state)

        assertEquals("生成草稿中", articleReady.statusLabel())
        assertEquals("第 6/7 步", articleReady.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, articleReady.workflowSteps()[4].state)
        assertEquals(WorkflowStepState.CURRENT, articleReady.workflowSteps()[5].state)

        assertEquals("生成草稿中", wechat.statusLabel())
        assertEquals("第 6/7 步", wechat.workflowProgressLabel())
        assertTrue(wechat.workflowNextActionLabel().contains("等待公众号草稿创建"))

        assertEquals("第 5/7 步", failed.workflowProgressLabel())
        assertEquals(WorkflowStepState.BLOCKED, failed.workflowSteps()[4].state)
    }

    @Test
    fun serverFailureStageBlocksTheMatchingWorkflowStep() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.FAILED.value,
            processingStage = "ASR",
            lastError = "服务返回空转录结果",
        )

        val steps = recording.workflowSteps()

        assertEquals("第 4/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[2].state)
        assertEquals(WorkflowStepState.BLOCKED, steps[3].state)
        assertEquals(WorkflowStepState.PENDING, steps[4].state)
    }

    @Test
    fun serverDraftFailureStageBlocksWechatDraftStepWithoutSpecificErrorText() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.FAILED.value,
            processingStage = "DRAFT_FAILED",
            lastError = "Request failed with status code 502",
        )

        val steps = recording.workflowSteps()

        assertEquals("第 6/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.BLOCKED, steps[5].state)
        assertEquals(WorkflowStepState.PENDING, steps[6].state)
    }

    @Test
    fun completedArticleWaitsForDraftInfo() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.COMPLETED.value,
            articleTitle = "整理好的文章",
        )

        val steps = recording.workflowSteps()

        assertEquals("已成文", recording.statusLabel())
        assertTrue(recording.statusDetail().contains("等待公众号草稿信息"))
        assertTrue(recording.workflowNextActionLabel().contains("复制或分享正文"))
        assertEquals("第 6/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.CURRENT, steps[5].state)
        assertEquals(WorkflowStepState.PENDING, steps[6].state)
    }

    @Test
    fun completedArticleCanReportDraftFailureWithoutLosingArticleState() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.COMPLETED.value,
            articleTitle = "整理好的文章",
            processingStage = "DRAFT_FAILED",
            lastError = "公众号草稿创建失败：Request failed with status code 502",
        )

        val steps = recording.workflowSteps()

        assertEquals("已成文", recording.statusLabel())
        assertTrue(recording.statusDetail().contains("公众号草稿创建失败"))
        assertTrue(recording.workflowNextActionLabel().contains("复制正文备用"))
        assertEquals("第 6/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.CURRENT, steps[5].state)
        assertTrue(recording.hasDraftFailureMessage())
    }

    @Test
    fun completedDraftMovesToManualPublishConfirmation() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.COMPLETED.value,
            articleTitle = "整理好的文章",
            wechatDraftId = "MEDIA_ID_123",
        )

        val steps = recording.workflowSteps()

        assertEquals("草稿已就绪", recording.statusLabel())
        assertTrue(recording.statusDetail().contains("公众号草稿也已准备好"))
        assertTrue(recording.workflowNextActionLabel().contains("打开公众号草稿"))
        assertEquals("第 7/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[5].state)
        assertEquals(WorkflowStepState.CURRENT, steps[6].state)
    }

    @Test
    fun uploadFailureBlocksUploadStep() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.FAILED.value,
            lastError = "FILES_TOKEN 无效，上传被拒绝",
        )

        val steps = recording.workflowSteps()

        assertTrue(recording.workflowNextActionLabel().contains("更新 FILES_TOKEN"))
        assertEquals(WorkflowStepState.DONE, steps[0].state)
        assertEquals(WorkflowStepState.BLOCKED, steps[1].state)
        assertEquals(WorkflowStepState.PENDING, steps[2].state)
    }

    @Test
    fun draftFailureBlocksWechatDraftStep() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.FAILED.value,
            lastError = "微信公众号草稿创建失败",
        )

        val steps = recording.workflowSteps()

        assertTrue(recording.workflowNextActionLabel().contains("公众号草稿配置"))
        assertEquals("第 6/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.BLOCKED, steps[5].state)
        assertEquals(WorkflowStepState.PENDING, steps[6].state)
    }
}
