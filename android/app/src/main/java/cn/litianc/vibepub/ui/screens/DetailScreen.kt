package cn.litianc.vibepub.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.Html
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.core.content.FileProvider
import cn.litianc.vibepub.BuildConfig
import cn.litianc.vibepub.transcriptFileNameForRecording
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingRecoveryActionType
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.asRecordingStatus
import cn.litianc.vibepub.data.displayTitle
import cn.litianc.vibepub.data.durationLabel
import cn.litianc.vibepub.data.hasDraftFailureMessage
import cn.litianc.vibepub.data.primaryRecoveryAction
import cn.litianc.vibepub.data.statusDetail
import cn.litianc.vibepub.data.statusLabel
import cn.litianc.vibepub.data.sanitizedRemoteReference
import cn.litianc.vibepub.data.wechatDraftReferenceOrNull
import cn.litianc.vibepub.data.workflowCycleLabel
import cn.litianc.vibepub.data.workflowCurrentNodeLabel
import cn.litianc.vibepub.data.workflowAttention
import cn.litianc.vibepub.data.workflowFreshnessLabel
import cn.litianc.vibepub.data.workflowNextActionLabel
import cn.litianc.vibepub.data.workflowProgressFraction
import cn.litianc.vibepub.data.workflowProgressLabel
import cn.litianc.vibepub.ui.theme.PrimaryRed
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal data class ArticleReviewItem(
    val label: String,
    val value: String,
    val ready: Boolean,
)

internal data class ArticleReviewSummary(
    val title: String,
    val stageLabel: String,
    val nextStep: String,
    val items: List<ArticleReviewItem>,
)

internal data class WeChatDraftAction(
    val label: String,
    val enabled: Boolean,
    val url: String,
    val helperText: String,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(
    filename: String,
    lastSyncAtMs: Long,
    onBackClick: () -> Unit,
    onRefresh: () -> Unit,
    onAutoRefresh: () -> Unit,
    onRetryUpload: (RecordingEntity) -> Unit,
    onDeleteRecording: (RecordingEntity) -> Unit,
) {
    val context = LocalContext.current
    val recordingFlow = remember(filename) {
        AppDatabase.getDatabase(context).recordingDao().observeRecordingByFilename(filename)
    }
    val recording by recordingFlow.collectAsState(initial = null)
    var transcript by remember(filename) { mutableStateOf<JSONObject?>(null) }
    var lastAutoRefreshRequestAtMs by remember(filename) { mutableStateOf(0L) }

    LaunchedEffect(
        filename,
        recording?.status,
        recording?.articleTitle,
        recording?.rawTextPreview,
        recording?.wechatDraftId,
        recording?.wechatUrl,
        recording?.remoteStatusUpdatedAt,
        recording?.processingStage,
    ) {
        transcript = loadLocalTranscript(context, filename)
    }

    LaunchedEffect(recording, lastSyncAtMs) {
        while (recordingHasActiveCloudWork(recording)) {
            val nowMs = System.currentTimeMillis()
            if (shouldAutoRefreshActiveRecording(
                    recording = recording,
                    lastSyncAtMs = lastSyncAtMs,
                    lastAutoRefreshRequestAtMs = lastAutoRefreshRequestAtMs,
                    nowMs = nowMs,
                )
            ) {
                lastAutoRefreshRequestAtMs = nowMs
                onAutoRefresh()
            }
            delay(ACTIVE_RECORDING_AUTO_REFRESH_INTERVAL_MS)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("录音详情", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBackClick) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(
                        onClick = onRefresh,
                        modifier = Modifier.testTag("DetailRefreshButton"),
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        val currentRecording = recording
        if (currentRecording == null) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text("这条录音不在本机")
            }
            return@Scaffold
        }

        val transcriptTitle = transcript.optTranscriptString("articleTitle", "article_title")
        val articleTitle = transcriptTitle
            .ifBlank { currentRecording.articleTitle.orEmpty() }
            .ifBlank { currentRecording.displayTitle() }
        val rawText = transcript.optTranscriptString("rawText", "raw_text")
            .ifBlank { currentRecording.rawTextPreview.orEmpty() }
        val generatedArticleContent = transcript.optTranscriptString("articleContent", "article_content")
        val articleContentSource = generatedArticleContent.ifBlank { rawText }
        val articleContent = articleContentSource
            .takeIf { it.isNotBlank() }
            ?.let(::renderArticleText)
            ?: currentRecording.statusDetail()
        val articleContentIsGenerated = generatedArticleContent.isNotBlank()
        val transcriptProcessingStage = transcript.optTranscriptString("processingStage", "processing_stage")
        val effectiveProcessingStage = chooseEffectiveProcessingStage(
            transcriptProcessingStage = transcriptProcessingStage,
            recordingProcessingStage = currentRecording.processingStage.orEmpty(),
        )
        val wechatDraftId = transcript.optTranscriptString("wechatDraftId", "mediaId", "wechat_draft_id")
            .ifBlank { sanitizedRemoteReference(currentRecording.wechatDraftId).orEmpty() }
        val wechatUrl = transcript.optTranscriptString("wechatUrl", "wechat_url")
            .ifBlank { sanitizedRemoteReference(currentRecording.wechatUrl).orEmpty() }
        val transcriptError = transcript.optTranscriptString("errorMessage", "error_message")
        val draftError = when {
            currentRecording.hasDraftFailureMessage() -> currentRecording.lastError.orEmpty()
                .ifBlank { transcriptError }
                .ifBlank { currentRecording.statusDetail() }
            normalizeProcessingStage(effectiveProcessingStage) in DRAFT_FAILED_STAGES -> transcriptError
                .ifBlank { currentRecording.lastError.orEmpty() }
            else -> ""
        }
        val reviewSummary = buildArticleReviewSummary(
            status = currentRecording.status.asRecordingStatus(),
            articleTitle = articleTitle,
            articleContent = articleContent,
            articleContentIsGenerated = articleContentIsGenerated,
            rawText = rawText,
            wechatDraftId = wechatDraftId,
            wechatUrl = wechatUrl,
            draftError = draftError,
            processingStage = effectiveProcessingStage,
        )
        val draftAction = buildWeChatDraftAction(
            wechatDraftId = wechatDraftId,
            wechatUrl = wechatUrl,
        )
        val shareText = buildString {
            append(articleTitle)
            append("\n\n")
            append(articleContent)
        }
        val exportText = buildArticleExportText(
            articleTitle = articleTitle,
            articleContent = articleContent,
            rawText = rawText,
            statusLabel = currentRecording.statusLabel(),
            statusDetail = currentRecording.statusDetail(),
            nextAction = currentRecording.workflowNextActionLabel(),
            workflowNode = currentRecording.workflowCurrentNodeLabel(),
            workflowCycle = currentRecording.workflowCycleLabel(),
            wechatDraftId = wechatDraftId,
            wechatUrl = wechatUrl,
            filename = currentRecording.filename,
            createdAtMs = currentRecording.timestamp,
        )
        val scrollState = rememberScrollState()

        LaunchedEffect(filename) {
            scrollState.scrollTo(0)
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(scrollState)
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            AudioPlayerCard(recording = currentRecording)
            Spacer(modifier = Modifier.height(18.dp))
            StatusCard(
                recording = currentRecording,
                lastSyncAtMs = lastSyncAtMs,
                onRefresh = onRefresh,
                onRetryUpload = { onRetryUpload(currentRecording) },
                onDeleteRecording = {
                    onDeleteRecording(currentRecording)
                    onBackClick()
                },
            )
            Spacer(modifier = Modifier.height(22.dp))

            Text(
                text = articleTitle,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
                lineHeight = 32.sp,
            )

            if (rawText.isNotBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "原始识别结果: ${rawText.take(80)}${if (rawText.length > 80) "..." else ""}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(modifier = Modifier.height(16.dp))
            ArticleReviewCard(summary = reviewSummary)
            Spacer(modifier = Modifier.height(16.dp))
            ActionRow(
                articleTitle = articleTitle,
                articleContent = articleContent,
                shareText = shareText,
                exportText = exportText,
                exportFileName = exportFileName(articleTitle, currentRecording.filename),
                draftAction = draftAction,
            )
            Spacer(modifier = Modifier.height(20.dp))

            Text(
                text = articleContent,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                lineHeight = 28.sp,
            )
            Spacer(modifier = Modifier.height(40.dp))
        }
    }
}

@Composable
private fun AudioPlayerCard(recording: RecordingEntity) {
    val context = LocalContext.current
    val audioFile = remember(recording.localAudioPath, recording.filename) {
        val fromPath = recording.localAudioPath?.let(::File)
        when {
            fromPath != null && fromPath.exists() -> fromPath
            else -> File(context.filesDir, "recordings/${recording.filename}")
        }
    }
    val player = remember(audioFile.absolutePath) {
        ExoPlayer.Builder(context).build().apply {
            if (audioFile.exists()) {
                setMediaItem(MediaItem.fromUri(Uri.fromFile(audioFile)))
                prepare()
            }
        }
    }
    var isPlaying by remember { mutableStateOf(false) }
    var positionMs by remember { mutableLongStateOf(0L) }
    var playbackProgressRecorded by remember(audioFile.absolutePath) { mutableStateOf(false) }
    val durationMs = recording.durationMs.coerceAtLeast(0L)

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    LaunchedEffect(player, isPlaying) {
        while (true) {
            isPlaying = player.isPlaying
            positionMs = player.currentPosition.coerceAtLeast(0L)
            if (!playbackProgressRecorded && player.isPlaying && positionMs > 0L) {
                recordDebugDetailEvidence(context, "playbackProgress") {
                    put("positionMs", positionMs)
                    put("durationMs", durationMs)
                    put("filename", recording.filename)
                }
                playbackProgressRecorded = true
            }
            delay(300)
        }
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = {
                    if (!audioFile.exists()) return@IconButton
                    if (player.isPlaying) {
                        player.pause()
                        recordDebugDetailEvidence(context, "playbackToggle") {
                            put("action", "pause")
                            put("audioExists", audioFile.exists())
                            put("filename", recording.filename)
                        }
                    } else {
                        player.play()
                        recordDebugDetailEvidence(context, "playbackToggle") {
                            put("action", "play")
                            put("audioExists", audioFile.exists())
                            put("filename", recording.filename)
                            put("durationMs", durationMs)
                        }
                    }
                    isPlaying = player.isPlaying
                },
                modifier = Modifier
                    .size(52.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (audioFile.exists()) PrimaryRed else Color.Gray)
                    .testTag("PlayRecordingButton"),
            ) {
                Icon(
                    if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                    contentDescription = "Play",
                    tint = Color.White,
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Slider(
                    value = if (durationMs > 0) positionMs.coerceAtMost(durationMs).toFloat() else 0f,
                    onValueChange = { value ->
                        player.seekTo(value.toLong())
                        positionMs = value.toLong()
                    },
                    valueRange = 0f..durationMs.coerceAtLeast(1L).toFloat(),
                    enabled = audioFile.exists() && durationMs > 0,
                    modifier = Modifier.testTag("PlaybackSlider"),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(formatDurationLabel(positionMs), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(recording.durationLabel(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
internal fun StatusCard(
    recording: RecordingEntity,
    lastSyncAtMs: Long,
    onRefresh: () -> Unit,
    onRetryUpload: () -> Unit,
    onDeleteRecording: () -> Unit,
) {
    val status = recording.status.asRecordingStatus()
    val recoveryAction = recording.primaryRecoveryAction()
    val attention = recording.workflowAttention()
    var showWorkflowHelp by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    if (showWorkflowHelp) {
        WorkflowHelpDialog(
            recording = recording,
            onDismiss = { showWorkflowHelp = false },
        )
    }
    if (showDeleteConfirm) {
        DetailDeleteRecordingDialog(
            recording = recording,
            onDismiss = { showDeleteConfirm = false },
            onConfirm = {
                showDeleteConfirm = false
                onDeleteRecording()
            },
        )
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(9.dp)
                        .clip(CircleShape)
                        .background(statusColor(status)),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(recording.statusLabel(), fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    recording.workflowProgressLabel(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                IconButton(
                    onClick = { showWorkflowHelp = true },
                    modifier = Modifier
                        .size(32.dp)
                        .testTag("DetailWorkflowHelpButton"),
                ) {
                    Icon(
                        Icons.Default.Info,
                        contentDescription = "查看处理进度说明",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            LinearProgressIndicator(
                progress = { recording.workflowProgressFraction() },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp),
                color = statusColor(status),
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                recording.statusDetail(),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                recording.workflowNextActionLabel(),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.Medium,
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                recording.workflowFreshnessLabel(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (attention != null) {
                Spacer(modifier = Modifier.height(8.dp))
                WorkflowAttentionCallout(attention = attention)
            }
            if (recording.remoteStatusUpdatedAt?.isNotBlank() == true) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    "云端更新时间: ${recording.remoteStatusUpdatedAt}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                lastSyncLabel(lastSyncAtMs),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(10.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("刷新")
                    }
                    if (recoveryAction != null) {
                        Button(
                            onClick = {
                                when (recoveryAction.type) {
                                    RecordingRecoveryActionType.RETRY_UPLOAD -> onRetryUpload()
                                    RecordingRecoveryActionType.REFRESH_SYNC -> onRefresh()
                                }
                            },
                            modifier = Modifier.testTag("DetailRecoveryButton"),
                        ) {
                            Icon(
                                imageVector = when (recoveryAction.type) {
                                    RecordingRecoveryActionType.RETRY_UPLOAD -> Icons.Default.Upload
                                    RecordingRecoveryActionType.REFRESH_SYNC -> Icons.Default.Refresh
                                },
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(recoveryAction.label)
                        }
                    }
                }
                OutlinedButton(
                    onClick = { showDeleteConfirm = true },
                    modifier = Modifier.testTag("DetailDeleteRecordingButton"),
                ) {
                    Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("删除这条记录")
                }
            }
        }
    }
}

@Composable
private fun DetailDeleteRecordingDialog(
    recording: RecordingEntity,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        modifier = Modifier.testTag("DetailDeleteRecordingDialog"),
        onDismissRequest = onDismiss,
        title = { Text("删除这条录音？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "将从本机移除录音、音频和结果文件，并尝试删除云端历史记录。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    recording.displayTitle(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.testTag("ConfirmDetailDeleteRecordingButton"),
            ) {
                Text("删除", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.testTag("CancelDetailDeleteRecordingButton"),
            ) {
                Text("取消")
            }
        },
    )
}

@Composable
private fun ArticleReviewCard(summary: ArticleReviewSummary) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("ArticleReviewCard"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.TaskAlt,
                    contentDescription = null,
                    tint = PrimaryRed,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(summary.title, fontWeight = FontWeight.SemiBold)
            }
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .testTag("ArticleReviewStageLabel"),
            ) {
                Text(
                    text = summary.stageLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = FontWeight.Medium,
                )
            }
            Text(
                summary.nextStep,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            summary.items.forEach { item ->
                ArticleReviewItemRow(item = item)
            }
        }
    }
}

@Composable
private fun ArticleReviewItemRow(item: ArticleReviewItem) {
    val color = if (item.ready) Color(0xFF2E7D32) else Color(0xFFF9A825)
    Row(verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier
                .padding(top = 4.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(color),
        )
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Text(
                item.value,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ActionRow(
    articleTitle: String,
    articleContent: String,
    shareText: String,
    exportText: String,
    exportFileName: String,
    draftAction: WeChatDraftAction?,
) {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (draftAction != null) {
            Button(
                onClick = { openWechatDraft(context, draftAction.url) },
                enabled = draftAction.enabled,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("OpenWechatDraftButton"),
            ) {
                Icon(Icons.Default.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text(draftAction.label)
            }
            Text(
                draftAction.helperText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        OutlinedButton(
            onClick = { copyToClipboard(context, "VibePub 标题", articleTitle) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag("CopyTitleButton"),
        ) {
            Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(6.dp))
            Text("复制标题")
        }
        OutlinedButton(
            onClick = { copyToClipboard(context, "VibePub 正文", articleContent) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag("CopyArticleButton"),
        ) {
            Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(6.dp))
            Text("复制正文")
        }
        OutlinedButton(
            onClick = { shareArticle(context, shareText) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag("ShareArticleButton"),
        ) {
            Icon(Icons.Default.Share, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(6.dp))
            Text("分享")
        }
        OutlinedButton(
            onClick = { shareArticleExport(context, exportFileName, exportText) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag("ExportArticlePackageButton"),
        ) {
            Icon(Icons.Default.Description, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(6.dp))
            Text("导出材料包")
        }
    }
}

private fun copyToClipboard(context: Context, label: String, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
    val copiedText = clipboard.primaryClip
        ?.takeIf { it.itemCount > 0 }
        ?.getItemAt(0)
        ?.coerceToText(context)
        ?.toString()
        .orEmpty()
    recordDebugDetailEvidence(context, "clipboard") {
        put("label", label)
        put("textLength", text.length)
        put("textSha256", text.sha256())
        put("clipboardMatches", copiedText == text)
    }
}

private fun shareArticle(context: Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, "分享文章"))
    }.onSuccess {
        recordDebugDetailEvidence(context, "shareArticle") {
            put("sent", true)
            put("textLength", text.length)
            put("textSha256", text.sha256())
        }
    }.onFailure { error ->
        recordDebugDetailEvidence(context, "shareArticle") {
            put("sent", false)
            put("error", error.message.orEmpty())
        }
        Toast.makeText(context, "无法打开分享面板", Toast.LENGTH_SHORT).show()
    }
}

private fun openWechatDraft(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }.onSuccess {
        recordDebugDetailEvidence(context, "openWechatDraft") {
            put("sent", true)
            put("url", url)
        }
    }.onFailure { error ->
        recordDebugDetailEvidence(context, "openWechatDraft") {
            put("sent", false)
            put("url", url)
            put("error", error.message.orEmpty())
        }
        Toast.makeText(context, "无法打开草稿链接", Toast.LENGTH_SHORT).show()
    }
}

private fun shareArticleExport(context: Context, fileName: String, text: String) {
    val exportDir = File(context.cacheDir, "article_exports").apply { mkdirs() }
    val exportFile = File(exportDir, fileName)
    exportFile.writeText(text)
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", exportFile)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, fileName.removeSuffix(".txt"))
        putExtra(Intent.EXTRA_TEXT, "VibePub 文章材料包：${fileName.removeSuffix(".txt")}")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newUri(context.contentResolver, fileName, uri)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, "导出文章材料包"))
    }.onSuccess {
        recordDebugDetailEvidence(context, "exportArticle") {
            put("sent", true)
            put("fileName", fileName)
            put("fileExists", exportFile.exists())
            put("textLength", text.length)
            put("textSha256", text.sha256())
        }
    }.onFailure { error ->
        recordDebugDetailEvidence(context, "exportArticle") {
            put("sent", false)
            put("fileName", fileName)
            put("error", error.message.orEmpty())
        }
        Toast.makeText(context, "无法导出材料包", Toast.LENGTH_SHORT).show()
    }
}

private fun recordDebugDetailEvidence(
    context: Context,
    key: String,
    block: JSONObject.() -> Unit,
) {
    if (!BuildConfig.DEBUG) return

    runCatching {
        val file = File(context.filesDir, "debug-detail-actions.json")
        val root = if (file.exists()) {
            JSONObject(file.readText())
        } else {
            JSONObject()
        }
        val entry = JSONObject()
            .put("timestampMs", System.currentTimeMillis())
            .apply(block)
        root.put(key, entry)
        root.put("updatedAtMs", System.currentTimeMillis())
        file.writeText(root.toString(2))
    }
}

private fun String.sha256(): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(toByteArray())
    return digest.joinToString("") { "%02x".format(it) }
}

internal fun renderArticleText(content: String): String {
    val text = Html.fromHtml(content, Html.FROM_HTML_MODE_LEGACY)
        .toString()
        .lines()
        .joinToString("\n") { it.trim() }
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()
    return text.ifBlank { content }
}

internal fun JSONObject?.optTranscriptString(vararg keys: String): String {
    if (this == null) return ""
    return keys.firstNotNullOfOrNull { key ->
        optString(key, "").trim().blankToMissingString()
    }.orEmpty()
}

private fun String.blankToMissingString(): String? {
    return sanitizedRemoteReference(this)
}

internal fun buildArticleExportText(
    articleTitle: String,
    articleContent: String,
    rawText: String,
    statusLabel: String,
    statusDetail: String,
    nextAction: String,
    workflowNode: String,
    workflowCycle: String,
    wechatDraftId: String,
    wechatUrl: String,
    filename: String,
    createdAtMs: Long,
): String {
    val createdAt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(createdAtMs))
    val draftId = sanitizedRemoteReference(wechatDraftId).orEmpty()
    val draftUrl = sanitizedRemoteReference(wechatUrl).orEmpty()
    return buildString {
        appendLine("# $articleTitle")
        appendLine()
        appendLine("## 发布状态")
        appendLine("- 处理状态：$statusLabel")
        appendLine("- 状态说明：$statusDetail")
        appendLine("- $nextAction")
        appendLine("- $workflowNode")
        appendLine("- 完整流程：$workflowCycle")
        appendLine("- 公众号草稿：${draftId.ifBlank { "未同步草稿 ID" }}")
        appendLine("- 草稿链接：${draftUrl.ifBlank { "未同步草稿链接" }}")
        appendLine("- 原始文件：$filename")
        appendLine("- 创建时间：$createdAt")
        appendLine()
        appendLine("## 正文")
        appendLine(articleContent.ifBlank { "正文暂未生成" })
        appendLine()
        appendLine("## 原始识别")
        appendLine(rawText.ifBlank { "原始识别暂未同步" })
    }.trimEnd()
}

internal fun exportFileName(articleTitle: String, filename: String): String {
    val base = articleTitle
        .ifBlank { filename }
        .replace(Regex("[\\\\/:*?\"<>|\\n\\r\\t]+"), "-")
        .replace(Regex("\\s+"), " ")
        .trim()
        .ifBlank { "VibePub-article" }
        .take(48)
        .trim()
    return "$base.txt"
}

private val ARTICLE_READY_STAGES = setOf(
    "ARTICLE_READY",
    "WECHAT",
    "DRAFT",
    "DRAFTING",
    "CREATING_DRAFT",
    "PUBLISHING_DRAFT",
    "COMPLETED",
    "DONE",
)

private val DRAFT_FAILED_STAGES = setOf(
    "DRAFT_FAILED",
    "WECHAT_FAILED",
)

internal fun chooseEffectiveProcessingStage(
    transcriptProcessingStage: String,
    recordingProcessingStage: String,
): String {
    val transcriptStage = normalizeProcessingStage(transcriptProcessingStage)
    val recordingStage = normalizeProcessingStage(recordingProcessingStage)
    return when {
        transcriptStage.isBlank() -> recordingStage
        recordingStage.isBlank() -> transcriptStage
        processingStageRank(recordingStage) >= processingStageRank(transcriptStage) -> recordingStage
        else -> transcriptStage
    }
}

private fun normalizeProcessingStage(stage: String): String {
    return stage
        .trim()
        .uppercase(Locale.ROOT)
        .replace("-", "_")
        .replace(" ", "_")
}

private fun processingStageRank(stage: String): Int {
    return when (stage) {
        "UPLOADED", "QUEUED", "PENDING" -> 1
        "ASR", "TRANSCRIBING", "TRANSCRIPTION", "TRANSCRIBE" -> 2
        "ARTICLE", "REWRITE", "REWRITING", "LLM", "GENERATING_ARTICLE" -> 3
        "ARTICLE_READY", "ARTICLE_DONE", "READY_FOR_DRAFT" -> 4
        "WECHAT", "DRAFT", "DRAFTING", "CREATING_DRAFT", "PUBLISHING_DRAFT" -> 5
        "FAILED", "ERROR" -> 5
        "DRAFT_FAILED", "WECHAT_FAILED", "COMPLETED", "DONE" -> 6
        else -> 0
    }
}

internal fun buildArticleReviewSummary(
    status: RecordingStatus,
    articleTitle: String,
    articleContent: String,
    articleContentIsGenerated: Boolean = status == RecordingStatus.COMPLETED,
    rawText: String,
    wechatDraftId: String,
    wechatUrl: String,
    draftError: String = "",
    processingStage: String = "",
): ArticleReviewSummary {
    val hasTitle = articleTitle.isNotBlank() && !articleTitle.contains("录音片段")
    val contentChars = articleContent.trim().length
    val stage = normalizeProcessingStage(processingStage)
    val stageHasArticle = stage in ARTICLE_READY_STAGES
    val stageDraftFailed = stage in DRAFT_FAILED_STAGES
    val hasArticle = (status == RecordingStatus.COMPLETED || stageHasArticle || stageDraftFailed) &&
        articleContentIsGenerated &&
        contentChars >= 80
    val hasRawText = rawText.isNotBlank()
    val draftReference = wechatDraftReferenceOrNull(wechatDraftId, wechatUrl).orEmpty()
    val hasDraft = draftReference.isNotBlank()
    val draftFailed = (status == RecordingStatus.COMPLETED || stageDraftFailed) &&
        (draftError.isNotBlank() || stageDraftFailed)
    val stageLabel = when {
        hasDraft -> "草稿已就绪"
        draftFailed && hasArticle -> "文章可用 · 草稿需处理"
        hasArticle -> "文章可用 · 草稿待同步"
        status != RecordingStatus.COMPLETED -> "生成中 · 未到发布检查"
        else -> "结果不完整 · 建议刷新"
    }

    val nextStep = when {
        hasDraft -> "草稿已创建。下一步到公众号后台打开草稿，再做最后一眼人工确认。"
        draftFailed && hasArticle -> "文章已生成，但公众号草稿创建失败。可以先复制正文，稍后再重试草稿。"
        hasArticle -> "文章已生成，但还没拿到公众号草稿信息。可以先复制正文，或刷新等待草稿状态。"
        status != RecordingStatus.COMPLETED -> "文章还在生成中，完成后这里会变成发布前检查清单。"
        else -> "流程显示完成，但正文还不完整。请刷新同步，或检查诊断信息后重试。"
    }

    return ArticleReviewSummary(
        title = "公众号草稿审核",
        stageLabel = stageLabel,
        nextStep = nextStep,
        items = listOf(
            ArticleReviewItem(
                label = "标题",
                value = if (hasTitle) articleTitle else "等待云端生成更合适的标题",
                ready = hasTitle,
            ),
            ArticleReviewItem(
                label = "正文",
                value = if (hasArticle) "约 $contentChars 字，可复制或分享" else "正文还未完整生成",
                ready = hasArticle,
            ),
            ArticleReviewItem(
                label = "原始识别",
                value = if (hasRawText) "已保留，可用于核对口述原意" else "暂未同步到原始识别结果",
                ready = hasRawText,
            ),
            ArticleReviewItem(
                label = "公众号草稿",
                value = when {
                    hasDraft -> draftReference
                    draftFailed -> draftError
                        .ifBlank { "公众号草稿创建失败。文章已可复制，稍后可重试草稿。" }
                    else -> "等待云端创建草稿或返回草稿信息"
                },
                ready = hasDraft,
            ),
        ),
    )
}

internal fun buildWeChatDraftAction(
    wechatDraftId: String,
    wechatUrl: String,
): WeChatDraftAction? {
    val draftUrl = wechatUrl.trim().blankToMissingString().orEmpty()
    val draftId = wechatDraftId.trim().blankToMissingString().orEmpty()

    return when {
        draftUrl.isNotBlank() -> WeChatDraftAction(
            label = "打开公众号草稿",
            enabled = true,
            url = draftUrl,
            helperText = "打开后到公众号后台做最后一眼人工确认。",
        )
        draftId.isNotBlank() -> WeChatDraftAction(
            label = "草稿 ID 已同步",
            enabled = false,
            url = "",
            helperText = "草稿 ID：$draftId。当前没有可打开链接，可先复制正文或到公众号后台查看。",
        )
        else -> null
    }
}

private fun loadLocalTranscript(context: Context, filename: String): JSONObject? {
    val jsonFile = File(context.filesDir, "recordings/${transcriptFileNameForRecording(filename)}")
    return runCatching {
        if (jsonFile.exists()) JSONObject(jsonFile.readText()) else null
    }.getOrNull()
}

private fun formatDurationLabel(durationMs: Long): String {
    val totalSeconds = (durationMs / 1000).coerceAtLeast(0)
    return "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
}

private fun statusColor(status: RecordingStatus): Color {
    return when (status) {
        RecordingStatus.COMPLETED -> Color(0xFF2E7D32)
        RecordingStatus.FAILED -> Color(0xFFC62828)
        RecordingStatus.UPLOADING, RecordingStatus.UPLOADED, RecordingStatus.PROCESSING -> Color(0xFFF9A825)
        RecordingStatus.LOCAL_RECORDED -> Color(0xFF607D8B)
    }
}
