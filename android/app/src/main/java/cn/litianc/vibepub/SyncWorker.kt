package cn.litianc.vibepub

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.data.RecordingEntity
import org.json.JSONObject

class SyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val prefs = AppPreferences(applicationContext)
        val apiBaseUrl = prefs.apiBaseUrl
        val filesToken = prefs.filesToken

        if (filesToken.isBlank()) {
            return@withContext Result.failure()
        }

        val dir = File(applicationContext.filesDir, "recordings")
        val dao = AppDatabase.getDatabase(applicationContext).recordingDao()

        // Sync missing recordings from D1
        try {
            val endpoint = URL("${apiBaseUrl.trimEnd('/')}/api/recordings")
            val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("Authorization", "Bearer $filesToken")
            }
            if (connection.responseCode in 200..299) {
                val jsonText = connection.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(jsonText)
                val recordingsArray = json.optJSONArray("recordings")
                if (recordingsArray != null) {
                    for (i in 0 until recordingsArray.length()) {
                        val recObj = recordingsArray.getJSONObject(i)
                        val filename = recObj.optString("filename")
                        if (filename.isBlank()) continue
                        val existing = dao.getRecordingByFilename(filename)
                        val d1Status = recObj.optString("status", "UPLOADED")
                        if (existing == null) {
                            dao.insert(RecordingEntity(
                                filename = filename,
                                durationMs = 0L,
                                timestamp = System.currentTimeMillis(), // use current for now
                                status = d1Status
                            ))
                        } else if (existing.status != d1Status && existing.status != "COMPLETED") {
                            dao.insert(existing.copy(status = d1Status))
                        }
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        val recordings = dao.getAllRecordings()

        var allSuccess = true

        for (recording in recordings) {
            val jsonFile = File(dir, recording.filename.replace(".m4a", ".json"))
            if (!jsonFile.exists()) {
                try {
                    val encodedFilename = URLEncoder.encode(recording.filename, "UTF-8").replace("+", "%20")
                    val endpoint = URL("${apiBaseUrl.trimEnd('/')}/api/transcripts/$encodedFilename")
                    val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 10_000
                        readTimeout = 10_000
                        setRequestProperty("Authorization", "Bearer $filesToken")
                    }

                    val responseCode = connection.responseCode
                    if (responseCode in 200..299) {
                        val jsonText = connection.inputStream.bufferedReader().use { it.readText() }
                        dir.mkdirs()
                        jsonFile.writeText(jsonText)
                        dao.insert(recording.copy(status = "COMPLETED"))
                    } else if (responseCode == 404) {
                        // Not ready yet
                    } else {
                        allSuccess = false
                    }
                } catch (e: Exception) {
                    allSuccess = false
                }
            } else {
                // Ensure room reflects COMPLETED
                if (recording.status != "COMPLETED") {
                    dao.insert(recording.copy(status = "COMPLETED"))
                }
            }
        }

        if (allSuccess) Result.success() else Result.retry()
    }
}
