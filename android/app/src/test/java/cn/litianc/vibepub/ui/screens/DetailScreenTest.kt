package cn.litianc.vibepub.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class DetailScreenTest {
    @Test
    fun renderArticleTextConvertsHtmlToReadableText() {
        val rendered = renderArticleText(
            "<p>第一段</p><h3>小标题</h3><p>第二段<br>下一行</p>",
        )

        assertFalse(rendered.contains("<p>"))
        assertFalse(rendered.contains("<h3>"))
        assertEquals("第一段\n\n小标题\n\n第二段\n下一行", rendered)
    }
}
