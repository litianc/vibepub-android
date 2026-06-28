package cn.litianc.vibepub.ui.navigation

import android.net.Uri
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

import cn.litianc.vibepub.data.AppDatabase

@Composable
fun AppNavigation(
    preferences: AppPreferences,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit
) {
    val navController = rememberNavController()
    val context = LocalContext.current
    
    val recordingsFlow = remember {
        AppDatabase.getDatabase(context).recordingDao().getAllRecordingsFlow()
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
                    navController.navigate("detail/${Uri.encode(recording.filename)}")
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
