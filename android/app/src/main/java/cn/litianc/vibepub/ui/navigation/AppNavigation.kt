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
    
    val recordingsFlow = remember {
        flow {
            while (true) {
                val dir = File(context.filesDir, "recordings")
                val files = dir.listFiles()?.toList() ?: emptyList()
                val transcribed = preferences.transcribedFiles
                val recordings = files.mapIndexed { index, file ->
                    // filename: VoiceDrop-2026-06-27-223000-0m15s-Sat-Evening.m4a
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
                    val status = if (transcribed.contains(file.name)) "TRANSCRIBED" else "UPLOADED"
                    RecordingEntity(index, file.name, durationMs, timestamp, status)
                }.sortedByDescending { it.timestamp }
                
                emit(recordings)
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
                    navController.navigate("detail/${recording.id}")
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
        
        composable("detail/{id}") { backStackEntry ->
            val idStr = backStackEntry.arguments?.getString("id")
            DetailScreen(
                recordingId = idStr?.toIntOrNull() ?: 0,
                onBackClick = { navController.popBackStack() }
            )
        }
    }
}
