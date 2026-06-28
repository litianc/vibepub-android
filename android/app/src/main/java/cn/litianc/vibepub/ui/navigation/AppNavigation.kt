package cn.litianc.vibepub.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import cn.litianc.vibepub.AppPreferences
import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.ui.screens.DetailScreen
import cn.litianc.vibepub.ui.screens.HomeScreen
import cn.litianc.vibepub.ui.screens.RecordingScreen
import cn.litianc.vibepub.ui.screens.SettingsScreen
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.io.File

@Composable
fun AppNavigation(
    preferences: AppPreferences,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit
) {
    val navController = rememberNavController()
    val context = LocalContext.current
    
    val isRunningTest = remember {
        try {
            Class.forName("org.robolectric.Robolectric")
            true
        } catch (e: Exception) {
            false
        }
    }

    val recordingsFlow = remember {
        flow {
            while (true) {
                val dir = File(context.filesDir, "recordings")
                val files = dir.listFiles()?.filter { it.name.endsWith(".m4a") }?.toList() ?: emptyList()
                val recordings = files.mapIndexed { index, file ->
                    // filename: VibePub-2026-06-27-223000-0m15s-Sat-Evening.m4a
                    var durationMs = 0L
                    try {
                        val parts = file.name.split("-")
                        if (parts.size >= 5) {
                            val durationStr = parts[3]
                            val mins = durationStr.substringBefore("m").toLongOrNull() ?: 0L
                            val secs = durationStr.substringAfter("m").substringBefore("s").toLongOrNull() ?: 0L
                            durationMs = (mins * 60 + secs) * 1000
                        }
                    } catch (e: Exception) {
                        // ignore parsing errors
                    }
                    
                    val timestamp = file.lastModified()
                    val hasJson = File(dir, file.name.replace(".m4a", ".json")).exists()
                    val status = if (hasJson) "TRANSCRIBED" else "UPLOADED"
                    RecordingEntity(index, file.name, durationMs, timestamp, status)
                }.sortedByDescending { it.timestamp }
                
                emit(recordings)
                if (isRunningTest) break
                delay(1000)
            }
        }
    }
    
    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            HomeScreen(
                recordingsFlow = recordingsFlow,
                onSettingsClick = { navController.navigate("settings") },
                onRecordClick = {
                    onStartRecording()
                    navController.navigate("recording")
                },
                onRecordingClick = { recording ->
                    navController.navigate("detail/${recording.filename}")
                }
            )
        }
        
        composable("recording") {
            RecordingScreen(
                onStopClick = {
                    onStopRecording()
                    navController.popBackStack()
                }
            )
        }
        
        composable("settings") {
            SettingsScreen(
                onBackClick = { navController.popBackStack() }
            )
        }
        
        composable("detail/{filename}") { backStackEntry ->
            val filename = backStackEntry.arguments?.getString("filename") ?: ""
            DetailScreen(
                filename = filename,
                onBackClick = { navController.popBackStack() }
            )
        }
    }
}
