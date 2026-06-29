package cn.litianc.vibepub

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingStatus
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
            updateLocalStatus(file.name, RecordingStatus.FAILED, "本地录音文件不存在")
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
                updateLocalStatus(file.name, RecordingStatus.UPLOADED, null)
                Result.success()
            } else if (responseCode >= 500) {
                updateLocalStatus(file.name, RecordingStatus.UPLOADING, "服务器暂时不可用，稍后自动重试")
                Result.retry()
            } else {
                val body = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val message = if (responseCode == 401 || responseCode == 403) {
                    "FILES_TOKEN 无效或没有权限"
                } else {
                    "上传失败 HTTP $responseCode"
                }
                updateLocalStatus(file.name, RecordingStatus.FAILED, message)
                Result.failure(
                    androidx.work.workDataOf(
                        KEY_ERROR to JSONObject.quote(body).take(256),
                    ),
                )
            }
        } catch (error: Exception) {
            updateLocalStatus(file.name, RecordingStatus.UPLOADING, "网络异常，稍后自动重试")
            Result.retry()
        }
    }

    private suspend fun updateLocalStatus(
        filename: String,
        status: RecordingStatus,
        error: String?,
    ) {
        val dao = AppDatabase.getDatabase(applicationContext).recordingDao()
        val entity = dao.getRecordingByFilename(filename) ?: return
        if (entity.status == RecordingStatus.COMPLETED.value && status != RecordingStatus.COMPLETED) {
            return
        }
        dao.insert(
            entity.copy(
                status = status.value,
                lastError = error,
            ),
        )
    }

    companion object {
        const val KEY_FILE_PATH = "file_path"
        const val KEY_API_BASE_URL = "api_base_url"
        const val KEY_FILES_TOKEN = "files_token"
        const val KEY_ERROR = "error"
    }
}
