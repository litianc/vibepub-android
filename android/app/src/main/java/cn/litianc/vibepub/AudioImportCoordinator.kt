package cn.litianc.vibepub

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

data class ImportedAudioFile(
    val file: File,
    val durationMs: Long,
)

object AudioImportCoordinator {
    private val supportedExtensions = setOf("m4a", "mp3", "mp4", "wav")

    suspend fun importAudio(
        context: Context,
        uri: Uri,
        now: Instant = Instant.now(),
    ): ImportedAudioFile = withContext(Dispatchers.IO) {
        val displayName = displayNameForUri(context, uri)
        val mimeType = context.contentResolver.getType(uri)
        val extension = audioImportExtension(displayName, mimeType)
            ?: throw IllegalArgumentException("Unsupported audio file type")
        val durationMs = readAudioDurationMs(context, uri)
            ?: throw IllegalArgumentException("Could not read audio duration")
        val recordingsDir = File(context.filesDir, "recordings").apply { mkdirs() }
        val destination = uniqueImportedAudioFile(
            directory = recordingsDir,
            baseName = importedAudioFileBaseName(now, durationMs),
            extension = extension,
        )
        val tempFile = File(recordingsDir, "${destination.name}.tmp")

        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                tempFile.outputStream().use { output -> input.copyTo(output) }
            } ?: throw IllegalArgumentException("Could not open selected audio file")

            check(tempFile.exists() && tempFile.length() > 0L) {
                "Selected audio file was empty"
            }

            if (!tempFile.renameTo(destination)) {
                tempFile.copyTo(destination, overwrite = false)
                check(tempFile.delete()) {
                    "Could not delete imported temporary audio file"
                }
            }
        } catch (error: Throwable) {
            tempFile.delete()
            destination.delete()
            throw error
        }

        ImportedAudioFile(file = destination, durationMs = durationMs)
    }

    internal fun audioImportExtension(displayName: String?, mimeType: String?): String? {
        val fromName = displayName
            ?.substringAfterLast('.', missingDelimiterValue = "")
            ?.lowercase(Locale.US)
            ?.takeIf { it in supportedExtensions }
        if (fromName != null) return fromName

        return when (mimeType?.lowercase(Locale.US)?.substringBefore(';')?.trim()) {
            "audio/mpeg", "audio/mp3" -> "mp3"
            "audio/mp4", "audio/x-m4a", "audio/m4a" -> "m4a"
            "video/mp4" -> "mp4"
            "audio/wav", "audio/x-wav", "audio/wave" -> "wav"
            else -> null
        }
    }

    internal fun importedAudioFileBaseName(now: Instant, durationMs: Long): String {
        val dateStr = DateTimeFormatter
            .ofPattern("yyyy-MM-dd-HHmmss")
            .withZone(ZoneId.systemDefault())
            .format(now)
        return "VibePub-$dateStr-${durationSegment(durationMs)}-Imported-Audio"
    }

    private fun durationSegment(durationMs: Long): String {
        val totalSeconds = (durationMs / 1000L).coerceAtLeast(0L)
        val minutes = totalSeconds / 60L
        val seconds = totalSeconds % 60L
        return "${minutes}m${seconds}s"
    }

    private fun uniqueImportedAudioFile(
        directory: File,
        baseName: String,
        extension: String,
    ): File {
        var candidate = File(directory, "$baseName.$extension")
        var suffix = 2
        while (candidate.exists()) {
            candidate = File(directory, "$baseName-$suffix.$extension")
            suffix += 1
        }
        return candidate
    }

    private fun displayNameForUri(context: Context, uri: Uri): String? {
        return runCatching {
            context.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            }
        }.getOrNull()
    }

    private fun readAudioDurationMs(context: Context, uri: Uri): Long? {
        return runCatching {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(context, uri)
                retriever
                    .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toLongOrNull()
                    ?.takeIf { it > 0L }
            } finally {
                retriever.release()
            }
        }.getOrNull()
    }
}
