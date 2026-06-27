package cn.litianc.vibepub.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.ui.theme.IconLightRedBackground
import cn.litianc.vibepub.ui.theme.PrimaryRed
import kotlinx.coroutines.flow.Flow
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    recordingsFlow: Flow<List<RecordingEntity>>,
    onSettingsClick: () -> Unit,
    onRecordClick: () -> Unit,
    onRecordingClick: (RecordingEntity) -> Unit
) {
    val recordings by recordingsFlow.collectAsState(initial = emptyList())

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // Mock Logo
                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            Box(modifier = Modifier.width(3.dp).height(12.dp).background(PrimaryRed, CircleShape))
                            Box(modifier = Modifier.width(3.dp).height(18.dp).background(PrimaryRed, CircleShape))
                            Box(modifier = Modifier.width(3.dp).height(12.dp).background(PrimaryRed, CircleShape))
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "VoiceDrop 口述",
                            fontWeight = FontWeight.Bold,
                            fontSize = 18.sp
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onSettingsClick) {
                        Icon(
                            imageVector = Icons.Default.Settings,
                            contentDescription = "Settings"
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onRecordClick,
                containerColor = PrimaryRed,
                contentColor = Color.White,
                shape = CircleShape,
                modifier = Modifier.size(72.dp)
            ) {
                // Large red FAB as in the screenshot, but empty or with a mic? 
                // Screenshot just shows a solid red circle. The FAB itself is red.
            }
        },
        floatingActionButtonPosition = FabPosition.Center,
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // Tabs
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "我的录音",
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Box(modifier = Modifier.fillMaxWidth().height(2.dp).background(PrimaryRed))
                }
                Column(
                    modifier = Modifier.weight(1f),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "VD 社区",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Box(modifier = Modifier.fillMaxWidth().height(2.dp).background(Color.Transparent))
                }
            }
            
            // List
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(recordings) { recording ->
                    RecordingCard(recording, onClick = { onRecordingClick(recording) })
                }
            }
        }
    }
}

@Composable
fun RecordingCard(recording: RecordingEntity, onClick: () -> Unit) {
    val dateFormat = SimpleDateFormat("M月d日 · HH:mm", Locale.getDefault())
    val dateString = dateFormat.format(Date(recording.timestamp))
    
    val mins = recording.durationMs / 60000
    val secs = (recording.durationMs % 60000) / 1000
    val durationString = "${mins}m${secs}s"
    
    val isTranscribed = recording.status == "TRANSCRIBED"

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp) // Flat cards
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Icon box
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(IconLightRedBackground),
                contentAlignment = Alignment.Center
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    Box(modifier = Modifier.width(3.dp).height(12.dp).background(PrimaryRed, CircleShape))
                    Box(modifier = Modifier.width(3.dp).height(18.dp).background(PrimaryRed, CircleShape))
                    Box(modifier = Modifier.width(3.dp).height(12.dp).background(PrimaryRed, CircleShape))
                }
            }
            
            Spacer(modifier = Modifier.width(16.dp))
            
            Column(modifier = Modifier.weight(1f)) {
                // The filename from AudioRecorder already has the timestamp, but we'll show a nice title
                // For now just parse or use the date string + mock title
                val title = "$dateString · 录音片段" // Mocking a title for now
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1
                )
                Spacer(modifier = Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = durationString,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(if (isTranscribed) Color(0xFF4CAF50) else Color.Gray))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = if (isTranscribed) "已成文" else "处理中",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            
            Spacer(modifier = Modifier.width(8.dp))
            Text(">", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
