import { describe, expect, it } from "vitest";
import {
  articleImageKey,
  insertArticleImagesIntoHtml,
  normalizeArticleImageActions,
} from "../src/articleImageActions.js";

describe("article image actions", () => {
  it("normalizes model image actions", () => {
    const actions = normalizeArticleImageActions([
      {
        image_id: " opening desk ",
        kind: "insert_image",
        prompt: "A warm desk, no text",
        alt_text: "办公桌",
        anchor: { position: "after", paragraph_index: 1 },
      },
      { prompt: "" },
    ]);

    expect(actions).toEqual([
      {
        imageId: "opening_desk",
        kind: "insert_image",
        prompt: "A warm desk, no text",
        alt: "办公桌",
        anchor: { position: "after", paragraphIndex: 1, text: undefined },
      },
    ]);
  });

  it("inserts an image after the selected paragraph", () => {
    const html = insertArticleImagesIntoHtml(
      "<p>第一段正文。</p><p>第二段正文。</p>",
      [
        {
          imageId: "image_1",
          kind: "insert_image",
          prompt: "A warm desk",
          alt: "配图",
          anchor: { position: "after", paragraphIndex: 1 },
          r2Key: "article-images/post/image_1.png",
          wechatUrl: "https://mmbiz.qpic.cn/image.png",
        },
      ],
    );

    expect(html).toBe('<p>第一段正文。</p><figure data-vibepub-image-id="image_1"><img src="https://mmbiz.qpic.cn/image.png" alt="配图" /></figure><p>第二段正文。</p>');
  });

  it("builds stable article image R2 keys", () => {
    expect(articleImageKey("inbox/VibePub-2026-07-02-160000-0m18s-Test.m4a", "opening desk")).toBe(
      "article-images/VibePub-2026-07-02-160000-0m18s-Test/opening_desk.png",
    );
  });
});
