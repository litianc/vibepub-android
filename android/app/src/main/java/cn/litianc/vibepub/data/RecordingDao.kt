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
        WHERE NOT EXISTS (
            SELECT 1
            FROM recordings AS better
            WHERE better.filename = recordings.filename
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
        WHERE NOT EXISTS (
            SELECT 1
            FROM recordings AS better
            WHERE better.filename = recordings.filename
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

    @Query("SELECT * FROM recordings WHERE id = :id LIMIT 1")
    suspend fun getRecordingById(id: Int): RecordingEntity?
    
    @Query("""
        SELECT * FROM recordings
        WHERE filename = :filename
        ORDER BY durationMs DESC, timestamp ASC, id ASC
        LIMIT 1
    """)
    suspend fun getRecordingByFilename(filename: String): RecordingEntity?
}
