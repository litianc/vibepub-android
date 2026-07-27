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
            body = """
                1. 整体气质：真实、理性、结构化、有个人判断，但不浮夸。
                2. 使用第一人称视角，保留“我”的观察和判断，但不要过度抒情。
                3. 从真实问题、具体观察或一次亲身排查开场，不写空泛鸡汤式引言。
                4. 开头尽早给出核心判断：这篇文章到底想说明什么。
                5. 优先使用“问题背景 -> 关键判断 -> 分层拆解 -> 证据/案例 -> 建议 -> 总结”的结构。
                6. 标题要有明确对象和判断，避免夸张标题党。
                7. 正文段落保持短而清楚，每段只承载一个意思。
                8. 多使用小标题、编号列表、表格来降低阅读成本。
                9. 技术内容要保留关键参数、版本、链路、失败条件和排查过程。
                10. 产品/组织内容要把抽象判断落到具体机制、场景和下一步动作。
                11. 结尾要回到可执行建议或清晰判断，不写泛泛的励志收束。
            """.trimIndent(),
        ),
        WritingStyleProfileOption(
            id = "style_product_review",
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "产品复盘",
            description = "先讲用户问题，再讲取舍和下一步，适合产品功能和体验复盘。",
            body = """
                1. 开头直接交代问题现场和核心判断，不写宏大背景。
                2. 用“现象 -> 原因 -> 机制 -> 代价 -> 下一步”的结构推进。
                3. 保留具体角色、流程、失败条件、权衡和决策依据。
                4. 多写“为什么会这样”和“下次怎么避免”，少写情绪评价。
                5. 标题要像一个复盘结论，而不是营销口号。
                6. 结尾必须给出一条可执行的机制调整或产品动作。
            """.trimIndent(),
        ),
        WritingStyleProfileOption(
            id = "style_technical_note",
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "技术札记",
            description = "结构清楚、保留关键细节，适合架构、调试和工程经验总结。",
            body = """
                1. 开头说明问题、影响范围、环境版本和最终结论。
                2. 按时间线或假设树写清排查过程，保留关键命令、日志和错误码。
                3. 区分事实、推断和未验证假设，不把猜测写成结论。
                4. 对每个方案说明为什么采用或放弃。
                5. 代码和配置片段要短，解释它解决了什么问题。
                6. 结尾列出验证结果、剩余风险和后续动作。
            """.trimIndent(),
        ),
        WritingStyleProfileOption(
            id = "style_public_explainer",
            version = DEFAULT_STYLE_PROFILE_VERSION,
            name = "通俗解释",
            description = "少术语，多比喻和上下文，适合把复杂概念讲给更广泛读者。",
            body = """
                1. 用一个具体生活化场景开头，把抽象问题落到读者能理解的画面。
                2. 每次只解释一个概念，必要术语要马上翻译成人话。
                3. 多使用类比、对照和小例子，但不要编造不存在的数据。
                4. 结构清晰，段落短，小标题要像路标。
                5. 语气自然、克制，不用夸张形容词制造紧张感。
                6. 结尾回到读者可以怎么判断或怎么行动。
            """.trimIndent(),
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

    fun submissionBodyFor(profile: WritingStyleProfileOption): String {
        val isRegisteredDefault = profile.id == DEFAULT_STYLE_PROFILE_ID &&
            profile.version == DEFAULT_STYLE_PROFILE_VERSION
        return if (isRegisteredDefault) "" else profile.body.orEmpty().trim()
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
                            body = item.optString("body").trim().takeIf { it.isNotBlank() },
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
                        val body = profile.body.orEmpty().trim()
                        if (body.isNotBlank()) {
                            put("body", body)
                        }
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
