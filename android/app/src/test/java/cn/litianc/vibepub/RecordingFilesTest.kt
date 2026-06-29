package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Test

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
}
