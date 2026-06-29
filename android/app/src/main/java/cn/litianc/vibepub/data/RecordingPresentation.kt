package cn.litianc.vibepub.data

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
