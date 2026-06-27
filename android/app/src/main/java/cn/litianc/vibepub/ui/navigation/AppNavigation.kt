package cn.litianc.vibepub.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import cn.litianc.vibepub.data.AppDatabase
import cn.litianc.vibepub.ui.screens.DetailScreen
import cn.litianc.vibepub.ui.screens.HomeScreen
import cn.litianc.vibepub.ui.screens.RecordingScreen
import cn.litianc.vibepub.ui.screens.SettingsScreen

@Composable
fun AppNavigation(
    database: AppDatabase,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit
) {
    val navController = rememberNavController()
    
    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            HomeScreen(
                recordingsFlow = database.recordingDao().getAllRecordings(),
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
