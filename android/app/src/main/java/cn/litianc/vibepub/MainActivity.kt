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
import androidx.compose.runtime.livedata.observeAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import cn.litianc.vibepub.ui.theme.PrimaryRed
import cn.litianc.vibepub.ui.theme.VibePubTheme
import kotlinx.coroutines.launch
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

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

    // Upload Queue UI State
    val workManager = WorkManager.getInstance(context)
    val uploadWorkInfos by workManager.getWorkInfosByTagLiveData("upload_job").observeAsState(emptyList())
    val queueCount = uploadWorkInfos.count { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING }

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
            .addTag("upload_job")
            .setInputData(
                workDataOf(
                    UploadWorker.KEY_FILE_PATH to file.absolutePath,
                    UploadWorker.KEY_API_BASE_URL to apiBaseUrl,
                    UploadWorker.KEY_FILES_TOKEN to filesToken,
                ),
            )
            .build()

        workManager.enqueue(request)
    }

    fun startRecording() {
        if (isRecording) return
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
        if (!isRecording) return
        isRecording = false
        scope.launch {
            withContext(Dispatchers.IO + NonCancellable) {
                runCatching {
                    val file = recorder.stop()
                    enqueueUpload(file)
                }.onFailure {
                    // Ignore failures on stop, e.g. if the recording was too short or broken
                }
            }
        }
    }

    val permissionsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val audioGranted = results[Manifest.permission.RECORD_AUDIO] == true
        if (audioGranted) {
            startRecording()
        } else {
            scope.launch { snackbarHostState.showSnackbar("Microphone permission denied") }
        }
    }

    // Lifecycle Observer for Auto-Start/Stop
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                val audioGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                if (audioGranted) {
                    startRecording()
                } else {
                    permissionsLauncher.launch(arrayOf(
                        Manifest.permission.RECORD_AUDIO,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    ))
                }
            } else if (event == Lifecycle.Event.ON_PAUSE) {
                stopRecording()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
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
                    if (queueCount > 0) {
                        Text(
                            text = "↑ $queueCount",
                            color = MaterialTheme.colorScheme.onSurface,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(end = 16.dp)
                        )
                    }
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
            
            // Apple Voice Memos style Record Button (Now purely visual / emergency stop)
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
                            val audioGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                            if (audioGranted) {
                                startRecording()
                            } else {
                                permissionsLauncher.launch(arrayOf(
                                    Manifest.permission.RECORD_AUDIO,
                                    Manifest.permission.ACCESS_COARSE_LOCATION
                                ))
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
