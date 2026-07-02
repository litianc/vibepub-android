import OpenAI from "openai";
import { buildWechatArticlePrompt } from "./styleProfile.js";

const GLM_API_KEY = process.env.GLM_API_KEY!;
const GLM_BASE_URL = process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/";
const GLM_MODEL = process.env.GLM_MODEL || "glm-5.2"; // using the appropriate glm model (e.g. glm-5.2)

const openai = new OpenAI({
  apiKey: GLM_API_KEY,
  baseURL: GLM_BASE_URL,
});

export type ArticleResult = {
  title: string;
  content: string;
  imagePrompt: string;
  coverTitle?: string[];
  coverSubtitle?: string;
  coverImageUrl?: string;
};

type ParsedArticle = Partial<{
  title: string;
  content: string;
  imagePrompt: string;
  coverTitle: unknown;
  coverSubtitle: string;
}>;

export async function processAudioText(rawText: string): Promise<ArticleResult> {
  const prompt = buildWechatArticlePrompt(rawText);

  const response = await openai.chat.completions.create({
    model: GLM_MODEL,
    messages: [
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_object" },
    temperature: 0.6,
  });

  const responseText = response.choices[0].message.content;
  if (!responseText) {
    throw new Error("Empty response from LLM");
  }
  
  try {
    return articleResultFromParsed(JSON.parse(responseText), responseText);
  } catch (e) {
    const recovered = recoverArticleJsonLikeResponse(responseText);
    if (recovered) {
      console.warn("Failed to parse JSON, recovered article fields from raw response");
      return articleResultFromParsed(recovered, responseText);
    }
    console.warn("Failed to parse JSON, falling back to raw response");
    return articleResultFromParsed({}, responseText);
  }
}

function articleResultFromParsed(result: ParsedArticle, fallbackContent: string): ArticleResult {
  return {
    title: cleanArticleString(result.title) || "VibePub 语音随笔",
    content: cleanArticleString(result.content) || fallbackContent,
    imagePrompt: cleanArticleString(result.imagePrompt) || "A serene and minimalist abstract background, cinematic lighting, 8k resolution, realistic photography",
    coverTitle: Array.isArray(result.coverTitle)
      ? result.coverTitle.map(value => cleanArticleString(value)).filter(Boolean).slice(0, 3)
      : undefined,
    coverSubtitle: cleanArticleString(result.coverSubtitle) || undefined,
  };
}

function cleanArticleString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function recoverArticleJsonLikeResponse(responseText: string): ParsedArticle | null {
  const title = extractJsonLikeStringField(responseText, "title");
  const content = extractJsonLikeStringField(responseText, "content");
  if (!title && !content) {
    return null;
  }

  return {
    title,
    content,
    coverTitle: extractJsonLikeStringArrayField(responseText, "coverTitle"),
    coverSubtitle: extractJsonLikeStringField(responseText, "coverSubtitle"),
    imagePrompt: extractJsonLikeStringField(responseText, "imagePrompt"),
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
