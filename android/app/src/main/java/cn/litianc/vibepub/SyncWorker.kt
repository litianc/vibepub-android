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
import cn.litianc.vibepub.data.RecordingSourceType
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.asRecordingSourceType
import cn.litianc.vibepub.data.asRecordingStatus
import cn.litianc.vibepub.data.mergePublicationSnapshot
import cn.litianc.vibepub.data.parsePublicationSnapshot
import cn.litianc.vibepub.data.publicationSnapshotOrNull
import cn.litianc.vibepub.data.withPublicationSnapshot
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
        .blankToNullValue()
}

internal fun transcriptRawTextOrNull(transcript: JSONObject?): String? {
    if (transcript == null) return null
    return transcript.optString("rawText", "")
        .ifBlank { transcript.optString("raw_text", "") }
        .blankToNullValue()
}

internal fun JSONObject.coverImageUrlOrNull(): String? {
    return optString("coverImageUrl", "")
        .ifBlank { optString("cover_image_url", "") }
        .blankToNullValue()
}

internal fun String.blankToNullValue(): String? {
    val value = trim()
    return value.takeUnless { it.isBlank() || it.equals("null", ignoreCase = true) }
}

internal fun shouldSkipRemoteRecording(existing: RecordingEntity?): Boolean {
    return existing?.deletedAt != null
}

internal fun shouldFetchRemoteTranscript(jsonFile: File, recording: RecordingEntity): Boolean {
    if (!jsonFile.exists()) return true

    val status = recording.status.asRecordingStatus()
    val stage = recording.processingStage.orEmpty()
        .trim()
        .uppercase(Locale.ROOT)
        .replace("-", "_")
        .replace(" ", "_")
    val remoteMayHaveUpdatedTranscript = status == RecordingStatus.COMPLETED ||
        stage in TRANSCRIPT_REFRESH_STAGES
    if (!remoteMayHaveUpdatedTranscript) return false

    val remoteUpdatedAtMs = parseRemoteRecordingCreatedAt(recording.remoteStatusUpdatedAt)
    return remoteUpdatedAtMs != null && remoteUpdatedAtMs > jsonFile.lastModified() + 1_000L
}

internal fun mergeRemoteRecordingFromListItem(
    recObj: JSONObject,
    existing: RecordingEntity?,
    nowMs: Long = System.currentTimeMillis(),
    userId: String = AppPreferences.DEFAULT_USER_ID,
): RecordingEntity? {
    val filename = recObj.optString("filename").trim()
    if (filename.isBlank() || shouldSkipRemoteRecording(existing)) return null

    val remoteStatus = recObj.optString("status", RecordingStatus.UPLOADED.value)
        .asRecordingStatus()
    val remoteCreatedAtMs = parseRemoteRecordingCreatedAt(recObj.optString("created_at", ""))
    val fallbackDurationMs = recObj.optLong("duration_ms", -1L)
        .takeIf { it > 0L }
        ?: recObj.optLong("durationMs", -1L).takeIf { it > 0L }
        ?: parseDurationMsFromRecordingFilename(filename)
    val remoteUpdatedAt = recObj.optString("updated_at", "").blankToNullValue()
    val articleTitle = recObj.optString("article_title", "")
        .ifBlank { recObj.optString("articleTitle", "") }
        .blankToNullValue()
    val rawTextPreview = recObj.optString("raw_text_preview", "")
        .ifBlank { recObj.optString("rawTextPreview", "") }
        .blankToNullValue()
    val lastError = recObj.optString("error_message", "")
        .ifBlank { recObj.optString("lastError", "") }
        .blankToNullValue()
    val wechatDraftId = recObj.optString("wechat_draft_id", "")
        .ifBlank { recObj.optString("wechatDraftId", "") }
        .ifBlank { recObj.optString("mediaId", "") }
        .blankToNullValue()
    val wechatUrl = recObj.wechatUrlOrNull()
    val coverImageUrl = recObj.coverImageUrlOrNull()
    val processingStage = recObj.processingStageOrNull()
    val sourceType = recObj.optString("source_type", "")
        .ifBlank { recObj.optString("sourceType", "") }
        .ifBlank { inferSourceTypeFromFilename(filename).value }
        .asRecordingSourceType()
    val inputText = recObj.optString("input_text", "")
        .ifBlank { recObj.optString("inputText", "") }
        .blankToNullValue()
    val remoteRecordingId = recObj.optLong("id", -1L).takeIf { it > 0L }
    val incomingPublicationSnapshot = parsePublicationSnapshot(recObj)
    val publicationSnapshot = mergePublicationSnapshot(
        existing = existing?.publicationSnapshotOrNull(),
        incoming = incomingPublicationSnapshot,
    )

    fun applyPublicationSnapshot(recording: RecordingEntity): RecordingEntity {
        val withRemoteId = recording.copy(
            remoteRecordingId = remoteRecordingId ?: recording.remoteRecordingId,
        )
        return publicationSnapshot?.let(withRemoteId::withPublicationSnapshot) ?: withRemoteId
    }

    if (existing == null) {
        return applyPublicationSnapshot(RecordingEntity(
            userId = userId,
            filename = filename,
            durationMs = fallbackDurationMs ?: 0L,
            timestamp = remoteCreatedAtMs ?: nowMs,
            status = remoteStatus.value,
            articleTitle = articleTitle,
            rawTextPreview = rawTextPreview,
            remoteStatusUpdatedAt = remoteUpdatedAt,
            lastError = lastError,
            completedAt = if (remoteStatus == RecordingStatus.COMPLETED) nowMs else null,
            wechatDraftId = wechatDraftId,
            wechatUrl = wechatUrl,
            coverImageUrl = coverImageUrl,
            processingStage = processingStage,
            sourceType = sourceType.value,
            inputText = inputText,
        ))
    }

    if (
        existing.status == RecordingStatus.COMPLETED.value &&
        remoteStatus != RecordingStatus.COMPLETED &&
        incomingPublicationSnapshot == null
    ) {
        return null
    }

    val nextStatus = when {
        remoteStatus == RecordingStatus.COMPLETED -> RecordingStatus.COMPLETED
        existing.status == RecordingStatus.COMPLETED.value -> RecordingStatus.COMPLETED
        remoteStatus == RecordingStatus.UPLOADED && existing.status == RecordingStatus.UPLOADING.value -> RecordingStatus.PROCESSING
        else -> remoteStatus
    }

    return applyPublicationSnapshot(existing.copy(
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
            existing.completedAt ?: nowMs
        } else {
            existing.completedAt
        },
        wechatDraftId = wechatDraftId ?: existing.wechatDraftId,
        wechatUrl = wechatUrl ?: existing.wechatUrl,
        coverImageUrl = coverImageUrl ?: existing.coverImageUrl,
        processingStage = processingStage ?: existing.processingStage,
        sourceType = sourceType.value,
        inputText = inputText ?: existing.inputText,
    ))
}

internal fun inferSourceTypeFromFilename(filename: String): RecordingSourceType {
    val normalized = filename.trim().lowercase(Locale.ROOT)
    return when {
        normalized.endsWith(".txt") || normalized.endsWith(".json") && normalized.contains("-text-") -> RecordingSourceType.TEXT
        normalized.contains("imported-audio") -> RecordingSourceType.AUDIO_FILE
        else -> RecordingSourceType.RECORDING
    }
}

class SyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val prefs = AppPreferences(applicationContext)
        val apiBaseUrl = prefs.apiBaseUrl
        val userId = prefs.effectiveUserId

        val dir = File(applicationContext.filesDir, "recordings")
        val dao = AppDatabase.getDatabase(applicationContext).recordingDao()
        var allSuccess = true

        if (prefs.accessToken.isBlank()) {
            markSyncAuthFailure(
                userId = userId,
                message = "请先登录，无法同步云端状态",
                onlyActive = true,
            )
            return@withContext Result.failure()
        }

        // Sync missing recordings from D1
        try {
            val response = AuthenticatedHttpClient.request(
                preferences = prefs,
                url = URL("${apiBaseUrl.trimEnd('/')}/api/recordings"),
                method = "GET",
                connectTimeoutMs = 10_000,
                readTimeoutMs = 10_000,
            )
            val responseCode = response.statusCode
            if (responseCode in 200..299) {
                val json = JSONObject(response.body)
                val recordingsArray = json.optJSONArray("recordings")
                if (recordingsArray != null) {
                    for (i in 0 until recordingsArray.length()) {
                        val recObj = recordingsArray.getJSONObject(i)
                        val filename = recObj.optString("filename").trim()
                        if (filename.isBlank()) continue
                        val existing = dao.getRecordingByFilenameIncludingDeleted(userId, filename)
                        val merged = mergeRemoteRecordingFromListItem(recObj, existing, userId = userId)
                        if (merged != null) {
                            dao.upsertBest(merged)
                        }
                    }
                }
            } else if (classifySyncHttpFailure(responseCode) == SyncHttpFailure.AUTH) {
                markSyncAuthFailure(
                    userId = userId,
                    message = "登录已失效或没有权限，无法同步云端录音列表",
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

        val recordings = dao.getAllRecordings(userId)

        for (recording in recordings) {
            val jsonFile = File(dir, transcriptFileNameForRecording(recording.filename))
            if (shouldFetchRemoteTranscript(jsonFile, recording)) {
                try {
                    val wasExistingTranscript = jsonFile.exists()
                    val encodedFilename = URLEncoder.encode(recording.filename, "UTF-8").replace("+", "%20")
                    val response = AuthenticatedHttpClient.request(
                        preferences = prefs,
                        url = URL("${apiBaseUrl.trimEnd('/')}/api/transcripts/$encodedFilename"),
                        method = "GET",
                        connectTimeoutMs = 10_000,
                        readTimeoutMs = 10_000,
                    )
                    val responseCode = response.statusCode
                    if (responseCode in 200..299) {
                        val jsonText = response.body
                        dir.mkdirs()
                        jsonFile.writeText(jsonText)
                        val transcript = JSONObject(jsonText)
                        val transcriptProcessingStage = transcript.processingStageOrNull() ?: "COMPLETED"
                        val transcriptWechatDraftId = transcript.wechatDraftIdOrNull()
                        val transcriptWechatUrl = transcript.wechatUrlOrNull()
                        val transcriptCoverImageUrl = transcript.coverImageUrlOrNull()
                        downloadCoverImageIfNeeded(
                            dir = dir,
                            filename = recording.filename,
                            coverImageUrl = transcriptCoverImageUrl ?: recording.coverImageUrl,
                            preferences = prefs,
                            force = wasExistingTranscript,
                        )
                        dao.upsertBest(
                            recording.copy(
                                status = RecordingStatus.COMPLETED.value,
                                articleTitle = transcriptArticleTitleOrNull(transcript) ?: recording.articleTitle,
                                rawTextPreview = transcriptRawTextOrNull(transcript)
                                    ?.take(80)
                                    ?.blankToNullValue()
                                    ?: recording.rawTextPreview,
                                lastError = mergedTranscriptError(
                                    existingError = recording.lastError,
                                    transcriptError = transcript.errorMessageOrNull(),
                                    hasDraftReference = transcriptWechatDraftId != null || transcriptWechatUrl != null,
                                ),
                                completedAt = recording.completedAt ?: System.currentTimeMillis(),
                                wechatDraftId = transcriptWechatDraftId ?: recording.wechatDraftId,
                                wechatUrl = transcriptWechatUrl ?: recording.wechatUrl,
                                coverImageUrl = transcriptCoverImageUrl ?: recording.coverImageUrl,
                                processingStage = transcriptProcessingStage,
                            ),
                        )
                    } else {
                        when (classifySyncHttpFailure(responseCode)) {
                            SyncHttpFailure.MISSING_TRANSCRIPT -> {
                                if (recording.status == RecordingStatus.UPLOADED.value || recording.status == RecordingStatus.UPLOADING.value) {
                                    dao.upsertBest(recording.copy(status = RecordingStatus.PROCESSING.value))
                                }
                            }
                            SyncHttpFailure.AUTH -> {
                                dao.upsertBest(
                                    recording.copy(
                                        status = RecordingStatus.FAILED.value,
                                        lastError = "登录已失效或没有权限，无法同步转录结果",
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
                val transcript = runCatching { JSONObject(jsonFile.readText()) }.getOrNull()
                val transcriptCoverImageUrl = transcript?.coverImageUrlOrNull()
                downloadCoverImageIfNeeded(
                    dir = dir,
                    filename = recording.filename,
                    coverImageUrl = transcriptCoverImageUrl ?: recording.coverImageUrl,
                    preferences = prefs,
                )
                if (recording.status != RecordingStatus.COMPLETED.value) {
                    val transcriptTitle = transcriptArticleTitleOrNull(transcript)
                    val transcriptPreview = transcriptRawTextOrNull(transcript)?.take(80)?.blankToNullValue()
                    val transcriptProcessingStage = transcript?.processingStageOrNull() ?: "COMPLETED"
                    val transcriptWechatDraftId = transcript?.wechatDraftIdOrNull()
                    val transcriptWechatUrl = transcript?.wechatUrlOrNull()
                    dao.upsertBest(
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
                            coverImageUrl = transcriptCoverImageUrl ?: recording.coverImageUrl,
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

    private suspend fun markSyncAuthFailure(userId: String, message: String, onlyActive: Boolean) {
        val dao = AppDatabase.getDatabase(applicationContext).recordingDao()
        dao.getAllRecordings(userId).forEach { recording ->
            val status = recording.status.asRecordingStatus()
            if (shouldMarkSyncConfigurationFailure(status, onlyActive)) {
                dao.upsertBest(
                    recording.copy(
                        status = RecordingStatus.FAILED.value,
                        lastError = message,
                    ),
                )
            }
        }
    }

    private fun JSONObject.errorMessageOrNull(): String? = syncErrorMessageOrNull()

    private suspend fun downloadCoverImageIfNeeded(
        dir: File,
        filename: String,
        coverImageUrl: String?,
        preferences: AppPreferences,
        force: Boolean = false,
    ) {
        val url = coverImageUrl?.trim()?.takeIf { it.isNotBlank() } ?: return
        val file = File(dir, coverImageFileNameForRecording(filename))
        if (!force && file.exists() && file.length() > 0L) return

        val tempFile = File(file.parentFile, "${file.name}.tmp")
        runCatching {
            dir.mkdirs()
            tempFile.delete()
            val parsed = URL(url)
            val bytes = if (shouldAuthorizeVibePubFileUrl(parsed, preferences.apiBaseUrl)) {
                val response = AuthenticatedHttpClient.requestBytes(
                    preferences = preferences,
                    url = parsed,
                    method = "GET",
                    connectTimeoutMs = 10_000,
                    readTimeoutMs = 20_000,
                )
                if (response.statusCode !in 200..299) return@runCatching
                response.body
            } else {
                downloadPublicCoverImageBytes(parsed) ?: return@runCatching
            }
            tempFile.writeBytes(bytes)
            if (file.exists() && file.length() == 0L) file.delete()
            if (!tempFile.renameTo(file)) {
                tempFile.copyTo(file, overwrite = true)
                tempFile.delete()
            }
        }.onFailure {
            tempFile.delete()
        }
    }
}

private fun downloadPublicCoverImageBytes(url: URL): ByteArray? {
    val connection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 10_000
        readTimeout = 20_000
    }
    return try {
        if (connection.responseCode !in 200..299) return null
        connection.inputStream.use { it.readBytes() }
    } finally {
        connection.disconnect()
    }
}

internal fun JSONObject.wechatDraftIdOrNull(): String? {
    return optString("wechatDraftId", "")
        .ifBlank { optString("mediaId", "") }
        .ifBlank { optString("wechat_draft_id", "") }
        .blankToNullValue()
}

internal fun JSONObject.wechatUrlOrNull(): String? {
    return optString("wechatUrl", "")
        .ifBlank { optString("wechat_url", "") }
        .blankToNullValue()
}

internal fun JSONObject.processingStageOrNull(): String? {
    return optString("processingStage", "")
        .ifBlank { optString("processing_stage", "") }
        .blankToNullValue()
}

internal fun JSONObject.syncErrorMessageOrNull(): String? {
    return optString("errorMessage", "")
        .ifBlank { optString("error_message", "") }
        .blankToNullValue()
}

private val TRANSCRIPT_REFRESH_STAGES = setOf(
    "ARTICLE_READY",
    "DRAFT_FAILED",
    "REVISION_FAILED",
    "COMPLETED",
    "DONE",
)
