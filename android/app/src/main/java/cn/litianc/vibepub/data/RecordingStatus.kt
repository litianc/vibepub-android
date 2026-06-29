package cn.litianc.vibepub.data

enum class RecordingStatus(val value: String) {
    LOCAL_RECORDED("LOCAL_RECORDED"),
    UPLOADING("UPLOADING"),
    UPLOADED("UPLOADED"),
    PROCESSING("PROCESSING"),
    COMPLETED("COMPLETED"),
    FAILED("FAILED");

    companion object {
        fun normalize(raw: String?): RecordingStatus {
            return when (raw?.uppercase()) {
                "LOCAL_RECORDED" -> LOCAL_RECORDED
                "UPLOADING" -> UPLOADING
                "UPLOADED", "TRANSCRIBED" -> UPLOADED
                "PROCESSING" -> PROCESSING
                "COMPLETED" -> COMPLETED
                "FAILED" -> FAILED
                else -> LOCAL_RECORDED
            }
        }
    }
}

fun String.asRecordingStatus(): RecordingStatus = RecordingStatus.normalize(this)
