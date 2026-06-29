package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DetailScreenTest {
    @Test
    fun renderArticleTextConvertsHtmlToReadableText() {
        val rendered = renderArticleText(
            "<p>第一段</p><h3>小标题</h3><p>第二段<br>下一行</p>",
        )

        assertFalse(rendered, rendered.contains("<p>"))
        assertFalse(rendered, rendered.contains("<h3>"))
        assertEquals("第一段\n\n小标题\n\n第二段\n下一行", rendered)
    }

    @Test
    fun reviewSummaryMarksCompletedDraftReady() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.COMPLETED,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            rawText = "原始识别文本",
            wechatDraftId = "MEDIA_ID_123",
        )

        assertEquals("公众号草稿审核", summary.title)
        assertTrue(summary.nextStep.contains("草稿已创建"))
        assertTrue(summary.items.all { it.ready })
        assertEquals("MEDIA_ID_123", summary.items.last().value)
    }

    @Test
    fun reviewSummaryKeepsDraftPendingWhenArticleExists() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.COMPLETED,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            rawText = "原始识别文本",
            wechatDraftId = "",
        )

        assertTrue(summary.nextStep.contains("还没拿到公众号草稿 ID"))
        assertTrue(summary.items.first { it.label == "正文" }.ready)
        assertFalse(summary.items.first { it.label == "公众号草稿" }.ready)
    }

    @Test
    fun reviewSummaryShowsProcessingMessageBeforeCompletion() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.PROCESSING,
            articleTitle = "6月29日 录音片段",
            articleContent = "云端正在转录和整理文章。",
            rawText = "",
            wechatDraftId = "",
        )

        assertTrue(summary.nextStep.contains("文章还在生成中"))
        assertFalse(summary.items.first { it.label == "正文" }.ready)
        assertFalse(summary.items.first { it.label == "公众号草稿" }.ready)
    }
}
