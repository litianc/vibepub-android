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
        assertTrue(recording.canRetryUpload())
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
        assertEquals("当前节点：5. 文章改写 · 当前", recording.workflowCurrentNodeLabel())
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
        assertEquals("第 6/7 步", drafting.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.CURRENT, steps[5].state)
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
        assertEquals("第 6/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.CURRENT, steps[5].state)
        assertEquals(WorkflowStepState.PENDING, steps[6].state)
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

        assertEquals("第 6/7 步", recording.workflowProgressLabel())
        assertEquals(WorkflowStepState.DONE, steps[4].state)
        assertEquals(WorkflowStepState.BLOCKED, steps[5].state)
        assertEquals(WorkflowStepState.PENDING, steps[6].state)
    }
}
