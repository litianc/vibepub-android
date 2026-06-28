package cn.litianc.vibepub

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
        val files = dir.listFiles()?.toList() ?: emptyList()

        // Find .m4a files that do not have a corresponding .json file yet
        val pendingFiles = files.filter { 
            it.name.endsWith(".m4a") && !File(dir, it.name.replace(".m4a", ".json")).exists()
        }

        var allSuccess = true

        for (file in pendingFiles) {
            try {
                val endpoint = URL("${apiBaseUrl.trimEnd('/')}/api/transcripts/${file.name}")
                val connection = (endpoint.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 10_000
                    readTimeout = 10_000
                    setRequestProperty("Authorization", "Bearer $filesToken")
                }

                val responseCode = connection.responseCode
                if (responseCode in 200..299) {
                    val jsonText = connection.inputStream.bufferedReader().use { it.readText() }
                    val jsonFile = File(dir, file.name.replace(".m4a", ".json"))
                    jsonFile.writeText(jsonText)
                    
                    // Mark as transcribed for legacy compat (though we rely on JSON file existence now)
                    prefs.markAsTranscribed(file.name)
                } else if (responseCode == 404) {
                    // Not ready yet, skip but don't fail worker
                } else {
                    allSuccess = false
                }
            } catch (e: Exception) {
                allSuccess = false
            }
        }

        if (allSuccess) Result.success() else Result.retry()
    }
}
