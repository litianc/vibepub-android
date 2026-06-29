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
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.WorkManager
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingStatus
import cn.litianc.vibepub.ui.navigation.AppNavigation
import cn.litianc.vibepub.ui.theme.VibePubTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {
    private lateinit var preferences: AppPreferences
    private lateinit var recorder: AudioRecorder

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        preferences = AppPreferences(this)
        recorder = AudioRecorder(this)
        
        // Schedule SyncWorker
        val workManager = WorkManager.getInstance(this)
        val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        workManager.enqueueUniquePeriodicWork("sync_transcripts", ExistingPeriodicWorkPolicy.KEEP, syncRequest)
        
        // Also run once immediately on startup
        workManager.enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())

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

    var isRecording by remember { mutableStateOf(false) }
    var openRecordingAfterPermission by remember { mutableStateOf(false) }

    fun runSync() {
        WorkManager.getInstance(context)
            .enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())
    }

    fun enqueueUpload(file: File): Boolean {
        val queued = RecordingUploadCoordinator.enqueueUpload(context, preferences, file)
        if (!queued) {
            Toast.makeText(context, "请先在设置中配置 FILES_TOKEN", Toast.LENGTH_LONG).show()
        }
        return queued
    }

    val permissionsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val audioGranted = results[Manifest.permission.RECORD_AUDIO] == true
        if (audioGranted) {
            runCatching {
                recorder.start()
                isRecording = true
                openRecordingAfterPermission = true
            }.onFailure {
                Toast.makeText(context, "无法开始录音", Toast.LENGTH_SHORT).show()
            }
        } else {
            Toast.makeText(context, "需要麦克风权限才能录音", Toast.LENGTH_SHORT).show()
        }
    }

    AppNavigation(
        preferences = preferences,
        onRefresh = {
            runSync()
            Toast.makeText(context, "正在同步云端状态", Toast.LENGTH_SHORT).show()
        },
        onRetryUpload = { recording ->
            scope.launch {
                val path = recording.localAudioPath
                val file = if (!path.isNullOrBlank()) File(path) else File(context.filesDir, "recordings/${recording.filename}")
                if (!file.exists()) {
                    withContext(Dispatchers.IO) {
                        AppDatabase.getDatabase(context)
                            .recordingDao()
                            .insert(recording.copy(status = RecordingStatus.FAILED.value, lastError = "本地录音文件不存在"))
                    }
                    Toast.makeText(context, "本地录音文件不存在", Toast.LENGTH_SHORT).show()
                } else {
                    enqueueUpload(file)
                    Toast.makeText(context, "已重新加入上传队列", Toast.LENGTH_SHORT).show()
                }
            }
        },
        onDeleteRecording = { recording ->
            scope.launch(Dispatchers.IO) {
                AppDatabase.getDatabase(context).recordingDao().deleteByFilename(recording.filename)
                recording.localAudioPath?.let { File(it).delete() }
                File(context.filesDir, "recordings/${recording.filename}").delete()
                File(context.filesDir, "recordings/${transcriptFileNameForRecording(recording.filename)}").delete()
            }
        },
        onStartRecording = {
            if (isRecording) return@AppNavigation false
            val audioGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (audioGranted) {
                runCatching {
                    recorder.start()
                    isRecording = true
                }.onFailure {
                    Toast.makeText(context, "无法开始录音", Toast.LENGTH_SHORT).show()
                }.isSuccess
            } else {
                permissionsLauncher.launch(arrayOf(
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ))
                false
            }
        },
        onStopRecording = {
            if (!isRecording) return@AppNavigation true
            isRecording = false
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val (file, duration) = recorder.stop()
                    val saved = RecordingUploadCoordinator.saveRecording(context, file, duration)
                    saved to file
                }
            }
            result.fold(
                onSuccess = { (saved, file) ->
                    if (saved) {
                        val queued = enqueueUpload(file)
                        val message = if (queued) {
                            "录音已保存，正在上传处理"
                        } else {
                            "录音已保存，请配置 FILES_TOKEN 后重试上传"
                        }
                        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(context, "录音太短，已丢弃", Toast.LENGTH_SHORT).show()
                    }
                    true
                },
                onFailure = {
                    isRecording = true
                    Toast.makeText(context, "保存录音失败，请再试一次", Toast.LENGTH_SHORT).show()
                    false
                },
            )
        },
        shouldOpenRecording = openRecordingAfterPermission,
        onRecordingOpened = { openRecordingAfterPermission = false },
        currentRecordingAmplitude = recorder::currentAmplitude,
    )
}
