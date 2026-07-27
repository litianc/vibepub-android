package cn.litianc.vibepub.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PublicationWorkflowPresentationTest {
    @Test
    fun everyPublicationStageUsesTheFrozenProgressAndAudioTextStepTables() {
        val stages = listOf(
            "queued" to 0,
            "transcribing" to 14,
            "transcript_ready" to 20,
            "writing" to 28,
            "draft_generated" to 36,
            "reviewing" to 50,
            "revising" to 50,
            "reviewed" to 56,
            "content_frozen" to 62,
            "visual_planning" to 68,
            "visual_generating" to 74,
            "visual_ready" to 80,
            "formatting" to 84,
            "visual_qa" to 90,
            "draft_syncing" to 96,
            "draft_verifying" to 98,
            "draft_ready" to 100,
        )

        stages.forEach { (state, progress) ->
            val audio = publicationRecording(state, progress, text = false)
            val text = publicationRecording(state, progress, text = true)
            assertEquals(progress / 100f, audio.workflowProgressFraction())
            assertEquals(progress / 100f, text.workflowProgressFraction())
            assertEquals(audioStepFor(state) + 1, audio.currentWorkflowStep().number)
            assertEquals(textStepFor(state) + 1, text.currentWorkflowStep().number)
        }
    }

    @Test
    fun needsActionAndFailedStayAtLastSuccessfulStepWithoutLeakingRawCodes() {
        listOf("needs_action", "failed").forEach { runStatus ->
            val recording = publicationRecording(
                state = runStatus,
                progress = 96,
                text = false,
                lastSuccessfulState = "visual_generating",
                lastSuccessfulProgress = 74,
                nextAction = "reconcile_external_side_effect",
                errorCode = "provider_internal_error_500",
            )

            val steps = recording.workflowSteps()
            assertEquals(0.74f, recording.workflowProgressFraction())
            assertEquals(WorkflowStepState.BLOCKED, steps[4].state)
            assertFalse(recording.statusDetail().contains("provider_internal_error_500"))
            assertFalse(recording.workflowNextActionLabel().contains("provider_internal_error_500"))
            assertTrue(recording.workflowNextActionLabel().contains("核对"))
        }
    }

    @Test
    fun retryingUsesLastSuccessfulStateAndDraftReadyLeavesManualStepCurrent() {
        val retrying = publicationRecording(
            state = "retrying",
            progress = 74,
            text = true,
            lastSuccessfulState = "content_frozen",
            lastSuccessfulProgress = 62,
        )
        assertEquals(0.62f, retrying.workflowProgressFraction())
        assertEquals(WorkflowStepState.CURRENT, retrying.workflowSteps()[3].state)
        assertTrue(retrying.statusLabel().contains("重试"))

        val ready = publicationRecording("draft_ready", 100, text = false)
        assertEquals("草稿已就绪", ready.statusLabel())
        assertTrue(ready.isTerminalComplete())
        assertEquals(WorkflowStepState.DONE, ready.workflowSteps()[5].state)
        assertEquals(WorkflowStepState.CURRENT, ready.workflowSteps()[6].state)
        assertTrue(ready.workflowNextActionLabel().contains("人工确认"))
    }

    @Test
    fun cancelledV3RunStopsAtTheLastSuccessfulStepWithoutLegacyFallbackOrRawErrors() {
        val cancelled = publicationRecording(
            state = "cancelled",
            progress = 100,
            text = false,
            lastSuccessfulState = "visual_generating",
            lastSuccessfulProgress = 74,
            errorCode = "provider_internal_error_500",
        )

        assertEquals("已取消", cancelled.statusLabel())
        assertEquals(0.74f, cancelled.workflowProgressFraction())
        assertEquals(WorkflowStepState.CURRENT, cancelled.workflowSteps()[4].state)
        assertTrue(cancelled.statusDetail().contains("已取消"))
        assertFalse(cancelled.statusDetail().contains("provider_internal_error_500"))
        assertFalse(cancelled.workflowNextActionLabel().contains("provider_internal_error_500"))
    }

    @Test
    fun humanReviewRoundsUseExplicitSafeChineseInstructions() {
        val actions = mapOf(
            "review_round_1_human_review" to "第一轮人工内容审核",
            "review_round_2_human_review" to "第二轮人工内容审核",
        )

        actions.forEach { (action, expectedCopy) ->
            val recording = publicationRecording(
                state = "needs_action",
                progress = 50,
                text = true,
                lastSuccessfulState = "reviewing",
                lastSuccessfulProgress = 50,
                nextAction = action,
                errorCode = "provider_internal_error_500",
            )

            assertTrue(recording.workflowNextActionLabel().contains(expectedCopy))
            assertFalse(recording.workflowNextActionLabel().contains(action))
            assertFalse(recording.workflowNextActionLabel().contains("provider_internal_error_500"))
        }
    }

    @Test
    fun legacyRecordingsWithoutSummaryKeepTheExistingSevenStepPresentation() {
        val legacy = RecordingEntity(
            filename = "legacy.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
            processingStage = "ASR",
        )

        assertEquals("转录中", legacy.statusLabel())
        assertEquals("第 4/7 步", legacy.workflowProgressLabel())
        assertEquals(WorkflowStepState.CURRENT, legacy.workflowSteps()[3].state)
    }

    private fun publicationRecording(
        state: String,
        progress: Int,
        text: Boolean,
        lastSuccessfulState: String = state,
        lastSuccessfulProgress: Int = progress,
        nextAction: String? = null,
        errorCode: String? = null,
    ): RecordingEntity {
        val runStatus = when (state) {
            "draft_ready" -> "ready"
            "needs_action", "failed", "retrying", "cancelled" -> state
            else -> "active"
        }
        return RecordingEntity(
            filename = if (text) "idea.txt" else "voice.m4a",
            durationMs = if (text) 0L else 1_000L,
            timestamp = 1L,
            status = RecordingStatus.PROCESSING.value,
            sourceType = if (text) RecordingSourceType.TEXT.value else RecordingSourceType.RECORDING.value,
            publicationRunId = "run-$state-$text",
            publicationState = state,
            publicationRunStatus = runStatus,
            publicationStage = "stage",
            publicationStateRevision = 1L,
            publicationProgressPercent = progress,
            publicationLastSuccessfulState = lastSuccessfulState,
            publicationLastSuccessfulProgressPercent = lastSuccessfulProgress,
            publicationRetryCount = 0,
            publicationNextAction = nextAction,
            publicationErrorCode = errorCode,
            publicationRunCreatedAt = "2026-07-22T00:00:00.000Z",
            publicationUpdatedAt = "2026-07-22T00:00:01.000Z",
        )
    }

    private fun audioStepFor(state: String): Int = when (state) {
        "queued" -> 2
        "transcribing", "transcript_ready" -> 3
        "writing", "draft_generated", "reviewing", "revising", "reviewed", "content_frozen",
        "visual_planning", "visual_generating", "visual_ready", "formatting", "visual_qa" -> 4
        "draft_syncing", "draft_verifying" -> 5
        "draft_ready" -> 6
        else -> 4
    }

    private fun textStepFor(state: String): Int = when (state) {
        "queued", "transcribing", "transcript_ready" -> 2
        "writing", "draft_generated", "reviewing", "revising", "reviewed", "content_frozen" -> 3
        "visual_planning", "visual_generating", "visual_ready", "formatting", "visual_qa" -> 4
        "draft_syncing", "draft_verifying" -> 5
        "draft_ready" -> 6
        else -> 4
    }
}
