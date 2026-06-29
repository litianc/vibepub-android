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
    val status: String,
    val articleTitle: String? = null,
    val rawTextPreview: String? = null,
    val localAudioPath: String? = null,
    val remoteStatusUpdatedAt: String? = null,
    val lastError: String? = null,
    val completedAt: Long? = null,
    val wechatDraftId: String? = null,
    val wechatUrl: String? = null,
    val processingStage: String? = null,
)
