import { describe, expect, it } from "vitest";
import {
  WECHAT_COVER_HEIGHT,
  WECHAT_COVER_WIDTH,
  buildWechatCoverSvg,
  deriveCoverTitleLines,
  generateWechatCoverBuffer,
  normalizeCoverBrief,
} from "../src/coverRenderer.js";

describe("WeChat cover renderer", () => {
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
});
