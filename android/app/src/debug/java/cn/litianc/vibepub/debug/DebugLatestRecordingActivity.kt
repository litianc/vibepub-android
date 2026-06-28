package cn.litianc.vibepub.debug

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.ui.screens.DetailScreen
import cn.litianc.vibepub.ui.theme.VibePubTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class DebugLatestRecordingActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            VibePubTheme {
                val context = LocalContext.current
                var filename by remember { mutableStateOf<String?>(null) }
                var loaded by remember { mutableStateOf(false) }

                LaunchedEffect(Unit) {
                    filename = withContext(Dispatchers.IO) {
                        AppDatabase.getDatabase(context)
                            .recordingDao()
                            .getAllRecordings()
                            .firstOrNull()
                            ?.filename
                    }
                    loaded = true
                }

                when {
                    filename != null -> DetailScreen(
                        filename = filename.orEmpty(),
                        onBackClick = { finish() },
                    )
                    loaded -> Text("No recordings available")
                    else -> Text("Loading latest recording...")
                }
            }
        }
    }
}
