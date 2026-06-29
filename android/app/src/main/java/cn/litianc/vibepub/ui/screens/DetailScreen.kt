package cn.litianc.vibepub.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.Html
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
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Upload
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
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.RecordingWorkflowStep
import cn.litianc.vibepub.data.WorkflowStepState
import cn.litianc.vibepub.data.asRecordingStatus
import cn.litianc.vibepub.data.currentWorkflowStep
import cn.litianc.vibepub.data.displayLabel
import cn.litianc.vibepub.data.displayTitle
import cn.litianc.vibepub.data.durationLabel
import cn.litianc.vibepub.data.statusDetail
import cn.litianc.vibepub.data.statusLabel
import cn.litianc.vibepub.data.workflowProgressFraction
import cn.litianc.vibepub.data.workflowProgressLabel
import cn.litianc.vibepub.data.workflowSteps
import cn.litianc.vibepub.ui.theme.PrimaryRed
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File
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
    val nextStep: String,
    val items: List<ArticleReviewItem>,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(
    filename: String,
    onBackClick: () -> Unit,
    onRefresh: () -> Unit,
    onRetryUpload: (RecordingEntity) -> Unit,
) {
    val context = LocalContext.current
    val recordingFlow = remember(filename) {
        AppDatabase.getDatabase(context).recordingDao().observeRecordingByFilename(filename)
    }
    val recording by recordingFlow.collectAsState(initial = null)
    var transcript by remember(filename) { mutableStateOf<JSONObject?>(null) }

    LaunchedEffect(filename, recording?.status) {
        transcript = loadLocalTranscript(context, filename)
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

        val transcriptTitle = transcript?.optString("articleTitle", "").orEmpty().trim()
        val articleTitle = transcriptTitle
            .ifBlank { currentRecording.articleTitle.orEmpty() }
            .ifBlank { currentRecording.displayTitle() }
        val rawText = transcript?.optString("rawText", "")?.ifBlank { currentRecording.rawTextPreview.orEmpty() }.orEmpty()
        val articleContent = transcript?.optString("articleContent", "")?.ifBlank { rawText }?.let(::renderArticleText)
            ?: currentRecording.statusDetail()
        val wechatDraftId = transcript?.optString("wechatDraftId", "").orEmpty()
            .ifBlank { transcript?.optString("mediaId", "").orEmpty() }
            .ifBlank { transcript?.optString("wechat_draft_id", "").orEmpty() }
            .ifBlank { currentRecording.wechatDraftId.orEmpty() }
        val wechatUrl = transcript?.optString("wechatUrl", "").orEmpty()
            .ifBlank { transcript?.optString("wechat_url", "").orEmpty() }
            .ifBlank { currentRecording.wechatUrl.orEmpty() }
        val reviewSummary = buildArticleReviewSummary(
            status = currentRecording.status.asRecordingStatus(),
            articleTitle = articleTitle,
            articleContent = articleContent,
            rawText = rawText,
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
            wechatDraftId = wechatDraftId,
            wechatUrl = wechatUrl,
            filename = currentRecording.filename,
            createdAtMs = currentRecording.timestamp,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            AudioPlayerCard(recording = currentRecording)
            Spacer(modifier = Modifier.height(18.dp))
            StatusCard(
                recording = currentRecording,
                onRefresh = onRefresh,
                onRetryUpload = { onRetryUpload(currentRecording) },
            )
            Spacer(modifier = Modifier.height(16.dp))
            ProductionFlowCard(recording = currentRecording)
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
internal fun ProductionFlowCard(recording: RecordingEntity) {
    val currentStep = recording.currentWorkflowStep()

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("ProductionFlowCard"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.TaskAlt,
                    contentDescription = null,
                    tint = PrimaryRed,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text("生产流程", fontWeight = FontWeight.SemiBold)
                    Text(
                        "当前：${currentStep.number}. ${currentStep.title} · ${currentStep.state.displayLabel()}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    recording.workflowProgressLabel(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            recording.workflowSteps().forEach { step ->
                ProductionFlowStepRow(step = step)
            }
        }
    }
}

@Composable
private fun ProductionFlowStepRow(step: RecordingWorkflowStep) {
    val color = workflowStepColor(step.state)

    Row(
        modifier = Modifier.testTag("ProductionFlowStep-${step.number}"),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 2.dp)
                .size(24.dp)
                .clip(CircleShape)
                .background(color),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = step.number.toString(),
                color = Color.White,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "${step.title} · ${step.state.displayLabel()}",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                step.detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
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
    val durationMs = recording.durationMs.coerceAtLeast(0L)

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    LaunchedEffect(player, isPlaying) {
        while (true) {
            isPlaying = player.isPlaying
            positionMs = player.currentPosition.coerceAtLeast(0L)
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
                    } else {
                        player.play()
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
private fun StatusCard(
    recording: RecordingEntity,
    onRefresh: () -> Unit,
    onRetryUpload: () -> Unit,
) {
    val status = recording.status.asRecordingStatus()
    var showWorkflowHelp by remember { mutableStateOf(false) }

    if (showWorkflowHelp) {
        WorkflowHelpDialog(
            recording = recording,
            onDismiss = { showWorkflowHelp = false },
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
            if (recording.remoteStatusUpdatedAt?.isNotBlank() == true) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    "云端更新时间: ${recording.remoteStatusUpdatedAt}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(modifier = Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRefresh) {
                    Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("刷新")
                }
                if (status == RecordingStatus.FAILED || status == RecordingStatus.LOCAL_RECORDED) {
                    Button(onClick = onRetryUpload) {
                        Icon(Icons.Default.Upload, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("重试上传")
                    }
                }
            }
        }
    }
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
) {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
}

private fun shareArticle(context: Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, "分享文章"))
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
    context.startActivity(Intent.createChooser(intent, "导出文章材料包"))
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

internal fun buildArticleExportText(
    articleTitle: String,
    articleContent: String,
    rawText: String,
    statusLabel: String,
    wechatDraftId: String,
    wechatUrl: String,
    filename: String,
    createdAtMs: Long,
): String {
    val createdAt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(createdAtMs))
    return buildString {
        appendLine("# $articleTitle")
        appendLine()
        appendLine("## 发布状态")
        appendLine("- 处理状态：$statusLabel")
        appendLine("- 公众号草稿：${wechatDraftId.ifBlank { "未同步草稿 ID" }}")
        appendLine("- 草稿链接：${wechatUrl.ifBlank { "未同步草稿链接" }}")
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

internal fun buildArticleReviewSummary(
    status: RecordingStatus,
    articleTitle: String,
    articleContent: String,
    rawText: String,
    wechatDraftId: String,
    wechatUrl: String,
): ArticleReviewSummary {
    val hasTitle = articleTitle.isNotBlank() && !articleTitle.contains("录音片段")
    val contentChars = articleContent.trim().length
    val hasArticle = status == RecordingStatus.COMPLETED && contentChars >= 80
    val hasRawText = rawText.isNotBlank()
    val draftReference = wechatDraftId.ifBlank { wechatUrl }
    val hasDraft = status == RecordingStatus.COMPLETED && draftReference.isNotBlank()

    val nextStep = when {
        status != RecordingStatus.COMPLETED -> "文章还在生成中，完成后这里会变成发布前检查清单。"
        hasDraft -> "草稿已创建。下一步到公众号后台打开草稿，再做最后一眼人工确认。"
        hasArticle -> "文章已生成，但还没拿到公众号草稿信息。可以先复制正文，或刷新等待草稿状态。"
        else -> "流程显示完成，但正文还不完整。请刷新同步，或检查诊断信息后重试。"
    }

    return ArticleReviewSummary(
        title = "公众号草稿审核",
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
                value = if (hasDraft) draftReference else "等待云端创建草稿或返回草稿信息",
                ready = hasDraft,
            ),
        ),
    )
}

private fun loadLocalTranscript(context: Context, filename: String): JSONObject? {
    val jsonFile = File(context.filesDir, "recordings/${filename.replace(".m4a", ".json")}")
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

private fun workflowStepColor(state: WorkflowStepState): Color {
    return when (state) {
        WorkflowStepState.DONE -> Color(0xFF2E7D32)
        WorkflowStepState.CURRENT -> Color(0xFFF9A825)
        WorkflowStepState.BLOCKED -> Color(0xFFC62828)
        WorkflowStepState.PENDING -> Color(0xFF9E9E9E)
    }
}
