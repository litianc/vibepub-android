import { describe, expect, it } from "vitest";
import { recoverArticleJsonLikeResponse } from "../src/llm.js";

describe("LLM article response recovery", () => {
  it("recovers article fields when content contains unescaped quotes", () => {
    const response = `
{
  "title": "深入业务做 AI 转型：为什么派人轮岗这条路走不通",
  "content": "<section><p>这种"意思一下"式的配合，是企业做 AI 转型会遇到的阻力。</p></section>",
  "coverTitle": ["业务部门", "不会告诉你", "真实痛点"],
  "coverSubtitle": "派人轮岗",
  "imagePrompt": "A clean office maze illustration, no text"
}
`;

    const recovered = recoverArticleJsonLikeResponse(response);

    expect(recovered).toMatchObject({
      title: "深入业务做 AI 转型：为什么派人轮岗这条路走不通",
      content: '<section><p>这种"意思一下"式的配合，是企业做 AI 转型会遇到的阻力。</p></section>',
      coverTitle: ["业务部门", "不会告诉你", "真实痛点"],
      coverSubtitle: "派人轮岗",
      imagePrompt: "A clean office maze illustration, no text",
    });
  });
});
