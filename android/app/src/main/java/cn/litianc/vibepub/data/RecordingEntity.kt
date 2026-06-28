package cn.litianc.vibepub.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "recordings",
    indices = [Index(value = ["filename"], unique = true)]
)
data class RecordingEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val filename: String,
    val durationMs: Long,
    val timestamp: Long,
    val status: String // "UPLOADING", "UPLOADED", "TRANSCRIBED"
)
