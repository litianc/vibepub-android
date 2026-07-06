package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Test

class StyleProfileNameHintTest {
    @Test
    fun buildsCompactStyleNameHintFromImportedTitle() {
        val source = SharedStyleSource(
            sourceType = "wechat_article",
            title = null,
            url = "https://mp.weixin.qq.com/s/example",
            text = null,
            autoDistill = true,
        )

        assertEquals(
            "王建硕：一个产品人的现场笔记风格",
            styleProfileNameHintForSource(source, "王建硕：一个产品人的现场笔记"),
        )
    }

    @Test
    fun fallsBackToWechatArticleStyleName() {
        val source = SharedStyleSource(
            sourceType = "wechat_article",
            title = null,
            url = "https://mp.weixin.qq.com/s/example",
            text = null,
            autoDistill = true,
        )

        assertEquals("微信文章风格", styleProfileNameHintForSource(source, null))
    }
}
