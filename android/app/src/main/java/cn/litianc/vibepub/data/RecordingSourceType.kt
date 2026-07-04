package cn.litianc.vibepub.data

enum class RecordingSourceType(val value: String) {
    RECORDING("RECORDING"),
    AUDIO_FILE("AUDIO_FILE"),
    TEXT("TEXT"),
    ;

    companion object {
        fun normalize(value: String?): RecordingSourceType {
            return when (value?.trim()?.uppercase()) {
                AUDIO_FILE.value -> AUDIO_FILE
                TEXT.value -> TEXT
                else -> RECORDING
            }
        }
    }
}

fun String?.asRecordingSourceType(): RecordingSourceType = RecordingSourceType.normalize(this)

fun RecordingEntity.sourceTypeValue(): RecordingSourceType = sourceType.asRecordingSourceType()

fun RecordingEntity.isTextSource(): Boolean = sourceTypeValue() == RecordingSourceType.TEXT
