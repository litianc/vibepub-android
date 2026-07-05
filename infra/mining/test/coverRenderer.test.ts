import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  WECHAT_COVER_HEIGHT,
  WECHAT_COVER_WIDTH,
  buildWechatCoverSvg,
  deriveCoverTitleLines,
  generateWechatCoverBuffer,
  normalizeCoverBrief,
} from "../src/coverRenderer.js";

const GPT_IMAGE_ENV_KEYS = [
  "GPT_IMAGE_API_KEY",
  "GPT_IMAGE_BASE_URL",
  "GPT_IMAGE_MODEL",
  "GPT_IMAGE_SIZE",
  "GPT_IMAGE_TIMEOUT_MS",
] as const;

describe("WeChat cover renderer", () => {
  beforeEach(() => {
    clearGptImageEnv();
  });

  afterEach(() => {
    clearGptImageEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("derives concise title lines for Vibe Coding dashboard articles", () => {
    expect(deriveCoverTitleLines("为什么我不建议用 Vibe Coding 搭建数据仪表盘")).toEqual([
      "不建议",
      "Vibe Coding",
      "搭数据仪表盘",
    ]);
  });

  it("builds a quiet typography-first SVG without explanatory corner labels", () => {
    const brief = normalizeCoverBrief({
      title: "为什么我不建议用 Vibe Coding 搭建数据仪表盘",
      titleLines: ["不建议", "Vibe Coding", "搭数据仪表盘"],
      subtitle: "原型速度 ≠ 数据可信度",
    });
    const svg = buildWechatCoverSvg(brief);

    expect(svg).toContain(`width="${WECHAT_COVER_WIDTH}"`);
    expect(svg).toContain(`height="${WECHAT_COVER_HEIGHT}"`);
    expect(svg).toContain("不建议");
    expect(svg).toContain("Vibe Coding");
    expect(svg).toContain("搭数据仪表盘");
    expect(svg).toContain("原型速度 ≠ 数据可信度");
    expect(svg).not.toContain("观点");
    expect(svg).not.toContain("产品判断");
  });

  it("renders a 900x383 PNG buffer", async () => {
    const buffer = await generateWechatCoverBuffer({
      title: "为什么我不建议用 Vibe Coding 搭建数据仪表盘",
      titleLines: ["不建议", "Vibe Coding", "搭数据仪表盘"],
      subtitle: "原型速度 ≠ 数据可信度",
    });

    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buffer.length).toBeGreaterThan(10_000);
  });

  it("uses GPT Image 2 as the cover background when configured", async () => {
    process.env.GPT_IMAGE_API_KEY = "test-key";
    process.env.GPT_IMAGE_BASE_URL = "https://image.example.test";
    process.env.GPT_IMAGE_MODEL = "gpt-image-2";
    const imageBuffer = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: "#f8f2e8",
      },
    }).png().toBuffer();

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBuffer.toString("base64") }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const buffer = await generateWechatCoverBuffer({
      title: "为什么我不建议用 Vibe Coding 搭建数据仪表盘",
      titleLines: ["不建议", "Vibe Coding", "搭数据仪表盘"],
      subtitle: "原型速度 ≠ 数据可信度",
      imagePrompt: "A clean editorial desk cover image, no text",
    });

    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://image.example.test/v1/images/generations");
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }));
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image-2",
      size: "1024x1024",
      n: 1,
    });
    expect(String(init?.body)).toContain("A clean editorial desk cover image");
    expect(String(init?.body)).toContain("No text");
  });

  it("falls back to the deterministic cover when GPT Image 2 fails", async () => {
    process.env.GPT_IMAGE_API_KEY = "test-key";
    process.env.GPT_IMAGE_BASE_URL = "https://image.example.test";

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const buffer = await generateWechatCoverBuffer({
      title: "失败也要有封面",
      imagePrompt: "A calm cover image, no text",
    });

    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buffer.length).toBeGreaterThan(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to deterministic cover"));
  });

  it("falls back when GPT Image 2 returns an unreadable image", async () => {
    process.env.GPT_IMAGE_API_KEY = "test-key";
    process.env.GPT_IMAGE_BASE_URL = "https://image.example.test";

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("not an image").toString("base64") }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const buffer = await generateWechatCoverBuffer({
      title: "坏图也要回落",
      imagePrompt: "A calm cover image, no text",
    });

    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("GPT Image cover rendering failed"));
  });
});

function clearGptImageEnv(): void {
  for (const key of GPT_IMAGE_ENV_KEYS) {
    delete process.env[key];
  }
}
