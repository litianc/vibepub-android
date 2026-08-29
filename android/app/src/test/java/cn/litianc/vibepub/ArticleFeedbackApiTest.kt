package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ArticleFeedbackApiTest {
    @Test
    fun endpointEncodesTheRecordingFilename() {
        assertEquals(
            "https://vibepub.example.test/api/recordings/VibePub-2026-08-29%20Article.m4a/article-feedback",
            articleFeedbackEndpoint(
                "https://vibepub.example.test/",
                "VibePub-2026-08-29 Article.m4a",
            ).toString(),
        )
    }

    @Test
    fun responseParsesTheCurrentVersionAndLatestChoice() {
        val state = parseArticleFeedbackState(
            """{
              "legacy": false,
              "current_version": {"id": "version_1", "version_no": 1},
              "current_feedback": {
                "id": "feedback_2",
                "server_sequence": 2,
                "version_id": "version_1",
                "action": "not_adopted"
              }
            }""".trimIndent(),
        )

        assertEquals("version_1", state.currentVersion?.id)
        assertEquals(1, state.currentVersion?.versionNo)
        assertEquals(ArticleFeedbackAction.NOT_ADOPTED, state.currentAction)
    }

    @Test
    fun legacyResponseHasNoVersionOrChoice() {
        val state = parseArticleFeedbackState(
            """{"legacy":true,"current_version":null,"current_feedback":null}""",
        )

        assertNull(state.currentVersion)
        assertNull(state.currentAction)
    }

    @Test
    fun staleVersionMessageTellsTheUserToRefresh() {
        assertEquals(
            "文章已有新版本，请刷新后再选择",
            articleFeedbackFailureMessage(
                409,
                """{"error":"stale_article_version","message":"文章已有新版本，请刷新后再选择"}""",
            ),
        )
    }
}
