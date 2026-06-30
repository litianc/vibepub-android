package cn.litianc.vibepub

import androidx.work.ExistingWorkPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    fun remoteRecordingDeleteUrlEncodesFilename() {
        val url = remoteRecordingDeleteUrl(
            apiBaseUrl = "https://vibepub.litianc.cn/",
            filename = "VibePub 录音 1.m4a",
        )

        assertEquals(
            "https://vibepub.litianc.cn/api/recordings/VibePub%20%E5%BD%95%E9%9F%B3%201.m4a",
            url.toString(),
        )
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

    @Test
    fun uploadWorkNameIsStablePerRecordingWithoutLeakingFilename() {
        val filename = "VibePub-2026-06-30-090000-0m18s-Tue-Morning.m4a"

        val first = RecordingUploadCoordinator.uniqueUploadWorkName(filename)
        val second = RecordingUploadCoordinator.uniqueUploadWorkName(filename)
        val other = RecordingUploadCoordinator.uniqueUploadWorkName("other-recording.m4a")

        assertEquals(first, second)
        assertTrue(first.startsWith("upload_recording-"))
        assertFalse(first.contains("VibePub"))
        assertFalse(first.contains("090000"))
        assertFalse(first.contains(".m4a"))
        assertFalse(first == other)
    }

    @Test
    fun explicitUploadRetryReplacesStaleUniqueWork() {
        assertEquals(
            ExistingWorkPolicy.KEEP,
            RecordingUploadCoordinator.uploadExistingWorkPolicy(replaceExistingUpload = false),
        )
        assertEquals(
            ExistingWorkPolicy.REPLACE,
            RecordingUploadCoordinator.uploadExistingWorkPolicy(replaceExistingUpload = true),
        )
    }

    @Test
    fun stoppedRecordingStartsWithActionableUploadState() {
        assertEquals(
            "UPLOADING",
            initialRecordingStatusForUploadToken(hasUploadToken = true),
        )
        assertNull(initialRecordingErrorForUploadToken(hasUploadToken = true))

        assertEquals(
            "FAILED",
            initialRecordingStatusForUploadToken(hasUploadToken = false),
        )
        assertEquals(
            "请先在设置中配置 FILES_TOKEN",
            initialRecordingErrorForUploadToken(hasUploadToken = false),
        )
    }

    @Test
    fun retryUploadMessageMatchesWhetherWorkWasQueued() {
        assertEquals("已重新加入上传队列", retryUploadToastMessage(queued = true))
        assertEquals("请先配置 FILES_TOKEN 后重试上传", retryUploadToastMessage(queued = false))
    }

    @Test
    fun deleteRecordingMessageReflectsRemoteResult() {
        assertEquals("已删除本机和云端记录", deleteRecordingToastMessage(remoteDeleted = true))
        assertEquals("已删除本机记录，云端删除未完成", deleteRecordingToastMessage(remoteDeleted = false))
    }

    @Test
    fun activeProgressSyncReplacesStaleOneTimeWork() {
        assertEquals(
            ExistingWorkPolicy.KEEP,
            syncWorkPolicyForRequest(SyncRequestKind.STARTUP),
        )
        assertEquals(
            ExistingWorkPolicy.REPLACE,
            syncWorkPolicyForRequest(SyncRequestKind.USER_OR_ACTIVE_PROGRESS),
        )
    }

    @Test
    fun stopRecordingFailureMessageAsksForFreshRecording() {
        assertEquals("保存录音失败，请重新开始录音", stopRecordingFailureToastMessage())
        assertTrue(shouldLeaveRecordingAfterStopFailure())
    }
}
