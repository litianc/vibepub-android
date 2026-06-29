package cn.litianc.vibepub.data

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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

fun RecordingEntity.isTerminalComplete(): Boolean = status.asRecordingStatus() == RecordingStatus.COMPLETED

fun RecordingEntity.canRetryUpload(): Boolean {
    return status.asRecordingStatus() == RecordingStatus.FAILED ||
        status.asRecordingStatus() == RecordingStatus.LOCAL_RECORDED
}

fun RecordingEntity.workflowHelpTitle(): String {
    return "当前状态：${statusLabel()}"
}

fun RecordingEntity.workflowHelpSummary(): String {
    val steps = workflowSteps()
    val currentStep = steps.firstOrNull {
        it.state == WorkflowStepState.CURRENT || it.state == WorkflowStepState.BLOCKED
    }
    val currentText = currentStep?.let { "${it.number}. ${it.title}" } ?: "${steps.size}. 完成"
    return "这条录音正在经历从口述想法到公众号草稿的流程。当前节点是 $currentText。${workflowProgressLabel()}"
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
    return when (processingStageKey()) {
        "QUEUED" -> "录音已到云端，等待后台任务开始处理。"
        "ASR" -> "云端正在进行语音识别。"
        "REWRITING" -> "已拿到识别结果，云端正在整理公众号文章。"
        "DRAFTING" -> "文章已生成，正在准备微信公众号草稿。"
        else -> when (processingWorkflowIndex()) {
        4 -> "已拿到识别结果，云端正在整理公众号文章。"
        5 -> "文章已生成，正在准备微信公众号草稿。"
        else -> "云端正在进行语音识别。"
        }
    }
}

private fun RecordingEntity.processingStatusLabel(): String {
    return when (processingStageKey()) {
        "QUEUED" -> "排队中"
        "ASR" -> "转录中"
        "REWRITING" -> "正在成文"
        "DRAFTING" -> "生成草稿中"
        else -> if (processingWorkflowIndex() >= 4) "正在成文" else "转录中"
    }
}

private fun RecordingEntity.completedStatusDetail(): String {
    return when {
        hasWechatDraftReference() -> "文章已生成，公众号草稿也已准备好。"
        else -> "文章已生成，正在等待公众号草稿信息同步。"
    }
}

private fun RecordingEntity.hasWechatDraftReference(): Boolean {
    return wechatDraftId?.isNotBlank() == true || wechatUrl?.isNotBlank() == true
}

private fun RecordingEntity.workflowIndexFromProcessingStage(): Int? {
    return when (processingStageKey()) {
        "QUEUED" -> 2
        "ASR" -> 3
        "REWRITING" -> 4
        "DRAFTING" -> 5
        "COMPLETED" -> completedWorkflowIndex()
        else -> null
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
