import { describe, expect, it } from "vitest";
import { buildWechatArticlePrompt, LITIAN_C_WECHAT_STYLE_PROFILE } from "../src/styleProfile.js";

describe("litianc WeChat style profile", () => {
  it("captures the intended writing voice and publication constraints", () => {
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("真实、理性、结构化");
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("问题背景 -> 关键判断 -> 分层拆解");
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("微信公众号草稿的 HTML 片段");
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("不要编造原始录音中没有出现的事实");
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("coverTitle 是公众号封面主标题短句");
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("不要解释性小字");
    expect(LITIAN_C_WECHAT_STYLE_PROFILE).toContain("不要依赖它生成中文标题");
  });

  it("builds a JSON-only article prompt with the raw transcript", () => {
    const prompt = buildWechatArticlePrompt(" 我今天想讲一下 AI 转型不能只是在旧流程里加按钮。 ");

    expect(prompt).toContain("请只返回 JSON 对象");
    expect(prompt).toContain("title：文章标题");
    expect(prompt).toContain("content：正文 HTML 片段");
    expect(prompt).toContain("coverTitle：公众号封面主标题短句数组");
    expect(prompt).toContain("coverSubtitle：可选封面副标题");
    expect(prompt).toContain("imagePrompt：备用英文无字底图提示词");
    expect(prompt).toContain("AI 转型不能只是在旧流程里加按钮");
    expect(prompt).not.toContain(" 我今天想讲一下 AI 转型不能只是在旧流程里加按钮。 ");
  });
});
