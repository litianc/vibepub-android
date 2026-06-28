package cn.litianc.vibepub.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "recordings")
data class RecordingEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val filename: String,
    val durationMs: Long,
    val timestamp: Long,
    val status: String // "UPLOADING", "UPLOADED", "TRANSCRIBED"
)
