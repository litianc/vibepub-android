package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class AudioImportCoordinatorTest {
    @Test
    fun audioImportExtensionPrefersSupportedDisplayNameExtension() {
        assertEquals("mp3", AudioImportCoordinator.audioImportExtension("memo.MP3", "audio/unknown"))
        assertEquals("m4a", AudioImportCoordinator.audioImportExtension("voice.m4a", null))
        assertEquals("wav", AudioImportCoordinator.audioImportExtension("voice.wav", "application/octet-stream"))
    }

    @Test
    fun audioImportExtensionFallsBackToMimeType() {
        assertEquals("mp3", AudioImportCoordinator.audioImportExtension("memo", "audio/mpeg"))
        assertEquals("m4a", AudioImportCoordinator.audioImportExtension("memo", "audio/mp4"))
        assertEquals("mp4", AudioImportCoordinator.audioImportExtension("memo", "video/mp4"))
        assertEquals("wav", AudioImportCoordinator.audioImportExtension("memo", "audio/x-wav"))
    }

    @Test
    fun audioImportExtensionRejectsUnsupportedTypes() {
        assertNull(AudioImportCoordinator.audioImportExtension("memo.txt", "text/plain"))
        assertNull(AudioImportCoordinator.audioImportExtension("memo.flac", "audio/flac"))
    }

    @Test
    fun importedAudioFileNameKeepsVibePubDurationContract() {
        val name = AudioImportCoordinator.importedAudioFileBaseName(
            now = Instant.parse("2026-07-02T02:55:00Z"),
            durationMs = 201_500L,
        )

        assertTrue(name.startsWith("VibePub-"))
        assertTrue(name.contains("-3m21s-Imported-Audio"))
    }
}
