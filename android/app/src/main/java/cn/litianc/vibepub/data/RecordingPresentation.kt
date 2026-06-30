package cn.litianc.vibepub.data

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

enum class WorkflowStepState {
    DONE,
    CURRENT,
    PENDING,
    BLOCKED,
}

data class RecordingWorkflowStep(
    val number: Int,
    val title: String,
    val detail: String,
    val state: WorkflowStepState,
)

enum class RecordingRecoveryActionType {
    RETRY_UPLOAD,
    REFRESH_SYNC,
}

data class RecordingRecoveryAction(
    val type: RecordingRecoveryActionType,
    val label: String,
    val detail: String,
)

fun RecordingEntity.displayTitle(locale: Locale = Locale.getDefault()): String {
    val title = articleTitle?.trim()
    if (!title.isNullOrBlank()) return title
    return "${SimpleDateFormat("M月d日 HH:mm", locale).format(Date(timestamp))} · 录音片段"
}

fun RecordingEntity.durationLabel(): String {
    val totalSeconds = (durationMs / 1000).coerceAtLeast(0)
    return "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
}

fun RecordingEntity.listDurationLabel(): String {
    val totalSeconds = (durationMs / 1000).coerceAtLeast(0)
    return "${totalSeconds / 60}m${totalSeconds % 60}s"
}

fun RecordingEntity.statusLabel(): String {
    return when (status.asRecordingStatus()) {
        RecordingStatus.LOCAL_RECORDED -> "待上传"
        RecordingStatus.UPLOADING -> "上传中"
        RecordingStatus.UPLOADED -> if (workflowIndexFromProcessingStage() == 2) "排队中" else "处理中"
        RecordingStatus.PROCESSING -> processingStatusLabel()
        RecordingStatus.COMPLETED -> if (hasWechatDraftReference()) "草稿已就绪" else "已成文"
        RecordingStatus.FAILED -> "需要处理"
    }
}

fun RecordingEntity.statusDetail(): String {
    return when (status.asRecordingStatus()) {
        RecordingStatus.LOCAL_RECORDED -> "录音已保存，等待上传。"
        RecordingStatus.UPLOADING -> "正在上传录音，网络恢复后会自动继续。"
        RecordingStatus.UPLOADED -> "录音已到云端，正在排队转录。"
        RecordingStatus.PROCESSING -> processingStatusDetail()
        RecordingStatus.COMPLETED -> completedStatusDetail()
        RecordingStatus.FAILED -> lastError?.takeIf { it.isNotBlank() } ?: "这条录音处理失败，可以重试。"
    }
}

fun RecordingEntity.workflowNextActionLabel(): String {
    return when (status.asRecordingStatus()) {
        RecordingStatus.LOCAL_RECORDED -> "下一步：点重试上传；如果反复失败，先到设置页检查 FILES_TOKEN。"
        RecordingStatus.UPLOADING -> "下一步：保持网络可用，等待上传完成；也可以下拉或点同步刷新状态。"
        RecordingStatus.UPLOADED -> "下一步：等待云端任务接手；如果长时间不动，点同步确认后台进度。"
        RecordingStatus.PROCESSING -> processingNextActionLabel()
        RecordingStatus.COMPLETED -> completedNextActionLabel()
        RecordingStatus.FAILED -> failureNextActionLabel()
    }
}

fun RecordingEntity.isTerminalComplete(): Boolean = status.asRecordingStatus() == RecordingStatus.COMPLETED

fun RecordingEntity.primaryRecoveryAction(): RecordingRecoveryAction? {
    return when (status.asRecordingStatus()) {
        RecordingStatus.LOCAL_RECORDED -> RecordingRecoveryAction(
            type = RecordingRecoveryActionType.RETRY_UPLOAD,
            label = "上传",
            detail = "把本机录音重新加入上传队列。",
        )
        RecordingStatus.FAILED -> failedRecoveryAction()
        RecordingStatus.UPLOADING,
        RecordingStatus.UPLOADED,
        RecordingStatus.PROCESSING -> RecordingRecoveryAction(
            type = RecordingRecoveryActionType.REFRESH_SYNC,
            label = "同步",
            detail = "刷新云端状态，确认当前处理进度。",
        )
        RecordingStatus.COMPLETED -> if (hasDraftFailureMessage()) {
            RecordingRecoveryAction(
                type = RecordingRecoveryActionType.REFRESH_SYNC,
                label = "同步草稿",
                detail = "文章已可用，刷新草稿创建状态。",
            )
        } else {
            null
        }
    }
}

fun RecordingEntity.workflowHelpTitle(): String {
    return "当前状态：${statusLabel()}"
}

fun RecordingEntity.workflowHelpSummary(): String {
    return "这条录音正在经历从口述想法到公众号草稿的流程。${workflowCurrentNodeLabel()}，${workflowProgressLabel()}。${workflowNextActionLabel()}"
}

fun RecordingEntity.workflowProgressLabel(): String {
    val steps = workflowSteps()
    val activeStep = steps.firstOrNull {
        it.state == WorkflowStepState.CURRENT || it.state == WorkflowStepState.BLOCKED
    } ?: steps.last()
    return "第 ${activeStep.number}/${steps.size} 步"
}

fun RecordingEntity.workflowProgressFraction(): Float {
    val steps = workflowSteps()
    if (steps.isEmpty()) return 0f
    val doneCount = steps.count { it.state == WorkflowStepState.DONE }
    val currentWeight = if (steps.any { it.state == WorkflowStepState.CURRENT || it.state == WorkflowStepState.BLOCKED }) 0.5f else 0f
    return ((doneCount + currentWeight) / steps.size).coerceIn(0f, 1f)
}

fun RecordingEntity.currentWorkflowStep(): RecordingWorkflowStep {
    val steps = workflowSteps()
    return steps.firstOrNull {
        it.state == WorkflowStepState.CURRENT || it.state == WorkflowStepState.BLOCKED
    } ?: steps.last()
}

fun RecordingEntity.workflowCurrentNodeLabel(): String {
    val step = currentWorkflowStep()
    return "当前节点：${step.number}. ${step.title} · ${step.state.displayLabel()}"
}

fun RecordingEntity.workflowFreshnessLabel(nowMs: Long = System.currentTimeMillis()): String {
    val age = workflowFreshnessAnchorMs()?.let { relativeWorkflowAgeLabel(it, nowMs) } ?: "未知"
    return when (status.asRecordingStatus()) {
        RecordingStatus.LOCAL_RECORDED -> "本机保存：$age"
        RecordingStatus.UPLOADING -> "上传状态更新：$age"
        RecordingStatus.UPLOADED -> "云端排队更新：$age"
        RecordingStatus.PROCESSING -> "当前阶段更新：$age"
        RecordingStatus.COMPLETED -> "完成时间：$age"
        RecordingStatus.FAILED -> "失败时间：$age"
    }
}

fun RecordingEntity.workflowCycleLabel(): String {
    return WORKFLOW_BASE_STEPS.joinToString(" → ") { it.title }
}

fun RecordingEntity.workflowSteps(): List<RecordingWorkflowStep> {
    val status = status.asRecordingStatus()
    val currentIndex = workflowCurrentIndex(status)

    return WORKFLOW_BASE_STEPS.mapIndexed { index, step ->
        val state = when {
            status == RecordingStatus.COMPLETED && index <= currentIndex -> WorkflowStepState.DONE
            status == RecordingStatus.COMPLETED && index == currentIndex + 1 -> WorkflowStepState.CURRENT
            status == RecordingStatus.FAILED && index == currentIndex -> WorkflowStepState.BLOCKED
            index < currentIndex -> WorkflowStepState.DONE
            index == currentIndex -> WorkflowStepState.CURRENT
            else -> WorkflowStepState.PENDING
        }
        step.copy(state = state)
    }
}

private fun RecordingEntity.workflowCurrentIndex(status: RecordingStatus): Int {
    return when (status) {
        RecordingStatus.LOCAL_RECORDED -> 0
        RecordingStatus.UPLOADING -> 1
        RecordingStatus.UPLOADED -> 2
        RecordingStatus.PROCESSING -> processingWorkflowIndex()
        RecordingStatus.COMPLETED -> completedWorkflowIndex()
        RecordingStatus.FAILED -> failureWorkflowIndex()
    }
}

private fun RecordingEntity.processingWorkflowIndex(): Int {
    workflowIndexFromProcessingStage()?.let { return it }
    return when {
        articleTitle?.isNotBlank() == true -> 4
        rawTextPreview?.isNotBlank() == true -> 4
        else -> 3
    }
}

private fun RecordingEntity.completedWorkflowIndex(): Int {
    return when {
        hasWechatDraftReference() -> 5
        else -> 4
    }
}

private fun RecordingEntity.failureWorkflowIndex(): Int {
    workflowIndexFromProcessingStage()?.let { return it }
    val error = lastError.orEmpty().lowercase(Locale.ROOT)
    return when {
        error.contains("token") ||
            error.contains("401") ||
            error.contains("403") ||
            error.contains("上传") ||
            error.contains("网络") ||
            error.contains("本地录音") -> 1
        error.contains("识别") ||
            error.contains("asr") ||
            error.contains("转录") -> 3
        error.contains("微信") ||
            error.contains("公众号") ||
            error.contains("草稿") ||
            error.contains("wechat") -> 5
        else -> 4
    }
}

private fun RecordingEntity.processingStatusDetail(): String {
    return when (processingStageKind()) {
        ProcessingStageKind.QUEUED -> "录音已到云端，等待后台任务开始处理。"
        ProcessingStageKind.ASR -> "云端正在进行语音识别。"
        ProcessingStageKind.ARTICLE -> "已拿到识别结果，云端正在整理公众号文章。"
        ProcessingStageKind.ARTICLE_READY -> "文章已生成，可以先阅读、复制或分享；公众号草稿仍在准备或同步中。"
        ProcessingStageKind.WECHAT -> "文章已生成，正在准备微信公众号草稿。"
        ProcessingStageKind.COMPLETED -> completedStatusDetail()
        ProcessingStageKind.FAILED -> lastError?.takeIf { it.isNotBlank() } ?: "云端处理阶段失败，等待重试或人工检查。"
        ProcessingStageKind.ASR_FAILED -> lastError?.takeIf { it.isNotBlank() } ?: "语音识别失败，可以重试或检查音频。"
        ProcessingStageKind.ARTICLE_FAILED -> lastError?.takeIf { it.isNotBlank() } ?: "文章生成失败，可以重试或反馈诊断信息。"
        ProcessingStageKind.WECHAT_FAILED -> lastError?.takeIf { it.isNotBlank() } ?: "公众号草稿创建失败，可以先复制正文。"
        ProcessingStageKind.UNKNOWN -> when (processingWorkflowIndex()) {
            4 -> "已拿到识别结果，云端正在整理公众号文章。"
            5 -> "文章已生成，正在准备微信公众号草稿。"
            else -> "云端正在进行语音识别。"
        }
    }
}

private fun RecordingEntity.processingStatusLabel(): String {
    return when (processingStageKind()) {
        ProcessingStageKind.QUEUED -> "排队中"
        ProcessingStageKind.ASR -> "转录中"
        ProcessingStageKind.ARTICLE -> "正在成文"
        ProcessingStageKind.ARTICLE_READY -> "文章已生成"
        ProcessingStageKind.WECHAT -> "生成草稿中"
        ProcessingStageKind.COMPLETED -> if (hasWechatDraftReference()) "草稿已就绪" else "已成文"
        ProcessingStageKind.FAILED -> "需要处理"
        ProcessingStageKind.ASR_FAILED,
        ProcessingStageKind.ARTICLE_FAILED,
        ProcessingStageKind.WECHAT_FAILED -> "需要处理"
        ProcessingStageKind.UNKNOWN -> if (processingWorkflowIndex() >= 4) "正在成文" else "转录中"
    }
}

private fun RecordingEntity.processingNextActionLabel(): String {
    return when (processingStageKind()) {
        ProcessingStageKind.QUEUED -> "下一步：等待后台任务开始；如果超过几分钟没有变化，点同步刷新。"
        ProcessingStageKind.ASR -> "下一步：等待语音识别完成；详情页会先显示原始识别片段。"
        ProcessingStageKind.ARTICLE -> "下一步：等待文章标题和正文生成；完成后可以复制、分享或导出。"
        ProcessingStageKind.ARTICLE_READY -> "下一步：可以先查看、复制或分享正文；点同步等待公众号草稿状态。"
        ProcessingStageKind.WECHAT -> "下一步：等待公众号草稿创建；草稿可用后会显示打开入口。"
        ProcessingStageKind.COMPLETED -> completedNextActionLabel()
        ProcessingStageKind.FAILED -> failureNextActionLabel()
        ProcessingStageKind.ASR_FAILED,
        ProcessingStageKind.ARTICLE_FAILED,
        ProcessingStageKind.WECHAT_FAILED -> failureNextActionLabel()
        ProcessingStageKind.UNKNOWN -> when (processingWorkflowIndex()) {
            4 -> "下一步：等待文章标题和正文生成；完成后可以复制、分享或导出。"
            5 -> "下一步：等待公众号草稿创建；草稿可用后会显示打开入口。"
            else -> "下一步：等待云端转录；如果长时间没有更新，点同步刷新。"
        }
    }
}

private enum class ProcessingStageKind {
    QUEUED,
    ASR,
    ARTICLE,
    ARTICLE_READY,
    WECHAT,
    COMPLETED,
    FAILED,
    ASR_FAILED,
    ARTICLE_FAILED,
    WECHAT_FAILED,
    UNKNOWN,
}

private fun RecordingEntity.processingStageKind(): ProcessingStageKind {
    return when (processingStageKey()) {
        "UPLOADED", "QUEUED", "PENDING" -> ProcessingStageKind.QUEUED
        "ASR", "TRANSCRIBING", "TRANSCRIPTION", "TRANSCRIBE" -> ProcessingStageKind.ASR
        "ARTICLE", "REWRITE", "REWRITING", "LLM", "GENERATING_ARTICLE" -> ProcessingStageKind.ARTICLE
        "ARTICLE_READY", "ARTICLE_DONE", "READY_FOR_DRAFT" -> ProcessingStageKind.ARTICLE_READY
        "WECHAT", "DRAFT", "DRAFTING", "CREATING_DRAFT", "PUBLISHING_DRAFT" -> ProcessingStageKind.WECHAT
        "COMPLETED", "DONE" -> ProcessingStageKind.COMPLETED
        "ASR_FAILED", "TRANSCRIPTION_FAILED", "TRANSCRIBE_FAILED" -> ProcessingStageKind.ASR_FAILED
        "ARTICLE_FAILED", "REWRITE_FAILED", "LLM_FAILED" -> ProcessingStageKind.ARTICLE_FAILED
        "DRAFT_FAILED", "WECHAT_FAILED" -> ProcessingStageKind.WECHAT_FAILED
        "FAILED", "ERROR" -> ProcessingStageKind.FAILED
        else -> ProcessingStageKind.UNKNOWN
    }
}

private fun RecordingEntity.workflowIndexFromProcessingStage(): Int? {
    return when (processingStageKind()) {
        ProcessingStageKind.QUEUED -> 2
        ProcessingStageKind.ASR -> 3
        ProcessingStageKind.ARTICLE -> 4
        ProcessingStageKind.ARTICLE_READY -> 5
        ProcessingStageKind.WECHAT -> 5
        ProcessingStageKind.COMPLETED -> completedWorkflowIndex()
        ProcessingStageKind.FAILED -> null
        ProcessingStageKind.ASR_FAILED -> 3
        ProcessingStageKind.ARTICLE_FAILED -> 4
        ProcessingStageKind.WECHAT_FAILED -> 5
        ProcessingStageKind.UNKNOWN -> null
    }
}

private fun RecordingEntity.processingStageKey(): String {
    return processingStage
        .orEmpty()
        .trim()
        .uppercase(Locale.ROOT)
        .replace("-", "_")
        .replace(" ", "_")
}

private fun RecordingEntity.workflowFreshnessAnchorMs(): Long? {
    return when (status.asRecordingStatus()) {
        RecordingStatus.COMPLETED -> completedAt
            ?: remoteStatusUpdatedAt.toWorkflowTimestampMs()
            ?: timestamp.takeIf { it > 0L }
        RecordingStatus.LOCAL_RECORDED -> timestamp.takeIf { it > 0L }
        RecordingStatus.UPLOADING,
        RecordingStatus.UPLOADED,
        RecordingStatus.PROCESSING,
        RecordingStatus.FAILED -> remoteStatusUpdatedAt.toWorkflowTimestampMs()
            ?: timestamp.takeIf { it > 0L }
    }
}

private fun relativeWorkflowAgeLabel(anchorMs: Long, nowMs: Long): String {
    val elapsedSeconds = ((nowMs - anchorMs).coerceAtLeast(0L) / 1000L).toInt()
    return when {
        elapsedSeconds < 60 -> "刚刚"
        elapsedSeconds < 3600 -> "${elapsedSeconds / 60} 分钟前"
        elapsedSeconds < 86_400 -> "${elapsedSeconds / 3600} 小时前"
        else -> "${elapsedSeconds / 86_400} 天前"
    }
}

private fun String?.toWorkflowTimestampMs(): Long? {
    val value = this?.trim().orEmpty()
    if (value.isBlank()) return null

    val patterns = listOf(
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(value)?.time
        }.getOrNull()
    }
}

private val WORKFLOW_BASE_STEPS = listOf(
    RecordingWorkflowStep(
        number = 1,
        title = "保存录音",
        detail = "把本机音频文件和基础信息保存下来，避免同一次录音出现多条记录。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 2,
        title = "上传音频",
        detail = "把录音上传到云端；网络或 Token 配置异常会停在这里。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 3,
        title = "云端排队",
        detail = "录音已到云端，等待后台任务开始处理。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 4,
        title = "语音识别",
        detail = "把口述音频转成原始文字，供后续成文核对。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 5,
        title = "文章改写",
        detail = "把原始识别整理成标题和适合公众号阅读的正文。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 6,
        title = "公众号草稿",
        detail = "把整理好的标题和正文准备到微信公众号草稿箱。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 7,
        title = "人工发布确认",
        detail = "打开草稿做最后一眼检查，再由你决定是否发布。",
        state = WorkflowStepState.PENDING,
    ),
)

private fun RecordingEntity.completedStatusDetail(): String {
    return when {
        hasWechatDraftReference() -> "文章已生成，公众号草稿也已准备好。"
        hasDraftFailureMessage() -> "文章已生成，但公众号草稿创建失败。可以先复制正文，稍后再重试草稿。"
        else -> "文章已生成，正在等待公众号草稿信息同步。"
    }
}

private fun RecordingEntity.completedNextActionLabel(): String {
    return when {
        hasWechatDraftReference() -> "下一步：打开公众号草稿做最后一眼人工确认，再决定是否发布。"
        hasDraftFailureMessage() -> "下一步：先复制正文备用；修复公众号草稿问题后再同步或重试。"
        else -> "下一步：先复制或分享正文；如果需要草稿入口，点同步等待草稿信息。"
    }
}

private fun RecordingEntity.failureNextActionLabel(): String {
    val error = lastError.orEmpty().lowercase(Locale.ROOT)
    return when {
        error.contains("token") ||
            error.contains("401") ||
            error.contains("403") -> "下一步：到设置页更新 FILES_TOKEN，并用“测试后端连接”确认授权。"
        failureWorkflowIndex() == 1 -> "下一步：点重试上传；如果仍失败，到设置页检查后端连接。"
        failureWorkflowIndex() == 5 -> "下一步：文章可能已生成，先复制正文；再检查公众号草稿配置。"
        else -> "下一步：点同步或重试；如果仍失败，复制诊断信息反馈。"
    }
}

private fun RecordingEntity.failedRecoveryAction(): RecordingRecoveryAction {
    val failedStepIndex = failureWorkflowIndex()
    return if (failedStepIndex <= 1) {
        RecordingRecoveryAction(
            type = RecordingRecoveryActionType.RETRY_UPLOAD,
            label = "重试上传",
            detail = "重新上传本机录音，适合 Token、网络或本地上传失败。",
        )
    } else {
        RecordingRecoveryAction(
            type = RecordingRecoveryActionType.REFRESH_SYNC,
            label = if (failedStepIndex == 5) "同步草稿" else "同步状态",
            detail = "录音已进入云端流程，先同步最新处理结果；需要重跑时再重新上传。",
        )
    }
}

private fun RecordingEntity.hasWechatDraftReference(): Boolean {
    return wechatDraftId?.isNotBlank() == true || wechatUrl?.isNotBlank() == true
}

fun RecordingEntity.hasDraftFailureMessage(): Boolean {
    val error = lastError.orEmpty().lowercase(Locale.ROOT)
    val stage = processingStageKey()
    return stage == "DRAFT_FAILED" ||
        stage == "WECHAT_FAILED" ||
        error.contains("微信") ||
        error.contains("公众号") ||
        error.contains("草稿") ||
        error.contains("wechat")
}

fun WorkflowStepState.displayLabel(): String {
    return when (this) {
        WorkflowStepState.DONE -> "已完成"
        WorkflowStepState.CURRENT -> "当前"
        WorkflowStepState.PENDING -> "等待"
        WorkflowStepState.BLOCKED -> "需处理"
    }
}
