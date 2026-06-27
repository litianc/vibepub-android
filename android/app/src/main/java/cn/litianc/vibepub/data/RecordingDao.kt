package cn.litianc.vibepub.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface RecordingDao {
    @Query("SELECT * FROM recordings ORDER BY timestamp DESC")
    fun getAllRecordings(): Flow<List<RecordingEntity>>

    @Insert
    suspend fun insertRecording(recording: RecordingEntity)

    @Query("UPDATE recordings SET status = :status WHERE id = :id")
    suspend fun updateStatus(id: Int, status: String)

    @Query("UPDATE recordings SET status = :status WHERE filename = :filename")
    suspend fun updateStatusByFilename(filename: String, status: String)
}
