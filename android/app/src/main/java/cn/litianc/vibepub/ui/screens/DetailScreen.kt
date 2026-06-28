package cn.litianc.vibepub.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.ui.theme.PrimaryRed
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONObject
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(
    filename: String,
    onBackClick: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { },
                navigationIcon = {
                    IconButton(onClick = onBackClick) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { /* TODO */ }) {
                        Icon(Icons.Default.MoreHoriz, contentDescription = "More")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { /* TODO */ },
                containerColor = Color.White,
                contentColor = MaterialTheme.colorScheme.onSurface,
                shape = RoundedCornerShape(32.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 32.dp)
            ) {
                Icon(Icons.Default.Mic, contentDescription = "Edit")
                Spacer(modifier = Modifier.width(8.dp))
                Text("按住 说话 修改", fontWeight = FontWeight.SemiBold)
            }
        },
        floatingActionButtonPosition = FabPosition.Center,
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp)
        ) {
            val context = LocalContext.current
            var durationText by remember { mutableStateOf("--:--") }
            var articleTitle by remember { mutableStateOf("正在获取云端转录...") }
            var articleContent by remember { mutableStateOf("音频已上传，云端正在为您精心转录和排版中，请稍候并下拉刷新或重新进入本页。") }
            var rawText by remember { mutableStateOf("") }

            // Player Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(12.dp)
            ) {
                Row(
                    modifier = Modifier.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFFE36049)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Default.PlayArrow, contentDescription = "Play", tint = Color.White)
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        LinearProgressIndicator(
                            progress = { 0f }, // Mock progress
                            modifier = Modifier.fillMaxWidth().height(4.dp),
                            color = PrimaryRed,
                            trackColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f)
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("00:00", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(durationText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            
            Spacer(modifier = Modifier.height(24.dp))
            
            LaunchedEffect(filename) {
                repeat(12) { attempt ->
                    try {
                        durationText = loadRecordingDurationText(context, filename)
                        val transcript = loadTranscript(context, filename)
                        if (transcript != null) {
                            articleTitle = transcript.optString("articleTitle", "转录完成")
                            articleContent = transcript.optString(
                                "articleContent",
                                transcript.optString("rawText", "未能获取转录内容"),
                            )
                            rawText = transcript.optString("rawText", "")
                            markRecordingCompleted(context, filename)
                            return@LaunchedEffect
                        }

                        val status = fetchRecordingStatus(context, filename)
                        if (status == "FAILED") {
                            articleTitle = "转录失败"
                            articleContent = "云端处理这段录音时失败了，请稍后重试或重新录制。"
                            updateRecordingStatus(context, filename, status)
                            return@LaunchedEffect
                        }

                        if (status.isNotBlank()) {
                            updateRecordingStatus(context, filename, status)
                            articleTitle = when (status) {
                                "PROCESSING" -> "正在转录..."
                                else -> "正在获取云端转录..."
                            }
                        }
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }

                    if (attempt < 11) delay(5_000)
                }
            }
            
            Text(
                text = articleTitle,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
                lineHeight = 32.sp
            )
            
            Spacer(modifier = Modifier.height(8.dp))
            
            if (rawText.isNotEmpty()) {
                Text(
                    text = "原始识别结果: ${rawText.take(50)}...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            
            Spacer(modifier = Modifier.height(24.dp))
            
            Text(
                text = articleContent,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                lineHeight = 28.sp
            )
            
            Spacer(modifier = Modifier.height(100.dp)) // Space for FAB
        }
    }
}

private suspend fun loadRecordingDurationText(context: android.content.Context, filename: String): String =
    withContext(Dispatchers.IO) {
        val durationMs = AppDatabase.getDatabase(context)
            .recordingDao()
            .getRecordingByFilename(filename)
            ?.durationMs
            ?: return@withContext "--:--"
        formatDuration(durationMs)
    }

private fun formatDuration(durationMs: Long): String {
    val totalSeconds = (durationMs / 1000).coerceAtLeast(0)
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "%d:%02d".format(minutes, seconds)
}

private suspend fun loadTranscript(context: android.content.Context, filename: String): JSONObject? =
    withContext(Dispatchers.IO) {
        val dir = File(context.filesDir, "recordings")
        val jsonFile = File(dir, filename.replace(".m4a", ".json"))
        if (!jsonFile.exists()) {
            fetchTranscript(context, filename)?.let { jsonText ->
                dir.mkdirs()
                jsonFile.writeText(jsonText)
            }
        }

        if (jsonFile.exists()) {
            JSONObject(jsonFile.readText())
        } else {
            null
        }
    }

private suspend fun fetchTranscript(context: android.content.Context, filename: String): String? =
    withContext(Dispatchers.IO) {
        val prefs = AppPreferences(context)
        val token = prefs.filesToken
        if (token.isBlank()) return@withContext null

        try {
            val encodedFilename = URLEncoder.encode(filename, "UTF-8").replace("+", "%20")
            val endpoint = URL("${prefs.apiBaseUrl.trimEnd('/')}/api/transcripts/$encodedFilename")
            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("Authorization", "Bearer $token")
            }

            if (connection.responseCode in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

private suspend fun fetchRecordingStatus(context: android.content.Context, filename: String): String =
    withContext(Dispatchers.IO) {
        val prefs = AppPreferences(context)
        val token = prefs.filesToken
        if (token.isBlank()) return@withContext ""

        try {
            val endpoint = URL("${prefs.apiBaseUrl.trimEnd('/')}/api/recordings")
            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("Authorization", "Bearer $token")
            }

            if (connection.responseCode in 200..299) {
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                val recordings = JSONObject(body).optJSONArray("recordings")
                if (recordings != null) {
                    for (i in 0 until recordings.length()) {
                        val recording = recordings.getJSONObject(i)
                        if (recording.optString("filename") == filename) {
                            return@withContext recording.optString("status")
                        }
                    }
                }
            }
            ""
        } catch (_: Exception) {
            ""
        }
    }

private suspend fun markRecordingCompleted(context: android.content.Context, filename: String) =
    updateRecordingStatus(context, filename, "COMPLETED")

private suspend fun updateRecordingStatus(context: android.content.Context, filename: String, status: String) =
    withContext(Dispatchers.IO) {
        val dao = AppDatabase.getDatabase(context).recordingDao()
        val entity = dao.getRecordingByFilename(filename)
        if (entity != null && entity.status != status) {
            dao.insert(entity.copy(status = status))
        }
    }
