package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WritingStyleProfilesTest {
    @Test
    fun builtInProfilesExposeDefaultAndMarketplaceSeeds() {
        assertEquals("style_litianc_default", WritingStyleProfiles.defaultStyleProfile.id)
        assertEquals(4, WritingStyleProfiles.builtIn.size)
        assertNotNull(WritingStyleProfiles.findById("style_product_review"))
        assertNotNull(WritingStyleProfiles.findById("style_technical_note"))
        assertNotNull(WritingStyleProfiles.findById("style_public_explainer"))
    }

    @Test
    fun unknownProfileFallsBackToDefault() {
        assertEquals(
            WritingStyleProfiles.defaultStyleProfile,
            WritingStyleProfiles.optionFor("style_not_installed"),
        )
    }

    @Test
    fun customProfilesRoundTripThroughJson() {
        val profile = WritingStyleProfiles.newCustomProfile(
            name = "我的产品复盘风格",
            description = "保留具体排查过程",
            body = "请用真实克制的产品复盘风格写作。",
            nowMs = 1_782_854_400_000L,
        )

        val decoded = WritingStyleProfiles.decodeCustomProfiles(
            WritingStyleProfiles.encodeCustomProfiles(listOf(profile)),
        )

        assertEquals(1, decoded.size)
        assertEquals("我的产品复盘风格", decoded.first().name)
        assertEquals("请用真实克制的产品复盘风格写作。", decoded.first().body)
        assertEquals(true, decoded.first().custom)
    }

    @Test
    fun remoteProfilesRoundTripThroughJsonAndCanBeSelected() {
        val profile = WritingStyleProfileOption(
            id = "style_my_old_articles",
            version = "2026-07-05T12:00:00Z",
            name = "我的旧文风格",
            description = "从旧文章蒸馏出来的风格。",
            remote = true,
        )

        val decoded = WritingStyleProfiles.decodeRemoteProfiles(
            WritingStyleProfiles.encodeRemoteProfiles(listOf(profile)),
        )

        assertEquals(1, decoded.size)
        assertEquals("style_my_old_articles", decoded.first().id)
        assertEquals(true, decoded.first().remote)
        assertEquals(
            "我的旧文风格",
            WritingStyleProfiles.optionFor(
                id = "style_my_old_articles",
                remoteProfiles = decoded,
            ).name,
        )
    }

    @Test
    fun voiceTurnsAppendToCustomPromptBody() {
        val first = WritingStyleProfiles.mergeStylePromptTurn(
            existingBody = "",
            turnText = "开头直接说结论，不要像营销文",
        )
        val second = WritingStyleProfiles.mergeStylePromptTurn(
            existingBody = first,
            turnText = "保留具体排查过程",
        )

        assertEquals(true, second.contains("开头直接说结论"))
        assertEquals(true, second.contains("保留具体排查过程"))
    }
}
