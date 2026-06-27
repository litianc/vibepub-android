package cn.litianc.vibepub

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import cn.litianc.vibepub.ui.theme.PrimaryRed
import cn.litianc.vibepub.ui.theme.VibePubTheme
import kotlinx.coroutines.launch
import java.io.File

class MainActivity : ComponentActivity() {
    private lateinit var preferences: AppPreferences
    private lateinit var recorder: AudioRecorder

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        preferences = AppPreferences(this)
        recorder = AudioRecorder(this)

        setContent {
            VibePubTheme {
                VibePubScreen(preferences, recorder)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VibePubScreen(
    preferences: AppPreferences,
    recorder: AudioRecorder,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    
    var apiBaseUrl by remember { mutableStateOf(preferences.apiBaseUrl) }
    var filesToken by remember { mutableStateOf(preferences.filesToken) }
    var isRecording by remember { mutableStateOf(false) }
    
    var showSettings by remember { mutableStateOf(false) }

    fun enqueueUpload(file: File) {
        if (filesToken.isBlank()) {
            scope.launch {
                val result = snackbarHostState.showSnackbar(
                    message = "Add FILES_TOKEN before upload.",
                    actionLabel = "Settings",
                    duration = SnackbarDuration.Long
                )
                if (result == SnackbarResult.ActionPerformed) {
                    showSettings = true
                }
            }
            return
        }

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(constraints)
            .setInputData(
                workDataOf(
                    UploadWorker.KEY_FILE_PATH to file.absolutePath,
                    UploadWorker.KEY_API_BASE_URL to apiBaseUrl,
                    UploadWorker.KEY_FILES_TOKEN to filesToken,
                ),
            )
            .build()

        WorkManager.getInstance(context).enqueue(request)
        scope.launch {
            snackbarHostState.showSnackbar("录音已安全送达云端，AI 正在为您排版，请稍后前往微信草稿箱查看")
        }
    }

    fun startRecording() {
        runCatching {
            recorder.start()
            isRecording = true
        }.onFailure {
            scope.launch {
                snackbarHostState.showSnackbar("Could not start recording: ${it.message.orEmpty()}")
            }
        }
    }

    fun stopRecording() {
        runCatching {
            val file = recorder.stop()
            isRecording = false
            enqueueUpload(file)
        }.onFailure {
            isRecording = false
            scope.launch {
                snackbarHostState.showSnackbar("Could not stop recording: ${it.message.orEmpty()}")
            }
        }
    }

    val audioPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            startRecording()
        } else {
            scope.launch { snackbarHostState.showSnackbar("Microphone permission denied") }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { 
                    Text(
                        "VibePub", 
                        color = MaterialTheme.colorScheme.onSurface, 
                        fontWeight = FontWeight.Bold 
                    ) 
                },
                actions = {
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = MaterialTheme.colorScheme.onSurface)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentAlignment = Alignment.Center
        ) {
            
            // Apple Voice Memos style Record Button
            val innerSize by animateDpAsState(targetValue = if (isRecording) 48.dp else 72.dp)
            val cornerRadius by animateDpAsState(targetValue = if (isRecording) 8.dp else 36.dp)

            Box(
                modifier = Modifier
                    .size(88.dp)
                    .clickable(
                        interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                        indication = null // Remove default ripple
                    ) {
                        if (isRecording) {
                            stopRecording()
                        } else {
                            val granted = ContextCompat.checkSelfPermission(
                                context,
                                Manifest.permission.RECORD_AUDIO,
                            ) == PackageManager.PERMISSION_GRANTED
                            if (granted) {
                                startRecording()
                            } else {
                                audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                    },
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(CircleShape)
                        .background(Color.Transparent)
                        .border(
                            width = 3.dp,
                            color = MaterialTheme.colorScheme.onSurface,
                            shape = CircleShape
                        )
                )

                // Inner morphing button
                Box(
                    modifier = Modifier
                        .size(innerSize)
                        .clip(RoundedCornerShape(cornerRadius))
                        .background(PrimaryRed),
                    contentAlignment = Alignment.Center
                ) {
                    // Invisible text for UI Testing framework
                    Text(
                        text = if (isRecording) "STOP" else "RECORD",
                        color = Color.Transparent,
                        fontSize = 1.sp
                    )
                }
            }
        }

        if (showSettings) {
            ModalBottomSheet(
                onDismissRequest = { showSettings = false },
                containerColor = MaterialTheme.colorScheme.surface
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    Text("Configuration", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
                    
                    OutlinedTextField(
                        value = apiBaseUrl,
                        onValueChange = {
                            apiBaseUrl = it
                            preferences.apiBaseUrl = it
                        },
                        label = { Text("API base URL") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = PrimaryRed,
                            focusedLabelColor = PrimaryRed,
                        )
                    )

                    OutlinedTextField(
                        value = filesToken,
                        onValueChange = {
                            filesToken = it
                            preferences.filesToken = it
                        },
                        label = { Text("FILES_TOKEN") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = PrimaryRed,
                            focusedLabelColor = PrimaryRed,
                        )
                    )
                    
                    Spacer(modifier = Modifier.height(24.dp))
                }
            }
        }
    }
}
