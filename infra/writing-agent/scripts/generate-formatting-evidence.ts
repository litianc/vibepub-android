import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { articlePackageFromResponse, type ArticlePackage } from "../src/article";
import {
  FORMATTING_SKILL_ID,
  FORMATTING_SKILL_VERSION,
  LEGACY_LAYOUT_PROFILE_ID,
  LEGACY_LAYOUT_PROFILE_VERSION,
  resolveFormattingSkill,
  validateAndNormalizeArticlePackage,
} from "../src/formattingSkills";
import worker, { createWritingAgentWorker } from "../src/index";
import {
  createTestFormattingSkillRegistry,
  TEST_FORMATTING_SKILL_ID,
  TEST_FORMATTING_SKILL_VERSION,
} from "../test/fixtures/testFormattingSkill";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../test/fixtures/md-to-wechat-article.json");
const outputDir = argument("--out");
if (!outputDir) {
  throw new Error("Usage: vite-node scripts/generate-formatting-evidence.ts --out /absolute/evidence/directory");
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
await mkdir(outputDir, { recursive: true });
await writeJson("fixture.json", fixture);

const networkRequests: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  networkRequests.push(String(input));
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(fixture) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const testRegistry = createTestFormattingSkillRegistry();
  const testWorker = createWritingAgentWorker(testRegistry);
  const canonicalRequest = rewriteRequest({
    formatting_skill_id: FORMATTING_SKILL_ID,
    formatting_skill_version: FORMATTING_SKILL_VERSION,
  });
  const canonicalResponse = await worker.fetch(canonicalRequest.request, workerEnv());
  const canonicalBody = await canonicalResponse.json() as Record<string, unknown>;
  assertStatus(canonicalResponse.status, 201, "canonical rewrite");
  await writeJson("canonical-request.json", canonicalRequest.redacted);
  await writeJson("canonical-response.json", responseMetadata(canonicalBody));

  const legacyRequest = rewriteRequest({
    layout_profile_id: LEGACY_LAYOUT_PROFILE_ID,
    layout_profile_version: LEGACY_LAYOUT_PROFILE_VERSION,
  });
  const legacyResponse = await worker.fetch(legacyRequest.request, workerEnv());
  const legacyBody = await legacyResponse.json() as Record<string, unknown>;
  assertStatus(legacyResponse.status, 201, "legacy rewrite");
  await writeJson("legacy-alias-request.json", legacyRequest.redacted);
  await writeJson("legacy-alias-response.json", responseMetadata(legacyBody));

  const alternateRequest = rewriteRequest({
    formatting_skill_id: TEST_FORMATTING_SKILL_ID,
    formatting_skill_version: TEST_FORMATTING_SKILL_VERSION,
  });
  const alternateResponse = await testWorker.fetch(alternateRequest.request, workerEnv());
  const alternateBody = await alternateResponse.json() as Record<string, unknown>;
  assertStatus(alternateResponse.status, 201, "alternate test adapter rewrite");
  await writeJson("alternate-skill-request.json", alternateRequest.redacted);
  await writeJson("alternate-skill-response.json", responseMetadata(alternateBody));

  const contentHtml = String((canonicalBody.result as Record<string, unknown>).content_html || "");
  const alternateContentHtml = String((alternateBody.result as Record<string, unknown>).content_html || "");
  await writeFile(resolve(outputDir, "preview.html"), renderPreview({
    label: `${FORMATTING_SKILL_ID}@${FORMATTING_SKILL_VERSION}`,
    title: fixture.title,
    contentHtml,
    imageActions: fixture.image_actions,
    warnings: ((canonicalBody.result as Record<string, unknown>).warnings || []) as string[],
  }));
  await writeFile(resolve(outputDir, "alternate-preview.html"), renderPreview({
    label: `${TEST_FORMATTING_SKILL_ID}@${TEST_FORMATTING_SKILL_VERSION}`,
    title: fixture.title,
    contentHtml: alternateContentHtml,
    imageActions: fixture.image_actions,
    warnings: ((alternateBody.result as Record<string, unknown>).warnings || []) as string[],
  }));
  await writeFile(resolve(outputDir, "side-by-side.html"), renderSideBySide({
    title: fixture.title,
    canonical: { label: `${FORMATTING_SKILL_ID}@${FORMATTING_SKILL_VERSION}`, contentHtml },
    alternate: { label: `${TEST_FORMATTING_SKILL_ID}@${TEST_FORMATTING_SKILL_VERSION}`, contentHtml: alternateContentHtml },
  }));
  await writeJson("replaceability-comparison.json", {
    fixture: "md-to-wechat-article.json",
    content_html_equal: contentHtml === alternateContentHtml,
    canonical: {
      id: FORMATTING_SKILL_ID,
      version: FORMATTING_SKILL_VERSION,
      heading_marker: "border-left:4px solid #1677ff",
      formula_fallback: "inline_code",
      mermaid_fallback: "pre_code",
    },
    alternate: {
      id: TEST_FORMATTING_SKILL_ID,
      version: TEST_FORMATTING_SKILL_VERSION,
      heading_marker: "border-bottom:2px solid #0f766e",
      formula_fallback: "labelled_strong_text",
      mermaid_fallback: "quoted_source",
    },
  });

  const entityInput = `<section><h2>实体语义</h2><p>研发 &amp;amp; 发布，&amp;quot;引号&amp;quot;，&amp;#20013;&amp;#x6587;，&amp;copy; &amp;hellip; &amp;mdash; &amp;ldquo;引用&amp;rdquo; Caf&amp;eacute;，深层 &amp;amp;amp;copy;，未知 &amp;amp;definitelyInvalid;，危险 &amp;amp;lt;script&amp;amp;gt;</p></section>`;
  const entityOutput = validateAndNormalizeArticlePackage(articleFromHtml(entityInput), resolveFormattingSkill(undefined));
  await writeJson("entity-input.json", { content_html: entityInput });
  await writeJson("entity-normalized-output.json", { content_html: entityOutput.content_html, warnings: entityOutput.warnings });
  await writeFile(resolve(outputDir, "entity-preview.html"), renderPreview({
    label: `${FORMATTING_SKILL_ID}@${FORMATTING_SKILL_VERSION} · entity regression`,
    title: "合成实体语义夹具",
    contentHtml: entityOutput.content_html,
    imageActions: [],
    warnings: entityOutput.warnings,
  }));

  const hostileInput = `<section><p onclick="alert(1)">合成安全正文 <a href="javascript:alert(2)">危险链接</a></p><img src="https://remote.example.test/image.png"><form><input></form><script>fetch('https://bad.example.test')</script><p>公式：$x^2$</p><pre class="mermaid">graph TD; X-->Y;</pre></section>`;
  const hostileOutput = validateAndNormalizeArticlePackage(articleFromHtml(hostileInput), resolveFormattingSkill(undefined));
  await writeJson("hostile-input.json", { content_html: hostileInput });
  await writeJson("hostile-normalized-output.json", {
    content_html: hostileOutput.content_html,
    warnings: hostileOutput.warnings,
  });
  await writeFile(resolve(outputDir, "hostile-preview.html"), renderPreview({
    label: `${FORMATTING_SKILL_ID}@${FORMATTING_SKILL_VERSION} · hostile fixture`,
    title: "合成 hostile fixture",
    contentHtml: hostileOutput.content_html,
    imageActions: [],
    warnings: hostileOutput.warnings,
  }));

  let validationFailure: Record<string, unknown>;
  try {
    validateAndNormalizeArticlePackage(articlePackageFromResponse("<script>untrusted model response</script>"), resolveFormattingSkill(undefined));
    throw new Error("malformed response unexpectedly passed validation");
  } catch (error) {
    validationFailure = {
      error_code: (error as { code?: string }).code || "unknown",
      message: (error as Error).message,
    };
  }
  await writeJson("formatting-validation-failure.json", validationFailure);

  const checks = {
    content_html: inspectContentHtml(contentHtml),
    alternate_content_html: inspectContentHtml(alternateContentHtml),
    entity_content_html: inspectContentHtml(entityOutput.content_html),
    hostile_content_html: inspectContentHtml(hostileOutput.content_html),
    network: {
      request_count: networkRequests.length,
      urls: networkRequests,
      forbidden_skillhub_requests: networkRequests.filter(url => /skillhub|feishu2weixin|remote\.example\.test/i.test(url)).length,
      external_image_requests: 0,
    },
  };
  await writeJson("formatter-security-audit.json", checks);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(outputDir);

function rewriteRequest(profiles: Record<string, string>) {
  const body = {
    protocol_version: "vibepub.rewrite.v1",
    client_job_id: "synthetic-formatting-fixture",
    idempotency_key: "synthetic-formatting-fixture",
    input: {
      source_type: "text_submission",
      raw_text: "完全合成的输入，用于生成排版证据。",
    },
    profiles,
    output_contract: { allow_image_actions: true },
  };
  return {
    request: new Request("https://writing-agent.fixture.test/v1/rewrite-jobs", {
      method: "POST",
      headers: { Authorization: "Bearer redacted", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    redacted: {
      method: "POST",
      path: "/v1/rewrite-jobs",
      body: {
        ...body,
        input: { source_type: body.input.source_type, raw_text: "[synthetic fixture input omitted]" },
      },
    },
  };
}

function workerEnv() {
  return {
    WRITING_AGENT_TOKEN: "redacted",
    GLM_API_KEY: "fixture-key-not-persisted",
    GLM_BASE_URL: "https://glm.fixture.test/api/coding/paas/v4",
    GLM_MODEL: "glm-5.2",
  };
}

function articleFromHtml(content_html: string): ArticlePackage {
  return {
    title: "合成安全夹具",
    content_html,
    cover: { image_prompt: "Synthetic cover prompt" },
    warnings: [],
  };
}

function renderPreview(input: {
  label: string;
  title: string;
  contentHtml: string;
  imageActions: Fixture["image_actions"];
  warnings: string[];
}): string {
  const actionRows = input.imageActions.map(action =>
    `<li style="margin:6px 0;word-break:break-word;"><strong>image_action</strong> ${escapeHtml(action.kind)} · ${escapeHtml(action.image_id)} · ${escapeHtml(action.alt || "")}</li>`,
  ).join("");
  const warningRows = input.warnings.map(warning => `<li style="margin:6px 0;">${escapeHtml(warning)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#eef2f6;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
  <main style="max-width:760px;margin:0 auto;padding:24px 16px 48px;box-sizing:border-box;">
    <div style="margin:0 0 16px;color:#64748b;font-size:13px;line-height:1.5;">${escapeHtml(input.label)} · synthetic fixture · wechat_html_fragment</div>
    <article style="box-sizing:border-box;width:100%;margin:0;padding:28px 22px;background:#ffffff;border:1px solid #dbe3ec;">
      <h1 style="margin:0 0 28px;font-size:28px;line-height:1.35;color:#0f172a;">${escapeHtml(input.title)}</h1>
      <div data-formatted-content>${input.contentHtml}</div>
      <section style="margin:28px 0 0;padding:14px 16px;border:1px solid #bfdbfe;background:#eff6ff;">
        <strong style="color:#1d4ed8;">image_actions</strong>
        <ul style="margin:10px 0 0;padding-left:20px;">${actionRows || "<li>none</li>"}</ul>
      </section>
      <section style="margin:18px 0 0;padding:14px 16px;border:1px solid #fed7aa;background:#fff7ed;">
        <strong style="color:#9a3412;">warnings</strong>
        <ul style="margin:10px 0 0;padding-left:20px;">${warningRows || "<li>none</li>"}</ul>
      </section>
    </article>
  </main>
</body>
</html>`;
}

function renderSideBySide(input: {
  title: string;
  canonical: { label: string; contentHtml: string };
  alternate: { label: string; contentHtml: string };
}): string {
  const panel = (value: { label: string; contentHtml: string }) => `
    <article style="box-sizing:border-box;min-width:0;padding:24px 20px;background:#ffffff;border:1px solid #dbe3ec;">
      <div style="margin:0 0 18px;color:#475569;font-size:13px;line-height:1.5;">${escapeHtml(value.label)}</div>
      <h1 style="margin:0 0 24px;font-size:25px;line-height:1.35;color:#0f172a;">${escapeHtml(input.title)}</h1>
      <div data-formatted-content>${value.contentHtml}</div>
    </article>`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#eef2f6;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
  <main style="max-width:1380px;margin:0 auto;padding:28px 18px 48px;box-sizing:border-box;">
    <div style="margin:0 0 18px;color:#334155;font-size:16px;line-height:1.5;font-weight:700;">同一合成夹具 · 两个可替换 Formatting Skill adapter</div>
    <section style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:start;">
      ${panel(input.canonical)}
      ${panel(input.alternate)}
    </section>
  </main>
</body>
</html>`;
}

function inspectContentHtml(contentHtml: string) {
  return {
    has_document_shell: /<(html|head|body)\b/i.test(contentHtml),
    has_forbidden_tag: /<(script|style|iframe|form|img)\b/i.test(contentHtml),
    has_event_attribute: /\son[a-z]+\s*=/i.test(contentHtml),
    has_javascript_url: /javascript\s*:/i.test(contentHtml),
    has_external_image: /<img\b|https?:\/\//i.test(contentHtml),
    allowed_tags_only: !/<\/?(?!section\b|p\b|h2\b|h3\b|strong\b|em\b|blockquote\b|ul\b|ol\b|li\b|table\b|thead\b|tbody\b|tr\b|th\b|td\b|hr\b|pre\b|code\b)[a-z][^>]*>/i.test(contentHtml),
  };
}

function responseMetadata(body: Record<string, unknown>) {
  const result = body.result as Record<string, unknown>;
  return {
    protocol_version: body.protocol_version,
    job_id: body.job_id,
    status: body.status,
    profile_versions: body.profile_versions,
    result: {
      title_present: Boolean(result?.title),
      content_html_present: Boolean(result?.content_html),
      image_actions_count: Array.isArray(result?.image_actions) ? result.image_actions.length : 0,
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      cover_fields: Object.keys((result?.cover || {}) as Record<string, unknown>).sort(),
    },
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function assertStatus(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label} returned HTTP ${actual}`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

type Fixture = {
  title: string;
  content_html: string;
  cover_title: string[];
  cover_subtitle: string;
  image_prompt: string;
  image_actions: Array<{
    image_id: string;
    kind: "insert_image";
    prompt: string;
    alt?: string;
    anchor: { position: "start" | "end" | "before" | "after"; paragraph_index?: number };
  }>;
};
