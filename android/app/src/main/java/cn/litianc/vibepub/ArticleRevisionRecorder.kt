package cn.litianc.vibepub

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

class ArticleRevisionRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startedAtMs: Long = 0L

    val isRecording: Boolean
        get() = recorder != null

    fun start(): File {
        check(recorder == null) { "Article revision recording is already active" }
        val dir = File(context.cacheDir, "article_revisions").apply { mkdirs() }
        val file = File(dir, "revision-${System.currentTimeMillis()}.m4a")
        val mediaRecorder = createRecorder().apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(44_100)
            setAudioEncodingBitRate(96_000)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
        recorder = mediaRecorder
        outputFile = file
        startedAtMs = System.currentTimeMillis()
        return file
    }

    fun stop(): RecordedRevisionAudio {
        val activeRecorder = recorder ?: throw IllegalStateException("Article revision recording is not active")
        val file = outputFile ?: throw IllegalStateException("Article revision output file is missing")
        val durationMs = (System.currentTimeMillis() - startedAtMs).coerceAtLeast(0L)
        try {
            activeRecorder.stop()
        } finally {
            release()
        }
        return RecordedRevisionAudio(file = file, durationMs = durationMs)
    }

    fun cancel() {
        val file = outputFile
        runCatching {
            recorder?.stop()
        }
        release()
        file?.delete()
    }

    private fun release() {
        runCatching {
            recorder?.reset()
            recorder?.release()
        }
        recorder = null
        outputFile = null
        startedAtMs = 0L
    }

    private fun createRecorder(): MediaRecorder {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
    }
}

data class RecordedRevisionAudio(
    val file: File,
    val durationMs: Long,
)
