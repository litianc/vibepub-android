package cn.litianc.vibepub

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingSourceType
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
        lastError: String? = null,
        sourceType: RecordingSourceType = RecordingSourceType.RECORDING,
        userId: String = AppPreferences.DEFAULT_USER_ID,
        minDurationMs: Long = MIN_RECORDING_DURATION_MS,
    ): Boolean {
        if (!shouldSaveRecording(file, durationMs, minDurationMs)) {
            file.delete()
            return false
        }

        AppDatabase.getDatabase(context)
            .recordingDao()
            .upsertBest(
                RecordingEntity(
                    userId = userId,
                    filename = file.name,
                    durationMs = durationMs,
                    timestamp = System.currentTimeMillis(),
                    status = status,
                    localAudioPath = file.absolutePath,
                    lastError = lastError,
                    sourceType = sourceType.value,
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
        replaceExistingUpload: Boolean = false,
    ): Boolean {
        val session = preferences.currentAuthSessionSnapshot()
        if (!preferences.canUseCloudFeatures || session.sessionId.isBlank() || session.userId.isBlank()) {
            markUploadBlocked(context, preferences.effectiveUserId, file.name, "请先登录并完成邮箱验证后重试上传")
            return false
        }
        val userId = session.userId

        CoroutineScope(Dispatchers.IO).launch {
            val dao = AppDatabase.getDatabase(context).recordingDao()
            val existing = dao.getRecordingByFilename(userId, file.name)
            if (existing != null && existing.status != RecordingStatus.COMPLETED.value) {
                dao.upsertBest(
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
            .setInputData(uploadWorkInputData(preferences, file, session))

        if (addUploadJobTag) {
            requestBuilder.addTag("upload_job")
        }

        WorkManager.getInstance(context).enqueueUniqueWork(
            uniqueUploadWorkName(file.name, userId),
            uploadExistingWorkPolicy(replaceExistingUpload),
            requestBuilder.build(),
        )
        return true
    }

    internal fun uploadWorkInputData(
        preferences: AppPreferences,
        file: File,
        session: AuthSessionSnapshot = preferences.currentAuthSessionSnapshot(),
    ): Data {
        val selectedProfile = preferences.selectedWritingStyleProfile()
        return workDataOf(
            UploadWorker.KEY_FILE_PATH to file.absolutePath,
            UploadWorker.KEY_API_BASE_URL to preferences.apiBaseUrl,
            UploadWorker.KEY_LOCAL_SESSION_ID to session.sessionId,
            UploadWorker.KEY_USER_ID to session.userId,
            UploadWorker.KEY_STYLE_PROFILE_ID to selectedProfile.id,
            UploadWorker.KEY_STYLE_PROFILE_VERSION to selectedProfile.version,
            UploadWorker.KEY_STYLE_PROFILE_NAME to selectedProfile.name,
            UploadWorker.KEY_STYLE_PROFILE_DESCRIPTION to selectedProfile.description,
            UploadWorker.KEY_STYLE_PROFILE_BODY to WritingStyleProfiles.submissionBodyFor(selectedProfile),
            UploadWorker.KEY_LAYOUT_PROFILE_ID to preferences.selectedLayoutProfileId,
            UploadWorker.KEY_LAYOUT_PROFILE_VERSION to preferences.selectedLayoutProfileVersion,
        )
    }

    internal fun uploadExistingWorkPolicy(replaceExistingUpload: Boolean): ExistingWorkPolicy {
        return if (replaceExistingUpload) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
    }

    internal fun uniqueUploadWorkName(filename: String, userId: String = AppPreferences.DEFAULT_USER_ID): String {
        val normalized = filename.trim().ifBlank { "unnamed" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${userId.trim().ifBlank { AppPreferences.DEFAULT_USER_ID }}/$normalized".toByteArray())
            .take(8)
            .joinToString("") { "%02x".format(it) }
        return "$UNIQUE_UPLOAD_WORK_PREFIX-$digest"
    }

    private fun markUploadBlocked(context: Context, userId: String, filename: String, error: String) {
        CoroutineScope(Dispatchers.IO).launch {
            val dao = AppDatabase.getDatabase(context).recordingDao()
            val existing = dao.getRecordingByFilename(userId, filename)
            if (existing != null) {
                dao.upsertBest(
                    existing.copy(
                        status = RecordingStatus.FAILED.value,
                        lastError = error,
                    ),
                )
            }
        }
    }
}
