package cn.litianc.vibepub.ui.screens

import cn.litianc.vibepub.data.RecordingEntity
import cn.litianc.vibepub.data.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.json.JSONObject
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
    fun transcriptStringReaderAcceptsCamelAndSnakeCaseFields() {
        val transcript = JSONObject(
            """
            {
              "article_title": "后端标题",
              "article_content": "<p>正文</p>",
              "raw_text": "原始转录",
              "error_message": "公众号草稿创建失败"
            }
            """.trimIndent(),
        )

        assertEquals("后端标题", transcript.optTranscriptString("articleTitle", "article_title"))
        assertEquals("<p>正文</p>", transcript.optTranscriptString("articleContent", "article_content"))
        assertEquals("原始转录", transcript.optTranscriptString("rawText", "raw_text"))
        assertEquals("公众号草稿创建失败", transcript.optTranscriptString("errorMessage", "error_message"))
    }

    @Test
    fun transcriptStringReaderSkipsBlankValuesBeforeFallback() {
        val transcript = JSONObject("""{"articleTitle":"   ","article_title":"可用标题"}""")

        assertEquals("可用标题", transcript.optTranscriptString("articleTitle", "article_title"))
        assertEquals("", (null as JSONObject?).optTranscriptString("articleTitle", "article_title"))
    }

    @Test
    fun transcriptStringReaderTreatsNullStringAsMissing() {
        val transcript = JSONObject("""{"wechatUrl":"null","wechat_url":"   "}""")

        assertEquals("", transcript.optTranscriptString("wechatUrl", "wechat_url"))
    }

    @Test
    fun reviewSummaryMarksCompletedDraftReady() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.COMPLETED,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            rawText = "原始识别文本",
            wechatDraftId = "MEDIA_ID_123",
            wechatUrl = "",
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
            wechatUrl = "",
        )

        assertTrue(summary.nextStep.contains("还没拿到公众号草稿信息"))
        assertTrue(summary.items.first { it.label == "正文" }.ready)
        assertFalse(summary.items.first { it.label == "公众号草稿" }.ready)
    }

    @Test
    fun reviewSummaryTreatsArticleReadyStageAsConsumableBeforeDraftCompletes() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.PROCESSING,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            articleContentIsGenerated = true,
            rawText = "原始识别文本",
            wechatDraftId = "",
            wechatUrl = "",
            processingStage = "ARTICLE_READY",
        )

        assertTrue(summary.nextStep.contains("文章已生成"))
        assertTrue(summary.nextStep.contains("刷新等待草稿状态"))
        assertTrue(summary.items.first { it.label == "正文" }.ready)
        assertFalse(summary.items.first { it.label == "公众号草稿" }.ready)
    }

    @Test
    fun reviewSummaryShowsDraftFailureWhileKeepingArticleReady() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.COMPLETED,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            rawText = "原始识别文本",
            wechatDraftId = "",
            wechatUrl = "",
            draftError = "公众号草稿创建失败：Request failed with status code 502",
        )

        assertTrue(summary.nextStep.contains("公众号草稿创建失败"))
        assertTrue(summary.items.first { it.label == "正文" }.ready)
        val draftItem = summary.items.first { it.label == "公众号草稿" }
        assertFalse(draftItem.ready)
        assertTrue(draftItem.value.contains("502"))
    }

    @Test
    fun reviewSummaryKeepsDraftFailureActionableWhenStageFailsBeforeCompletedStatus() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.PROCESSING,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            articleContentIsGenerated = true,
            rawText = "原始识别文本",
            wechatDraftId = "",
            wechatUrl = "",
            draftError = "公众号草稿创建失败：Request failed with status code 502",
            processingStage = "DRAFT_FAILED",
        )

        assertTrue(summary.nextStep.contains("公众号草稿创建失败"))
        assertTrue(summary.nextStep.contains("先复制正文"))
        assertTrue(summary.items.first { it.label == "正文" }.ready)
        val draftItem = summary.items.first { it.label == "公众号草稿" }
        assertFalse(draftItem.ready)
        assertTrue(draftItem.value.contains("502"))
    }

    @Test
    fun effectiveProcessingStagePrefersNewerRoomStageOverStaleTranscriptStage() {
        assertEquals(
            "DRAFT_FAILED",
            chooseEffectiveProcessingStage(
                transcriptProcessingStage = "ARTICLE_READY",
                recordingProcessingStage = "DRAFT_FAILED",
            ),
        )
        assertEquals(
            "COMPLETED",
            chooseEffectiveProcessingStage(
                transcriptProcessingStage = "article-ready",
                recordingProcessingStage = "completed",
            ),
        )
        assertEquals(
            "ARTICLE_READY",
            chooseEffectiveProcessingStage(
                transcriptProcessingStage = "ARTICLE_READY",
                recordingProcessingStage = "",
            ),
        )
        assertEquals(
            "COMPLETED",
            chooseEffectiveProcessingStage(
                transcriptProcessingStage = "FAILED",
                recordingProcessingStage = "COMPLETED",
            ),
        )
    }

    @Test
    fun reviewSummaryDoesNotTreatRawTranscriptFallbackAsGeneratedArticle() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.COMPLETED,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是原始识别文本，不是整理后的公众号正文。".repeat(12),
            articleContentIsGenerated = false,
            rawText = "这是原始识别文本，不是整理后的公众号正文。",
            wechatDraftId = "",
            wechatUrl = "",
            processingStage = "ARTICLE_READY",
        )

        assertFalse(summary.items.first { it.label == "正文" }.ready)
        assertTrue(summary.nextStep.contains("正文还不完整"))
    }

    @Test
    fun reviewSummaryMarksDraftReadyWhenOnlyUrlExists() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.COMPLETED,
            articleTitle = "一篇整理好的文章",
            articleContent = "这是一段已经整理好的正文。".repeat(12),
            rawText = "原始识别文本",
            wechatDraftId = "",
            wechatUrl = "https://mp.weixin.qq.com/draft",
        )

        val draftItem = summary.items.first { it.label == "公众号草稿" }
        assertTrue(summary.nextStep.contains("草稿已创建"))
        assertTrue(draftItem.ready)
        assertEquals("https://mp.weixin.qq.com/draft", draftItem.value)
    }

    @Test
    fun reviewSummaryShowsProcessingMessageBeforeCompletion() {
        val summary = buildArticleReviewSummary(
            status = RecordingStatus.PROCESSING,
            articleTitle = "6月29日 录音片段",
            articleContent = "云端正在转录和整理文章。",
            rawText = "",
            wechatDraftId = "",
            wechatUrl = "",
        )

        assertTrue(summary.nextStep.contains("文章还在生成中"))
        assertFalse(summary.items.first { it.label == "正文" }.ready)
        assertFalse(summary.items.first { it.label == "公众号草稿" }.ready)
    }

    @Test
    fun articleExportTextIncludesPublishingMetadataAndSources() {
        val text = buildArticleExportText(
            articleTitle = "整理好的文章",
            articleContent = "正文内容",
            rawText = "原始识别",
            statusLabel = "已成文",
            statusDetail = "文章已生成，公众号草稿也已准备好。",
            nextAction = "下一步：打开公众号草稿做最后一眼人工确认，再决定是否发布。",
            workflowNode = "当前节点：6. 公众号草稿 · 已完成",
            workflowCycle = "保存录音 → 上传音频 → 云端排队 → 语音识别 → 文章改写 → 公众号草稿 → 人工发布确认",
            wechatDraftId = "MEDIA_ID_123",
            wechatUrl = "https://mp.weixin.qq.com/draft",
            filename = "VibePub-test.m4a",
            createdAtMs = 1_771_000_000_000L,
        )

        assertTrue(text.contains("# 整理好的文章"))
        assertTrue(text.contains("- 处理状态：已成文"))
        assertTrue(text.contains("- 状态说明：文章已生成，公众号草稿也已准备好。"))
        assertTrue(text.contains("- 下一步：打开公众号草稿做最后一眼人工确认，再决定是否发布。"))
        assertTrue(text.contains("- 当前节点：6. 公众号草稿 · 已完成"))
        assertTrue(text.contains("- 完整流程：保存录音 → 上传音频 → 云端排队 → 语音识别 → 文章改写 → 公众号草稿 → 人工发布确认"))
        assertTrue(text.contains("- 公众号草稿：MEDIA_ID_123"))
        assertTrue(text.contains("- 草稿链接：https://mp.weixin.qq.com/draft"))
        assertTrue(text.contains("正文内容"))
        assertTrue(text.contains("原始识别"))
    }

    @Test
    fun draftActionOpensWhenDraftUrlExists() {
        val action = buildWeChatDraftAction(
            wechatDraftId = "",
            wechatUrl = "https://mp.weixin.qq.com/draft",
        )

        checkNotNull(action)
        assertEquals("打开公众号草稿", action.label)
        assertTrue(action.enabled)
        assertEquals("https://mp.weixin.qq.com/draft", action.url)
        assertTrue(action.helperText.contains("最后一眼人工确认"))
    }

    @Test
    fun draftActionKeepsMediaIdVisibleWhenUrlIsMissing() {
        val action = buildWeChatDraftAction(
            wechatDraftId = "MEDIA_ID_123",
            wechatUrl = "",
        )

        checkNotNull(action)
        assertEquals("草稿 ID 已同步", action.label)
        assertFalse(action.enabled)
        assertEquals("", action.url)
        assertTrue(action.helperText.contains("MEDIA_ID_123"))
        assertTrue(action.helperText.contains("复制正文"))
    }

    @Test
    fun draftActionIgnoresNullStringUrlWhenMediaIdExists() {
        val action = buildWeChatDraftAction(
            wechatDraftId = "MEDIA_ID_123",
            wechatUrl = "null",
        )

        checkNotNull(action)
        assertEquals("草稿 ID 已同步", action.label)
        assertFalse(action.enabled)
        assertEquals("", action.url)
    }

    @Test
    fun draftActionStaysHiddenWhenDraftReferenceIsMissing() {
        val action = buildWeChatDraftAction(
            wechatDraftId = "",
            wechatUrl = "",
        )

        assertEquals(null, action)
    }

    @Test
    fun exportFileNameRemovesUnsafeCharacters() {
        val fileName = exportFileName("标题/带:非法*字符?", "fallback.m4a")

        assertEquals("标题-带-非法-字符-.txt", fileName)
    }

    @Test
    fun detailActiveRecordingAutoRefreshUsesCloudPipelineStatuses() {
        assertFalse(recordingHasActiveCloudWork(recording(status = RecordingStatus.LOCAL_RECORDED)))
        assertFalse(recordingHasActiveCloudWork(recording(status = RecordingStatus.COMPLETED)))
        assertFalse(recordingHasActiveCloudWork(recording(status = RecordingStatus.FAILED)))
        assertTrue(recordingHasActiveCloudWork(recording(status = RecordingStatus.UPLOADING)))
        assertTrue(recordingHasActiveCloudWork(recording(status = RecordingStatus.UPLOADED)))
        assertTrue(recordingHasActiveCloudWork(recording(status = RecordingStatus.PROCESSING)))
        assertFalse(recordingHasActiveCloudWork(null))
    }

    @Test
    fun detailActiveRecordingAutoRefreshRespectsFreshSyncAndInterval() {
        val active = recording(status = RecordingStatus.PROCESSING)

        assertTrue(
            shouldAutoRefreshActiveRecording(
                recording = active,
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 0L,
                nowMs = 60_000L,
            ),
        )
        assertFalse(
            shouldAutoRefreshActiveRecording(
                recording = active,
                lastSyncAtMs = 50_000L,
                lastAutoRefreshRequestAtMs = 0L,
                nowMs = 60_000L,
            ),
        )
        assertFalse(
            shouldAutoRefreshActiveRecording(
                recording = active,
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 45_000L,
                nowMs = 60_000L,
            ),
        )
        assertFalse(
            shouldAutoRefreshActiveRecording(
                recording = recording(status = RecordingStatus.COMPLETED),
                lastSyncAtMs = 0L,
                lastAutoRefreshRequestAtMs = 0L,
                nowMs = 60_000L,
            ),
        )
    }

    private fun recording(status: RecordingStatus): RecordingEntity {
        return RecordingEntity(
            filename = "${status.value}.m4a",
            durationMs = 1_000L,
            timestamp = 1L,
            status = status.value,
        )
    }
}
