package cn.litianc.vibepub.ui.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppNavigationTest {
    @Test
    fun permissionGrantedRecordingSignalNavigatesOnce() {
        assertTrue(shouldNavigateToRecording(shouldOpenRecording = true))
        assertFalse(shouldNavigateToRecording(shouldOpenRecording = false))
    }
}
