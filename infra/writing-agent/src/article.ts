export type ArticlePackage = {
  title: string;
  content_html: string;
  summary?: string;
  image_actions?: ArticleImageAction[];
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
  imageActions: unknown;
  image_actions: unknown;
}>;

type ArticleImageAction = {
  image_id: string;
  kind: "insert_image";
  prompt: string;
  alt?: string;
  anchor: {
    position: "start" | "end" | "before" | "after";
    paragraph_index?: number;
    text?: string;
  };
};

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
    image_actions: normalizeImageActions(result.image_actions ?? result.imageActions),
    cover: {
      cover_title: normalizeStringArray(result.cover_title ?? result.coverTitle),
      cover_subtitle: cleanArticleString(result.cover_subtitle ?? result.coverSubtitle) || undefined,
      image_prompt: cleanArticleString(result.image_prompt ?? result.imagePrompt) ||
        "A clean editorial cover image, no text, no logo, no watermark, natural light",
    },
    warnings,
  };
}

function normalizeImageActions(value: unknown): ArticleImageAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value
    .map((item, index) => normalizeImageAction(item, index))
    .filter((item): item is ArticleImageAction => Boolean(item))
    .slice(0, 3);
  return actions.length > 0 ? actions : undefined;
}

function normalizeImageAction(value: unknown, index: number): ArticleImageAction | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const prompt = cleanArticleString(record.prompt ?? record.image_prompt);
  if (!prompt) return undefined;
  return {
    image_id: sanitizeImageId(cleanArticleString(record.image_id ?? record.imageId ?? record.id) || `image_${index + 1}`),
    kind: "insert_image",
    prompt,
    alt: cleanArticleString(record.alt ?? record.alt_text ?? record.altText) || undefined,
    anchor: normalizeImageAnchor(record.anchor),
  };
}

function normalizeImageAnchor(value: unknown): ArticleImageAction["anchor"] {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawPosition = cleanArticleString(record.position ?? record.mode ?? record.location).toLowerCase();
  const paragraphIndex = positiveInteger(record.paragraph_index ?? record.paragraphIndex);
  return {
    position: rawPosition.includes("start") || rawPosition.includes("front")
      ? "start"
      : rawPosition.includes("before")
        ? "before"
        : rawPosition.includes("after")
          ? "after"
          : "end",
    paragraph_index: paragraphIndex,
    text: cleanArticleString(record.text ?? record.near_text ?? record.nearText) || undefined,
  };
}

function cleanArticleString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeImageId(value: string): string {
  return value.trim().replace(/[^\w.-]/g, "_").slice(0, 80) || "image";
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(cleanArticleString(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
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
