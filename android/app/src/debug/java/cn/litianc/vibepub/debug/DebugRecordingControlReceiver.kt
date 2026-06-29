package cn.litianc.vibepub.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.AudioRecorder
import cn.litianc.vibepub.RecordingUploadCoordinator
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

class DebugRecordingControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        DebugRecordingHarness.handle(context.applicationContext, intent.action.orEmpty()) {
            pending.finish()
        }
    }
}

private object DebugRecordingHarness {
    private const val ACTION_START = "cn.litianc.vibepub.DEBUG_START_RECORDING"
    private const val ACTION_STOP = "cn.litianc.vibepub.DEBUG_STOP_RECORDING"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var recorder: AudioRecorder? = null

    fun handle(context: Context, action: String, done: () -> Unit) {
        scope.launch {
            try {
                when (action) {
                    ACTION_START -> start(context)
                    ACTION_STOP -> stop(context)
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

    private fun enqueueUpload(context: Context, file: File): Boolean {
        val preferences = AppPreferences(context)
        return RecordingUploadCoordinator.enqueueUpload(context, preferences, file)
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
