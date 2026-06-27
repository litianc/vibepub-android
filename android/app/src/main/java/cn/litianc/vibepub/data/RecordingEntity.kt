package cn.litianc.vibepub.data

data class RecordingEntity(
    val id: Int,
    val filename: String,
    val durationMs: Long,
    val timestamp: Long,
    val status: String // "UPLOADING", "UPLOADED", "TRANSCRIBED"
)
