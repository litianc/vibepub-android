import { afterEach, describe, expect, it, vi } from "vitest";
import { articlePackageFromResponse, type ArticlePackage } from "../src/article";
import {
  buildFormattingInstructions,
  createFormattingSkillRegistryForTests,
  FORMATTING_SKILL_ID,
  FORMATTING_SKILL_VERSION,
  FormattingSkillError,
  getFormattingSkill,
  LEGACY_LAYOUT_PROFILE_ID,
  LEGACY_LAYOUT_PROFILE_VERSION,
  listFormattingSkills,
  resolveFormattingSkill,
  validateAndNormalizeArticlePackage,
} from "../src/formattingSkills";
import worker from "../src/index";

const authHeaders = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatting skill registry", () => {
  it("resolves the canonical default and legacy layout alias to md_to_wechat", () => {
    const defaultSkill = resolveFormattingSkill(undefined);
    const canonical = resolveFormattingSkill({
      formatting_skill_id: FORMATTING_SKILL_ID,
      formatting_skill_version: FORMATTING_SKILL_VERSION,
    });
    const legacy = resolveFormattingSkill({
      layout_profile_id: LEGACY_LAYOUT_PROFILE_ID,
      layout_profile_version: LEGACY_LAYOUT_PROFILE_VERSION,
    });

    expect(defaultSkill).toMatchObject({ id: FORMATTING_SKILL_ID, version: FORMATTING_SKILL_VERSION, resolved_from: "default" });
    expect(canonical).toMatchObject({ id: FORMATTING_SKILL_ID, version: FORMATTING_SKILL_VERSION, resolved_from: "formatting_skill" });
    expect(legacy).toMatchObject({ id: FORMATTING_SKILL_ID, version: FORMATTING_SKILL_VERSION, resolved_from: "legacy_layout_profile" });
    expect(resolveFormattingSkill({
      formatting_skill_id: FORMATTING_SKILL_ID,
      formatting_skill_version: FORMATTING_SKILL_VERSION,
      layout_profile_id: LEGACY_LAYOUT_PROFILE_ID,
      layout_profile_version: LEGACY_LAYOUT_PROFILE_VERSION,
    }).id).toBe(FORMATTING_SKILL_ID);
  });

  it("keeps test registry entries isolated from the default manifest list", () => {
    const registry = createFormattingSkillRegistryForTests();
    const testSkill = resolveFormattingSkill({
      formatting_skill_id: "test_isolated_skill",
      formatting_skill_version: "0.0.1",
    }, registry);

    expect(buildFormattingInstructions(testSkill)).toBe("TEST_ONLY_FORMATTING_INSTRUCTIONS");
    expect(listFormattingSkills()).toHaveLength(1);
    expect(listFormattingSkills()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "test_isolated_skill" }),
    ]));
  });

  it("returns precise errors for missing, unknown, stale, and conflicting profile selections", () => {
    const assertSkillError = (fn: () => unknown, status: number, code: string) => {
      try {
        fn();
        throw new Error("expected formatting skill resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(FormattingSkillError);
        expect(error).toMatchObject({ status, code });
      }
    };

    assertSkillError(() => resolveFormattingSkill({ formatting_skill_id: FORMATTING_SKILL_ID }), 400, "formatting_skill_version_required");
    assertSkillError(() => resolveFormattingSkill({ formatting_skill_id: "unknown", formatting_skill_version: "1.0.0" }), 404, "formatting_skill_not_found");
    assertSkillError(() => resolveFormattingSkill({ formatting_skill_id: FORMATTING_SKILL_ID, formatting_skill_version: "0.9.0" }), 409, "formatting_skill_version_conflict");
    assertSkillError(() => resolveFormattingSkill({
      formatting_skill_id: FORMATTING_SKILL_ID,
      formatting_skill_version: FORMATTING_SKILL_VERSION,
      layout_profile_id: "incompatible_layout",
    }), 409, "formatting_profile_conflict");
  });

  it("exposes only public formatting manifests", () => {
    const manifest = getFormattingSkill(FORMATTING_SKILL_ID);
    expect(manifest).toMatchObject({
      id: FORMATTING_SKILL_ID,
      version: FORMATTING_SKILL_VERSION,
      output_format: "wechat_html_fragment",
      image_policy: "image_actions_only",
      author_source: "publishing_identity",
    });
    expect(JSON.stringify(manifest)).not.toContain("输出 content_html 时");
    expect(() => getFormattingSkill("missing")).toThrow(expect.objectContaining({ code: "formatting_skill_not_found" }));
  });
});

describe("md_to_wechat normalizer", () => {
  it("keeps the supported article structure and deterministically degrades formulas and Mermaid", () => {
    const article = syntheticArticle(`
      <section><h2>核心判断</h2><p>第一段很短。</p><h3>展开</h3>
      <ul><li>无序项</li></ul><ol><li>有序项</li></ol>
      <blockquote>引用内容</blockquote><pre><code>const safe = true;</code></pre>
      <table><thead><tr><th>方案</th><th>结果</th></tr></thead><tbody><tr><td>A</td><td>可用</td></tr></tbody></table>
      <p>公式 $E=mc^2$。</p><pre class="mermaid">graph TD; A--&gt;B;</pre>
      <img src="https://images.example.test/remote.png"><script>alert(1)</script>
    </section>`);

    const output = validateAndNormalizeArticlePackage(article, resolveFormattingSkill(undefined));

    expect(output.content_html).toContain("<h2 style=");
    expect(output.content_html).toContain("<h3 style=");
    expect(output.content_html).toContain("<ul style=");
    expect(output.content_html).toContain("<blockquote style=");
    expect(output.content_html).toContain("<pre style=");
    expect(output.content_html).toContain("<table style=");
    expect(output.content_html).toContain("E=mc^2");
    expect(output.content_html).toContain("graph TD");
    expect(output.content_html).not.toMatch(/<(script|img|style|iframe|form)\b/i);
    expect(output.warnings.join(" ")).toContain("公式已降级");
    expect(output.warnings.join(" ")).toContain("Mermaid 已降级");
    expect(output.warnings.join(" ")).toContain("img");
  });

  it("removes dangerous HTML and fails closed when a malformed model response cannot be recovered", () => {
    const safe = validateAndNormalizeArticlePackage(syntheticArticle(
      `<p onclick="alert(1)">可读正文 <a href="javascript:alert(2)">危险链接</a></p><form><input></form><img src="https://remote.example.test/a.png">`,
    ), resolveFormattingSkill(undefined));
    expect(safe.content_html).not.toMatch(/onclick|javascript:|https:\/\/remote|<form|<img/i);
    expect(safe.content_html).toContain("危险链接");

    expect(() => validateAndNormalizeArticlePackage(
      articlePackageFromResponse("<script>untrusted response</script>"),
      resolveFormattingSkill(undefined),
    )).toThrow(expect.objectContaining({ code: "formatting_validation_failed" }));
  });
});

describe("formatting skill Worker contract", () => {
  it("requires auth and returns a public list/detail without adapter instructions", async () => {
    const unauthorized = await worker.fetch(new Request("https://writing-agent.test/v1/formatting-skills"), {
      WRITING_AGENT_TOKEN: "test-token",
    });
    expect(unauthorized.status).toBe(401);

    const list = await worker.fetch(new Request("https://writing-agent.test/v1/formatting-skills", { headers: authHeaders }), {
      WRITING_AGENT_TOKEN: "test-token",
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      formatting_skills: [expect.objectContaining({ id: FORMATTING_SKILL_ID, version: FORMATTING_SKILL_VERSION })],
    });

    const detail = await worker.fetch(new Request(`https://writing-agent.test/v1/formatting-skills/${FORMATTING_SKILL_ID}`, { headers: authHeaders }), {
      WRITING_AGENT_TOKEN: "test-token",
    });
    const detailBody = await detail.json() as { formatting_skill: Record<string, unknown> };
    expect(detail.status).toBe(200);
    expect(detailBody.formatting_skill).not.toHaveProperty("promptInstructions");
    expect(detailBody.formatting_skill).not.toHaveProperty("adapter");

    const missing = await worker.fetch(new Request("https://writing-agent.test/v1/formatting-skills/missing", { headers: authHeaders }), {
      WRITING_AGENT_TOKEN: "test-token",
    });
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "formatting_skill_not_found" } });
    expect(missing.status).toBe(404);
  });

  it("uses the canonical and legacy selections for rewrite and revision while preserving metadata", async () => {
    const fetchMock = mockGlmArticle();
    const defaultRewrite = await rewriteRequest({});
    expect(defaultRewrite.status).toBe(201);
    await expect(defaultRewrite.json()).resolves.toMatchObject({
      profile_versions: { formatting_skill_id: FORMATTING_SKILL_ID, formatting_skill_version: FORMATTING_SKILL_VERSION },
    });

    const canonical = await rewriteRequest({
      formatting_skill_id: FORMATTING_SKILL_ID,
      formatting_skill_version: FORMATTING_SKILL_VERSION,
    });
    expect(canonical.status).toBe(201);
    await expect(canonical.json()).resolves.toMatchObject({
      profile_versions: {
        formatting_skill_id: FORMATTING_SKILL_ID,
        formatting_skill_version: FORMATTING_SKILL_VERSION,
        layout_profile_id: LEGACY_LAYOUT_PROFILE_ID,
        layout_profile_version: LEGACY_LAYOUT_PROFILE_VERSION,
      },
    });

    const legacy = await worker.fetch(new Request("https://writing-agent.test/v1/revision-jobs", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
      current_article: { title: "旧标题", content_html: "<section><p>旧正文。</p></section>" },
      instruction: { text: "补充一个结论" },
        profiles: {
          formatting_skill_id: FORMATTING_SKILL_ID,
          formatting_skill_version: FORMATTING_SKILL_VERSION,
          layout_profile_id: LEGACY_LAYOUT_PROFILE_ID,
          layout_profile_version: LEGACY_LAYOUT_PROFILE_VERSION,
        },
      }),
    }), workerEnv());
    expect(legacy.status, await legacy.clone().text()).toBe(201);
    await expect(legacy.json()).resolves.toMatchObject({
      profile_versions: { formatting_skill_id: FORMATTING_SKILL_ID, formatting_skill_version: FORMATTING_SKILL_VERSION },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("glm.example.test");
    expect(String(fetchMock.mock.calls[1][0])).toContain("glm.example.test");
    expect(String(fetchMock.mock.calls[2][0])).toContain("glm.example.test");
  });

  it("rejects invalid formatting selections before making a GLM call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const profiles of [
      { formatting_skill_id: "missing", formatting_skill_version: "1.0.0" },
      { formatting_skill_id: FORMATTING_SKILL_ID, formatting_skill_version: "0.0.0" },
      { formatting_skill_id: FORMATTING_SKILL_ID, formatting_skill_version: FORMATTING_SKILL_VERSION, layout_profile_id: "incompatible_layout" },
    ]) {
      const response = await rewriteRequest(profiles);
      expect(response.status).toBe(profiles.layout_profile_id ? 409 : profiles.formatting_skill_id === "missing" ? 404 : 409);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function syntheticArticle(contentHtml: string): ArticlePackage {
  return {
    title: "合成排版夹具",
    content_html: contentHtml,
    cover: { image_prompt: "Synthetic editorial cover, no text" },
    warnings: [],
    image_actions: [{
      image_id: "synthetic-image-action",
      kind: "insert_image",
      prompt: "Synthetic inline illustration, no text",
      alt: "合成插图动作",
      anchor: { position: "after", paragraph_index: 1 },
    }],
  };
}

function workerEnv() {
  return {
    WRITING_AGENT_TOKEN: "test-token",
    GLM_API_KEY: "test-glm-key",
    GLM_BASE_URL: "https://glm.example.test/api/paas/v4",
    GLM_MODEL: "test-model",
  };
}

function mockGlmArticle() {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      title: "合成输出标题",
      content_html: "<section><h2>合成小节</h2><p>合成正文。</p></section>",
      cover_title: ["合成", "标题"],
      image_prompt: "Synthetic editorial cover, no text",
      image_actions: [{
        image_id: "fixture-image",
        kind: "insert_image",
        prompt: "Synthetic inline illustration, no text",
        alt: "合成插图动作",
        anchor: { position: "after", paragraph_index: 1 },
      }],
    }) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function rewriteRequest(profiles: Record<string, string | undefined>) {
  return worker.fetch(new Request("https://writing-agent.test/v1/rewrite-jobs", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      input: { raw_text: "这是完全合成的排版夹具输入。" },
      profiles,
    }),
  }), workerEnv());
}
