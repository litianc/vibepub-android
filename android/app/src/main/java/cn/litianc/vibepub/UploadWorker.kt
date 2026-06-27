package cn.litianc.vibepub

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class UploadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val path = inputData.getString(KEY_FILE_PATH) ?: return@withContext Result.failure()
        val apiBaseUrl = inputData.getString(KEY_API_BASE_URL) ?: return@withContext Result.failure()
        val filesToken = inputData.getString(KEY_FILES_TOKEN).orEmpty()
        val file = File(path)

        if (!file.exists()) {
            return@withContext Result.failure()
        }

        try {
            val endpoint = URL("${apiBaseUrl.trimEnd('/')}/api/uploads")
            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 60_000
                doOutput = true
                setRequestProperty("Authorization", "Bearer $filesToken")
                setRequestProperty("Content-Type", "audio/mp4")
                setRequestProperty("X-File-Name", file.name)
                setFixedLengthStreamingMode(file.length())
            }

            file.inputStream().use { input ->
                connection.outputStream.use { output -> input.copyTo(output) }
            }

            val responseCode = connection.responseCode
            if (responseCode in 200..299) {
                cn.litianc.vibepub.data.AppDatabase.getDatabase(applicationContext)
                    .recordingDao().updateStatusByFilename(file.name, "TRANSCRIBED")
                Result.success()
            } else if (responseCode >= 500) {
                Result.retry()
            } else {
                val body = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                Result.failure(
                    androidx.work.workDataOf(
                        KEY_ERROR to JSONObject.quote(body).take(256),
                    ),
                )
            }
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        const val KEY_FILE_PATH = "file_path"
        const val KEY_API_BASE_URL = "api_base_url"
        const val KEY_FILES_TOKEN = "files_token"
        const val KEY_ERROR = "error"
    }
}
