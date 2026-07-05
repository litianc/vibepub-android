package cn.litianc.vibepub

import android.content.Intent

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
    val title = (
        intent.getStringExtra(Intent.EXTRA_TITLE)
            ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
    )?.trim()?.takeIf { it.isNotBlank() }

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
    return Regex("""https?://[^\s，。！？、）)]+""")
        .find(text)
        ?.value
        ?.trim()
        ?.takeIf { it.isNotBlank() }
}
