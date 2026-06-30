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
          AND NOT EXISTS (
            SELECT 1
            FROM recordings AS better
            WHERE better.filename = recordings.filename
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
    fun getAllRecordingsFlow(): Flow<List<RecordingEntity>>

    @Query("""
        SELECT * FROM recordings
        WHERE deletedAt IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM recordings AS better
            WHERE better.filename = recordings.filename
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
    suspend fun getAllRecordings(): List<RecordingEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(recordings: List<RecordingEntity>): List<Long>
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(recording: RecordingEntity): Long

    @Transaction
    suspend fun upsertBest(recording: RecordingEntity): Long {
        val existing = getRecordingByFilenameIncludingDeleted(recording.filename)
        return if (existing == null || recording.id == existing.id || recording.shouldReplaceExisting(existing)) {
            insert(recording.copy(id = if (recording.id == 0 && existing != null) existing.id else recording.id))
        } else {
            existing.id.toLong()
        }
    }

    @Query("DELETE FROM recordings WHERE filename = :filename")
    suspend fun deleteByFilename(filename: String): Int

    @Query("UPDATE recordings SET deletedAt = :deletedAt WHERE filename = :filename")
    suspend fun markDeletedByFilename(filename: String, deletedAt: Long): Int

    @Query("SELECT * FROM recordings WHERE id = :id LIMIT 1")
    suspend fun getRecordingById(id: Int): RecordingEntity?

    @Query("""
        SELECT * FROM recordings
        WHERE filename = :filename
          AND deletedAt IS NULL
        ORDER BY durationMs DESC, timestamp ASC, id ASC
        LIMIT 1
    """)
    fun observeRecordingByFilename(filename: String): Flow<RecordingEntity?>
    
    @Query("""
        SELECT * FROM recordings
        WHERE filename = :filename
          AND deletedAt IS NULL
        ORDER BY durationMs DESC, timestamp ASC, id ASC
        LIMIT 1
    """)
    suspend fun getRecordingByFilename(filename: String): RecordingEntity?

    @Query("""
        SELECT * FROM recordings
        WHERE filename = :filename
        ORDER BY
            CASE WHEN deletedAt IS NULL THEN 0 ELSE 1 END,
            durationMs DESC,
            timestamp ASC,
            id ASC
        LIMIT 1
    """)
    suspend fun getRecordingByFilenameIncludingDeleted(filename: String): RecordingEntity?
}

internal fun RecordingEntity.shouldReplaceExisting(existing: RecordingEntity): Boolean {
    if (deletedAt == null && existing.deletedAt != null) return true
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
    return !articleTitle.isNullOrBlank() || !rawTextPreview.isNullOrBlank() || !wechatDraftId.isNullOrBlank() || !wechatUrl.isNullOrBlank()
}

private fun RecordingEntity.hasPositiveDuration(): Boolean = durationMs > 0L
