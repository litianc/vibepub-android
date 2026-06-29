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
        RecordingStatus.UPLOADED -> "处理中"
        RecordingStatus.PROCESSING -> "正在成文"
        RecordingStatus.COMPLETED -> "已成文"
        RecordingStatus.FAILED -> "需要处理"
    }
}

fun RecordingEntity.statusDetail(): String {
    return when (status.asRecordingStatus()) {
        RecordingStatus.LOCAL_RECORDED -> "录音已保存，等待上传。"
        RecordingStatus.UPLOADING -> "正在上传录音，网络恢复后会自动继续。"
        RecordingStatus.UPLOADED -> "录音已到云端，正在排队转录。"
        RecordingStatus.PROCESSING -> "云端正在转录和整理文章。"
        RecordingStatus.COMPLETED -> "转录和成文已经完成。"
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
    val currentStep = workflowSteps().firstOrNull {
        it.state == WorkflowStepState.CURRENT || it.state == WorkflowStepState.BLOCKED
    }
    val currentText = currentStep?.let { "${it.number}. ${it.title}" } ?: "6. 完成"
    return "这条录音正在经历从口述想法到公众号草稿的流程。当前节点是 $currentText。"
}

fun RecordingEntity.workflowSteps(): List<RecordingWorkflowStep> {
    val status = status.asRecordingStatus()
    val currentIndex = when (status) {
        RecordingStatus.LOCAL_RECORDED -> 0
        RecordingStatus.UPLOADING -> 1
        RecordingStatus.UPLOADED -> 2
        RecordingStatus.PROCESSING -> 3
        RecordingStatus.COMPLETED -> WORKFLOW_BASE_STEPS.lastIndex
        RecordingStatus.FAILED -> failureWorkflowIndex()
    }

    return WORKFLOW_BASE_STEPS.mapIndexed { index, step ->
        val state = when {
            status == RecordingStatus.COMPLETED -> WorkflowStepState.DONE
            status == RecordingStatus.FAILED && index == currentIndex -> WorkflowStepState.BLOCKED
            index < currentIndex -> WorkflowStepState.DONE
            index == currentIndex -> WorkflowStepState.CURRENT
            else -> WorkflowStepState.PENDING
        }
        step.copy(state = state)
    }
}

private fun RecordingEntity.failureWorkflowIndex(): Int {
    val error = lastError.orEmpty().lowercase(Locale.ROOT)
    return when {
        error.contains("token") ||
            error.contains("401") ||
            error.contains("403") ||
            error.contains("上传") ||
            error.contains("网络") ||
            error.contains("本地录音") -> 1
        error.contains("微信") ||
            error.contains("公众号") ||
            error.contains("草稿") ||
            error.contains("wechat") -> 4
        else -> 3
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
        title = "识别与成文",
        detail = "云端完成语音识别，并把口述内容整理成适合公众号的文章。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 5,
        title = "创建草稿",
        detail = "把整理好的标题和正文准备到微信公众号草稿箱。",
        state = WorkflowStepState.PENDING,
    ),
    RecordingWorkflowStep(
        number = 6,
        title = "完成",
        detail = "App 可以查看文章、播放原音，并复制或分享正文。",
        state = WorkflowStepState.PENDING,
    ),
)
