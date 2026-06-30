package cn.litianc.vibepub

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.asRecordingStatus
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

internal enum class SyncHttpFailure {
    AUTH,
    MISSING_TRANSCRIPT,
    RETRYABLE,
}

internal fun classifySyncHttpFailure(responseCode: Int): SyncHttpFailure {
    return when {
        responseCode == 401 || responseCode == 403 -> SyncHttpFailure.AUTH
        responseCode == 404 -> SyncHttpFailure.MISSING_TRANSCRIPT
        else -> SyncHttpFailure.RETRYABLE
    }
}

internal fun shouldMarkSyncConfigurationFailure(status: RecordingStatus, onlyActive: Boolean): Boolean {
    return status != RecordingStatus.COMPLETED && (
        !onlyActive ||
            status == RecordingStatus.UPLOADING ||
            status == RecordingStatus.UPLOADED ||
            status == RecordingStatus.PROCESSING
    )
}

internal fun parseRemoteRecordingCreatedAt(createdAt: String?): Long? {
    val value = createdAt?.trim().orEmpty()
    if (value.isBlank()) return null

    val patterns = listOf(
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(value)?.time
        }.getOrNull()
    }
}

internal fun parseDurationMsFromRecordingFilename(filename: String): Long? {
    val match = Regex("""-(\d+)m(\d+)s(?:-|\.|$)""").find(filename) ?: return null
    val minutes = match.groupValues[1].toLongOrNull() ?: return null
    val seconds = match.groupValues[2].toLongOrNull() ?: return null
    return ((minutes * 60) + seconds) * 1_000
}

internal fun mergedTranscriptError(
    existingError: String?,
    transcriptError: String?,
    hasDraftReference: Boolean,
): String? {
    return when {
        hasDraftReference -> null
        !transcriptError.isNullOrBlank() -> transcriptError
        else -> existingError?.trim()?.ifBlank { null }
    }
}

internal fun transcriptArticleTitleOrNull(transcript: JSONObject?): String? {
    if (transcript == null) return null
    return transcript.optString("articleTitle", "")
        .ifBlank { transcript.optString("article_title", "") }
        .trim()
        .ifBlank { null }
}

internal fun transcriptRawTextOrNull(transcript: JSONObject?): String? {
    if (transcript == null) return null
    return transcript.optString("rawText", "")
        .ifBlank { transcript.optString("raw_text", "") }
        .trim()
        .ifBlank { null }
}

internal fun shouldSkipRemoteRecording(existing: RecordingEntity?): Boolean {
    return existing?.deletedAt != null
}

class SyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val prefs = AppPreferences(applicationContext)
        val apiBaseUrl = prefs.apiBaseUrl
        val filesToken = prefs.filesToken

        val dir = File(applicationContext.filesDir, "recordings")
        val dao = AppDatabase.getDatabase(applicationContext).recordingDao()
        var allSuccess = true

        if (filesToken.isBlank()) {
            markSyncAuthFailure(
                message = "请先在设置中配置 FILES_TOKEN，无法同步云端状态",
                onlyActive = true,
            )
            return@withContext Result.failure()
        }

        // Sync missing recordings from D1
        try {
            val endpoint = URL("${apiBaseUrl.trimEnd('/')}/api/recordings")
            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("Authorization", "Bearer $filesToken")
            }
            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                val jsonText = connection.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(jsonText)
                val recordingsArray = json.optJSONArray("recordings")
                if (recordingsArray != null) {
                    for (i in 0 until recordingsArray.length()) {
                        val recObj = recordingsArray.getJSONObject(i)
                        val filename = recObj.optString("filename")
                        if (filename.isBlank()) continue
                        val existing = dao.getRecordingByFilenameIncludingDeleted(filename)
                        if (shouldSkipRemoteRecording(existing)) continue
                        val d1Status = recObj.optString("status", RecordingStatus.UPLOADED.value)
                            .asRecordingStatus()
                        val remoteCreatedAtMs = parseRemoteRecordingCreatedAt(recObj.optString("created_at", ""))
                        val fallbackDurationMs = recObj.optLong("duration_ms", -1L)
                            .takeIf { it > 0L }
                            ?: recObj.optLong("durationMs", -1L).takeIf { it > 0L }
                            ?: parseDurationMsFromRecordingFilename(filename)
                        val remoteUpdatedAt = recObj.optString("updated_at", "").blankToNull()
                        val articleTitle = recObj.optString("article_title", "")
                            .ifBlank { recObj.optString("articleTitle", "") }
                            .blankToNull()
                        val rawTextPreview = recObj.optString("raw_text_preview", "")
                            .ifBlank { recObj.optString("rawTextPreview", "") }
                            .blankToNull()
                        val lastError = recObj.optString("error_message", "")
                            .ifBlank { recObj.optString("lastError", "") }
                            .blankToNull()
                        val wechatDraftId = recObj.optString("wechat_draft_id", "")
                            .ifBlank { recObj.optString("wechatDraftId", "") }
                            .ifBlank { recObj.optString("mediaId", "") }
                            .blankToNull()
                        val wechatUrl = recObj.wechatUrlOrNull()
                        val processingStage = recObj.processingStageOrNull()
                        if (existing == null) {
                            dao.insert(RecordingEntity(
                                filename = filename,
                                durationMs = fallbackDurationMs ?: 0L,
                                timestamp = remoteCreatedAtMs ?: System.currentTimeMillis(),
                                status = d1Status.value,
                                articleTitle = articleTitle,
                                rawTextPreview = rawTextPreview,
                                remoteStatusUpdatedAt = remoteUpdatedAt,
                                lastError = lastError,
                                completedAt = if (d1Status == RecordingStatus.COMPLETED) System.currentTimeMillis() else null,
                                wechatDraftId = wechatDraftId,
                                wechatUrl = wechatUrl,
                                processingStage = processingStage,
                            ))
                        } else if (existing.status != RecordingStatus.COMPLETED.value || d1Status == RecordingStatus.COMPLETED) {
                            val nextStatus = when {
                                d1Status == RecordingStatus.COMPLETED -> RecordingStatus.COMPLETED
                                existing.status == RecordingStatus.COMPLETED.value -> RecordingStatus.COMPLETED
                                d1Status == RecordingStatus.UPLOADED && existing.status == RecordingStatus.UPLOADING.value -> RecordingStatus.PROCESSING
                                else -> d1Status
                            }
                            dao.insert(
                                existing.copy(
                                    status = nextStatus.value,
                                    durationMs = if (existing.durationMs > 0L) existing.durationMs else fallbackDurationMs ?: 0L,
                                    timestamp = when {
                                        existing.localAudioPath.isNullOrBlank() && remoteCreatedAtMs != null -> remoteCreatedAtMs
                                        existing.timestamp > 0L -> existing.timestamp
                                        else -> remoteCreatedAtMs ?: existing.timestamp
                                    },
                                    articleTitle = articleTitle ?: existing.articleTitle,
                                    rawTextPreview = rawTextPreview ?: existing.rawTextPreview,
                                    remoteStatusUpdatedAt = remoteUpdatedAt ?: existing.remoteStatusUpdatedAt,
                                    lastError = lastError,
                                    completedAt = if (nextStatus == RecordingStatus.COMPLETED) {
                                        existing.completedAt ?: System.currentTimeMillis()
                                    } else {
                                        existing.completedAt
                                    },
                                    wechatDraftId = wechatDraftId ?: existing.wechatDraftId,
                                    wechatUrl = wechatUrl ?: existing.wechatUrl,
                                    processingStage = processingStage ?: existing.processingStage,
                                ),
                            )
                        }
                    }
                }
            } else if (classifySyncHttpFailure(responseCode) == SyncHttpFailure.AUTH) {
                markSyncAuthFailure(
                    message = "FILES_TOKEN 无效或没有权限，无法同步云端录音列表",
                    onlyActive = true,
                )
                return@withContext Result.failure()
            } else {
                allSuccess = false
            }
        } catch (e: Exception) {
            e.printStackTrace()
            allSuccess = false
        }

        val recordings = dao.getAllRecordings()

        for (recording in recordings) {
            val jsonFile = File(dir, transcriptFileNameForRecording(recording.filename))
            if (!jsonFile.exists()) {
                try {
                    val encodedFilename = URLEncoder.encode(recording.filename, "UTF-8").replace("+", "%20")
                    val endpoint = URL("${apiBaseUrl.trimEnd('/')}/api/transcripts/$encodedFilename")
                    val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 10_000
                        readTimeout = 10_000
                        setRequestProperty("Authorization", "Bearer $filesToken")
                    }

                    val responseCode = connection.responseCode
                    if (responseCode in 200..299) {
                        val jsonText = connection.inputStream.bufferedReader().use { it.readText() }
                        dir.mkdirs()
                        jsonFile.writeText(jsonText)
                        val transcript = JSONObject(jsonText)
                        val transcriptProcessingStage = transcript.processingStageOrNull() ?: "COMPLETED"
                        val transcriptWechatDraftId = transcript.wechatDraftIdOrNull()
                        val transcriptWechatUrl = transcript.wechatUrlOrNull()
                        dao.insert(
                            recording.copy(
                                status = RecordingStatus.COMPLETED.value,
                                articleTitle = transcriptArticleTitleOrNull(transcript) ?: recording.articleTitle,
                                rawTextPreview = transcriptRawTextOrNull(transcript)
                                    ?.take(80)
                                    ?.blankToNull()
                                    ?: recording.rawTextPreview,
                                lastError = mergedTranscriptError(
                                    existingError = recording.lastError,
                                    transcriptError = transcript.errorMessageOrNull(),
                                    hasDraftReference = transcriptWechatDraftId != null || transcriptWechatUrl != null,
                                ),
                                completedAt = recording.completedAt ?: System.currentTimeMillis(),
                                wechatDraftId = transcriptWechatDraftId ?: recording.wechatDraftId,
                                wechatUrl = transcriptWechatUrl ?: recording.wechatUrl,
                                processingStage = transcriptProcessingStage,
                            ),
                        )
                    } else {
                        when (classifySyncHttpFailure(responseCode)) {
                            SyncHttpFailure.MISSING_TRANSCRIPT -> {
                                if (recording.status == RecordingStatus.UPLOADED.value || recording.status == RecordingStatus.UPLOADING.value) {
                                    dao.insert(recording.copy(status = RecordingStatus.PROCESSING.value))
                                }
                            }
                            SyncHttpFailure.AUTH -> {
                                dao.insert(
                                    recording.copy(
                                        status = RecordingStatus.FAILED.value,
                                        lastError = "FILES_TOKEN 无效或没有权限，无法同步转录结果",
                                        processingStage = recording.processingStage,
                                    ),
                                )
                                allSuccess = false
                            }
                            SyncHttpFailure.RETRYABLE -> {
                                allSuccess = false
                            }
                        }
                    }
                } catch (e: Exception) {
                    allSuccess = false
                }
            } else {
                if (recording.status != RecordingStatus.COMPLETED.value) {
                    val transcript = runCatching { JSONObject(jsonFile.readText()) }.getOrNull()
                    val transcriptTitle = transcriptArticleTitleOrNull(transcript)
                    val transcriptPreview = transcriptRawTextOrNull(transcript)?.take(80)?.blankToNull()
                    val transcriptProcessingStage = transcript?.processingStageOrNull() ?: "COMPLETED"
                    val transcriptWechatDraftId = transcript?.wechatDraftIdOrNull()
                    val transcriptWechatUrl = transcript?.wechatUrlOrNull()
                    dao.insert(
                        recording.copy(
                            status = RecordingStatus.COMPLETED.value,
                            articleTitle = transcriptTitle ?: recording.articleTitle,
                            rawTextPreview = transcriptPreview ?: recording.rawTextPreview,
                            lastError = mergedTranscriptError(
                                existingError = recording.lastError,
                                transcriptError = transcript?.errorMessageOrNull(),
                                hasDraftReference = transcriptWechatDraftId != null || transcriptWechatUrl != null,
                            ),
                            completedAt = recording.completedAt ?: System.currentTimeMillis(),
                            wechatDraftId = transcriptWechatDraftId ?: recording.wechatDraftId,
                            wechatUrl = transcriptWechatUrl ?: recording.wechatUrl,
                            processingStage = transcriptProcessingStage,
                        ),
                    )
                }
            }
        }

        if (allSuccess) {
            prefs.lastSyncAtMs = System.currentTimeMillis()
            Result.success()
        } else {
            Result.retry()
        }
    }

    private suspend fun markSyncAuthFailure(message: String, onlyActive: Boolean) {
        val dao = AppDatabase.getDatabase(applicationContext).recordingDao()
        dao.getAllRecordings().forEach { recording ->
            val status = recording.status.asRecordingStatus()
            if (shouldMarkSyncConfigurationFailure(status, onlyActive)) {
                dao.insert(
                    recording.copy(
                        status = RecordingStatus.FAILED.value,
                        lastError = message,
                    ),
                )
            }
        }
    }

    private fun String.blankToNull(): String? = trim().ifBlank { null }

    private fun JSONObject.wechatDraftIdOrNull(): String? {
        return optString("wechatDraftId", "")
            .ifBlank { optString("mediaId", "") }
            .ifBlank { optString("wechat_draft_id", "") }
            .blankToNull()
    }

    private fun JSONObject.wechatUrlOrNull(): String? {
        return optString("wechatUrl", "")
            .ifBlank { optString("wechat_url", "") }
            .blankToNull()
    }

    private fun JSONObject.processingStageOrNull(): String? {
        return optString("processingStage", "")
            .ifBlank { optString("processing_stage", "") }
            .blankToNull()
    }

    private fun JSONObject.errorMessageOrNull(): String? {
        return optString("errorMessage", "")
            .ifBlank { optString("error_message", "") }
            .blankToNull()
    }
}
