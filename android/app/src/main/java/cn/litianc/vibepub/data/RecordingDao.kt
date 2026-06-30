package cn.litianc.vibepub.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
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
