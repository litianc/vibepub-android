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
        assertEquals(
            "再说一小会儿就可以保存",
            recordingAudioFeedback(
                secondsElapsed = 1,
                minSeconds = 2,
                amplitudeLevel = 1f,
                hasHeardAudio = true,
            ).hint,
        )
        assertEquals(
            "说几句看看音量是否有反应",
            recordingAudioFeedback(
                secondsElapsed = 3,
                minSeconds = 2,
                amplitudeLevel = 0.02f,
                hasHeardAudio = false,
            ).hint,
        )
        assertEquals(
            "停止后会自动上传并同步成文",
            recordingAudioFeedback(
                secondsElapsed = 3,
                minSeconds = 2,
                amplitudeLevel = 0.5f,
                hasHeardAudio = true,
            ).hint,
        )
    }

    @Test
    fun stopButtonRequiresMinimumDurationAndIgnoresDuplicateStops() {
        assertEquals(false, canStopRecording(secondsElapsed = 1, minSeconds = 2, isStopping = false))
        assertEquals(true, canStopRecording(secondsElapsed = 2, minSeconds = 2, isStopping = false))
        assertEquals(false, canStopRecording(secondsElapsed = 5, minSeconds = 2, isStopping = true))
    }

    @Test
    fun audioFeedbackEscalatesOnlyAfterSustainedSilence() {
        val warmingUp = recordingAudioFeedback(
            secondsElapsed = 3,
            minSeconds = 2,
            amplitudeLevel = 0.01f,
            hasHeardAudio = false,
        )
        assertEquals(RecordingAudioFeedbackState.WARMING_UP, warmingUp.state)
        assertEquals("正在检测麦克风", warmingUp.statusLabel)

        val tooQuiet = recordingAudioFeedback(
            secondsElapsed = 6,
            minSeconds = 2,
            amplitudeLevel = 0.01f,
            hasHeardAudio = false,
        )
        assertEquals(RecordingAudioFeedbackState.TOO_QUIET, tooQuiet.state)
        assertEquals("还没听到明显声音", tooQuiet.statusLabel)
        assertEquals("可以靠近麦克风一点，或检查麦克风输入", tooQuiet.hint)
    }

    @Test
    fun audioFeedbackRemembersHeardAudioDuringPauses() {
        assertEquals(false, updateHasHeardAudio(false, 0.05f))
        assertEquals(true, updateHasHeardAudio(false, 0.2f))
        assertEquals(true, updateHasHeardAudio(true, 0.0f))

        val pausedAfterSpeech = recordingAudioFeedback(
            secondsElapsed = 8,
            minSeconds = 2,
            amplitudeLevel = 0.01f,
            hasHeardAudio = true,
        )

        assertEquals(RecordingAudioFeedbackState.HEARD_AUDIO, pausedAfterSpeech.state)
        assertEquals("已听到声音，停顿也没关系", pausedAfterSpeech.hint)
    }
}
