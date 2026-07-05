import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export type CoverBrief = {
  title: string;
  titleLines?: string[];
  subtitle?: string;
  imagePrompt?: string;
};

export const WECHAT_COVER_WIDTH = 900;
export const WECHAT_COVER_HEIGHT = 383;

const MAX_TITLE_LINES = 3;
const MAX_LINE_LENGTH = 12;
const COVER_BACKGROUND_DIR = fileURLToPath(new URL("../assets/cover-backgrounds/", import.meta.url));
const COVER_BACKGROUND_MANIFEST_PATH = path.join(COVER_BACKGROUND_DIR, "templates.json");

export type CoverBackgroundTemplate = {
  id: string;
  file: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
};

type CoverBackgroundSelection = {
  template: CoverBackgroundTemplate;
  buffer: Buffer;
};

let coverBackgroundTemplateCache: Promise<CoverBackgroundTemplate[]> | undefined;

export function normalizeCoverBrief(brief: CoverBrief): Required<CoverBrief> {
  const titleLines = normalizeTitleLines(brief.titleLines, brief.title);
  return {
    title: brief.title,
    titleLines,
    subtitle: sanitizeText(brief.subtitle).slice(0, 18),
    imagePrompt: sanitizeText(brief.imagePrompt).slice(0, 1_500),
  };
}

export async function generateWechatCoverBuffer(brief: CoverBrief): Promise<Buffer> {
  const normalized = normalizeCoverBrief(brief);
  const background = await tryLoadCoverBackgroundTemplate(normalized);
  if (background) {
    try {
      return await renderWechatCoverWithImageBackground(normalized, background.buffer);
    } catch (error) {
      console.warn(`Cover background template ${background.template.id} failed; falling back to deterministic cover: ${errorMessage(error)}`);
    }
  }
  return renderDeterministicWechatCover(normalized);
}

function renderDeterministicWechatCover(brief: Required<CoverBrief>): Promise<Buffer> {
  return sharp(Buffer.from(buildWechatCoverSvg(brief)))
    .png()
    .toBuffer();
}

async function renderWechatCoverWithImageBackground(
  brief: Required<CoverBrief>,
  imageBackground: Buffer,
): Promise<Buffer> {
  const background = await sharp(imageBackground)
    .resize(WECHAT_COVER_WIDTH, WECHAT_COVER_HEIGHT, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();

  return sharp(background)
    .composite([{ input: Buffer.from(buildWechatCoverOverlaySvg(brief)), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export function buildWechatCoverSvg(brief: Required<CoverBrief>): string {
  const titleLineSvgs = buildTitleLineSvgs(brief.titleLines);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${WECHAT_COVER_WIDTH}" height="${WECHAT_COVER_HEIGHT}" viewBox="0 0 ${WECHAT_COVER_WIDTH} ${WECHAT_COVER_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8f2e8"/>
      <stop offset="0.56" stop-color="#f3eadf"/>
      <stop offset="1" stop-color="#ead8cf"/>
    </linearGradient>
    <radialGradient id="warm" cx="77%" cy="22%" r="52%">
      <stop offset="0" stop-color="#d63b32" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#d63b32" stop-opacity="0"/>
    </radialGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.8" flood-color="#f8f2e8" flood-opacity="0.95"/>
    </filter>
  </defs>
  <rect width="900" height="383" fill="url(#bg)"/>
  <rect width="900" height="383" fill="url(#warm)"/>
  <rect x="30" y="30" width="840" height="323" rx="12" fill="none" stroke="#1d1d1d" stroke-opacity="0.32" stroke-width="2"/>
  <rect x="70" y="66" width="14" height="252" rx="7" fill="#d63b32"/>
  <g opacity="0.34" stroke="#151515" stroke-width="2" stroke-linecap="round">
    <line x1="612" y1="88" x2="762" y2="88"/>
    <line x1="630" y1="112" x2="810" y2="112"/>
    <line x1="652" y1="136" x2="772" y2="136"/>
    <line x1="126" y1="302" x2="238" y2="302"/>
    <line x1="142" y1="280" x2="206" y2="280"/>
  </g>
  <g fill="#151515" opacity="0.42">
    <rect x="724" y="276" width="12" height="28" rx="5"/>
    <rect x="748" y="252" width="12" height="52" rx="5"/>
    <rect x="772" y="268" width="12" height="36" rx="5"/>
    <rect x="796" y="234" width="12" height="70" rx="5"/>
  </g>
  <g filter="url(#softShadow)" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', sans-serif" font-weight="800" text-anchor="middle">
${titleLineSvgs}
  </g>
${buildSubtitleSvg(brief.subtitle)}
</svg>`.trim();
}

function buildWechatCoverOverlaySvg(brief: Required<CoverBrief>): string {
  const titleLineSvgs = buildTitleLineSvgs(brief.titleLines);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${WECHAT_COVER_WIDTH}" height="${WECHAT_COVER_HEIGHT}" viewBox="0 0 ${WECHAT_COVER_WIDTH} ${WECHAT_COVER_HEIGHT}">
  <defs>
    <radialGradient id="titleScrim" cx="50%" cy="52%" r="62%">
      <stop offset="0" stop-color="#f8f2e8" stop-opacity="0.84"/>
      <stop offset="0.72" stop-color="#f8f2e8" stop-opacity="0.58"/>
      <stop offset="1" stop-color="#f8f2e8" stop-opacity="0.32"/>
    </radialGradient>
    <linearGradient id="edgeWarmth" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8f2e8" stop-opacity="0.42"/>
      <stop offset="0.6" stop-color="#f8f2e8" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#d63b32" stop-opacity="0.12"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.8" flood-color="#f8f2e8" flood-opacity="0.95"/>
    </filter>
  </defs>
  <rect width="900" height="383" fill="url(#titleScrim)"/>
  <rect width="900" height="383" fill="url(#edgeWarmth)"/>
  <rect x="30" y="30" width="840" height="323" rx="12" fill="none" stroke="#1d1d1d" stroke-opacity="0.32" stroke-width="2"/>
  <rect x="70" y="66" width="14" height="252" rx="7" fill="#d63b32"/>
  <g filter="url(#softShadow)" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', sans-serif" font-weight="800" text-anchor="middle">
${titleLineSvgs}
  </g>
${buildSubtitleSvg(brief.subtitle)}
</svg>`.trim();
}

async function tryLoadCoverBackgroundTemplate(brief: Required<CoverBrief>): Promise<CoverBackgroundSelection | undefined> {
  try {
    const template = selectCoverBackgroundTemplate(brief, await loadCoverBackgroundTemplates());
    if (!template) return undefined;
    const buffer = await readFile(path.join(COVER_BACKGROUND_DIR, path.basename(template.file)));
    return { template, buffer };
  } catch (error) {
    console.warn(`Cover background template unavailable; falling back to deterministic cover: ${errorMessage(error)}`);
    return undefined;
  }
}

async function loadCoverBackgroundTemplates(): Promise<CoverBackgroundTemplate[]> {
  coverBackgroundTemplateCache ??= readCoverBackgroundTemplates();
  return coverBackgroundTemplateCache;
}

async function readCoverBackgroundTemplates(): Promise<CoverBackgroundTemplate[]> {
  const raw = JSON.parse(await readFile(COVER_BACKGROUND_MANIFEST_PATH, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("cover background manifest must be an array");
  }
  return raw.filter(isCoverBackgroundTemplate);
}

function isCoverBackgroundTemplate(value: unknown): value is CoverBackgroundTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as Record<string, unknown>;
  return typeof template.id === "string" && typeof template.file === "string";
}

export function selectCoverBackgroundTemplate(
  brief: Required<CoverBrief>,
  templates: CoverBackgroundTemplate[],
): CoverBackgroundTemplate | undefined {
  const enabledTemplates = templates.filter(template => template.enabled !== false);
  if (!enabledTemplates.length) return undefined;

  const corpus = `${brief.title} ${brief.titleLines.join(" ")} ${brief.subtitle} ${brief.imagePrompt}`.toLowerCase();
  let bestTemplate = enabledTemplates[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const template of enabledTemplates) {
    const tags = template.tags || [];
    let score = tags.includes("default") ? 1 : 0;
    for (const tag of tags) {
      if (tagMatchesCorpus(tag, corpus)) {
        score += 3;
      }
    }
    if (score > bestScore || (score === bestScore && template.id < bestTemplate.id)) {
      bestTemplate = template;
      bestScore = score;
    }
  }

  return bestTemplate;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function tagMatchesCorpus(tag: string, corpus: string): boolean {
  const aliases = COVER_BACKGROUND_TAG_ALIASES[tag] || [tag];
  return aliases.some(alias => corpus.includes(alias.toLowerCase()));
}

const COVER_BACKGROUND_TAG_ALIASES: Record<string, string[]> = {
  dashboard: ["dashboard", "仪表盘", "数据看板", "数据"],
  office: ["office", "desk", "workspace", "办公室", "办公", "书桌"],
  product: ["product", "产品", "原型", "体验"],
  tech: ["tech", "technology", "ai", "vibe coding", "技术", "系统"],
  voice: ["voice", "recording", "audio", "语音", "录音", "口述"],
  warm: ["warm", "daylight", "自然光", "温暖"],
};

function buildTitleLineSvgs(lines: string[]): string {
  const normalized = lines.slice(0, MAX_TITLE_LINES);
  const layouts = normalized.length === 1
    ? [{ y: 210, size: fontSizeForLine(normalized[0], 92), fill: "#151515" }]
    : normalized.length === 2
      ? [
          { y: 163, size: fontSizeForLine(normalized[0], 86), fill: "#151515" },
          { y: 252, size: fontSizeForLine(normalized[1], 66), fill: "#d63b32" },
        ]
      : [
          { y: 140, size: fontSizeForLine(normalized[0], 92), fill: "#151515" },
          { y: 226, size: fontSizeForLine(normalized[1], 58), fill: "#151515" },
          { y: 292, size: fontSizeForLine(normalized[2], 62), fill: "#d63b32" },
        ];

  return layouts
    .map((layout, index) => `    <text x="450" y="${layout.y}" font-size="${layout.size}" fill="${layout.fill}">${escapeXml(normalized[index])}</text>`)
    .join("\n");
}

function fontSizeForLine(line: string, maxSize: number): number {
  const weightedLength = [...line].reduce((sum, char) => {
    return sum + (/^[\x00-\x7F]$/.test(char) ? 0.58 : 1);
  }, 0);
  if (weightedLength <= 5) return maxSize;
  if (weightedLength <= 9) return Math.floor(maxSize * 0.88);
  return Math.floor(maxSize * 0.76);
}

function buildSubtitleSvg(subtitle: string): string {
  if (!subtitle) return "";
  return `  <text x="450" y="346" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', sans-serif" font-size="24" font-weight="500" text-anchor="middle" fill="#222222" fill-opacity="0.86">${escapeXml(subtitle)}</text>`;
}

function normalizeTitleLines(lines: string[] | undefined, fallbackTitle: string): string[] {
  const provided = lines
    ?.map(sanitizeText)
    .filter(Boolean)
    .slice(0, MAX_TITLE_LINES);
  if (provided?.length) {
    return provided.map(line => truncateLine(line));
  }
  return deriveCoverTitleLines(fallbackTitle);
}

export function deriveCoverTitleLines(title: string): string[] {
  const cleanTitle = sanitizeText(title)
    .replace(/[《》「」“”"']/g, "")
    .replace(/^为什么/, "")
    .replace(/^我/, "")
    .trim();

  const vibeCoding = /vibe\s*coding/i.test(cleanTitle);
  const dashboard = /仪表盘|dashboard/i.test(cleanTitle);
  const notRecommend = /不建议|不要|别/.test(cleanTitle);

  if (vibeCoding && dashboard) {
    return [
      notRecommend ? "不建议" : "慎用",
      "Vibe Coding",
      "搭数据仪表盘",
    ];
  }

  const parts = cleanTitle
    .split(/[：:，,。！？!?、\s]+/)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return parts.slice(0, MAX_TITLE_LINES).map(line => truncateLine(line));
  }

  return chunkTitle(cleanTitle || "VibePub 语音随笔");
}

function chunkTitle(title: string): string[] {
  const chars = [...title];
  if (chars.length <= MAX_LINE_LENGTH) return [title];
  const lines: string[] = [];
  for (let index = 0; index < chars.length && lines.length < MAX_TITLE_LINES; index += 7) {
    lines.push(chars.slice(index, index + 7).join(""));
  }
  return lines;
}

function truncateLine(line: string): string {
  const chars = [...line];
  if (chars.length <= MAX_LINE_LENGTH) return line;
  return `${chars.slice(0, MAX_LINE_LENGTH - 1).join("")}…`;
}

function sanitizeText(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim() || "";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
