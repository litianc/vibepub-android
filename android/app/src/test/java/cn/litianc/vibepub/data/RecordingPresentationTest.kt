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
        assertEquals("正在成文", recording.statusLabel())
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
        )

        val steps = recording.workflowSteps()

        assertEquals("当前状态：正在成文", recording.workflowHelpTitle())
        assertTrue(recording.workflowHelpSummary().contains("4. 识别与成文"))
        assertEquals(WorkflowStepState.DONE, steps[0].state)
        assertEquals(WorkflowStepState.DONE, steps[1].state)
        assertEquals(WorkflowStepState.DONE, steps[2].state)
        assertEquals(WorkflowStepState.CURRENT, steps[3].state)
        assertEquals(WorkflowStepState.PENDING, steps[4].state)
    }

    @Test
    fun completedWorkflowMarksEveryStepDone() {
        val recording = RecordingEntity(
            filename = "VibePub-test.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.COMPLETED.value,
        )

        assertTrue(recording.workflowSteps().all { it.state == WorkflowStepState.DONE })
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
}
