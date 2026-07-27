package cn.litianc.vibepub.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "recordings",
    indices = [Index(value = ["userId", "filename"], unique = true)]
)
data class RecordingEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val userId: String = "default_user",
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
    val coverImageUrl: String? = null,
    val processingStage: String? = null,
    val deletedAt: Long? = null,
    val sourceType: String = RecordingSourceType.RECORDING.value,
    val inputText: String? = null,
    val remoteRecordingId: Long? = null,
    val publicationRunId: String? = null,
    val publicationState: String? = null,
    val publicationRunStatus: String? = null,
    val publicationStage: String? = null,
    val publicationStateRevision: Long? = null,
    val publicationProgressPercent: Int? = null,
    val publicationLastSuccessfulState: String? = null,
    val publicationLastSuccessfulProgressPercent: Int? = null,
    val publicationRetryCount: Int? = null,
    val publicationNextAction: String? = null,
    val publicationErrorCode: String? = null,
    val publicationRunCreatedAt: String? = null,
    val publicationUpdatedAt: String? = null,
)
