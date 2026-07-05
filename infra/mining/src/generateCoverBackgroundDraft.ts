import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import sharp from "sharp";
import { WECHAT_COVER_HEIGHT, WECHAT_COVER_WIDTH } from "./coverRenderer.js";

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_ID = "warm-editorial-desk-v1";
const BACKGROUND_DIR = path.resolve("assets/cover-backgrounds");
const ENDPOINT_PATH = "/v1/images/generations";

type ImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
};

async function main() {
  const id = argValue("--id") || process.env.COVER_BACKGROUND_ID || DEFAULT_ID;
  const prompt = argValue("--prompt") || process.env.COVER_BACKGROUND_PROMPT || defaultPrompt();
  const baseUrl = requiredEnv("GPT_IMAGE_BASE_URL");
  const apiKey = await resolveApiKey();
  const model = process.env.GPT_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
  const size = process.env.GPT_IMAGE_SIZE?.trim() || DEFAULT_SIZE;
  const timeoutMs = positiveInt(process.env.GPT_IMAGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const image = await generateBackground({
    apiKey,
    baseUrl,
    model,
    prompt,
    size,
    timeoutMs,
  });

  await mkdir(BACKGROUND_DIR, { recursive: true });
  const outputPath = path.join(BACKGROUND_DIR, `${id}.png`);
  const finalBuffer = await sharp(image)
    .resize(WECHAT_COVER_WIDTH, WECHAT_COVER_HEIGHT, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();
  await writeFile(outputPath, finalBuffer);

  const metadata = await sharp(finalBuffer).metadata();
  console.log(JSON.stringify({
    id,
    outputPath,
    model,
    size,
    width: metadata.width,
    height: metadata.height,
    prompt,
  }, null, 2));
}

async function generateBackground(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  size: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(joinUrl(options.baseUrl, ENDPOINT_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        size: options.size,
        n: 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const payload = await response.json() as ImageResponse;
    const image = payload.data?.[0];
    if (image?.b64_json) {
      return Buffer.from(image.b64_json, "base64");
    }
    if (image?.url) {
      const imageResponse = await fetch(image.url, { signal: controller.signal });
      if (!imageResponse.ok) {
        throw new Error(`image URL HTTP ${imageResponse.status}`);
      }
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    throw new Error("response did not include b64_json or url");
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveApiKey(): Promise<string> {
  const apiKey = process.env.GPT_IMAGE_API_KEY?.trim();
  if (apiKey) return apiKey;

  if (!input.isTTY) {
    const piped = readFileSync(0, "utf8").trim();
    if (piped) return piped;
    throw new Error("GPT_IMAGE_API_KEY is required");
  }

  const readline = createInterface({ input, output });
  try {
    const value = (await readline.question("GPT_IMAGE_API_KEY: ")).trim();
    if (!value) throw new Error("GPT_IMAGE_API_KEY is required");
    return value;
  } finally {
    readline.close();
  }
}

function defaultPrompt(): string {
  return [
    "Use case: photorealistic-natural.",
    "Asset type: reusable no-text background draft for a VibePub WeChat article cover.",
    "Scene/backdrop: warm daylight desk, soft office plants, subtle laptop edge, calm editorial workspace.",
    "Composition/framing: horizontal cover background with a quiet center area for large overlaid Chinese title text.",
    "Lighting/mood: bright natural light, warm, thoughtful, calm, professional.",
    "Color palette: off-white, soft beige, muted green plants, small restrained warm red accents only if natural.",
    "Constraints: no text, no letters, no logo, no watermark, no UI, no phone screen text.",
    "Avoid: dark atmosphere, pure abstract gradient, busy clutter, decorative orbs, bokeh blobs.",
  ].join(" ");
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function joinUrl(baseUrl: string, pathSuffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathSuffix}`;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
