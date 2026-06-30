package cn.litianc.vibepub

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
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
import java.security.MessageDigest

object RecordingUploadCoordinator {
    const val MIN_RECORDING_DURATION_MS = 2_000L
    private const val UNIQUE_UPLOAD_WORK_PREFIX = "upload_recording"

    suspend fun saveRecording(
        context: Context,
        file: File,
        durationMs: Long,
        status: String = RecordingStatus.LOCAL_RECORDED.value,
        minDurationMs: Long = MIN_RECORDING_DURATION_MS,
    ): Boolean {
        if (!shouldSaveRecording(file, durationMs, minDurationMs)) {
            file.delete()
            return false
        }

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
        return true
    }

    fun shouldSaveRecording(
        file: File,
        durationMs: Long,
        minDurationMs: Long = MIN_RECORDING_DURATION_MS,
    ): Boolean {
        return durationMs >= minDurationMs && file.exists() && file.length() > 0L
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

        WorkManager.getInstance(context).enqueueUniqueWork(
            uniqueUploadWorkName(file.name),
            ExistingWorkPolicy.KEEP,
            requestBuilder.build(),
        )
        return true
    }

    internal fun uniqueUploadWorkName(filename: String): String {
        val normalized = filename.trim().ifBlank { "unnamed" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(normalized.toByteArray())
            .take(8)
            .joinToString("") { "%02x".format(it) }
        return "$UNIQUE_UPLOAD_WORK_PREFIX-$digest"
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
