package cn.litianc.vibepub

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.ServerSocket
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ArticleRevisionApiTest {
    @Test
    fun buildsStableVersionBoundRevisionIdentityFromActualAudio() {
        val audio = temporaryAudio("abc")

        val first = createArticleRevisionRequestIdentity(
            effectiveUserId = "usr_a",
            filename = "article.m4a",
            parentVersionId = "version_1",
            audioFile = audio,
        )
        val retry = createArticleRevisionRequestIdentity(
            effectiveUserId = "usr_a",
            filename = "article.m4a",
            parentVersionId = "version_1",
            audioFile = temporaryAudio("abc"),
        )

        assertEquals("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", first.audioSha256)
        assertEquals("revision:c9ace47ada2ec80d15f48bfe9d374a58248db3e236235b4e3d86ce6dcb3fb34d", first.requestId)
        assertEquals("feedback:c9ace47ada2ec80d15f48bfe9d374a58248db3e236235b4e3d86ce6dcb3fb34d", first.feedbackId)
        assertEquals(first, retry)
        assertTrue(first.requestId.length <= 200)
        assertEquals(
            mapOf(
                "X-Article-Version-Id" to "version_1",
                "X-Revision-Request-Id" to first.requestId,
                "X-Revision-Feedback-Id" to first.feedbackId,
                "X-Revision-Audio-Sha256" to first.audioSha256,
            ),
            first.headers,
        )
    }

    @Test
    fun differentRevisionAudioGetsDifferentRequestIdentity() {
        val first = createArticleRevisionRequestIdentity("usr_a", "article.m4a", "version_1", temporaryAudio("first"))
        val second = createArticleRevisionRequestIdentity("usr_a", "article.m4a", "version_1", temporaryAudio("second"))

        assertNotEquals(first.requestId, second.requestId)
        assertNotEquals(first.audioSha256, second.audioSha256)
    }

    @Test
    fun parsesVersionBindingFeedbackFromRevisionResponse() {
        val result = parseArticleRevisionSubmitResult(
            """{
                "revision_id":"revision_2",
                "status":"QUEUED",
                "parent_version_id":"version_1",
                "continue_revision":true
            }""".trimIndent(),
        )

        assertEquals("revision_2", result.revisionId)
        assertEquals("QUEUED", result.status)
        assertEquals("version_1", result.parentVersionId)
        assertEquals(true, result.continueRevision)
    }

    @Test
    fun versionedPublicSubmitSeamSendsRequiredIdentityHeaders() = runBlocking {
        val server = captureOneRequest(
            """{"revision_id":"revision_2","status":"QUEUED","parent_version_id":"version_1","continue_revision":true}""",
        )
        val audio = temporaryAudio("abc")

        val result = ArticleRevisionApi.submitVoiceRevision(
            apiBaseUrl = server.baseUrl,
            filesToken = "token_a",
            effectiveUserId = "usr_a",
            filename = "article.m4a",
            parentVersionId = "version_1",
            audioFile = audio,
        )
        val request = server.request.get(5, TimeUnit.SECONDS)

        assertEquals("version_1", request.headers["x-article-version-id"])
        assertEquals("revision:c9ace47ada2ec80d15f48bfe9d374a58248db3e236235b4e3d86ce6dcb3fb34d", request.headers["x-revision-request-id"])
        assertEquals("feedback:c9ace47ada2ec80d15f48bfe9d374a58248db3e236235b4e3d86ce6dcb3fb34d", request.headers["x-revision-feedback-id"])
        assertEquals("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", request.headers["x-revision-audio-sha256"])
        assertEquals("version_1", result.parentVersionId)
    }

    @Test
    fun legacyPublicSubmitSeamStillAcceptsOldResponsesWithoutVersionHeaders() = runBlocking {
        val server = captureOneRequest("""{"revision_id":"legacy_revision","status":"QUEUED"}""")

        val result = ArticleRevisionApi.submitVoiceRevision(
            apiBaseUrl = server.baseUrl,
            filesToken = "legacy_token",
            filename = "old-article.m4a",
            audioFile = temporaryAudio("old instruction"),
        )
        val request = server.request.get(5, TimeUnit.SECONDS)

        assertEquals("legacy_revision", result.revisionId)
        assertEquals(null, request.headers["x-article-version-id"])
        assertEquals(null, request.headers["x-revision-request-id"])
        assertEquals(null, request.headers["x-revision-audio-sha256"])
    }

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
            "登录已失效或没有权限，无法提交修改",
            articleRevisionFailureMessage(401, ""),
        )
        assertEquals(
            "文章已有新版本，请刷新后重新提交修改",
            articleRevisionFailureMessage(409, """{"message":"not ready"}"""),
        )
        assertEquals(
            "提交修改失败：bad request",
            articleRevisionFailureMessage(400, """{"message":"bad request"}"""),
        )
    }

    private fun temporaryAudio(content: String): File =
        File.createTempFile("article-revision-", ".m4a").apply {
            writeText(content)
            deleteOnExit()
        }

    private fun captureOneRequest(responseBody: String): TestHttpServer {
        val socket = ServerSocket(0)
        val executor = Executors.newSingleThreadExecutor()
        val request = executor.submit<CapturedRequest> {
            socket.use { server ->
                server.accept().use { client ->
                    val input = client.getInputStream()
                    val headerBytes = ByteArrayOutputStream()
                    var matched = 0
                    while (matched < 4) {
                        val byte = input.read()
                        check(byte >= 0) { "request ended before headers" }
                        headerBytes.write(byte)
                        matched = when {
                            matched == 0 && byte == '\r'.code -> 1
                            matched == 1 && byte == '\n'.code -> 2
                            matched == 2 && byte == '\r'.code -> 3
                            matched == 3 && byte == '\n'.code -> 4
                            byte == '\r'.code -> 1
                            else -> 0
                        }
                    }
                    val lines = headerBytes.toString(Charsets.ISO_8859_1.name()).split("\r\n")
                    val headers = lines.drop(1).mapNotNull { line ->
                        val separator = line.indexOf(':')
                        if (separator <= 0) null else {
                            line.substring(0, separator).trim().lowercase(Locale.ROOT) to
                                line.substring(separator + 1).trim()
                        }
                    }.toMap()
                    val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                    repeat(contentLength) { check(input.read() >= 0) { "request body ended early" } }

                    val body = responseBody.toByteArray(Charsets.UTF_8)
                    client.getOutputStream().use { output ->
                        output.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        output.write(body)
                    }
                    CapturedRequest(headers)
                }
            }
        }
        executor.shutdown()
        return TestHttpServer("http://127.0.0.1:${socket.localPort}", request)
    }

    private data class CapturedRequest(val headers: Map<String, String>)

    private data class TestHttpServer(
        val baseUrl: String,
        val request: java.util.concurrent.Future<CapturedRequest>,
    )
}
