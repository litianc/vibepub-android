import type { ArticlePackage } from "./article";

export const FORMATTING_SKILL_ID = "md_to_wechat";
export const FORMATTING_SKILL_VERSION = "1.0.0";
export const LEGACY_LAYOUT_PROFILE_ID = "wechat_clean_article";
export const LEGACY_LAYOUT_PROFILE_VERSION = "2026-07-05";

export type FormattingSkillProfileInput = {
  formatting_skill_id?: string;
  formatting_skill_version?: string;
  layout_profile_id?: string;
  layout_profile_version?: string;
};

export type FormattingSkillManifest = {
  id: string;
  version: string;
  name: string;
  description: string;
  aliases: Array<{
    type: "layout_profile";
    id: string;
    version: string;
  }>;
  output_format: "wechat_html_fragment";
  allowed_tags: string[];
  heading_policy: string;
  publication_checks: string[];
  image_policy: "image_actions_only";
  complex_content_fallbacks: Record<string, string>;
  capabilities: string[];
  author_source: "publishing_identity";
};

type FormattingSkillDefinition = {
  manifest: FormattingSkillManifest;
  promptInstructions: string;
};

export type ResolvedFormattingSkill = {
  id: string;
  version: string;
  manifest: FormattingSkillManifest;
  definition: FormattingSkillDefinition;
  resolved_from: "default" | "formatting_skill" | "legacy_layout_profile";
};

export class FormattingSkillError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ALLOWED_TAGS = [
  "section", "p", "h2", "h3", "strong", "em", "blockquote", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "hr", "pre", "code",
];

const MD_TO_WECHAT: FormattingSkillDefinition = {
  manifest: {
    id: FORMATTING_SKILL_ID,
    version: FORMATTING_SKILL_VERSION,
    name: "公众号 Markdown 排版",
    description: "稳定的标题层级、短段落和微信兼容基础排版。",
    aliases: [{
      type: "layout_profile",
      id: LEGACY_LAYOUT_PROFILE_ID,
      version: LEGACY_LAYOUT_PROFILE_VERSION,
    }],
    output_format: "wechat_html_fragment",
    allowed_tags: ALLOWED_TAGS,
    heading_policy: "result.title is the H1 equivalent; content_html uses H2 and H3 only",
    publication_checks: [
      "allowlisted_tags_only",
      "no_event_attributes",
      "no_javascript_urls",
      "no_external_images",
      "no_document_shell",
    ],
    image_policy: "image_actions_only",
    complex_content_fallbacks: {
      formula: "readable_inline_code_with_warning",
      mermaid: "escaped_source_code_with_warning",
      unsupported_html: "remove_or_escape_with_warning",
    },
    capabilities: ["headings", "short_paragraphs", "lists", "quotes", "code", "tables", "image_actions"],
    author_source: "publishing_identity",
  },
  promptInstructions: `
输出 content_html 时只返回微信公众号可用的 HTML 片段，不能返回 html、head 或 body 文档外壳。
result.title 已经承担文章 H1，正文不要重复 H1；正文标题只使用 h2 和 h3。
正文使用短段落，并可使用 ul、ol、blockquote、pre/code 和 table 表达结构。
不要输出 script、style、iframe、form、事件属性、链接 JavaScript URL 或 img 标签。
图片只用 image_actions 描述，不能在 content_html 中插入图片地址或占位图片。
公式请改写成读者可理解的纯文本或 code；Mermaid 请改写成文字说明或 code，不要请求在线渲染。
`.trim(),
};

const DEFAULT_REGISTRY: FormattingSkillDefinition[] = [MD_TO_WECHAT];

export function resolveFormattingSkill(
  profiles: FormattingSkillProfileInput | undefined,
  registry: FormattingSkillDefinition[] = DEFAULT_REGISTRY,
): ResolvedFormattingSkill {
  const formattingId = normalized(profiles?.formatting_skill_id);
  const formattingVersion = normalized(profiles?.formatting_skill_version);
  const legacyId = normalized(profiles?.layout_profile_id);
  const legacyVersion = normalized(profiles?.layout_profile_version);

  if (formattingVersion && !formattingId) {
    throw new FormattingSkillError(400, "formatting_skill_id_required", "formatting_skill_version requires formatting_skill_id");
  }
  if (formattingId && !formattingVersion) {
    throw new FormattingSkillError(400, "formatting_skill_version_required", "formatting_skill_id requires formatting_skill_version");
  }

  const explicit = formattingId
    ? resolveCanonical(formattingId, formattingVersion, registry, "formatting_skill")
    : undefined;
  let legacy: ResolvedFormattingSkill | undefined;
  if (legacyId) {
    try {
      legacy = resolveLegacyAlias(legacyId, legacyVersion, registry);
    } catch (error) {
      if (explicit && error instanceof FormattingSkillError) {
        throw new FormattingSkillError(
          409,
          "formatting_profile_conflict",
          "formatting_skill and legacy layout_profile are inconsistent",
        );
      }
      throw error;
    }
  }

  if (explicit && legacy && (explicit.id !== legacy.id || explicit.version !== legacy.version)) {
    throw new FormattingSkillError(
      409,
      "formatting_profile_conflict",
      "formatting_skill and legacy layout_profile resolve to different formatting skills",
    );
  }

  return explicit || legacy || resolved(registry[0], "default");
}

export function listFormattingSkills(registry: FormattingSkillDefinition[] = DEFAULT_REGISTRY): FormattingSkillManifest[] {
  return registry.map(skill => publicFormattingManifest(skill));
}

export function getFormattingSkill(
  id: string,
  registry: FormattingSkillDefinition[] = DEFAULT_REGISTRY,
): FormattingSkillManifest {
  const definition = registry.find(skill => skill.manifest.id === id.trim());
  if (!definition) {
    throw new FormattingSkillError(404, "formatting_skill_not_found", "formatting skill does not exist");
  }
  return publicFormattingManifest(definition);
}

export function buildFormattingInstructions(skill: ResolvedFormattingSkill): string {
  return skill.definition.promptInstructions;
}

export function validateAndNormalizeArticlePackage(
  article: ArticlePackage,
  skill: ResolvedFormattingSkill,
): ArticlePackage {
  if (article.warnings.some(warning => warning.includes("模型没有返回标准文章 JSON"))) {
    throw new FormattingSkillError(
      422,
      "formatting_validation_failed",
      "Model response could not be safely recovered as a publishable article",
    );
  }

  const normalizedOutput = normalizeWechatHtml(article.content_html, article.title, skill.manifest);
  return {
    ...article,
    content_html: normalizedOutput.html,
    warnings: deduplicate([...article.warnings, ...normalizedOutput.warnings]),
  };
}

export function createFormattingSkillRegistryForTests(): FormattingSkillDefinition[] {
  return [
    MD_TO_WECHAT,
    {
      manifest: {
        ...MD_TO_WECHAT.manifest,
        id: "test_isolated_skill",
        version: "0.0.1",
        name: "Test isolated formatting skill",
        aliases: [],
      },
      promptInstructions: "TEST_ONLY_FORMATTING_INSTRUCTIONS",
    },
  ];
}

function resolveCanonical(
  id: string,
  version: string,
  registry: FormattingSkillDefinition[],
  resolvedFrom: ResolvedFormattingSkill["resolved_from"],
): ResolvedFormattingSkill {
  const byId = registry.find(skill => skill.manifest.id === id);
  if (!byId) {
    throw new FormattingSkillError(404, "formatting_skill_not_found", "formatting skill does not exist");
  }
  if (byId.manifest.version !== version) {
    throw new FormattingSkillError(
      409,
      "formatting_skill_version_conflict",
      `formatting skill version is unavailable; current version is ${byId.manifest.version}`,
    );
  }
  return resolved(byId, resolvedFrom);
}

function resolveLegacyAlias(
  id: string,
  version: string,
  registry: FormattingSkillDefinition[],
): ResolvedFormattingSkill {
  const matches = registry.filter(skill => skill.manifest.aliases.some(alias => alias.id === id));
  if (matches.length === 0) {
    throw new FormattingSkillError(404, "layout_profile_not_found", "layout_profile does not exist");
  }
  const match = matches.find(skill => skill.manifest.aliases.some(alias =>
    alias.id === id && (!version || alias.version === version),
  ));
  if (!match) {
    const current = matches[0].manifest.aliases.find(alias => alias.id === id)?.version;
    throw new FormattingSkillError(
      409,
      "formatting_skill_version_conflict",
      `legacy layout_profile version is unavailable; current version is ${current}`,
    );
  }
  return resolved(match, "legacy_layout_profile");
}

function resolved(
  definition: FormattingSkillDefinition,
  resolvedFrom: ResolvedFormattingSkill["resolved_from"],
): ResolvedFormattingSkill {
  return {
    id: definition.manifest.id,
    version: definition.manifest.version,
    manifest: publicFormattingManifest(definition),
    definition,
    resolved_from: resolvedFrom,
  };
}

function publicFormattingManifest(definition: FormattingSkillDefinition): FormattingSkillManifest {
  return {
    ...definition.manifest,
    aliases: definition.manifest.aliases.map(alias => ({ ...alias })),
    allowed_tags: [...definition.manifest.allowed_tags],
    publication_checks: [...definition.manifest.publication_checks],
    complex_content_fallbacks: { ...definition.manifest.complex_content_fallbacks },
    capabilities: [...definition.manifest.capabilities],
  };
}

function normalizeWechatHtml(rawHtml: string, title: string, manifest: FormattingSkillManifest): { html: string; warnings: string[] } {
  const warnings: string[] = [];
  const substitutions: Array<{ marker: string; html: string }> = [];
  let source = String(rawHtml || "").trim();
  if (!source) {
    throw new FormattingSkillError(422, "formatting_validation_failed", "Article content_html is empty");
  }

  source = extractComplexContent(source, substitutions, warnings);
  source = source.replace(/<(script|style|iframe|form|object|embed|svg|video|audio|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (_match, tag) => {
    warnings.push(`已移除不受支持的 <${String(tag).toLowerCase()}> 内容。`);
    return "";
  });
  source = source.replace(/<(script|style|iframe|form|object|embed|svg|video|audio|canvas|img)\b[^>]*\/?>/gi, (_match, tag) => {
    warnings.push(`已移除不受支持的 <${String(tag).toLowerCase()}> 标签。`);
    return "";
  });
  source = source.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi, (_match, content) => {
    const heading = htmlToText(content);
    warnings.push("正文中的 H1 已按公众号正文层级规范化。");
    return heading === title.trim() ? "" : `<h2>${content}</h2>`;
  });

  const normalized = normalizeTokens(source, manifest, warnings);
  const restored = substitutions.reduce((html, substitution) => html.replaceAll(substitution.marker, substitution.html), normalized);
  if (!htmlToText(restored)) {
    throw new FormattingSkillError(422, "formatting_validation_failed", "Article content has no publishable text after normalization");
  }
  const fragment = isSingleSection(restored)
    ? restored
    : `<section style="${tagStyle("section")}">${restored}</section>`;
  return {
    html: fragment,
    warnings: deduplicate(warnings),
  };
}

function isSingleSection(html: string): boolean {
  return /^<section\b[^>]*>[\s\S]*<\/section>$/.test(html) &&
    (html.match(/<section\b/gi)?.length || 0) === 1;
}

function extractComplexContent(
  source: string,
  substitutions: Array<{ marker: string; html: string }>,
  warnings: string[],
): string {
  let index = 0;
  const marker = (html: string): string => {
    const value = `VIBEPUB_COMPLEX_${index += 1}_MARKER`;
    substitutions.push({ marker: value, html });
    return value;
  };

  let output = source.replace(/<(pre|code|div)\b[^>]*\bclass\s*=\s*["'][^"']*mermaid[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/gi, (_match, _tag, content) => {
    warnings.push("Mermaid 已降级为可读源码，未请求在线渲染。 ");
    return marker(`<pre style="${tagStyle("pre")}"><code style="${tagStyle("code_in_pre")}">${escapeHtml(htmlToText(content))}</code></pre>`);
  });
  const formulas = /\$\$([\s\S]{1,600}?)\$\$|(?<!\\)\$([^$\n]{1,600})\$|\\\(([\s\S]{1,600}?)\\\)|\\\[([\s\S]{1,600}?)\\\]/g;
  output = output.replace(formulas, (_match, block, inline, round, square) => {
    const formula = String(block ?? inline ?? round ?? square ?? "").trim();
    if (!formula) return "";
    warnings.push("公式已降级为可读代码，未请求在线渲染。 ");
    return marker(`<code style="${tagStyle("code")}">${escapeHtml(formula)}</code>`);
  });
  return output;
}

function normalizeTokens(source: string, manifest: FormattingSkillManifest, warnings: string[]): string {
  const allowed = new Set(manifest.allowed_tags);
  const stack: string[] = [];
  const output: string[] = [];
  const tokens = source.split(/(<[^>]*>)/g);
  for (const token of tokens) {
    if (!token) continue;
    if (!token.startsWith("<")) {
      output.push(escapeHtml(token));
      continue;
    }
    const parsed = /^<\s*(\/)?\s*([a-zA-Z0-9]+)\b[^>]*>$/.exec(token);
    if (!parsed) {
      warnings.push("已转义不完整的 HTML 标签。 ");
      output.push(escapeHtml(token));
      continue;
    }
    const closing = Boolean(parsed[1]);
    const tag = parsed[2].toLowerCase();
    if (!allowed.has(tag)) {
      if (tag !== "br") warnings.push(`已移除不在白名单中的 <${tag}> 标签。`);
      continue;
    }
    if (closing) {
      closeTag(tag, stack, output);
      continue;
    }
    if (tag === "p" && stack.at(-1) === "p") closeTag("p", stack, output);
    if ((tag === "h2" || tag === "h3") && stack.at(-1) === "p") closeTag("p", stack, output);
    const style = tag === "code" && stack.at(-1) === "pre"
      ? tagStyle("code_in_pre")
      : tagStyle(tag);
    output.push(`<${tag} style="${style}">`);
    if (tag === "hr") continue;
    stack.push(tag);
  }
  while (stack.length > 0) output.push(`</${stack.pop()}>`);
  const html = output.join("").trim();
  if (/<[a-z]/i.test(html)) return html;
  return html ? `<p style="${tagStyle("p")}">${html}</p>` : "";
}

function closeTag(tag: string, stack: string[], output: string[]): void {
  const index = stack.lastIndexOf(tag);
  if (index < 0) return;
  while (stack.length > index) output.push(`</${stack.pop()}>`);
}

function tagStyle(tag: string): string {
  const styles: Record<string, string> = {
    section: "margin:0;padding:0;color:#262626;font-size:16px;line-height:1.8;word-break:break-word;",
    p: "margin:0 0 18px;line-height:1.8;text-align:justify;word-break:break-word;",
    h2: "margin:34px 0 16px;padding-left:10px;border-left:4px solid #1677ff;font-size:21px;line-height:1.45;font-weight:700;color:#1f2937;",
    h3: "margin:26px 0 12px;font-size:18px;line-height:1.5;font-weight:700;color:#334155;",
    strong: "font-weight:700;color:#111827;",
    em: "font-style:italic;",
    blockquote: "margin:20px 0;padding:12px 16px;border-left:3px solid #94a3b8;background:#f8fafc;color:#475569;line-height:1.75;",
    ul: "margin:0 0 18px;padding-left:24px;",
    ol: "margin:0 0 18px;padding-left:24px;",
    li: "margin:7px 0;line-height:1.75;",
    table: "width:100%;margin:20px 0;border-collapse:collapse;table-layout:fixed;font-size:14px;line-height:1.6;",
    thead: "background:#f1f5f9;",
    tbody: "background:#ffffff;",
    tr: "border-bottom:1px solid #dbe3ec;",
    th: "padding:9px 8px;border:1px solid #dbe3ec;text-align:left;font-weight:700;word-break:break-word;",
    td: "padding:9px 8px;border:1px solid #dbe3ec;vertical-align:top;word-break:break-word;",
    hr: "margin:28px 0;border:0;border-top:1px solid #dbe3ec;",
    pre: "margin:18px 0;padding:14px;overflow:hidden;background:#0f172a;color:#e2e8f0;font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-word;",
    code: "padding:1px 4px;border-radius:2px;background:#f1f5f9;color:#be123c;font-family:monospace;font-size:0.92em;word-break:break-word;",
    code_in_pre: "padding:0;background:transparent;color:inherit;font-family:monospace;font-size:inherit;word-break:break-word;",
  };
  return styles[tag] || "";
}

function htmlToText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalized(value: string | undefined): string {
  return value?.trim() || "";
}

function deduplicate(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
