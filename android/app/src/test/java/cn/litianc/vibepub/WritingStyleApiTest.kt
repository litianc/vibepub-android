package cn.litianc.vibepub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WritingStyleApiTest {
    @Test
    fun sourceImportBodyIncludesReferenceMetadata() {
        val json = JSONObject(
            buildStyleSourceImportBody(
                sourceType = "wechat_article",
                title = "参考文章",
                url = " https://mp.weixin.qq.com/s/example ",
                text = " 有现场感的旧文章 ",
            ),
        )

        assertEquals("wechat_article", json.getString("source_type"))
        assertEquals("参考文章", json.getString("title"))
        assertEquals("https://mp.weixin.qq.com/s/example", json.getString("url"))
        assertEquals("有现场感的旧文章", json.getString("text"))
    }

    @Test
    fun distillationBodyIncludesSourceIdsAndProfileMetadata() {
        val json = JSONObject(
            buildStyleDistillationBody(
                sourceImportIds = listOf(" ssi_1 ", "ssi_2", ""),
                profileId = "style_my_old_articles",
                name = "我的旧文风格",
                description = "从旧文提取",
            ),
        )

        assertEquals("ssi_1", json.getJSONArray("source_import_ids").getString(0))
        assertEquals("ssi_2", json.getJSONArray("source_import_ids").getString(1))
        assertEquals(2, json.getJSONArray("source_import_ids").length())
        assertEquals("style_my_old_articles", json.getJSONObject("profile").getString("id"))
        assertEquals("我的旧文风格", json.getJSONObject("profile").getString("name"))
    }

    @Test
    fun parsesRemoteStyleProfiles() {
        val profiles = parseStyleProfilesResponse(
            """
            {
              "style_profiles": [
                {"id":"style_litianc_default","name":"默认","version":"2026-07-05"},
                {"id":"style_my_old_articles","name":"我的旧文风格","version":"v1","description":"短段落"}
              ]
            }
            """.trimIndent(),
        )

        assertEquals(2, profiles.size)
        assertEquals("style_my_old_articles", profiles[1].id)
        assertEquals("v1", profiles[1].version)
        assertEquals("短段落", profiles[1].description)
        assertTrue(profiles[1].remote)
        assertFalse(profiles[1].custom)
    }

    @Test
    fun parsesStyleSourceImports() {
        val sources = parseStyleSourceImportsResponse(
            """
            {
              "source_imports": [
                {
                  "id":"ssi_1",
                  "source_type":"wechat_article",
                  "title":"参考文章",
                  "status":"ready",
                  "text_preview":"开头直接进入现场",
                  "created_at":"2026-07-06T00:00:00.000Z"
                }
              ]
            }
            """.trimIndent(),
        )

        assertEquals(1, sources.size)
        assertEquals("ssi_1", sources[0].id)
        assertEquals("wechat_article", sources[0].sourceType)
        assertEquals("参考文章", sources[0].title)
        assertEquals("开头直接进入现场", sources[0].textPreview)
    }

    @Test
    fun parsesDistillationResult() {
        val result = parseStyleDistillationResponse(
            """
            {
              "distillation_job": {"id":"sdj_1", "status":"profile_ready"},
              "style_profile": {
                "id":"style_my_old_articles",
                "name":"我的旧文风格",
                "version":"v1",
                "description":"短段落",
                "body":"1. 开头进入现场。"
              }
            }
            """.trimIndent(),
        )

        assertEquals("sdj_1", result.jobId)
        assertEquals("style_my_old_articles", result.profile.id)
        assertEquals("1. 开头进入现场。", result.body)
    }

    @Test
    fun failureMessageHandlesAuthAndUnconfiguredProxy() {
        assertEquals("FILES_TOKEN 无效或没有权限", writingStyleApiFailureMessage(401, ""))
        assertEquals("WritingAgent 尚未配置，请先部署风格服务", writingStyleApiFailureMessage(503, ""))
        assertEquals("风格服务暂时不可用，请稍后重试", writingStyleApiFailureMessage(502, "bad gateway"))
    }
}
