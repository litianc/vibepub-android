package cn.litianc.vibepub

import org.junit.Assert.assertEquals
import org.junit.Test

class ArticleRevisionApiTest {
    @Test
    fun buildsRevisionEndpointWithEncodedFilename() {
        val endpoint = articleRevisionEndpoint(
            apiBaseUrl = "https://vibepub.example.test/",
            filename = "VibePub-2026-07-02-160000-0m18s-Test Audio.m4a",
        )

        assertEquals(
            "https://vibepub.example.test/api/recordings/VibePub-2026-07-02-160000-0m18s-Test%20Audio.m4a/revisions",
            endpoint.toString(),
        )
    }

    @Test
    fun mapsRevisionSubmitFailuresToUserReadableMessages() {
        assertEquals(
            "FILES_TOKEN 无效或没有权限，无法提交修改",
            articleRevisionFailureMessage(401, ""),
        )
        assertEquals(
            "文章还没生成完成，暂不能说话修改",
            articleRevisionFailureMessage(409, """{"message":"not ready"}"""),
        )
        assertEquals(
            "提交修改失败：bad request",
            articleRevisionFailureMessage(400, """{"message":"bad request"}"""),
        )
    }
}
