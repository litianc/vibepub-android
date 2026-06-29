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
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.asRecordingStatus
import cn.litianc.vibepub.data.displayTitle
import cn.litianc.vibepub.data.durationLabel
import cn.litianc.vibepub.data.statusDetail
import cn.litianc.vibepub.data.statusLabel
import cn.litianc.vibepub.ui.theme.PrimaryRed
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File

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
        val shareText = buildString {
            append(articleTitle)
            append("\n\n")
            append(articleContent)
        }

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
                transcript = transcript,
                onRefresh = onRefresh,
                onRetryUpload = { onRetryUpload(currentRecording) },
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
            ActionRow(
                articleTitle = articleTitle,
                articleContent = articleContent,
                shareText = shareText,
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
    transcript: JSONObject?,
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
            if (status == RecordingStatus.COMPLETED) {
                val draft = transcript?.optString("wechatDraftId", "").orEmpty()
                    .ifBlank { transcript?.optString("mediaId", "").orEmpty() }
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    if (draft.isBlank()) "微信公众号草稿：已由云端处理" else "微信公众号草稿：$draft",
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
private fun ActionRow(
    articleTitle: String,
    articleContent: String,
    shareText: String,
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

internal fun renderArticleText(content: String): String {
    val text = Html.fromHtml(content, Html.FROM_HTML_MODE_LEGACY)
        .toString()
        .lines()
        .joinToString("\n") { it.trim() }
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()
    return text.ifBlank { content }
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
