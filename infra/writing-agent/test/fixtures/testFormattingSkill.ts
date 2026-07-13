import {
  createFormattingSkillRegistry,
  createHtmlFormattingAdapter,
  type FormattingSkillDefinition,
  type FormattingSkillManifest,
} from "../../src/formattingSkills";

export const TEST_FORMATTING_SKILL_ID = "test_editorial_compact";
export const TEST_FORMATTING_SKILL_VERSION = "0.0.1";

const TEST_MANIFEST: FormattingSkillManifest = {
  id: TEST_FORMATTING_SKILL_ID,
  version: TEST_FORMATTING_SKILL_VERSION,
  name: "Test compact editorial formatter",
  description: "Test-only adapter with compact spacing and green editorial headings.",
  aliases: [],
  output_format: "wechat_html_fragment",
  allowed_tags: [
    "section", "p", "h2", "h3", "strong", "em", "blockquote", "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td", "hr", "pre", "code",
  ],
  heading_policy: "test-only compact headings; non-title H1 becomes H3",
  publication_checks: [
    "allowlisted_tags_only",
    "no_event_attributes",
    "no_javascript_urls",
    "no_external_images",
    "no_document_shell",
  ],
  image_policy: "image_actions_only",
  complex_content_fallbacks: {
    formula: "labelled_strong_text_with_warning",
    mermaid: "quoted_source_with_warning",
    unsupported_html: "remove_or_escape_with_warning",
  },
  capabilities: ["headings", "compact_paragraphs", "lists", "quotes", "code", "tables", "image_actions"],
  author_source: "publishing_identity",
};

const TEST_STYLES: Readonly<Record<string, string>> = {
  section: "margin:0;padding:0;color:#134e4a;font-size:15px;line-height:1.65;word-break:break-word;",
  p: "margin:0 0 10px;line-height:1.65;text-align:left;word-break:break-word;",
  h2: "margin:28px 0 12px;padding:0 0 6px;border-bottom:2px solid #0f766e;font-size:20px;line-height:1.4;font-weight:700;color:#0f766e;",
  h3: "margin:20px 0 9px;padding:5px 8px;background:#ecfdf5;font-size:17px;line-height:1.45;font-weight:700;color:#065f46;",
  strong: "font-weight:700;color:#047857;",
  em: "font-style:italic;color:#115e59;",
  blockquote: "margin:14px 0;padding:10px 12px;border:1px solid #99f6e4;background:#f0fdfa;color:#115e59;line-height:1.6;",
  ul: "margin:0 0 12px;padding-left:21px;",
  ol: "margin:0 0 12px;padding-left:21px;",
  li: "margin:4px 0;line-height:1.6;",
  table: "width:100%;margin:14px 0;border-collapse:collapse;table-layout:fixed;font-size:13px;line-height:1.5;",
  thead: "background:#ccfbf1;",
  tbody: "background:#ffffff;",
  tr: "border-bottom:1px solid #99f6e4;",
  th: "padding:7px 6px;border:1px solid #99f6e4;text-align:left;font-weight:700;word-break:break-word;",
  td: "padding:7px 6px;border:1px solid #99f6e4;vertical-align:top;word-break:break-word;",
  hr: "margin:20px 0;border:0;border-top:2px dotted #5eead4;",
  pre: "margin:12px 0;padding:12px;overflow:hidden;background:#042f2e;color:#ccfbf1;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;",
  code: "padding:1px 4px;background:#ccfbf1;color:#115e59;font-family:monospace;font-size:0.92em;word-break:break-word;",
  code_in_pre: "padding:0;background:transparent;color:inherit;font-family:monospace;font-size:inherit;word-break:break-word;",
};

export const TEST_FORMATTING_SKILL: FormattingSkillDefinition = createHtmlFormattingAdapter(TEST_MANIFEST, {
  instructions: "TEST_ONLY_COMPACT_EDITORIAL_FORMATTING",
  tagStyles: TEST_STYLES,
  heading: {
    replacementTag: "h3",
    warning: "测试排版已将正文 H1 收敛为紧凑 H3。",
  },
  complexContent: {
    renderFormula: (value, helpers) => `<strong style="${helpers.styleFor("strong")}">公式 ${helpers.escapeHtml(value)}</strong>`,
    formulaWarning: "测试排版已将公式降级为带标签的文本。",
    renderMermaid: (value, helpers) => `<blockquote style="${helpers.styleFor("blockquote")}">流程源码：<code style="${helpers.styleFor("code")}">${helpers.escapeHtml(value)}</code></blockquote>`,
    mermaidWarning: "测试排版已将 Mermaid 降级为引用源码。",
  },
});

export function createTestFormattingSkillRegistry(): FormattingSkillDefinition[] {
  return createFormattingSkillRegistry([TEST_FORMATTING_SKILL]);
}
