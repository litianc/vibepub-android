package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RecordingFilesTest {
    @Test
    fun mapsAnyAudioExtensionToTranscriptJson() {
        assertEquals("voice.json", transcriptFileNameForRecording("voice.m4a"))
        assertEquals("voice.json", transcriptFileNameForRecording("voice.mp3"))
        assertEquals("voice.json", transcriptFileNameForRecording("voice"))
    }

    @Test
    fun choosesUploadContentTypeFromExtension() {
        assertEquals("audio/mp4", audioContentTypeForFilename("voice.m4a"))
        assertEquals("audio/mpeg", audioContentTypeForFilename("voice.mp3"))
        assertEquals("application/octet-stream", audioContentTypeForFilename("voice.unknown"))
    }

    @Test
    fun rejectsTooShortOrEmptyRecordingsBeforeTheyReachRoom() {
        val audioFile = File.createTempFile("vibepub-recording", ".m4a").apply {
            writeText("audio")
            deleteOnExit()
        }

        assertFalse(
            RecordingUploadCoordinator.shouldSaveRecording(
                file = audioFile,
                durationMs = RecordingUploadCoordinator.MIN_RECORDING_DURATION_MS - 1L,
            ),
        )

        audioFile.writeText("")
        assertFalse(
            RecordingUploadCoordinator.shouldSaveRecording(
                file = audioFile,
                durationMs = RecordingUploadCoordinator.MIN_RECORDING_DURATION_MS,
            ),
        )

        audioFile.writeText("audio")
        assertTrue(
            RecordingUploadCoordinator.shouldSaveRecording(
                file = audioFile,
                durationMs = RecordingUploadCoordinator.MIN_RECORDING_DURATION_MS,
            ),
        )
    }
}
