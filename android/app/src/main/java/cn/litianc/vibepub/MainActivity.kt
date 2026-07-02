package cn.litianc.vibepub

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
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
import androidx.work.ExistingWorkPolicy
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

private const val PERIODIC_SYNC_WORK_NAME = "sync_transcripts"
private const val ONE_TIME_SYNC_WORK_NAME = "sync_transcripts_now"

internal enum class SyncRequestKind {
    STARTUP,
    USER_OR_ACTIVE_PROGRESS,
}

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
        workManager.enqueueUniquePeriodicWork(PERIODIC_SYNC_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, syncRequest)
        
        // Also run once immediately on startup
        workManager.enqueueUniqueWork(
            ONE_TIME_SYNC_WORK_NAME,
            syncWorkPolicyForRequest(SyncRequestKind.STARTUP),
            OneTimeWorkRequestBuilder<SyncWorker>().build(),
        )

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
            .enqueueUniqueWork(
                ONE_TIME_SYNC_WORK_NAME,
                syncWorkPolicyForRequest(SyncRequestKind.USER_OR_ACTIVE_PROGRESS),
                OneTimeWorkRequestBuilder<SyncWorker>().build(),
            )
    }

    fun enqueueUpload(file: File, replaceExistingUpload: Boolean = false): Boolean {
        val queued = RecordingUploadCoordinator.enqueueUpload(
            context = context,
            preferences = preferences,
            file = file,
            replaceExistingUpload = replaceExistingUpload,
        )
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

    fun handleImportedAudio(uri: Uri) {
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val imported = AudioImportCoordinator.importAudio(context, uri)
                    val hasUploadToken = preferences.filesToken.isNotBlank()
                    val initialStatus = initialRecordingStatusForUploadToken(hasUploadToken)
                    val initialError = initialRecordingErrorForUploadToken(hasUploadToken)
                    val saved = RecordingUploadCoordinator.saveRecording(
                        context = context,
                        file = imported.file,
                        durationMs = imported.durationMs,
                        status = initialStatus,
                        lastError = initialError,
                    )
                    Triple(imported.file, hasUploadToken, saved)
                }
            }

            result.fold(
                onSuccess = { (file, hasUploadToken, saved) ->
                    if (!saved) {
                        Toast.makeText(context, "音频太短，已丢弃", Toast.LENGTH_SHORT).show()
                        return@fold
                    }
                    val queued = hasUploadToken && enqueueUpload(file)
                    val message = if (queued) {
                        "音频已导入，正在上传处理"
                    } else {
                        "音频已导入，请配置 FILES_TOKEN 后重试上传"
                    }
                    Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                },
                onFailure = {
                    Toast.makeText(context, importedAudioFailureToastMessage(it), Toast.LENGTH_SHORT).show()
                },
            )
        }
    }

    val audioImportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            handleImportedAudio(uri)
        }
    }

    AppNavigation(
        preferences = preferences,
        onRefresh = {
            runSync()
            Toast.makeText(context, "正在同步云端状态", Toast.LENGTH_SHORT).show()
        },
        onAutoRefresh = {
            runSync()
        },
        onRetryUpload = { recording ->
            scope.launch {
                val path = recording.localAudioPath
                val file = if (!path.isNullOrBlank()) File(path) else File(context.filesDir, "recordings/${recording.filename}")
                if (!file.exists()) {
                    withContext(Dispatchers.IO) {
                        AppDatabase.getDatabase(context)
                            .recordingDao()
                            .upsertBest(recording.copy(status = RecordingStatus.FAILED.value, lastError = "本地录音文件不存在"))
                    }
                    Toast.makeText(context, "本地录音文件不存在", Toast.LENGTH_SHORT).show()
                } else {
                    val queued = enqueueUpload(file, replaceExistingUpload = true)
                    Toast.makeText(context, retryUploadToastMessage(queued), Toast.LENGTH_SHORT).show()
                }
            }
        },
        onDeleteRecording = { recording ->
            scope.launch {
                val remoteDeleted = withContext(Dispatchers.IO) {
                    AppDatabase.getDatabase(context)
                        .recordingDao()
                        .markDeletedByFilename(recording.filename, System.currentTimeMillis())
                    recording.localAudioPath?.let { File(it).delete() }
                    File(context.filesDir, "recordings/${recording.filename}").delete()
                    File(context.filesDir, "recordings/${transcriptFileNameForRecording(recording.filename)}").delete()
                    File(context.filesDir, "recordings/${coverImageFileNameForRecording(recording.filename)}").delete()
                    deleteRemoteRecording(
                        apiBaseUrl = preferences.apiBaseUrl,
                        filesToken = preferences.filesToken,
                        filename = recording.filename,
                    )
                }
                Toast.makeText(context, deleteRecordingToastMessage(remoteDeleted), Toast.LENGTH_SHORT).show()
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
        onImportAudio = {
            audioImportLauncher.launch(arrayOf("audio/*", "video/mp4"))
        },
        onStopRecording = {
            if (!isRecording) return@AppNavigation true
            isRecording = false
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val (file, duration) = recorder.stop()
                    val hasUploadToken = preferences.filesToken.isNotBlank()
                    val initialStatus = initialRecordingStatusForUploadToken(hasUploadToken)
                    val initialError = initialRecordingErrorForUploadToken(hasUploadToken)
                    val saved = RecordingUploadCoordinator.saveRecording(
                        context = context,
                        file = file,
                        durationMs = duration,
                        status = initialStatus,
                        lastError = initialError,
                    )
                    Triple(saved, file, hasUploadToken)
                }
            }
            result.fold(
                onSuccess = { (saved, file, hasUploadToken) ->
                    if (saved) {
                        val queued = hasUploadToken && enqueueUpload(file)
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
                    isRecording = false
                    Toast.makeText(context, stopRecordingFailureToastMessage(), Toast.LENGTH_SHORT).show()
                    shouldLeaveRecordingAfterStopFailure()
                },
            )
        },
        shouldOpenRecording = openRecordingAfterPermission,
        onRecordingOpened = { openRecordingAfterPermission = false },
        currentRecordingAmplitude = recorder::currentAmplitude,
    )
}

internal fun initialRecordingStatusForUploadToken(hasUploadToken: Boolean): String {
    return if (hasUploadToken) RecordingStatus.UPLOADING.value else RecordingStatus.FAILED.value
}

internal fun initialRecordingErrorForUploadToken(hasUploadToken: Boolean): String? {
    return if (hasUploadToken) null else "请先在设置中配置 FILES_TOKEN"
}

internal fun retryUploadToastMessage(queued: Boolean): String {
    return if (queued) "已重新加入上传队列" else "请先配置 FILES_TOKEN 后重试上传"
}

internal fun deleteRecordingToastMessage(remoteDeleted: Boolean): String {
    return if (remoteDeleted) "已删除本机和云端记录" else "已删除本机记录，云端删除未完成"
}

internal fun stopRecordingFailureToastMessage(): String {
    return "保存录音失败，请重新开始录音"
}

internal fun shouldLeaveRecordingAfterStopFailure(): Boolean = true

internal fun importedAudioFailureToastMessage(error: Throwable): String {
    return if (error is IllegalArgumentException) {
        "请选择可读取的 m4a、mp3、mp4 或 wav 音频"
    } else {
        "导入音频失败，请重新选择"
    }
}

internal fun syncWorkPolicyForRequest(kind: SyncRequestKind): ExistingWorkPolicy {
    return when (kind) {
        SyncRequestKind.STARTUP -> ExistingWorkPolicy.KEEP
        SyncRequestKind.USER_OR_ACTIVE_PROGRESS -> ExistingWorkPolicy.REPLACE
    }
}
