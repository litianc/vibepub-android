package cn.litianc.vibepub.ui.navigation

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import cn.litianc.vibepub.data.AppDatabase

@Composable
fun AppNavigation(
    preferences: AppPreferences,
    onRefresh: () -> Unit,
    onAutoRefresh: () -> Unit,
    onRetryUpload: (RecordingEntity) -> Unit,
    onDeleteRecording: (RecordingEntity) -> Unit,
    onStartRecording: () -> Boolean,
    onImportAudio: () -> Unit,
    onStopRecording: suspend () -> Boolean,
    shouldOpenRecording: Boolean = false,
    onRecordingOpened: () -> Unit = {},
    currentRecordingAmplitude: () -> Int,
) {
    val navController = rememberNavController()
    val context = LocalContext.current
    
    val recordingsFlow = remember {
        AppDatabase.getDatabase(context).recordingDao().getAllRecordingsFlow()
    }
    val lastSyncAtMs by remember(preferences) {
        preferences.lastSyncAtMsFlow()
    }.collectAsState(initial = preferences.lastSyncAtMs)

    LaunchedEffect(shouldOpenRecording) {
        if (shouldNavigateToRecording(shouldOpenRecording)) {
            navController.navigate("recording") {
                launchSingleTop = true
            }
            onRecordingOpened()
        }
    }
    
    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            HomeScreen(
                recordingsFlow = recordingsFlow,
                lastSyncAtMs = lastSyncAtMs,
                onSettingsClick = { navController.navigate("settings") },
                onRefresh = onRefresh,
                onAutoRefresh = onAutoRefresh,
                onRetryUpload = onRetryUpload,
                onDeleteRecording = onDeleteRecording,
                onRecordClick = {
                    if (onStartRecording()) {
                        navController.navigate("recording")
                    }
                },
                onImportAudioClick = onImportAudio,
                onRecordingClick = { recording ->
                    navController.navigate("detail/${Uri.encode(recording.filename)}")
                }
            )
        }
        
        composable("recording") {
            RecordingScreen(
                amplitudeProvider = currentRecordingAmplitude,
                onStopClick = {
                    if (onStopRecording()) {
                        navController.popBackStack()
                        true
                    } else {
                        false
                    }
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
                lastSyncAtMs = lastSyncAtMs,
                onBackClick = { navController.popBackStack() },
                onRefresh = onRefresh,
                onAutoRefresh = onAutoRefresh,
                onRetryUpload = onRetryUpload,
                onDeleteRecording = onDeleteRecording,
            )
        }
    }
}

internal fun shouldNavigateToRecording(shouldOpenRecording: Boolean): Boolean = shouldOpenRecording
