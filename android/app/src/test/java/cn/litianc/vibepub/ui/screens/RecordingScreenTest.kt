package cn.litianc.vibepub.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingScreenTest {
    @Test
    fun normalizesRecorderAmplitudeIntoUiLevel() {
        assertEquals(0f, normalizeAmplitude(0), 0.001f)
        assertEquals(1f, normalizeAmplitude(32_767), 0.001f)
        assertTrue(normalizeAmplitude(4_000) in 0.7f..0.9f)
    }

    @Test
    fun recordingHintKeepsMinDurationAndLowVolumeGuidance() {
        assertEquals("再说一小会儿就可以保存", recordingHint(secondsElapsed = 1, minSeconds = 2, amplitudeLevel = 1f))
        assertEquals("音量偏低，可以靠近麦克风一点", recordingHint(secondsElapsed = 3, minSeconds = 2, amplitudeLevel = 0.02f))
        assertEquals("停止后会自动上传并同步成文", recordingHint(secondsElapsed = 3, minSeconds = 2, amplitudeLevel = 0.5f))
    }
}
