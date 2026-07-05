import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareArticleImages } from "../src/articleImages.js";
import { uploadArticleImage } from "../src/r2.js";

vi.mock("../src/r2.js", () => ({
  uploadArticleImage: vi.fn(),
}));

describe("article image generation", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("generates one image and uploads it to R2", async () => {
    process.env = {
      ...originalEnv,
      PUBLIC_BASE_URL: "https://vibepub.example.test",
      ARTICLE_IMAGE_API_KEY: "image-key",
      ARTICLE_IMAGE_BASE_URL: "https://image.example.test",
      ARTICLE_IMAGE_MODEL: "image-test",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("png-data").toString("base64") }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.mocked(uploadArticleImage).mockResolvedValue();

    const images = await prepareArticleImages(
      "inbox/VibePub-2026-07-02-160000-0m18s-Test.m4a",
      [
        {
          imageId: "opening-desk",
          kind: "insert_image",
          prompt: "A warm desk, no text",
          alt: "办公桌",
          anchor: { position: "after", paragraphIndex: 1 },
        },
      ],
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://image.example.test/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer image-key",
        }),
      }),
    );
    expect(uploadArticleImage).toHaveBeenCalledWith(
      "article-images/VibePub-2026-07-02-160000-0m18s-Test/opening-desk.png",
      Buffer.from("png-data"),
    );
    expect(images[0]).toMatchObject({
      imageId: "opening-desk",
      r2Key: "article-images/VibePub-2026-07-02-160000-0m18s-Test/opening-desk.png",
      publicUrl: "https://vibepub.example.test/api/files/article-images%2FVibePub-2026-07-02-160000-0m18s-Test%2Fopening-desk.png",
    });
  });
});
