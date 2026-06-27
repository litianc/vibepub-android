import OpenAI from "openai";

const GLM_API_KEY = process.env.GLM_API_KEY!;
const GLM_BASE_URL = process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/";
const GLM_MODEL = process.env.GLM_MODEL || "glm-5.2"; // using the appropriate glm model (e.g. glm-5.2)

const openai = new OpenAI({
  apiKey: GLM_API_KEY,
  baseURL: GLM_BASE_URL,
});

export async function processAudioText(rawText: string): Promise<{ title: string; content: string; imagePrompt: string }> {
  // Style Distillation Prompt
  // We want the AI to clean up the transcript but maintain the original voice.
  const prompt = `你是一个顶级的个人文字助理，擅长“风格蒸馏（Style Distillation）”。
我通过录音口述了一段想法，以下是语音转文字的原始草稿。
请你帮我把它整理成一篇结构清晰、逻辑连贯、适合发布在微信公众号的文章。

【重要原则】
1. 保持“我”的第一人称视角。
2. 保留观点，剔除废话。
3. 适当分段并加上小标题。
4. 核心：请根据文章内容，高度浓缩一句用于 AI 绘图的纯英文画面描述 (imagePrompt)。最好是写实摄影风格，不要带文字。
5. 返回 JSON，包含 title（文章标题）, content（正文, 支持HTML排版）, imagePrompt（英文绘图提示词）。

【原始录音文本】
${rawText}`;

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

export async function generateCoverImageBuffer(prompt: string): Promise<Buffer> {
  console.log(`Generating image with prompt: ${prompt}`);
  const response = await openai.images.generate({
    model: "cogview-4",
    prompt: prompt,
  });

  const imageUrl = response.data[0]?.url;
  if (!imageUrl) {
    throw new Error("Failed to generate image, no URL returned.");
  }

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error(`Failed to download generated image: ${imageRes.statusText}`);
  }
  const arrayBuffer = await imageRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
