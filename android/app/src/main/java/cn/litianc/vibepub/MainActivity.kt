package cn.litianc.vibepub

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import cn.litianc.vibepub.ui.navigation.AppNavigation
import cn.litianc.vibepub.ui.theme.VibePubTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
                VibePubApp(preferences, recorder)
            }
        }
    }
}

@Composable
fun VibePubApp(
    preferences: AppPreferences,
    recorder: AudioRecorder
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val workManager = WorkManager.getInstance(context)

    var isRecording by remember { mutableStateOf(false) }

    fun enqueueUpload(file: File) {
        val token = preferences.filesToken
        if (token.isBlank()) {
            Toast.makeText(context, "Please configure FILES_TOKEN in Settings", Toast.LENGTH_LONG).show()
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
                    UploadWorker.KEY_API_BASE_URL to preferences.apiBaseUrl,
                    UploadWorker.KEY_FILES_TOKEN to token,
                ),
            )
            .build()

        workManager.enqueue(request)
    }

    val permissionsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val audioGranted = results[Manifest.permission.RECORD_AUDIO] == true
        if (audioGranted) {
            runCatching {
                recorder.start()
                isRecording = true
            }.onFailure {
                Toast.makeText(context, "Could not start recording", Toast.LENGTH_SHORT).show()
            }
        } else {
            Toast.makeText(context, "Microphone permission denied", Toast.LENGTH_SHORT).show()
        }
    }

    AppNavigation(
        preferences = preferences,
        onStartRecording = {
            if (isRecording) return@AppNavigation
            val audioGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (audioGranted) {
                runCatching {
                    recorder.start()
                    isRecording = true
                }
            } else {
                permissionsLauncher.launch(arrayOf(
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ))
            }
        },
        onStopRecording = {
            if (!isRecording) return@AppNavigation
            isRecording = false
            scope.launch {
                withContext(Dispatchers.IO) {
                    runCatching {
                        val (file, duration) = recorder.stop()
                        
                        // Enqueue upload
                        enqueueUpload(file)
                    }
                }
            }
        }
    )
}
