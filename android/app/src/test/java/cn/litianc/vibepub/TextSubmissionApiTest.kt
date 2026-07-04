package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TextSubmissionApiTest {
    @Test
    fun failureMessageUsesBackendValidationMessage() {
        assertEquals(
            "文字太短，请再补充一些想法",
            textSubmissionFailureMessage(400, """{"message":"文字太短，请再补充一些想法"}"""),
        )
    }

    @Test
    fun failureMessageHandlesAuthAndServerErrors() {
        assertEquals("FILES_TOKEN 无效或没有权限", textSubmissionFailureMessage(401, ""))
        assertEquals("FILES_TOKEN 无效或没有权限", textSubmissionFailureMessage(403, ""))
        assertEquals("服务器暂时不可用，请稍后重试", textSubmissionFailureMessage(502, "bad gateway"))
    }

    @Test
    fun minimumTextLengthIsTenCharacters() {
        assertEquals(10, MIN_TEXT_SUBMISSION_CHARS)
    }
}
