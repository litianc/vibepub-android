package cn.litianc.vibepub

import org.json.JSONArray
import org.json.JSONObject

data class WritingStyleProfileOption(
    val id: String,
    val version: String,
    val name: String,
    val description: String,
    val body: String? = null,
    val custom: Boolean = false,
    val remote: Boolean = false,
)

object WritingStyleProfiles {
    const val DEFAULT_STYLE_PROFILE_ID = "style_litianc_default"
    const val DEFAULT_STYLE_PROFILE_VERSION = "2026-07-05"
    const val DEFAULT_LAYOUT_PROFILE_ID = "wechat_clean_article"
    const val DEFAULT_LAYOUT_PROFILE_VERSION = "2026-07-05"

    val builtIn: List<WritingStyleProfileOption> = listOf(
        WritingStyleProfileOption(
            id = DEFAULT_STYLE_PROFILE_ID,
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "李天 C 默认",
            description = "偏口语、有现场感，适合把日常思考整理成公众号文章。",
        ),
        WritingStyleProfileOption(
            id = "style_product_review",
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "产品复盘",
            description = "先讲用户问题，再讲取舍和下一步，适合产品功能和体验复盘。",
        ),
        WritingStyleProfileOption(
            id = "style_technical_note",
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "技术札记",
            description = "结构清楚、保留关键细节，适合架构、调试和工程经验总结。",
        ),
        WritingStyleProfileOption(
            id = "style_public_explainer",
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "通俗解释",
            description = "少术语，多比喻和上下文，适合把复杂概念讲给更广泛读者。",
        ),
    )

    val defaultStyleProfile: WritingStyleProfileOption = builtIn.first()

    fun findById(
        id: String?,
        customProfiles: List<WritingStyleProfileOption> = emptyList(),
        remoteProfiles: List<WritingStyleProfileOption> = emptyList(),
    ): WritingStyleProfileOption? {
        val normalized = id?.trim().orEmpty()
        return (builtIn + customProfiles + remoteProfiles).firstOrNull { it.id == normalized }
    }

    fun optionFor(
        id: String?,
        customProfiles: List<WritingStyleProfileOption> = emptyList(),
        remoteProfiles: List<WritingStyleProfileOption> = emptyList(),
    ): WritingStyleProfileOption {
        return findById(id, customProfiles, remoteProfiles) ?: defaultStyleProfile
    }

    fun decodeCustomProfiles(json: String): List<WritingStyleProfileOption> {
        if (json.isBlank()) return emptyList()
        return runCatching {
            val array = JSONArray(json)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val id = item.optString("id").trim()
                    val name = item.optString("name").trim()
                    val body = item.optString("body").trim()
                    if (id.isBlank() || name.isBlank() || body.isBlank()) continue
                    add(
                        WritingStyleProfileOption(
                            id = id,
                            version = item.optString("version").trim().ifBlank { customProfileVersion() },
                            name = name,
                            description = item.optString("description").trim(),
                            body = body,
                            custom = true,
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    fun encodeCustomProfiles(profiles: List<WritingStyleProfileOption>): String {
        val array = JSONArray()
        profiles
            .filter { it.custom && !it.body.isNullOrBlank() }
            .forEach { profile ->
                array.put(
                    JSONObject().apply {
                        put("id", profile.id)
                        put("version", profile.version)
                        put("name", profile.name)
                        put("description", profile.description)
                        put("body", profile.body.orEmpty())
                    },
                )
            }
        return array.toString()
    }

    fun decodeRemoteProfiles(json: String): List<WritingStyleProfileOption> {
        if (json.isBlank()) return emptyList()
        return runCatching {
            val array = JSONArray(json)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val id = item.optString("id").trim()
                    val name = item.optString("name").trim()
                    if (id.isBlank() || name.isBlank()) continue
                    add(
                        WritingStyleProfileOption(
                            id = id,
                            version = item.optString("version").trim().ifBlank { DEFAULT_STYLE_PROFILE_VERSION },
                            name = name,
                            description = item.optString("description").trim(),
                            remote = true,
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    fun encodeRemoteProfiles(profiles: List<WritingStyleProfileOption>): String {
        val array = JSONArray()
        profiles
            .filter { it.remote }
            .forEach { profile ->
                array.put(
                    JSONObject().apply {
                        put("id", profile.id)
                        put("version", profile.version)
                        put("name", profile.name)
                        put("description", profile.description)
                    },
                )
            }
        return array.toString()
    }

    fun newCustomProfile(
        name: String,
        description: String,
        body: String,
        nowMs: Long = System.currentTimeMillis(),
    ): WritingStyleProfileOption {
        return WritingStyleProfileOption(
            id = "custom_style_$nowMs",
            version = customProfileVersion(nowMs),
            name = name.trim().ifBlank { "我的写作风格" },
            description = description.trim(),
            body = body.trim(),
            custom = true,
        )
    }

    fun mergeStylePromptTurn(existingBody: String, turnText: String): String {
        val normalizedTurn = turnText.trim()
        if (normalizedTurn.isBlank()) return existingBody.trim()
        val base = existingBody.trim().ifBlank {
            """
            这是用户自定义的写作风格画像。请严格根据下面的偏好改写文章：
            1. 保持真实、克制、具体，不写营销味套话。
            2. 保留作者第一人称观察和明确判断。
            """.trimIndent()
        }
        val nextIndex = Regex("""(?m)^\d+\.\s""").findAll(base).count() + 1
        return "$base\n$nextIndex. ${normalizedTurn.replace(Regex("\\s+"), " ")}"
    }

    fun trimCustomProfileBody(body: String): String {
        return body.trim().take(MAX_CUSTOM_PROFILE_BODY_CHARS)
    }

    fun customProfileVersion(nowMs: Long = System.currentTimeMillis()): String {
        return nowMs.toString()
    }

    const val MAX_CUSTOM_PROFILE_BODY_CHARS = 3_000
}
