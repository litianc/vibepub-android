package cn.litianc.vibepub.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.AudioRecorder
import cn.litianc.vibepub.RecordingUploadCoordinator
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

class DebugRecordingControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        DebugRecordingHarness.handle(context.applicationContext, intent) {
            pending.finish()
        }
    }
}

private object DebugRecordingHarness {
    private const val ACTION_START = "cn.litianc.vibepub.DEBUG_START_RECORDING"
    private const val ACTION_STOP = "cn.litianc.vibepub.DEBUG_STOP_RECORDING"
    private const val ACTION_IMPORT_AUDIO = "cn.litianc.vibepub.DEBUG_IMPORT_AUDIO"
    private const val EXTRA_AUDIO_PATH = "audio_path"
    private const val EXTRA_DURATION_MS = "duration_ms"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var recorder: AudioRecorder? = null

    fun handle(context: Context, intent: Intent, done: () -> Unit) {
        scope.launch {
            try {
                when (val action = intent.action.orEmpty()) {
                    ACTION_START -> start(context)
                    ACTION_STOP -> stop(context)
                    ACTION_IMPORT_AUDIO -> importAudio(context, intent)
                    else -> writeStatus(context, "UNKNOWN_ACTION", error = action)
                }
            } catch (error: Throwable) {
                writeStatus(context, "ERROR", error = error.stackTraceToString())
            } finally {
                done()
            }
        }
    }

    private fun start(context: Context) {
        if (recorder != null) {
            writeStatus(context, "ALREADY_RECORDING")
            return
        }

        val nextRecorder = AudioRecorder(context)
        nextRecorder.start()
        recorder = nextRecorder
        writeStatus(context, "STARTED")
    }

    private suspend fun stop(context: Context) {
        val activeRecorder = recorder
        if (activeRecorder == null) {
            writeStatus(context, "NOT_RECORDING")
            return
        }

        val (file, durationMs) = activeRecorder.stop()
        recorder = null

        RecordingUploadCoordinator.saveRecording(context, file, durationMs)

        writeStatus(
            context = context,
            status = if (enqueueUpload(context, file)) "STOPPED" else "STOPPED_WITHOUT_UPLOAD_TOKEN",
            filename = file.name,
            durationMs = durationMs,
        )
    }

    private suspend fun importAudio(context: Context, intent: Intent) {
        if (recorder != null) {
            writeStatus(context, "ALREADY_RECORDING")
            return
        }

        val sourcePath = intent.getStringExtra(EXTRA_AUDIO_PATH).orEmpty()
        if (sourcePath.isBlank()) {
            writeStatus(context, "ERROR", error = "Missing $EXTRA_AUDIO_PATH")
            return
        }

        val source = resolveAudioFile(context, sourcePath)
        if (!source.exists() || source.length() <= 0L) {
            writeStatus(context, "ERROR", error = "Source audio not found: ${source.absolutePath}")
            return
        }

        val durationMs = intent.getLongExtra(EXTRA_DURATION_MS, 0L)
            .takeIf { it > 0L }
            ?: readDurationMs(source)
            ?: 1_000L
        val destination = nextImportedRecordingFile(context, source, durationMs)
        source.copyTo(destination, overwrite = false)

        RecordingUploadCoordinator.saveRecording(context, destination, durationMs)

        writeStatus(
            context = context,
            status = if (enqueueUpload(context, destination)) "IMPORTED" else "IMPORTED_WITHOUT_UPLOAD_TOKEN",
            filename = destination.name,
            durationMs = durationMs,
        )
    }

    private fun enqueueUpload(context: Context, file: File): Boolean {
        val preferences = AppPreferences(context)
        return RecordingUploadCoordinator.enqueueUpload(context, preferences, file)
    }

    private fun resolveAudioFile(context: Context, path: String): File {
        val file = File(path)
        return if (file.isAbsolute) file else File(context.filesDir, path)
    }

    private fun nextImportedRecordingFile(context: Context, source: File, durationMs: Long): File {
        val recordingsDir = File(context.filesDir, "recordings").apply { mkdirs() }
        val dateStr = SimpleDateFormat("yyyy-MM-dd-HHmmss", Locale.US).format(Date())
        val durationSecs = (durationMs / 1000).coerceAtLeast(0)
        val durationStr = "${durationSecs / 60}m${durationSecs % 60}s"
        val extension = source.extension
            .lowercase(Locale.US)
            .replace(Regex("[^a-z0-9]"), "")
            .ifBlank { "audio" }
        return File(recordingsDir, "VibePub-$dateStr-$durationStr-Debug-Audio-Import.$extension")
    }

    private fun readDurationMs(file: File): Long? {
        return runCatching {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(file.absolutePath)
                retriever
                    .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toLongOrNull()
                    ?.takeIf { it > 0L }
            } finally {
                retriever.release()
            }
        }.getOrNull()
    }

    private fun writeStatus(
        context: Context,
        status: String,
        filename: String? = null,
        durationMs: Long? = null,
        error: String? = null,
    ) {
        val json = JSONObject()
            .put("status", status)
            .put("timestampMs", System.currentTimeMillis())

        if (filename != null) json.put("filename", filename)
        if (durationMs != null) json.put("durationMs", durationMs)
        if (error != null) json.put("error", error.take(4000))

        File(context.filesDir, "debug-device-test-status.json").writeText(json.toString(2))
    }
}
