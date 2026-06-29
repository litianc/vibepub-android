package cn.litianc.vibepub.ui.screens

import android.os.Build
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
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Link
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
    var connectionResult by remember { mutableStateOf<String?>(null) }
    var showDiagnostics by remember { mutableStateOf(false) }
    var diagnostics by remember { mutableStateOf("") }

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
                                scope.launch {
                                    connectionResult = testBackendConnection(apiBaseUrl, filesToken)
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
                        connectionResult?.let {
                            Spacer(modifier = Modifier.height(10.dp))
                            Text(it, color = if (it.startsWith("连接正常")) Color(0xFF2E7D32) else Color(0xFFC62828))
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
        )
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

private suspend fun testBackendConnection(apiBaseUrl: String, filesToken: String): String =
    withContext(Dispatchers.IO) {
        val base = apiBaseUrl.trimEnd('/')
        if (base.isBlank()) return@withContext "连接失败：API Base URL 为空"
        try {
            val health = (URL("$base/health").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8_000
                readTimeout = 8_000
            }
            if (health.responseCode !in 200..299) {
                return@withContext "连接失败：/health HTTP ${health.responseCode}"
            }
            if (filesToken.isBlank()) return@withContext "连接失败：FILES_TOKEN 为空"

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
                "连接正常：后端可达，Token 有效，云端 $count 条录音"
            } else if (recordings.responseCode == 401 || recordings.responseCode == 403) {
                "连接失败：FILES_TOKEN 无效"
            } else {
                "连接失败：/api/recordings HTTP ${recordings.responseCode}"
            }
        } catch (error: Exception) {
            "连接失败：${error.message ?: error.javaClass.simpleName}"
        }
    }

private suspend fun buildDiagnostics(context: android.content.Context, preferences: AppPreferences): String =
    withContext(Dispatchers.IO) {
        val latest = AppDatabase.getDatabase(context).recordingDao().getAllRecordings().firstOrNull()
        val syncText = if (preferences.lastSyncAtMs > 0) {
            SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(preferences.lastSyncAtMs))
        } else {
            "尚未同步"
        }
        """
        App: VibePub ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})
        Device: ${Build.MANUFACTURER} ${Build.MODEL}
        Android: ${Build.VERSION.RELEASE} / SDK ${Build.VERSION.SDK_INT}
        API: ${preferences.apiBaseUrl}
        Token: ${if (preferences.filesToken.isBlank()) "未配置" else "已配置"}
        Last sync: $syncText
        Latest recording: ${latest?.filename ?: "无"}
        Latest status: ${latest?.status ?: "无"}
        Latest error: ${latest?.lastError ?: "无"}
        """.trimIndent()
    }
