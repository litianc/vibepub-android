package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.json.JSONObject
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
        assertEquals("登录已失效或没有权限，请重新登录", textSubmissionFailureMessage(401, ""))
        assertEquals("登录已失效或没有权限，请重新登录", textSubmissionFailureMessage(403, ""))
        assertEquals("服务器暂时不可用，请稍后重试", textSubmissionFailureMessage(502, "bad gateway"))
    }

    @Test
    fun minimumTextLengthIsTenCharacters() {
        assertEquals(10, MIN_TEXT_SUBMISSION_CHARS)
    }

    @Test
    fun textSubmissionBodyIncludesSelectedWritingProfiles() {
        val selectedProfile = requireNotNull(WritingStyleProfiles.findById("style_product_review"))
        val json = JSONObject(
            buildTextSubmissionBody(
                text = "  这是一段足够长的文字输入  ",
                titleHint = "  产品复盘  ",
                styleProfileId = selectedProfile.id,
                styleProfileVersion = selectedProfile.version,
                styleProfileName = selectedProfile.name,
                styleProfileDescription = selectedProfile.description,
                styleProfileBody = WritingStyleProfiles.submissionBodyFor(selectedProfile),
                layoutProfileId = "wechat_clean_article",
                layoutProfileVersion = "2026-07-05",
            ),
        )

        assertEquals("这是一段足够长的文字输入", json.getString("text"))
        assertEquals("产品复盘", json.getString("title_hint"))
        assertEquals("android_text", json.getString("source"))
        assertEquals(selectedProfile.id, json.getString("style_profile_id"))
        assertEquals("2026-07-05", json.getString("style_profile_version"))
        assertEquals(selectedProfile.name, json.getString("style_profile_name"))
        assertEquals(selectedProfile.description, json.getString("style_profile_description"))
        assertEquals(selectedProfile.body?.trim(), json.getString("style_profile_body"))
        assertEquals("wechat_clean_article", json.getString("layout_profile_id"))
        assertEquals("2026-07-05", json.getString("layout_profile_version"))
    }
}
