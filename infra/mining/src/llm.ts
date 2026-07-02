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
  return generateArticleFromPrompt(prompt);
}

export async function reviseArticleWithInstruction(input: {
  rawText: string;
  currentTitle: string;
  currentContent: string;
  instructionText: string;
}): Promise<ArticleResult> {
  const prompt = buildRevisionPrompt(input);
  return generateArticleFromPrompt(prompt);
}

async function generateArticleFromPrompt(prompt: string): Promise<ArticleResult> {
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

function buildRevisionPrompt(input: {
  rawText: string;
  currentTitle: string;
  currentContent: string;
  instructionText: string;
}): string {
  return `
你是 VibePub 的公众号文章编辑。用户已经有一篇由口述生成的公众号草稿，现在又用语音说了一段修改要求。

你的任务：
1. 在保留原文章核心观点、作者口吻和公众号可读性的前提下，只根据“修改要求”更新文章。
2. 优先修改现有文章，不要因为一次修改要求就另起炉灶。
3. 如果修改要求里有明确删除、补充、换标题、调整结构、改变语气、增加例子等指令，必须执行。
4. 如果修改要求模糊，做最小合理修改，并保持文章完整可发布。
5. 输出必须是 JSON object，字段为：
{
  "title": "新版标题",
  "content": "新版公众号正文，允许使用 <p>/<h3>/<ul>/<li> 等微信可接受 HTML",
  "imagePrompt": "适合新版文章封面的英文图片提示词",
  "coverTitle": ["封面标题第一行", "第二行", "可选第三行"],
  "coverSubtitle": "封面副标题"
}

原始口述转录：
${input.rawText}

当前文章标题：
${input.currentTitle}

当前文章正文：
${input.currentContent}

用户这次说的修改要求：
${input.instructionText}
`.trim();
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
