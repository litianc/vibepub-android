package cn.litianc.vibepub

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StyleSourceShareTest {
    @Test
    fun parsesWechatArticleShareText() {
        val source = sharedStyleSourceFromIntent(
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TITLE, "Voice Drop 更新")
                putExtra(Intent.EXTRA_TEXT, "Voice Drop 迎来更新 https://mp.weixin.qq.com/s/example")
            },
        )

        assertEquals("wechat_article", source?.sourceType)
        assertEquals("Voice Drop 更新", source?.title)
        assertEquals("https://mp.weixin.qq.com/s/example", source?.url)
        assertEquals("Voice Drop 迎来更新 https://mp.weixin.qq.com/s/example", source?.text)
    }

    @Test
    fun parsesPlainTextShareAsStyleSource() {
        val source = sharedStyleSourceFromIntent(
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, "这是一段我喜欢的旧文风格。")
            },
        )

        assertEquals("text", source?.sourceType)
        assertNull(source?.url)
        assertEquals("这是一段我喜欢的旧文风格。", source?.text)
    }

    @Test
    fun ignoresUnsupportedIntent() {
        assertNull(sharedStyleSourceFromIntent(Intent(Intent.ACTION_VIEW)))
    }
}
