export type ArticleImageAnchor = {
  position: "start" | "end" | "before" | "after";
  paragraphIndex?: number;
  text?: string;
};

export type ArticleImageAction = {
  imageId: string;
  kind: "insert_image";
  prompt: string;
  alt?: string;
  anchor: ArticleImageAnchor;
};

export type ArticleImageAsset = {
  imageId: string;
  kind: "insert_image";
  prompt: string;
  alt?: string;
  anchor: ArticleImageAnchor;
  r2Key: string;
  publicUrl?: string;
  wechatUrl?: string;
};

const MAX_ARTICLE_IMAGE_ACTIONS = 3;

export function normalizeArticleImageActions(value: unknown): ArticleImageAction[] {
  if (!Array.isArray(value)) return [];
  const actions: ArticleImageAction[] = [];
  for (const item of value) {
    if (actions.length >= MAX_ARTICLE_IMAGE_ACTIONS) break;
    if (!isRecord(item)) continue;
    const prompt = normalizeString(item.prompt ?? item.image_prompt);
    if (!prompt) continue;
    const rawKind = normalizeString(item.kind ?? item.action ?? item.type).toLowerCase();
    if (rawKind && !["insert_image", "insert", "insert_before", "insert_after", "image"].includes(rawKind)) {
      continue;
    }
    const imageId = sanitizeImageId(
      normalizeString(item.image_id ?? item.imageId ?? item.id) || `image_${actions.length + 1}`,
    );
    actions.push({
      imageId,
      kind: "insert_image",
      prompt,
      alt: normalizeString(item.alt ?? item.alt_text ?? item.altText) || undefined,
      anchor: normalizeArticleImageAnchor(item.anchor, rawKind),
    });
  }
  return actions;
}

export function insertArticleImagesIntoHtml(html: string, assets: ArticleImageAsset[]): string {
  return assets.reduce((currentHtml, asset) => {
    const src = asset.wechatUrl || asset.publicUrl;
    if (!src) return currentHtml;
    return insertSingleArticleImage(currentHtml, imageHtml(asset, src), asset.anchor);
  }, html);
}

export function articleImagesForTranscript(assets: ArticleImageAsset[]): ArticleImageAsset[] {
  return assets.map(asset => ({
    imageId: asset.imageId,
    kind: asset.kind,
    prompt: asset.prompt,
    alt: asset.alt,
    anchor: asset.anchor,
    r2Key: asset.r2Key,
    publicUrl: asset.publicUrl,
    wechatUrl: asset.wechatUrl,
  }));
}

export function articleImageKey(fileKey: string, imageId: string): string {
  const baseName = fileKey
    .split("/")
    .pop()
    ?.replace(/\.[^/.]+$/, "")
    .replace(/[^\w.-]/g, "_")
    || "article";
  return `article-images/${baseName}/${sanitizeImageId(imageId)}.png`;
}

function normalizeArticleImageAnchor(value: unknown, rawKind: string): ArticleImageAnchor {
  const record = isRecord(value) ? value : {};
  const rawPosition = normalizeString(
    record.position ?? record.mode ?? record.location ?? record.action ?? rawKind,
  ).toLowerCase();
  const paragraphIndex = positiveInteger(record.paragraph_index ?? record.paragraphIndex);
  const text = normalizeString(record.text ?? record.near_text ?? record.nearText) || undefined;

  if (rawPosition.includes("start") || rawPosition.includes("front") || rawPosition.includes("begin")) {
    return { position: "start", paragraphIndex, text };
  }
  if (rawPosition.includes("before")) {
    return { position: "before", paragraphIndex, text };
  }
  if (rawPosition.includes("after")) {
    return { position: "after", paragraphIndex, text };
  }
  return { position: "end", paragraphIndex, text };
}

function insertSingleArticleImage(html: string, imageMarkup: string, anchor: ArticleImageAnchor): string {
  if (anchor.position === "start") {
    return `${imageMarkup}${html}`;
  }

  const paragraphMatch = paragraphMatchForAnchor(html, anchor);
  if (paragraphMatch) {
    const insertIndex = anchor.position === "before"
      ? paragraphMatch.index
      : paragraphMatch.index + paragraphMatch.value.length;
    return `${html.slice(0, insertIndex)}${imageMarkup}${html.slice(insertIndex)}`;
  }

  return `${html}${imageMarkup}`;
}

function paragraphMatchForAnchor(
  html: string,
  anchor: ArticleImageAnchor,
): { index: number; value: string } | undefined {
  const paragraphs = Array.from(html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi))
    .map(match => ({ index: match.index ?? 0, value: match[0] }));
  if (paragraphs.length === 0) return undefined;

  if (anchor.text) {
    const byText = paragraphs.find(paragraph => paragraph.value.includes(anchor.text!));
    if (byText) return byText;
  }

  if (anchor.paragraphIndex && anchor.paragraphIndex > 0) {
    return paragraphs[Math.min(anchor.paragraphIndex, paragraphs.length) - 1];
  }

  if (anchor.position === "before") return paragraphs[0];
  if (anchor.position === "after") return paragraphs[paragraphs.length - 1];
  return undefined;
}

function imageHtml(asset: ArticleImageAsset, src: string): string {
  const alt = asset.alt || "VibePub article illustration";
  return `<figure data-vibepub-image-id="${escapeHtmlAttribute(asset.imageId)}"><img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}" /></figure>`;
}

function sanitizeImageId(value: string): string {
  return value.trim().replace(/[^\w.-]/g, "_").slice(0, 80) || "image";
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(normalizeString(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
