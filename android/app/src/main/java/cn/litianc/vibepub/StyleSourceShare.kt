package cn.litianc.vibepub

import android.content.Intent

private val urlPattern = Regex("""https?://[^\s，。！？、）)]+""")
private val whitespacePattern = Regex("""\s+""")

data class SharedStyleSource(
    val sourceType: String,
    val title: String?,
    val url: String?,
    val text: String?,
)

internal fun sharedStyleSourceFromIntent(intent: Intent?): SharedStyleSource? {
    if (intent?.action != Intent.ACTION_SEND) return null
    val type = intent.type.orEmpty().lowercase()
    if (type.isNotBlank() && !isSupportedStyleSourceMimeType(type)) return null

    val extraText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
    val title = normalizeSharedTitle(
        intent.getStringExtra(Intent.EXTRA_TITLE)
            ?: intent.getStringExtra(Intent.EXTRA_SUBJECT),
    ) ?: inferSharedTitleFromText(extraText)

    if (extraText.isBlank() && title.isNullOrBlank()) return null

    val url = extractFirstUrl(extraText)
    val text = extraText.takeIf { it.isNotBlank() }
    return SharedStyleSource(
        sourceType = if (url?.contains("mp.weixin.qq.com") == true) "wechat_article" else if (url != null) "url" else "text",
        title = title,
        url = url,
        text = text,
    )
}

private fun isSupportedStyleSourceMimeType(type: String): Boolean {
    return type.startsWith("text/") ||
        type == "application/pdf" ||
        type == "application/msword" ||
        type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

private fun extractFirstUrl(text: String): String? {
    return urlPattern
        .find(text)
        ?.value
        ?.trim()
        ?.takeIf { it.isNotBlank() }
}

private fun normalizeSharedTitle(value: String?): String? {
    val normalized = value?.trim().orEmpty()
    if (normalized.isBlank()) return null
    val lower = normalized.lowercase()
    if (lower == "null" || lower == "(null)" || lower == "undefined") return null
    return normalized
}

private fun inferSharedTitleFromText(text: String): String? {
    return text.lineSequence()
        .map { line ->
            urlPattern.replace(line, "")
                .replace(whitespacePattern, " ")
                .trim()
                .trim('「', '」', '《', '》', '"', '\'', '“', '”')
        }
        .firstOrNull { candidate ->
            candidate.length >= 2 &&
                !candidate.equals("null", ignoreCase = true) &&
                !candidate.equals("undefined", ignoreCase = true)
        }
        ?.take(80)
}
