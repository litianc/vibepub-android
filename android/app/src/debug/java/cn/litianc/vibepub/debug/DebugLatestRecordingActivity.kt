package cn.litianc.vibepub.debug

import android.os.Bundle
import android.content.Intent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.SyncWorker
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.ui.screens.DetailScreen
import cn.litianc.vibepub.ui.theme.VibePubTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class DebugLatestRecordingActivity : ComponentActivity() {
    companion object {
        const val EXTRA_FILENAME = "filename"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            VibePubTheme {
                val context = LocalContext.current
                val preferences = remember { AppPreferences(context) }
                val lastSyncAtMs by remember(preferences) {
                    preferences.lastSyncAtMsFlow()
                }.collectAsState(initial = preferences.lastSyncAtMs)
                var filename by remember { mutableStateOf<String?>(null) }
                var loaded by remember { mutableStateOf(false) }

                fun enqueueSync() {
                    WorkManager.getInstance(context)
                        .enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())
                }

                LaunchedEffect(Unit) {
                    enqueueSync()
                    filename = withContext(Dispatchers.IO) {
                        val requestedFilename = intent.getStringExtra(EXTRA_FILENAME).orEmpty()
                        if (requestedFilename.isNotBlank()) {
                            requestedFilename
                        } else {
                            AppDatabase.getDatabase(context)
                                .recordingDao()
                                .getAllRecordings()
                                .firstOrNull()
                                ?.filename
                        }
                    }
                    loaded = true
                }

                when {
                    filename != null -> DetailScreen(
                        filename = filename.orEmpty(),
                        lastSyncAtMs = lastSyncAtMs,
                        onBackClick = { finish() },
                        onRefresh = {
                            enqueueSync()
                            Toast.makeText(context, "Debug detail refresh requested", Toast.LENGTH_SHORT).show()
                        },
                        onAutoRefresh = { enqueueSync() },
                        onRetryUpload = {
                            Toast.makeText(context, "Debug detail retry requested", Toast.LENGTH_SHORT).show()
                        },
                        onDeleteRecording = {
                            Toast.makeText(context, "Debug detail delete requested", Toast.LENGTH_SHORT).show()
                        },
                    )
                    loaded -> Text("No recordings available")
                    else -> Text("Loading latest recording...")
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        recreate()
    }
}
