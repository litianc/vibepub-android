package cn.litianc.vibepub.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface RecordingDao {
    @Query("""
        SELECT * FROM recordings
        WHERE deletedAt IS NULL
          AND userId = :userId
          AND NOT EXISTS (
            SELECT 1
            FROM recordings AS better
            WHERE better.filename = recordings.filename
              AND better.userId = recordings.userId
              AND better.deletedAt IS NULL
              AND (
                  better.durationMs > recordings.durationMs
                  OR (
                      better.durationMs = recordings.durationMs
                      AND better.timestamp < recordings.timestamp
                  )
                  OR (
                      better.durationMs = recordings.durationMs
                      AND better.timestamp = recordings.timestamp
                      AND better.id < recordings.id
                  )
              )
            )
        ORDER BY timestamp DESC
    """)
    fun getAllRecordingsFlow(userId: String): Flow<List<RecordingEntity>>

    fun getAllRecordingsFlow(): Flow<List<RecordingEntity>> =
        getAllRecordingsFlow(DEFAULT_RECORDING_USER_ID)

    @Query("""
        SELECT * FROM recordings
        WHERE deletedAt IS NULL
          AND userId = :userId
          AND NOT EXISTS (
            SELECT 1
            FROM recordings AS better
            WHERE better.filename = recordings.filename
              AND better.userId = recordings.userId
              AND better.deletedAt IS NULL
              AND (
                  better.durationMs > recordings.durationMs
                  OR (
                      better.durationMs = recordings.durationMs
                      AND better.timestamp < recordings.timestamp
                  )
                  OR (
                      better.durationMs = recordings.durationMs
                      AND better.timestamp = recordings.timestamp
                      AND better.id < recordings.id
                  )
              )
            )
        ORDER BY timestamp DESC
    """)
    suspend fun getAllRecordings(userId: String): List<RecordingEntity>

    suspend fun getAllRecordings(): List<RecordingEntity> =
        getAllRecordings(DEFAULT_RECORDING_USER_ID)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(recordings: List<RecordingEntity>): List<Long>
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(recording: RecordingEntity): Long

    @Transaction
    suspend fun upsertBest(recording: RecordingEntity): Long {
        val existing = getRecordingByFilenameIncludingDeleted(recording.userId, recording.filename)
        if (existing != null && recording.deletedAt == null && existing.deletedAt != null) {
            return existing.id.toLong()
        }
        return if (existing == null || recording.id == existing.id || recording.shouldReplaceExisting(existing)) {
            insert(recording.copy(id = if (recording.id == 0 && existing != null) existing.id else recording.id))
        } else {
            existing.id.toLong()
        }
    }

    @Query("DELETE FROM recordings WHERE userId = :userId AND filename = :filename")
    suspend fun deleteByFilename(userId: String, filename: String): Int

    suspend fun deleteByFilename(filename: String): Int =
        deleteByFilename(DEFAULT_RECORDING_USER_ID, filename)

    @Query("UPDATE recordings SET deletedAt = :deletedAt WHERE userId = :userId AND filename = :filename")
    suspend fun markDeletedByFilename(userId: String, filename: String, deletedAt: Long): Int

    suspend fun markDeletedByFilename(filename: String, deletedAt: Long): Int =
        markDeletedByFilename(DEFAULT_RECORDING_USER_ID, filename, deletedAt)

    @Query("SELECT * FROM recordings WHERE id = :id LIMIT 1")
    suspend fun getRecordingById(id: Int): RecordingEntity?

    @Query("""
        SELECT * FROM recordings
        WHERE userId = :userId
          AND filename = :filename
          AND deletedAt IS NULL
        ORDER BY durationMs DESC, timestamp ASC, id ASC
        LIMIT 1
    """)
    fun observeRecordingByFilename(userId: String, filename: String): Flow<RecordingEntity?>

    fun observeRecordingByFilename(filename: String): Flow<RecordingEntity?> =
        observeRecordingByFilename(DEFAULT_RECORDING_USER_ID, filename)
    
    @Query("""
        SELECT * FROM recordings
        WHERE userId = :userId
          AND filename = :filename
          AND deletedAt IS NULL
        ORDER BY durationMs DESC, timestamp ASC, id ASC
        LIMIT 1
    """)
    suspend fun getRecordingByFilename(userId: String, filename: String): RecordingEntity?

    suspend fun getRecordingByFilename(filename: String): RecordingEntity? =
        getRecordingByFilename(DEFAULT_RECORDING_USER_ID, filename)

    @Query("""
        SELECT * FROM recordings
        WHERE userId = :userId
          AND filename = :filename
        ORDER BY
            CASE WHEN deletedAt IS NULL THEN 0 ELSE 1 END,
            durationMs DESC,
            timestamp ASC,
            id ASC
        LIMIT 1
    """)
    suspend fun getRecordingByFilenameIncludingDeleted(userId: String, filename: String): RecordingEntity?

    suspend fun getRecordingByFilenameIncludingDeleted(filename: String): RecordingEntity? =
        getRecordingByFilenameIncludingDeleted(DEFAULT_RECORDING_USER_ID, filename)
}

private const val DEFAULT_RECORDING_USER_ID = "default_user"

internal fun RecordingEntity.shouldReplaceExisting(existing: RecordingEntity): Boolean {
    if (deletedAt == null && existing.deletedAt != null) return false
    if (deletedAt != null && existing.deletedAt == null) return false
    if (statusScore() != existing.statusScore()) return statusScore() > existing.statusScore()
    if (hasArticlePayload() != existing.hasArticlePayload()) return hasArticlePayload()
    if (hasPositiveDuration() != existing.hasPositiveDuration()) return hasPositiveDuration()
    if (durationMs != existing.durationMs) return durationMs > existing.durationMs
    if (timestamp != existing.timestamp) return timestamp < existing.timestamp
    return id != 0 && (existing.id == 0 || id < existing.id)
}

private fun RecordingEntity.statusScore(): Int {
    return when (status.asRecordingStatus()) {
        RecordingStatus.COMPLETED -> 6
        RecordingStatus.PROCESSING -> 5
        RecordingStatus.UPLOADED -> 4
        RecordingStatus.UPLOADING -> 3
        RecordingStatus.LOCAL_RECORDED -> 2
        RecordingStatus.FAILED -> 1
    }
}

private fun RecordingEntity.hasArticlePayload(): Boolean {
    return !articleTitle.isNullOrBlank() ||
        !rawTextPreview.isNullOrBlank() ||
        !coverImageUrl.isNullOrBlank() ||
        !wechatDraftId.isNullOrBlank() ||
        !wechatUrl.isNullOrBlank()
}

private fun RecordingEntity.hasPositiveDuration(): Boolean = durationMs > 0L
