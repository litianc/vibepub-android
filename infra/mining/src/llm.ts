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
    const result = JSON.parse(responseText);
    return {
      title: result.title || "VibePub 语音随笔",
      content: result.content || responseText,
      imagePrompt: result.imagePrompt || "A serene and minimalist abstract background, cinematic lighting, 8k resolution, realistic photography",
      coverTitle: Array.isArray(result.coverTitle) ? result.coverTitle : undefined,
      coverSubtitle: typeof result.coverSubtitle === "string" ? result.coverSubtitle : undefined,
    };
  } catch (e) {
    console.warn("Failed to parse JSON, falling back to raw response");
    return {
      title: "VibePub 语音随笔",
      content: responseText,
      imagePrompt: "A serene and minimalist abstract background, cinematic lighting, 8k resolution, realistic photography",
    };
  }
}
