package cn.litianc.vibepub.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SyncProblem
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingWorkflowStep
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.data.WorkflowStepState
import cn.litianc.vibepub.data.asRecordingStatus
import cn.litianc.vibepub.data.canRetryUpload
import cn.litianc.vibepub.data.currentWorkflowStep
import cn.litianc.vibepub.data.displayLabel
import cn.litianc.vibepub.data.displayTitle
import cn.litianc.vibepub.data.hasDraftFailureMessage
import cn.litianc.vibepub.data.listDurationLabel
import cn.litianc.vibepub.data.statusDetail
import cn.litianc.vibepub.data.statusLabel
import cn.litianc.vibepub.data.workflowCycleLabel
import cn.litianc.vibepub.data.workflowCurrentNodeLabel
import cn.litianc.vibepub.data.workflowFreshnessLabel
import cn.litianc.vibepub.data.workflowHelpSummary
import cn.litianc.vibepub.data.workflowHelpTitle
import cn.litianc.vibepub.data.workflowNextActionLabel
import cn.litianc.vibepub.data.workflowProgressFraction
import cn.litianc.vibepub.data.workflowProgressLabel
import cn.litianc.vibepub.data.workflowSteps
import cn.litianc.vibepub.ui.theme.IconLightRedBackground
import cn.litianc.vibepub.ui.theme.PrimaryRed
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal data class HomeSyncNotice(
    val message: String,
)

private const val HOME_REFRESH_FINISH_DELAY_MS = 450L
private const val HOME_REFRESH_TIMEOUT_MS = 3_500L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    recordingsFlow: Flow<List<RecordingEntity>>,
    lastSyncAtMs: Long,
    onSettingsClick: () -> Unit,
    onRefresh: () -> Unit,
    onAutoRefresh: () -> Unit,
    onRetryUpload: (RecordingEntity) -> Unit,
    onDeleteRecording: (RecordingEntity) -> Unit,
    onRecordClick: () -> Unit,
    onRecordingClick: (RecordingEntity) -> Unit,
) {
    val recordings by recordingsFlow.collectAsState(initial = emptyList())
    val syncNotice = homeSyncNotice(recordings, lastSyncAtMs)
    val focusRecording = homeFocusRecording(recordings)
    var isRefreshing by remember { mutableStateOf(false) }
    var refreshStartedSyncAtMs by remember { mutableStateOf<Long?>(null) }
    var lastAutoRefreshRequestAtMs by remember { mutableStateOf(0L) }

    fun requestRefresh() {
        refreshStartedSyncAtMs = lastSyncAtMs
        isRefreshing = true
        onRefresh()
    }

    LaunchedEffect(isRefreshing, lastSyncAtMs, refreshStartedSyncAtMs) {
        if (!isRefreshing) return@LaunchedEffect
        val startedAt = refreshStartedSyncAtMs
        if (shouldFinishHomeRefresh(startedAt, lastSyncAtMs)) {
            delay(HOME_REFRESH_FINISH_DELAY_MS)
            isRefreshing = false
        } else {
            delay(HOME_REFRESH_TIMEOUT_MS)
            isRefreshing = false
        }
    }

    LaunchedEffect(recordings, lastSyncAtMs) {
        while (recordingsHaveActiveCloudWork(recordings)) {
            val nowMs = System.currentTimeMillis()
            if (shouldAutoRefreshActiveRecordings(
                    recordings = recordings,
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
                title = {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            VibeMark()
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "VibePub",
                                fontWeight = FontWeight.Bold,
                                fontSize = 20.sp,
                            )
                        }
                        Text(
                            text = "口述、成文、发布草稿",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { requestRefresh() }, modifier = Modifier.testTag("RefreshButton")) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = onSettingsClick, modifier = Modifier.testTag("SettingsButton")) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onRecordClick,
                containerColor = PrimaryRed,
                contentColor = Color.White,
                shape = CircleShape,
                modifier = Modifier
                    .size(72.dp)
                    .testTag("RecordButton"),
            ) {
                Icon(Icons.Default.Mic, contentDescription = "Record", modifier = Modifier.size(32.dp))
            }
        },
        floatingActionButtonPosition = androidx.compose.material3.FabPosition.Center,
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = isRefreshing,
            onRefresh = { requestRefresh() },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Text("我的录音", fontWeight = FontWeight.Bold)
                        Text(
                            "${recordings.size} 条 · ${lastSyncLabel(lastSyncAtMs)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    OutlinedButton(onClick = { requestRefresh() }) {
                        Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("同步")
                    }
                }

                if (focusRecording != null) {
                    HomeWorkflowOverviewCard(
                        recording = focusRecording,
                        onClick = { onRecordingClick(focusRecording) },
                    )
                }

                if (syncNotice != null) {
                    SyncNoticeCard(
                        notice = syncNotice,
                        onRefresh = { requestRefresh() },
                    )
                }

                if (recordings.isEmpty()) {
                    EmptyHome(onRecordClick = onRecordClick)
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 112.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(recordings, key = { it.filename }) { recording ->
                            RecordingCard(
                                recording = recording,
                                lastSyncAtMs = lastSyncAtMs,
                                onClick = { onRecordingClick(recording) },
                                onRetryUpload = { onRetryUpload(recording) },
                                onDeleteRecording = { onDeleteRecording(recording) },
                            )
                        }
                    }
                }
            }
        }
    }
}

internal fun homeFocusRecording(recordings: List<RecordingEntity>): RecordingEntity? {
    return recordings.minWithOrNull(
        compareBy<RecordingEntity> { homeFocusRank(it) }
            .thenByDescending { it.timestamp },
    )
}

private fun homeFocusRank(recording: RecordingEntity): Int {
    return when (recording.status.asRecordingStatus()) {
        RecordingStatus.FAILED -> 0
        RecordingStatus.UPLOADING,
        RecordingStatus.UPLOADED,
        RecordingStatus.PROCESSING -> 1
        RecordingStatus.LOCAL_RECORDED -> 2
        RecordingStatus.COMPLETED -> {
            val hasDraft = recording.wechatDraftId?.isNotBlank() == true ||
                recording.wechatUrl?.isNotBlank() == true
            if (recording.hasDraftFailureMessage() || !hasDraft) 3 else 4
        }
    }
}

internal fun shouldFinishHomeRefresh(refreshStartedSyncAtMs: Long?, lastSyncAtMs: Long): Boolean {
    return refreshStartedSyncAtMs != null &&
        lastSyncAtMs > 0L &&
        lastSyncAtMs != refreshStartedSyncAtMs
}

internal fun homeSyncNotice(
    recordings: List<RecordingEntity>,
    lastSyncAtMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): HomeSyncNotice? {
    if (recordings.isEmpty()) return null
    if (lastSyncAtMs <= 0L) {
        return HomeSyncNotice("还没有和云端同步过，点同步检查上传和处理进度。")
    }

    val elapsedMs = (nowMs - lastSyncAtMs).coerceAtLeast(0L)
    val hasActiveCloudWork = recordings.any { recording ->
        when (recording.status.asRecordingStatus()) {
            RecordingStatus.UPLOADING,
            RecordingStatus.UPLOADED,
            RecordingStatus.PROCESSING -> true
            RecordingStatus.LOCAL_RECORDED,
            RecordingStatus.COMPLETED,
            RecordingStatus.FAILED -> false
        }
    }

    return if (hasActiveCloudWork && elapsedMs >= STALE_ACTIVE_SYNC_MS) {
        HomeSyncNotice("云端状态已 ${syncAgeLabel(elapsedMs)} 没有更新，点同步确认处理是否完成。")
    } else {
        null
    }
}

internal fun lastSyncLabel(lastSyncAtMs: Long, nowMs: Long = System.currentTimeMillis()): String {
    if (lastSyncAtMs <= 0L) return "最近同步：尚未同步"
    val elapsedSeconds = ((nowMs - lastSyncAtMs).coerceAtLeast(0L) / 1000L).toInt()
    return when {
        elapsedSeconds < 60 -> "最近同步：刚刚"
        elapsedSeconds < 3600 -> "最近同步：${elapsedSeconds / 60} 分钟前"
        elapsedSeconds < 86_400 -> "最近同步：${elapsedSeconds / 3600} 小时前"
        else -> "最近同步：${elapsedSeconds / 86_400} 天前"
    }
}

private fun syncAgeLabel(elapsedMs: Long): String {
    val elapsedMinutes = (elapsedMs / 60_000L).coerceAtLeast(1L)
    return when {
        elapsedMinutes < 60L -> "${elapsedMinutes} 分钟"
        elapsedMinutes < 24L * 60L -> "${elapsedMinutes / 60L} 小时"
        else -> "${elapsedMinutes / (24L * 60L)} 天"
    }
}

@Composable
private fun HomeWorkflowOverviewCard(
    recording: RecordingEntity,
    onClick: () -> Unit,
) {
    val status = recording.status.asRecordingStatus()
    val currentStep = recording.currentWorkflowStep()
    var showWorkflowHelp by remember { mutableStateOf(false) }

    if (showWorkflowHelp) {
        WorkflowHelpDialog(
            recording = recording,
            onDismiss = { showWorkflowHelp = false },
        )
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clickable(onClick = onClick)
            .testTag("HomeWorkflowOverviewCard"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(IconLightRedBackground),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.TaskAlt,
                        contentDescription = null,
                        tint = PrimaryRed,
                        modifier = Modifier.size(19.dp),
                    )
                }
                Spacer(modifier = Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "当前进度",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = recording.displayTitle(),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("HomeWorkflowOverviewTitle"),
                    )
                }
                IconButton(
                    onClick = { showWorkflowHelp = true },
                    modifier = Modifier
                        .size(32.dp)
                        .testTag("HomeWorkflowOverviewHelpButton"),
                ) {
                    Icon(
                        Icons.Default.Info,
                        contentDescription = "查看处理进度说明",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(statusColor(status)),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "${recording.workflowProgressLabel()} · ${recording.statusLabel()}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            LinearProgressIndicator(
                progress = { recording.workflowProgressFraction() },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp),
                color = statusColor(status),
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
            )
            Text(
                text = "${currentStep.title}：${currentStep.detail}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = recording.workflowFreshnessLabel(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = recording.workflowNextActionLabel(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun SyncNoticeCard(
    notice: HomeSyncNotice,
    onRefresh: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 2.dp)
            .testTag("HomeSyncNotice"),
        colors = CardDefaults.cardColors(containerColor = IconLightRedBackground),
        shape = RoundedCornerShape(10.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.SyncProblem,
                contentDescription = null,
                tint = PrimaryRed,
                modifier = Modifier.size(20.dp),
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = notice.message,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = "同步",
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onRefresh)
                    .padding(horizontal = 8.dp, vertical = 5.dp),
                style = MaterialTheme.typography.labelMedium,
                color = PrimaryRed,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun EmptyHome(onRecordClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(IconLightRedBackground),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Mic, contentDescription = null, tint = PrimaryRed, modifier = Modifier.size(36.dp))
        }
        Spacer(modifier = Modifier.height(18.dp))
        Text("还没有录音", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "说完一段想法，VibePub 会把它上传并整理成文章。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(20.dp))
        Button(onClick = onRecordClick) {
            Icon(Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("开始录音")
        }
    }
}

@Composable
fun RecordingCard(
    recording: RecordingEntity,
    lastSyncAtMs: Long,
    onClick: () -> Unit,
    onRetryUpload: () -> Unit,
    onDeleteRecording: () -> Unit,
) {
    val dateString = SimpleDateFormat("M月d日 · HH:mm", Locale.getDefault()).format(Date(recording.timestamp))
    val status = recording.status.asRecordingStatus()
    var showWorkflowHelp by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    if (showWorkflowHelp) {
        WorkflowHelpDialog(
            recording = recording,
            onDismiss = { showWorkflowHelp = false },
        )
    }
    if (showDeleteConfirm) {
        DeleteRecordingDialog(
            recording = recording,
            onDismiss = { showDeleteConfirm = false },
            onConfirm = {
                showDeleteConfirm = false
                onDeleteRecording()
            },
        )
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(IconLightRedBackground),
                contentAlignment = Alignment.Center,
            ) {
                VibeMark()
            }

            Spacer(modifier = Modifier.width(16.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = recording.displayTitle(),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = "$dateString · ${recording.listDurationLabel()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(statusColor(status)),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = recording.statusLabel(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = recording.workflowProgressLabel(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    IconButton(
                        onClick = { showWorkflowHelp = true },
                        modifier = Modifier
                            .size(28.dp)
                            .testTag("WorkflowHelpButton"),
                    ) {
                        Icon(
                            Icons.Default.Info,
                            contentDescription = "查看处理进度说明",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(17.dp),
                        )
                    }
                    if (recording.rawTextPreview?.isNotBlank() == true) {
                        Text(
                            text = "有原文",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                LinearProgressIndicator(
                    progress = { recording.workflowProgressFraction() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp),
                    color = statusColor(status),
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                )
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = recordingCardSyncFreshnessLabel(
                        recording = recording,
                        status = status,
                        lastSyncAtMs = lastSyncAtMs,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("RecordingCardSyncFreshness"),
                )
                if (status == RecordingStatus.FAILED) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = recording.statusDetail(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(modifier = Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (recording.canRetryUpload()) {
                        OutlinedButton(onClick = onRetryUpload, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
                            Icon(Icons.Default.Upload, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("重试")
                        }
                    }
                    OutlinedButton(
                        onClick = { showDeleteConfirm = true },
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                        modifier = Modifier.testTag("DeleteRecordingButton"),
                    ) {
                        Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("删除")
                    }
                }
            }
        }
    }
}

internal fun recordingCardSyncFreshnessLabel(
    recording: RecordingEntity? = null,
    status: RecordingStatus,
    lastSyncAtMs: Long,
    nowMs: Long = System.currentTimeMillis(),
): String {
    return when (status) {
        RecordingStatus.UPLOADING,
        RecordingStatus.UPLOADED,
        RecordingStatus.PROCESSING -> recording?.workflowFreshnessLabel(nowMs) ?: lastSyncLabel(lastSyncAtMs, nowMs)
        RecordingStatus.LOCAL_RECORDED -> "本机已保存，等待上传"
        RecordingStatus.COMPLETED -> "云端结果已同步"
        RecordingStatus.FAILED -> "已停止自动等待，请按提示处理"
    }
}

@Composable
private fun DeleteRecordingDialog(
    recording: RecordingEntity,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        modifier = Modifier.testTag("DeleteRecordingDialog"),
        onDismissRequest = onDismiss,
        title = { Text("删除这条录音？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "将从本机移除录音记录、音频文件和本地结果文件。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    recording.displayTitle(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.testTag("ConfirmDeleteRecordingButton"),
            ) {
                Text("删除", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.testTag("CancelDeleteRecordingButton"),
            ) {
                Text("取消")
            }
        },
    )
}

@Composable
fun WorkflowHelpDialog(
    recording: RecordingEntity,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = onDismiss) {
                Text("知道了")
            }
        },
        title = { Text(recording.workflowHelpTitle()) },
        text = {
            val currentStep = recording.currentWorkflowStep()
            Column(
                modifier = Modifier
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    recording.workflowHelpSummary(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                WorkflowHelpSection(
                    label = "当前状态说明",
                    value = recording.statusDetail(),
                )
                WorkflowHelpSection(
                    label = "当前节点",
                    value = "${recording.workflowCurrentNodeLabel()}\n${currentStep.detail}",
                )
                WorkflowHelpSection(
                    label = "下一步建议",
                    value = recording.workflowNextActionLabel(),
                )
                WorkflowHelpSection(
                    label = "更新时间",
                    value = recording.workflowFreshnessLabel(),
                )
                WorkflowHelpSection(
                    label = "完整流程周期",
                    value = recording.workflowCycleLabel(),
                )
                recording.workflowSteps().forEach { step ->
                    WorkflowStepRow(step = step)
                }
                if (recording.status.asRecordingStatus() == RecordingStatus.FAILED) {
                    Text(
                        "失败后可以先重试；如果仍失败，到设置页检查后端连接和 FILES_TOKEN。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
    )
}

@Composable
private fun WorkflowHelpSection(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurface,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun WorkflowStepRow(step: RecordingWorkflowStep) {
    val color = when (step.state) {
        WorkflowStepState.DONE -> Color(0xFF2E7D32)
        WorkflowStepState.CURRENT -> Color(0xFFF9A825)
        WorkflowStepState.BLOCKED -> Color(0xFFC62828)
        WorkflowStepState.PENDING -> MaterialTheme.colorScheme.outline
    }
    Row(verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier
                .size(22.dp)
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
                text = "${step.title} · ${step.state.displayLabel()}",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = step.detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun VibeMark() {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.width(3.dp).height(12.dp).background(PrimaryRed, CircleShape))
        Box(modifier = Modifier.width(3.dp).height(18.dp).background(PrimaryRed, CircleShape))
        Box(modifier = Modifier.width(3.dp).height(12.dp).background(PrimaryRed, CircleShape))
    }
}

private fun statusColor(status: RecordingStatus): Color {
    return when (status) {
        RecordingStatus.COMPLETED -> Color(0xFF2E7D32)
        RecordingStatus.FAILED -> Color(0xFFC62828)
        RecordingStatus.UPLOADING, RecordingStatus.UPLOADED, RecordingStatus.PROCESSING -> Color(0xFFF9A825)
        RecordingStatus.LOCAL_RECORDED -> Color(0xFF607D8B)
    }
}

private const val STALE_ACTIVE_SYNC_MS = 10L * 60L * 1000L
