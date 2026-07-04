export type ArticlePackage = {
  title: string;
  content_html: string;
  summary?: string;
  cover: {
    cover_title?: string[];
    cover_subtitle?: string;
    image_prompt: string;
  };
  warnings: string[];
};

type ParsedArticle = Partial<{
  title: string;
  content: string;
  content_html: string;
  summary: string;
  imagePrompt: string;
  image_prompt: string;
  coverTitle: unknown;
  cover_title: unknown;
  coverSubtitle: string;
  cover_subtitle: string;
}>;

export function articlePackageFromResponse(responseText: string): ArticlePackage {
  try {
    return articlePackageFromParsed(JSON.parse(responseText), responseText);
  } catch {
    const recovered = recoverArticleJsonLikeResponse(responseText);
    if (recovered) {
      return articlePackageFromParsed(recovered, responseText, ["模型返回了不标准 JSON，已尽量恢复文章字段。"]);
    }
    return articlePackageFromParsed({}, responseText, ["模型没有返回标准文章 JSON，已把原始响应作为正文保留。"]);
  }
}

function articlePackageFromParsed(
  result: ParsedArticle,
  fallbackContent: string,
  warnings: string[] = [],
): ArticlePackage {
  return {
    title: cleanArticleString(result.title) || "VibePub 语音随笔",
    content_html: cleanArticleString(result.content_html) || cleanArticleString(result.content) || fallbackContent,
    summary: cleanArticleString(result.summary) || undefined,
    cover: {
      cover_title: normalizeStringArray(result.cover_title ?? result.coverTitle),
      cover_subtitle: cleanArticleString(result.cover_subtitle ?? result.coverSubtitle) || undefined,
      image_prompt: cleanArticleString(result.image_prompt ?? result.imagePrompt) ||
        "A clean editorial cover image, no text, no logo, no watermark, natural light",
    },
    warnings,
  };
}

function cleanArticleString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map(item => cleanArticleString(item))
    .filter(Boolean)
    .slice(0, 3);
  return normalized.length > 0 ? normalized : undefined;
}

function recoverArticleJsonLikeResponse(responseText: string): ParsedArticle | null {
  const title = extractJsonLikeStringField(responseText, "title");
  const content = extractJsonLikeStringField(responseText, "content_html") ??
    extractJsonLikeStringField(responseText, "content");
  if (!title && !content) {
    return null;
  }

  return {
    title,
    content_html: content,
    summary: extractJsonLikeStringField(responseText, "summary"),
    cover_title: extractJsonLikeStringArrayField(responseText, "cover_title") ??
      extractJsonLikeStringArrayField(responseText, "coverTitle"),
    cover_subtitle: extractJsonLikeStringField(responseText, "cover_subtitle") ??
      extractJsonLikeStringField(responseText, "coverSubtitle"),
    image_prompt: extractJsonLikeStringField(responseText, "image_prompt") ??
      extractJsonLikeStringField(responseText, "imagePrompt"),
  };
}

function extractJsonLikeStringField(responseText: string, field: string): string | undefined {
  const marker = `"${field}"`;
  const markerIndex = responseText.indexOf(marker);
  if (markerIndex < 0) return undefined;

  const colonIndex = responseText.indexOf(":", markerIndex + marker.length);
  if (colonIndex < 0) return undefined;

  const quoteIndex = responseText.indexOf('"', colonIndex + 1);
  if (quoteIndex < 0) return undefined;

  return readJsonLikeString(responseText, quoteIndex);
}

function readJsonLikeString(text: string, quoteIndex: number): string | undefined {
  let result = "";
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      result += decodeJsonEscape(next);
      index += 1;
      continue;
    }
    if (char === '"') {
      const nextMeaningful = nextMeaningfulChar(text, index + 1);
      if (nextMeaningful === "," || nextMeaningful === "}" || nextMeaningful === "]") {
        return result;
      }
    }
    result += char;
  }
  return undefined;
}

function decodeJsonEscape(char: string): string {
  switch (char) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "b": return "\b";
    case "f": return "\f";
    default: return char;
  }
}

function nextMeaningfulChar(text: string, start: number): string | undefined {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (!/\s/.test(char)) return char;
  }
  return undefined;
}

function extractJsonLikeStringArrayField(responseText: string, field: string): string[] | undefined {
  const marker = `"${field}"`;
  const markerIndex = responseText.indexOf(marker);
  if (markerIndex < 0) return undefined;

  const colonIndex = responseText.indexOf(":", markerIndex + marker.length);
  if (colonIndex < 0) return undefined;

  const openIndex = responseText.indexOf("[", colonIndex + 1);
  if (openIndex < 0) return undefined;

  const closeIndex = responseText.indexOf("]", openIndex + 1);
  if (closeIndex < 0) return undefined;

  const values = Array.from(responseText.slice(openIndex + 1, closeIndex).matchAll(/"([^"]+)"/g))
    .map(match => match[1].trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}
