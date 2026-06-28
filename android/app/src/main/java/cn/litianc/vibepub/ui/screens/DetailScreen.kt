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
                            Text("3m10s", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            
            Spacer(modifier = Modifier.height(24.dp))
            
            val context = LocalContext.current
            var articleTitle by remember { mutableStateOf("正在获取云端转录...") }
            var articleContent by remember { mutableStateOf("音频已上传，云端正在为您精心转录和排版中，请稍候并下拉刷新或重新进入本页。") }
            var rawText by remember { mutableStateOf("") }
            
            LaunchedEffect(filename) {
                try {
                    val dir = File(context.filesDir, "recordings")
                    val jsonFile = File(dir, filename.replace(".m4a", ".json"))
                    if (!jsonFile.exists()) {
                        fetchTranscript(context, filename)?.let { jsonText ->
                            dir.mkdirs()
                            jsonFile.writeText(jsonText)
                        }
                    }

                    if (jsonFile.exists()) {
                        val jsonString = jsonFile.readText()
                        val json = JSONObject(jsonString)
                        articleTitle = json.optString("articleTitle", "转录完成")
                        articleContent = json.optString("articleContent", json.optString("rawText", "未能获取转录内容"))
                        rawText = json.optString("rawText", "")
                        markRecordingCompleted(context, filename)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
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

private suspend fun markRecordingCompleted(context: android.content.Context, filename: String) =
    withContext(Dispatchers.IO) {
        val dao = AppDatabase.getDatabase(context).recordingDao()
        val entity = dao.getRecordingByFilename(filename)
        if (entity != null && entity.status != "COMPLETED") {
            dao.insert(entity.copy(status = "COMPLETED"))
        }
    }
