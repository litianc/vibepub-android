package cn.litianc.vibepub.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.BuildConfig
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.currentWorkflowStep
import cn.litianc.vibepub.data.displayTitle
import cn.litianc.vibepub.data.statusDetail
import cn.litianc.vibepub.data.statusLabel
import cn.litianc.vibepub.data.workflowCurrentNodeLabel
import cn.litianc.vibepub.data.workflowFreshnessLabel
import cn.litianc.vibepub.data.workflowNextActionLabel
import cn.litianc.vibepub.data.workflowProgressLabel
import cn.litianc.vibepub.data.wechatDraftReferenceOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal enum class ConnectionCheckState {
    PASSED,
    FAILED,
    SKIPPED,
}

internal data class ConnectionCheckItem(
    val label: String,
    val state: ConnectionCheckState,
    val detail: String,
)

internal data class ConnectionTestResult(
    val success: Boolean,
    val summary: String,
    val nextAction: String,
    val checks: List<ConnectionCheckItem>,
)

internal data class SettingsConnectionConfig(
    val apiBaseUrl: String,
    val filesToken: String,
) {
    fun normalized(): SettingsConnectionConfig {
        return SettingsConnectionConfig(
            apiBaseUrl = apiBaseUrl.trim(),
            filesToken = filesToken.trim(),
        )
    }
}

private const val SETTINGS_AUTO_CONNECTION_TEST_DELAY_MS = 900L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBackClick: () -> Unit,
) {
    val context = LocalContext.current
    val preferences = remember { AppPreferences(context) }
    val scope = rememberCoroutineScope()
    var apiBaseUrl by remember { mutableStateOf(preferences.apiBaseUrl) }
    var filesToken by remember { mutableStateOf(preferences.filesToken) }
    var showToken by remember { mutableStateOf(false) }
    var isTesting by remember { mutableStateOf(false) }
    var connectionResult by remember { mutableStateOf<ConnectionTestResult?>(null) }
    var showDiagnostics by remember { mutableStateOf(false) }
    var diagnostics by remember { mutableStateOf("") }
    val lastSyncAtMs by remember(preferences) {
        preferences.lastSyncAtMsFlow()
    }.collectAsState(initial = preferences.lastSyncAtMs)
    var lastTestedConfig by remember {
        mutableStateOf(SettingsConnectionConfig(apiBaseUrl, filesToken).normalized())
    }

    LaunchedEffect(apiBaseUrl, filesToken) {
        val currentConfig = SettingsConnectionConfig(apiBaseUrl, filesToken).normalized()
        if (!shouldAutoTestSettingsConnection(lastTestedConfig, currentConfig)) {
            return@LaunchedEffect
        }
        delay(SETTINGS_AUTO_CONNECTION_TEST_DELAY_MS)
        isTesting = true
        connectionResult = null
        try {
            connectionResult = testBackendConnection(currentConfig.apiBaseUrl, currentConfig.filesToken)
            lastTestedConfig = currentConfig
        } finally {
            isTesting = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBackClick) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item {
                Spacer(modifier = Modifier.height(4.dp))
                SettingsGroup(title = "后端连接") {
                    OutlinedTextField(
                        value = apiBaseUrl,
                        onValueChange = {
                            apiBaseUrl = it
                            preferences.apiBaseUrl = it
                            connectionResult = null
                        },
                        label = { Text("API Base URL") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .testTag("ApiBaseUrlField"),
                        leadingIcon = { Icon(Icons.Default.Link, contentDescription = null) },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp)
                    OutlinedTextField(
                        value = filesToken,
                        onValueChange = {
                            filesToken = it
                            preferences.filesToken = it
                            connectionResult = null
                        },
                        label = { Text("FILES_TOKEN") },
                        singleLine = true,
                        visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .testTag("FilesTokenField"),
                        leadingIcon = { Icon(Icons.Default.Key, contentDescription = null) },
                        trailingIcon = {
                            Row {
                                IconButton(onClick = { showToken = !showToken }) {
                                    Icon(if (showToken) Icons.Default.VisibilityOff else Icons.Default.Visibility, contentDescription = "Toggle token")
                                }
                                IconButton(onClick = {
                                    filesToken = ""
                                    preferences.filesToken = ""
                                    connectionResult = null
                                }) {
                                    Icon(Icons.Default.Delete, contentDescription = "Clear token")
                                }
                            }
                        },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp)
                    Column(modifier = Modifier.padding(16.dp)) {
                        Button(
                            onClick = {
                                isTesting = true
                                connectionResult = null
                                val currentConfig = SettingsConnectionConfig(apiBaseUrl, filesToken).normalized()
                                scope.launch {
                                    connectionResult = testBackendConnection(currentConfig.apiBaseUrl, currentConfig.filesToken)
                                    lastTestedConfig = currentConfig
                                    isTesting = false
                                }
                            },
                            modifier = Modifier.testTag("TestBackendButton"),
                        ) {
                            Icon(Icons.Default.CloudDone, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("测试后端连接")
                        }
                        if (isTesting) {
                            Spacer(modifier = Modifier.height(10.dp))
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        }
                        connectionResult?.let { result ->
                            Spacer(modifier = Modifier.height(10.dp))
                            ConnectionResultCard(result = result)
                        }
                    }
                }
            }

            item {
                SettingsGroup(title = "发布") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFFDECEA)) { Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color(0xFF2E7D32)) } },
                        title = "微信公众号草稿",
                        subtitle = "由云端 mining job 创建草稿，Android 只展示状态",
                        value = "云端托管",
                        valueColor = Color(0xFF2E7D32),
                        onClick = {},
                    )
                }
            }

            item {
                SettingsGroup(title = "同步") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFEAF2FF)) { Icon(Icons.Default.Sync, contentDescription = null, tint = Color(0xFF2762C7)) } },
                        title = "最近同步",
                        subtitle = settingsLastSyncDetail(lastSyncAtMs),
                        value = settingsLastSyncValue(lastSyncAtMs),
                        modifier = Modifier.testTag("SettingsLastSyncItem"),
                        onClick = {},
                    )
                }
            }

            item {
                SettingsGroup(title = "诊断") {
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFF2F2F7)) { Icon(Icons.Default.BugReport, contentDescription = null) } },
                        title = "诊断信息",
                        subtitle = "设备、版本、最近同步和最近录音",
                        modifier = Modifier.testTag("DiagnosticsItem"),
                        onClick = {
                            scope.launch {
                                diagnostics = buildDiagnostics(context, preferences)
                                showDiagnostics = true
                            }
                        },
                    )
                    Divider(color = MaterialTheme.colorScheme.background, thickness = 1.dp, modifier = Modifier.padding(start = 64.dp))
                    SettingsItem(
                        iconContent = { SettingsIcon(Color(0xFFF2F2F7)) { Icon(Icons.Default.ContentCopy, contentDescription = null) } },
                        title = "版本",
                        subtitle = "VibePub ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                        value = "Android",
                        onClick = {},
                    )
                }
            }
        }
    }

    if (showDiagnostics) {
        AlertDialog(
            onDismissRequest = { showDiagnostics = false },
            title = { Text("诊断信息") },
            text = { Text(diagnostics) },
            confirmButton = {
                TextButton(onClick = { showDiagnostics = false }) {
                    Text("关闭")
                }
            },
            dismissButton = {
                TextButton(onClick = { copyDiagnostics(context, diagnostics) }) {
                    Text("复制诊断")
                }
            },
        )
    }
}

@Composable
private fun ConnectionResultCard(result: ConnectionTestResult) {
    val accent = if (result.success) Color(0xFF2E7D32) else Color(0xFFC62828)
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("ConnectionResultCard"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.background),
        shape = RoundedCornerShape(10.dp),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = if (result.success) Icons.Default.CheckCircle else Icons.Default.Error,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    result.summary,
                    color = accent,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            result.checks.forEach { item ->
                ConnectionCheckRow(item = item)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                result.nextAction,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ConnectionCheckRow(item: ConnectionCheckItem) {
    val color = when (item.state) {
        ConnectionCheckState.PASSED -> Color(0xFF2E7D32)
        ConnectionCheckState.FAILED -> Color(0xFFC62828)
        ConnectionCheckState.SKIPPED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = when (item.state) {
                ConnectionCheckState.PASSED -> "通过"
                ConnectionCheckState.FAILED -> "失败"
                ConnectionCheckState.SKIPPED -> "跳过"
            },
            color = color,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.width(44.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(item.label, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
            Text(item.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column {
        if (title.isNotEmpty()) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp),
            )
        }
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(12.dp),
        ) {
            Column(content = content)
        }
    }
}

@Composable
fun SettingsItem(
    iconContent: @Composable () -> Unit,
    title: String,
    subtitle: String? = null,
    value: String? = null,
    valueColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        iconContent()
        Spacer(modifier = Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            if (subtitle != null) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (value != null) {
            Spacer(modifier = Modifier.width(8.dp))
            Text(value, style = MaterialTheme.typography.bodyMedium, color = valueColor)
        }
    }
}

@Composable
private fun SettingsIcon(color: Color, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(color),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

internal fun shouldAutoTestSettingsConnection(
    lastTestedConfig: SettingsConnectionConfig,
    currentConfig: SettingsConnectionConfig,
): Boolean {
    return lastTestedConfig.normalized() != currentConfig.normalized()
}

internal fun settingsLastSyncValue(
    lastSyncAtMs: Long,
    locale: Locale = Locale.getDefault(),
    timeZone: TimeZone = TimeZone.getDefault(),
): String {
    if (lastSyncAtMs <= 0L) return "尚未同步"
    return SimpleDateFormat("MM-dd HH:mm", locale).apply {
        this.timeZone = timeZone
    }.format(Date(lastSyncAtMs))
}

internal fun settingsLastSyncDetail(
    lastSyncAtMs: Long,
    locale: Locale = Locale.getDefault(),
    timeZone: TimeZone = TimeZone.getDefault(),
): String {
    if (lastSyncAtMs <= 0L) return "还没有从云端同步过录音状态"
    val formatted = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", locale).apply {
        this.timeZone = timeZone
    }.format(Date(lastSyncAtMs))
    return "上次从云端同步录音和成文状态：$formatted"
}

private suspend fun testBackendConnection(apiBaseUrl: String, filesToken: String): ConnectionTestResult =
    withContext(Dispatchers.IO) {
        val base = apiBaseUrl.trimEnd('/')
        if (base.isBlank()) {
            return@withContext connectionInputError("API Base URL 为空", tokenProvided = filesToken.isNotBlank())
        }
        try {
            val health = (URL("$base/health").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8_000
                readTimeout = 8_000
            }
            if (health.responseCode !in 200..299) {
                return@withContext buildConnectionResult(
                    healthStatusCode = health.responseCode,
                    tokenProvided = filesToken.isNotBlank(),
                    recordingsStatusCode = null,
                    recordingCount = null,
                    errorMessage = null,
                )
            }
            if (filesToken.isBlank()) {
                return@withContext buildConnectionResult(
                    healthStatusCode = health.responseCode,
                    tokenProvided = false,
                    recordingsStatusCode = null,
                    recordingCount = null,
                    errorMessage = null,
                )
            }

            runCatching {
                val recordings = (URL("$base/api/recordings").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 8_000
                    readTimeout = 8_000
                    setRequestProperty("Authorization", "Bearer $filesToken")
                }
                if (recordings.responseCode in 200..299) {
                    val count = JSONObject(recordings.inputStream.bufferedReader().use { it.readText() })
                        .optJSONArray("recordings")
                        ?.length()
                        ?: 0
                    buildConnectionResult(
                        healthStatusCode = health.responseCode,
                        tokenProvided = true,
                        recordingsStatusCode = recordings.responseCode,
                        recordingCount = count,
                        errorMessage = null,
                    )
                } else {
                    buildConnectionResult(
                        healthStatusCode = health.responseCode,
                        tokenProvided = true,
                        recordingsStatusCode = recordings.responseCode,
                        recordingCount = null,
                        errorMessage = null,
                    )
                }
            }.getOrElse { error ->
                buildConnectionResult(
                    healthStatusCode = health.responseCode,
                    tokenProvided = true,
                    recordingsStatusCode = null,
                    recordingCount = null,
                    errorMessage = null,
                    recordingsErrorMessage = error.message ?: error.javaClass.simpleName,
                )
            }
        } catch (error: Exception) {
            buildConnectionResult(
                healthStatusCode = null,
                tokenProvided = filesToken.isNotBlank(),
                recordingsStatusCode = null,
                recordingCount = null,
                errorMessage = error.message ?: error.javaClass.simpleName,
            )
        }
    }

internal fun buildConnectionResult(
    healthStatusCode: Int?,
    tokenProvided: Boolean,
    recordingsStatusCode: Int?,
    recordingCount: Int?,
    errorMessage: String?,
    recordingsErrorMessage: String? = null,
): ConnectionTestResult {
    val healthPassed = healthStatusCode != null && healthStatusCode in 200..299
    val recordingsPassed = recordingsStatusCode != null && recordingsStatusCode in 200..299
    val authFailed = recordingsStatusCode == 401 || recordingsStatusCode == 403

    val checks = listOf(
        ConnectionCheckItem(
            label = "后端网络",
            state = if (healthPassed) ConnectionCheckState.PASSED else ConnectionCheckState.FAILED,
            detail = when {
                healthPassed -> "/health HTTP $healthStatusCode"
                healthStatusCode != null -> "/health HTTP $healthStatusCode"
                errorMessage != null -> errorMessage
                else -> "无法访问 /health"
            },
        ),
        ConnectionCheckItem(
            label = "FILES_TOKEN",
            state = when {
                !tokenProvided -> ConnectionCheckState.FAILED
                authFailed -> ConnectionCheckState.FAILED
                recordingsPassed -> ConnectionCheckState.PASSED
                healthPassed -> ConnectionCheckState.SKIPPED
                else -> ConnectionCheckState.SKIPPED
            },
            detail = when {
                !tokenProvided -> "未填写，无法读取云端录音"
                authFailed -> "Token 无效或没有权限，/api/recordings HTTP $recordingsStatusCode"
                recordingsPassed -> "已通过授权接口校验"
                healthPassed -> "已填写，但录音列表未通过，暂未确认权限"
                else -> "后端未连通，暂未校验"
            },
        ),
        ConnectionCheckItem(
            label = "录音列表接口",
            state = when {
                recordingsPassed -> ConnectionCheckState.PASSED
                !healthPassed || !tokenProvided -> ConnectionCheckState.SKIPPED
                else -> ConnectionCheckState.FAILED
            },
            detail = when {
                recordingsPassed -> "/api/recordings HTTP $recordingsStatusCode，云端 $recordingCount 条录音"
                recordingsStatusCode != null -> "/api/recordings HTTP $recordingsStatusCode"
                recordingsErrorMessage != null -> recordingsErrorMessage
                !healthPassed -> "后端未连通，暂未请求"
                !tokenProvided -> "需要 FILES_TOKEN"
                else -> "没有拿到接口响应"
            },
        ),
    )

    return ConnectionTestResult(
        success = healthPassed && tokenProvided && recordingsPassed,
        summary = when {
            healthPassed && tokenProvided && recordingsPassed -> "连接正常"
            !healthPassed -> "后端不可达"
            !tokenProvided -> "缺少 FILES_TOKEN"
            authFailed -> "FILES_TOKEN 无效"
            else -> "录音列表接口异常"
        },
        nextAction = when {
            healthPassed && tokenProvided && recordingsPassed -> "可以继续录音、上传并等待成文。"
            !healthPassed -> "检查 API Base URL、网络或后端部署状态。"
            !tokenProvided -> "粘贴 FILES_TOKEN 后重新测试连接。"
            authFailed -> "在设置中更新 FILES_TOKEN，或检查 GitHub/Worker 使用的密钥是否一致。"
            else -> "稍后重试；如果持续失败，复制诊断信息反馈。"
        },
        checks = checks,
    )
}

private fun connectionInputError(message: String, tokenProvided: Boolean): ConnectionTestResult {
    return buildConnectionResult(
        healthStatusCode = null,
        tokenProvided = tokenProvided,
        recordingsStatusCode = null,
        recordingCount = null,
        errorMessage = message,
    ).copy(
        summary = "配置不完整",
        nextAction = "填写 API Base URL 后重新测试连接。",
    )
}

private fun copyDiagnostics(context: Context, diagnostics: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("VibePub 诊断信息", diagnostics))
    Toast.makeText(context, "诊断信息已复制", Toast.LENGTH_SHORT).show()
}

private suspend fun buildDiagnostics(context: android.content.Context, preferences: AppPreferences): String =
    withContext(Dispatchers.IO) {
        val recordings = AppDatabase.getDatabase(context).recordingDao().getAllRecordings()
        val latest = recordings.firstOrNull()
        val syncText = if (preferences.lastSyncAtMs > 0) {
            SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(preferences.lastSyncAtMs))
        } else {
            "尚未同步"
        }
        formatDiagnostics(
            appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
                .ifBlank { "unknown" },
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}",
            androidVersion = "${Build.VERSION.RELEASE} / SDK ${Build.VERSION.SDK_INT}",
            apiBaseUrl = preferences.apiBaseUrl,
            tokenConfigured = preferences.filesToken.isNotBlank(),
            lastSyncText = syncText,
            recordingCount = recordings.size,
            latest = latest,
            latestLocalAudioExists = latest?.localAudioPath
                ?.takeIf { it.isNotBlank() }
                ?.let { File(it).exists() },
        )
    }

internal fun formatDiagnostics(
    appVersion: String,
    deviceId: String,
    deviceName: String,
    androidVersion: String,
    apiBaseUrl: String,
    tokenConfigured: Boolean,
    lastSyncText: String,
    recordingCount: Int,
    latest: RecordingEntity?,
    latestLocalAudioExists: Boolean? = latest?.localAudioPath
        ?.takeIf { it.isNotBlank() }
        ?.let { File(it).exists() },
): String {
    val latestStep = latest?.currentWorkflowStep()
    val latestDraftReference = latest
        ?.let { recording -> wechatDraftReferenceOrNull(recording.wechatDraftId, recording.wechatUrl) }
        ?: "无"
    return """
    App: VibePub $appVersion
    Device ID: $deviceId
    Device: $deviceName
    Android: $androidVersion
    API host: ${apiBaseUrl.ifBlank { "未配置" }}
    Token: ${if (tokenConfigured) "已配置" else "未配置"}
    Last sync: $lastSyncText
    Recording count: $recordingCount
    Latest recording: ${latest?.filename ?: "无"}
    Latest title: ${latest?.displayTitle() ?: "无"}
    Latest status: ${latest?.status ?: "无"}
    Latest status label: ${latest?.statusLabel() ?: "无"}
    Latest status detail: ${latest?.statusDetail() ?: "无"}
    Latest processing stage: ${latest?.processingStage ?: "无"}
    Latest workflow: ${latest?.workflowCurrentNodeLabel() ?: "无"}
    Latest workflow progress: ${latest?.workflowProgressLabel() ?: "无"}
    Latest workflow freshness: ${latest?.workflowFreshnessLabel() ?: "无"}
    Latest workflow detail: ${latestStep?.detail ?: "无"}
    Latest next action: ${latest?.workflowNextActionLabel() ?: "无"}
    Latest remote update: ${latest?.remoteStatusUpdatedAt ?: "无"}
    Latest local audio path: ${latest?.localAudioPath ?: "无"}
    Latest local audio exists: ${latestLocalAudioExists?.let { if (it) "是" else "否" } ?: "未知"}
    Latest article title: ${latest?.articleTitle ?: "无"}
    Latest raw text: ${if (latest?.rawTextPreview.isNullOrBlank()) "无" else "已同步"}
    Latest WeChat draft: $latestDraftReference
    Latest error: ${latest?.lastError ?: "无"}
    """.trimIndent()
}
