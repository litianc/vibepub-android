package cn.litianc.vibepub.data

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** A redacted, server-owned publication projection cached with a recording. */
internal data class PublicationSnapshot(
    val runId: String,
    val state: String,
    val runStatus: String,
    val stage: String,
    val stateRevision: Long,
    val progressPercent: Int,
    val lastSuccessfulState: String,
    val lastSuccessfulProgressPercent: Int,
    val retryCount: Int,
    val nextAction: String?,
    val errorCode: String?,
    val createdAt: String?,
    val updatedAt: String?,
)

private val PUBLICATION_STATES = setOf(
    "queued", "transcribing", "transcript_ready", "writing", "draft_generated",
    "reviewing", "revising", "reviewed", "content_frozen", "visual_planning",
    "visual_generating", "visual_ready", "formatting", "visual_qa", "draft_syncing",
    "draft_verifying", "draft_ready", "retrying", "needs_action", "failed", "cancelled",
)

private val PUBLICATION_RUN_STATUSES = setOf(
    "active", "retrying", "needs_action", "failed", "cancelled", "ready",
)

internal fun parsePublicationSnapshot(recObj: JSONObject): PublicationSnapshot? {
    val nested = recObj.opt("publication_summary")
    return when (nested) {
        JSONObject.NULL -> null
        is JSONObject -> parseNestedPublicationSnapshot(nested)
        null -> parseFlatPublicationSnapshot(recObj)
        else -> null
    }
}

internal fun RecordingEntity.publicationSnapshotOrNull(): PublicationSnapshot? {
    val runId = publicationRunId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val state = publicationState?.trim()?.takeIf { it in PUBLICATION_STATES } ?: return null
    val runStatus = publicationRunStatus?.trim()?.takeIf { it in PUBLICATION_RUN_STATUSES } ?: return null
    val stage = publicationStage?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val revision = publicationStateRevision?.takeIf { it >= 0L } ?: return null
    val progress = publicationProgressPercent?.takeIf { it in 0..100 } ?: return null
    val successfulState = publicationLastSuccessfulState?.trim()?.takeIf { it in PUBLICATION_STATES } ?: return null
    val successfulProgress = publicationLastSuccessfulProgressPercent?.takeIf { it in 0..100 } ?: return null
    val retry = publicationRetryCount?.takeIf { it >= 0 } ?: return null
    return PublicationSnapshot(
        runId = runId,
        state = state,
        runStatus = runStatus,
        stage = stage,
        stateRevision = revision,
        progressPercent = progress,
        lastSuccessfulState = successfulState,
        lastSuccessfulProgressPercent = successfulProgress,
        retryCount = retry,
        nextAction = publicationNextAction?.trim()?.takeIf { it.isNotEmpty() },
        errorCode = null,
        createdAt = publicationRunCreatedAt?.trim()?.takeIf(::isPublicationTimestamp),
        updatedAt = publicationUpdatedAt?.trim()?.takeIf(::isPublicationTimestamp),
    )
}

internal fun RecordingEntity.withPublicationSnapshot(snapshot: PublicationSnapshot): RecordingEntity {
    return copy(
        publicationRunId = snapshot.runId,
        publicationState = snapshot.state,
        publicationRunStatus = snapshot.runStatus,
        publicationStage = snapshot.stage,
        publicationStateRevision = snapshot.stateRevision,
        publicationProgressPercent = snapshot.progressPercent,
        publicationLastSuccessfulState = snapshot.lastSuccessfulState,
        publicationLastSuccessfulProgressPercent = snapshot.lastSuccessfulProgressPercent,
        publicationRetryCount = snapshot.retryCount,
        publicationNextAction = snapshot.nextAction,
        publicationErrorCode = snapshot.errorCode,
        publicationRunCreatedAt = snapshot.createdAt,
        publicationUpdatedAt = snapshot.updatedAt,
    )
}

/**
 * Publication fields are a monotonic cache. Legacy fields are intentionally
 * merged elsewhere so an out-of-order publication response cannot erase them.
 */
internal fun mergePublicationSnapshot(
    existing: PublicationSnapshot?,
    incoming: PublicationSnapshot?,
): PublicationSnapshot? {
    if (incoming == null) return existing
    if (existing == null) return incoming
    if (incoming.runId == existing.runId) {
        return when {
            incoming.stateRevision > existing.stateRevision -> incoming
            incoming.stateRevision < existing.stateRevision -> existing
            else -> existing.copy(
                nextAction = existing.nextAction ?: incoming.nextAction,
                errorCode = null,
                createdAt = existing.createdAt ?: incoming.createdAt,
                updatedAt = existing.updatedAt ?: incoming.updatedAt,
            )
        }
    }

    val existingCreatedAt = existing.createdAt?.takeIf(::isPublicationTimestamp)?.let(::publicationTimestampMillis)
        ?: return existing
    val incomingCreatedAt = incoming.createdAt?.takeIf(::isPublicationTimestamp)?.let(::publicationTimestampMillis)
        ?: return existing
    return when {
        incomingCreatedAt > existingCreatedAt -> incoming
        incomingCreatedAt < existingCreatedAt -> existing
        incoming.runId > existing.runId -> incoming
        else -> existing
    }
}

private fun parseNestedPublicationSnapshot(summary: JSONObject): PublicationSnapshot? {
    val runId = summary.strictString("run_id") ?: return null
    val state = summary.strictString("state")?.takeIf { it in PUBLICATION_STATES } ?: return null
    val runStatus = summary.strictString("run_status")?.takeIf { it in PUBLICATION_RUN_STATUSES } ?: return null
    val stage = summary.strictString("publication_stage") ?: return null
    val revision = summary.nonNegativeLong("state_revision") ?: return null
    val progress = summary.boundedInt("progress_percent", 0, 100) ?: return null
    val successfulState = summary.strictString("last_successful_state")?.takeIf { it in PUBLICATION_STATES } ?: return null
    val successfulProgress = summary.boundedInt("last_successful_progress_percent", 0, 100) ?: return null
    val retryCount = summary.boundedInt("retry_count", 0, Int.MAX_VALUE) ?: return null
    val createdAt = summary.strictString("created_at")?.takeIf(::isPublicationTimestamp) ?: return null
    val updatedAt = summary.strictString("updated_at")?.takeIf(::isPublicationTimestamp) ?: return null
    return PublicationSnapshot(
        runId = runId,
        state = state,
        runStatus = runStatus,
        stage = stage,
        stateRevision = revision,
        progressPercent = progress,
        lastSuccessfulState = successfulState,
        lastSuccessfulProgressPercent = successfulProgress,
        retryCount = retryCount,
        nextAction = summary.optionalString("next_action"),
        errorCode = null,
        createdAt = createdAt,
        updatedAt = updatedAt,
    )
}

private fun parseFlatPublicationSnapshot(recording: JSONObject): PublicationSnapshot? {
    val runId = recording.strictString("run_id") ?: return null
    val stage = recording.strictString("publication_stage") ?: return null
    val revision = recording.nonNegativeLong("state_revision") ?: return null
    val progress = recording.boundedInt("progress_percent", 0, 100) ?: return null
    val retryCount = recording.boundedInt("retry_count", 0, Int.MAX_VALUE) ?: return null
    val state = recording.optionalString("state")?.takeIf { it in PUBLICATION_STATES } ?: stageToState(stage) ?: return null
    val runStatus = recording.optionalString("run_status")?.takeIf { it in PUBLICATION_RUN_STATUSES } ?: "active"
    val successfulState = recording.optionalString("last_successful_state")?.takeIf { it in PUBLICATION_STATES } ?: state
    val successfulProgress = recording.boundedInt("last_successful_progress_percent", 0, 100) ?: progress
    return PublicationSnapshot(
        runId = runId,
        state = state,
        runStatus = runStatus,
        stage = stage,
        stateRevision = revision,
        progressPercent = progress,
        lastSuccessfulState = successfulState,
        lastSuccessfulProgressPercent = successfulProgress,
        retryCount = retryCount,
        nextAction = recording.optionalString("next_action"),
        errorCode = null,
        createdAt = recording.optionalString("publication_run_created_at")?.takeIf(::isPublicationTimestamp),
        updatedAt = recording.optionalString("publication_updated_at")?.takeIf(::isPublicationTimestamp),
    )
}

private fun stageToState(stage: String): String? = when (stage) {
    "upload" -> "queued"
    "transcription" -> "transcribing"
    "writing" -> "writing"
    "review" -> "reviewing"
    "visual" -> "visual_generating"
    "publishing" -> "draft_syncing"
    "ready" -> "draft_ready"
    "retrying", "action_required", "failed", "cancelled" -> null
    else -> null
}

private fun JSONObject.strictString(key: String): String? {
    if (!has(key)) return null
    return (opt(key) as? String)?.trim()?.takeIf { it.isNotEmpty() }
}

private fun JSONObject.optionalString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return (opt(key) as? String)?.trim()?.takeIf { it.isNotEmpty() }
}

private fun JSONObject.nonNegativeLong(key: String): Long? {
    val raw = opt(key) as? Number ?: return null
    val value = raw.toLong()
    return value.takeIf { value >= 0L && raw.toDouble() == value.toDouble() }
}

private fun JSONObject.boundedInt(key: String, lower: Int, upper: Int): Int? {
    val value = nonNegativeLong(key) ?: return null
    if (value !in lower.toLong()..upper.toLong()) return null
    return value.toInt()
}

internal fun isPublicationTimestamp(value: String): Boolean = publicationTimestampMillis(value) != null

internal fun publicationTimestampMillis(value: String): Long? {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return null
    val patterns = listOf(
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                isLenient = false
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(trimmed)?.time
        }.getOrNull()
    }
}
