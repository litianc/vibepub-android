import { articleImageKey, type ArticleImageAction, type ArticleImageAsset } from "./articleImageActions.js";
import { uploadArticleImage } from "./r2.js";

type ImageGenerationResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
};

export type PreparedArticleImage = ArticleImageAsset & {
  buffer: Buffer;
};

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 90_000;
const ENDPOINT_PATH = "/v1/images/generations";

export async function prepareArticleImages(
  fileKey: string,
  actions: ArticleImageAction[],
): Promise<PreparedArticleImage[]> {
  const prepared: PreparedArticleImage[] = [];
  for (const action of actions) {
    const buffer = await generateArticleImageBuffer(action);
    const r2Key = articleImageKey(fileKey, action.imageId);
    await uploadArticleImage(r2Key, buffer);
    prepared.push({
      imageId: action.imageId,
      kind: action.kind,
      prompt: action.prompt,
      alt: action.alt,
      anchor: action.anchor,
      r2Key,
      publicUrl: publicFileUrl(r2Key),
      buffer,
    });
  }
  return prepared;
}

export async function generateArticleImageBuffer(action: ArticleImageAction): Promise<Buffer> {
  const apiKey = envValue("ARTICLE_IMAGE_API_KEY") || envValue("GPT_IMAGE_API_KEY");
  const baseUrl = envValue("ARTICLE_IMAGE_BASE_URL") || envValue("GPT_IMAGE_BASE_URL");
  if (!apiKey || !baseUrl) {
    throw new Error("ARTICLE_IMAGE_API_KEY and ARTICLE_IMAGE_BASE_URL are required for article image generation");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInt(process.env.ARTICLE_IMAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetch(joinUrl(baseUrl, ENDPOINT_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: envValue("ARTICLE_IMAGE_MODEL") || envValue("GPT_IMAGE_MODEL") || DEFAULT_IMAGE_MODEL,
        prompt: articleImagePrompt(action.prompt),
        size: envValue("ARTICLE_IMAGE_SIZE") || envValue("GPT_IMAGE_SIZE") || DEFAULT_IMAGE_SIZE,
        n: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`article image generation failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
    }

    const payload = await response.json() as ImageGenerationResponse;
    const image = payload.data?.[0];
    if (image?.b64_json) {
      return Buffer.from(image.b64_json, "base64");
    }
    if (image?.url) {
      const imageResponse = await fetch(image.url, { signal: controller.signal });
      if (!imageResponse.ok) {
        throw new Error(`article image download failed: HTTP ${imageResponse.status}`);
      }
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    throw new Error("article image response did not include b64_json or url");
  } finally {
    clearTimeout(timeout);
  }
}

function publicFileUrl(key: string): string | undefined {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, "")}/api/files/${encodeURIComponent(key)}`;
}

function articleImagePrompt(prompt: string): string {
  return [
    prompt,
    "Use case: inline illustration for a WeChat public account article.",
    "Constraints: no text, no letters, no logos, no watermarks, no UI screenshots unless explicitly requested.",
  ].join(" ");
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function joinUrl(baseUrl: string, pathSuffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathSuffix}`;
}
