import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  WECHAT_COVER_HEIGHT,
  WECHAT_COVER_WIDTH,
  buildWechatCoverSvg,
  deriveCoverTitleLines,
  generateWechatCoverBuffer,
  normalizeCoverBrief,
  selectCoverBackgroundTemplate,
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
    const metadata = await sharp(buffer).metadata();

    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(metadata.width).toBe(WECHAT_COVER_WIDTH);
    expect(metadata.height).toBe(WECHAT_COVER_HEIGHT);
    expect(buffer.length).toBeGreaterThan(10_000);
  });

  it("selects a reusable cover background template from title and image prompt tags", () => {
    const brief = normalizeCoverBrief({
      title: "为什么不建议用 Vibe Coding 搭建数据仪表盘？",
      imagePrompt: "A clean office workspace background, no text",
    });

    expect(selectCoverBackgroundTemplate(brief, [
      { id: "plain-default", file: "plain.png", tags: ["default"] },
      { id: "office-dashboard", file: "office.png", tags: ["office", "dashboard"] },
    ])?.id).toBe("office-dashboard");
  });

  it("does not call GPT Image 2 during normal cover rendering", async () => {
    process.env.GPT_IMAGE_API_KEY = "test-key";
    process.env.GPT_IMAGE_BASE_URL = "https://image.example.test";
    process.env.GPT_IMAGE_MODEL = "gpt-image-2";

    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    vi.stubGlobal("fetch", fetchMock);

    const buffer = await generateWechatCoverBuffer({
      title: "为什么我不建议用 Vibe Coding 搭建数据仪表盘",
      titleLines: ["不建议", "Vibe Coding", "搭数据仪表盘"],
      subtitle: "原型速度 ≠ 数据可信度",
      imagePrompt: "A clean office workspace background, no text",
    });

    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function clearGptImageEnv(): void {
  for (const key of GPT_IMAGE_ENV_KEYS) {
    delete process.env[key];
  }
}
