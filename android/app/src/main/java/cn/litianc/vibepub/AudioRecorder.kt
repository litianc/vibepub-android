package cn.litianc.vibepub

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

class AudioRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    fun start(): File {
        check(recorder == null) { "Recorder is already running" }

        val recordingsDir = File(context.filesDir, "recordings").apply { mkdirs() }
        val timestamp = DateTimeFormatter
            .ofPattern("yyyyMMdd-HHmmss")
            .withZone(ZoneOffset.UTC)
            .format(Instant.now())
        val file = File(recordingsDir, "vibepub-$timestamp.m4a")

        val nextRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        nextRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        nextRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        nextRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        nextRecorder.setAudioEncodingBitRate(128_000)
        nextRecorder.setAudioSamplingRate(44_100)
        nextRecorder.setOutputFile(file.absolutePath)
        nextRecorder.prepare()
        nextRecorder.start()

        recorder = nextRecorder
        outputFile = file
        return file
    }

    fun stop(): File {
        val file = checkNotNull(outputFile) { "No recording is active" }
        val activeRecorder = checkNotNull(recorder) { "No recording is active" }

        try {
            activeRecorder.stop()
        } catch (error: RuntimeException) {
            file.delete()
            throw error
        } finally {
            activeRecorder.release()
            recorder = null
            outputFile = null
        }

        return file
    }
}
