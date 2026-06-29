package cn.litianc.vibepub

import android.content.Context
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File

object RecordingUploadCoordinator {
    suspend fun saveRecording(
        context: Context,
        file: File,
        durationMs: Long,
        status: String = RecordingStatus.LOCAL_RECORDED.value,
    ) {
        AppDatabase.getDatabase(context)
            .recordingDao()
            .insert(
                RecordingEntity(
                    filename = file.name,
                    durationMs = durationMs,
                    timestamp = System.currentTimeMillis(),
                    status = status,
                    localAudioPath = file.absolutePath,
                    lastError = null,
                ),
            )
    }

    fun enqueueUpload(
        context: Context,
        preferences: AppPreferences,
        file: File,
        addUploadJobTag: Boolean = true,
    ): Boolean {
        val token = preferences.filesToken
        if (token.isBlank()) {
            markUploadBlocked(context, file.name, "请先在设置中配置 FILES_TOKEN")
            return false
        }

        CoroutineScope(Dispatchers.IO).launch {
            val dao = AppDatabase.getDatabase(context).recordingDao()
            val existing = dao.getRecordingByFilename(file.name)
            if (existing != null && existing.status != RecordingStatus.COMPLETED.value) {
                dao.insert(
                    existing.copy(
                        status = RecordingStatus.UPLOADING.value,
                        localAudioPath = existing.localAudioPath ?: file.absolutePath,
                        lastError = null,
                    ),
                )
            }
        }

        val requestBuilder = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setInputData(
                workDataOf(
                    UploadWorker.KEY_FILE_PATH to file.absolutePath,
                    UploadWorker.KEY_API_BASE_URL to preferences.apiBaseUrl,
                    UploadWorker.KEY_FILES_TOKEN to token,
                ),
            )

        if (addUploadJobTag) {
            requestBuilder.addTag("upload_job")
        }

        WorkManager.getInstance(context).enqueue(requestBuilder.build())
        return true
    }

    private fun markUploadBlocked(context: Context, filename: String, error: String) {
        CoroutineScope(Dispatchers.IO).launch {
            val dao = AppDatabase.getDatabase(context).recordingDao()
            val existing = dao.getRecordingByFilename(filename)
            if (existing != null) {
                dao.insert(
                    existing.copy(
                        status = RecordingStatus.FAILED.value,
                        lastError = error,
                    ),
                )
            }
        }
    }
}
