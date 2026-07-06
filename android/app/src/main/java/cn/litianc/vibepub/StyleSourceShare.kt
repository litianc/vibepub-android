package cn.litianc.vibepub

import android.content.Intent

private val urlPattern = Regex("""https?://[^\s，。！？、）)]+""")
private val whitespacePattern = Regex("""\s+""")

data class SharedStyleSource(
    val sourceType: String,
    val title: String?,
    val url: String?,
    val text: String?,
    val autoDistill: Boolean = false,
)

internal fun sharedStyleSourceFromIntent(intent: Intent?): SharedStyleSource? {
    return when (intent?.action) {
        Intent.ACTION_SEND -> sharedStyleSourceFromSendIntent(intent)
        Intent.ACTION_VIEW -> sharedStyleSourceFromViewIntent(intent)
        else -> null
    }
}

private fun sharedStyleSourceFromSendIntent(intent: Intent): SharedStyleSource? {
    val type = intent.type.orEmpty().lowercase()
    if (type.isNotBlank() && !isSupportedStyleSourceMimeType(type)) return null

    val extraText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
    val title = normalizeSharedTitle(
        intent.getStringExtra(Intent.EXTRA_TITLE)
            ?: intent.getStringExtra(Intent.EXTRA_SUBJECT),
    ) ?: inferSharedTitleFromText(extraText)

    if (extraText.isBlank() && title.isNullOrBlank()) return null

    val url = extractFirstUrl(extraText)
    val sourceType = sourceTypeForUrl(url)
    val text = extraText.takeIf { it.isNotBlank() }
    return SharedStyleSource(
        sourceType = sourceType,
        title = title,
        url = url,
        text = text,
        autoDistill = sourceType == "wechat_article",
    )
}

private fun sharedStyleSourceFromViewIntent(intent: Intent): SharedStyleSource? {
    val url = intent.dataString?.trim()?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        ?: return null
    val sourceType = sourceTypeForUrl(url)
    if (sourceType != "wechat_article") return null
    val title = normalizeSharedTitle(
        intent.getStringExtra(Intent.EXTRA_TITLE)
            ?: intent.getStringExtra(Intent.EXTRA_SUBJECT),
    )
    return SharedStyleSource(
        sourceType = sourceType,
        title = title,
        url = url,
        text = null,
        autoDistill = true,
    )
}

private fun sourceTypeForUrl(url: String?): String {
    return if (url?.contains("mp.weixin.qq.com") == true) "wechat_article" else if (url != null) "url" else "text"
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
