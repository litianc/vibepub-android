package cn.litianc.vibepub

import android.content.Context
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import java.io.File

object RecordingUploadCoordinator {
    suspend fun saveRecording(
        context: Context,
        file: File,
        durationMs: Long,
        status: String = "UPLOADED",
    ) {
        AppDatabase.getDatabase(context)
            .recordingDao()
            .insert(
                RecordingEntity(
                    filename = file.name,
                    durationMs = durationMs,
                    timestamp = System.currentTimeMillis(),
                    status = status,
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
            return false
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
}
