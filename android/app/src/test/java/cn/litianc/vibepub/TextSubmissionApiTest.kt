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
        assertEquals("FILES_TOKEN 无效或没有权限", textSubmissionFailureMessage(401, ""))
        assertEquals("FILES_TOKEN 无效或没有权限", textSubmissionFailureMessage(403, ""))
        assertEquals("服务器暂时不可用，请稍后重试", textSubmissionFailureMessage(502, "bad gateway"))
    }

    @Test
    fun minimumTextLengthIsTenCharacters() {
        assertEquals(10, MIN_TEXT_SUBMISSION_CHARS)
    }

    @Test
    fun textSubmissionBodyIncludesSelectedWritingProfiles() {
        val json = JSONObject(
            buildTextSubmissionBody(
                text = "  这是一段足够长的文字输入  ",
                titleHint = "  产品复盘  ",
                styleProfileId = "style_product_review",
                styleProfileVersion = "2026-07-05",
                styleProfileName = "我的产品复盘风格",
                styleProfileDescription = "保留具体排查过程",
                styleProfileBody = "请用真实克制的产品复盘风格写作。",
                layoutProfileId = "wechat_clean_article",
                layoutProfileVersion = "2026-07-05",
            ),
        )

        assertEquals("这是一段足够长的文字输入", json.getString("text"))
        assertEquals("产品复盘", json.getString("title_hint"))
        assertEquals("android_text", json.getString("source"))
        assertEquals("style_product_review", json.getString("style_profile_id"))
        assertEquals("2026-07-05", json.getString("style_profile_version"))
        assertEquals("我的产品复盘风格", json.getString("style_profile_name"))
        assertEquals("保留具体排查过程", json.getString("style_profile_description"))
        assertEquals("请用真实克制的产品复盘风格写作。", json.getString("style_profile_body"))
        assertEquals("wechat_clean_article", json.getString("layout_profile_id"))
        assertEquals("2026-07-05", json.getString("layout_profile_version"))
    }
}
