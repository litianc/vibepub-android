export type StyleProfile = {
  id: string;
  name: string;
  version: string;
  description: string;
  body: string;
};

export type LayoutProfile = {
  id: string;
  name: string;
  version: string;
  description: string;
  body: string;
};

export const DEFAULT_STYLE_PROFILES: StyleProfile[] = [
  {
    id: "style_litianc_default",
    name: "litianc 默认写作风格",
    version: "2026-07-05",
    description: "真实、理性、结构化、有个人判断但不浮夸。",
    body: `
1. 整体气质：真实、理性、结构化、有个人判断，但不浮夸。
2. 使用第一人称视角，保留“我”的观察和判断，但不要过度抒情。
3. 从真实问题、具体观察或一次亲身排查开场，不写空泛鸡汤式引言。
4. 开头尽早给出核心判断：这篇文章到底想说明什么。
5. 优先使用“问题背景 -> 关键判断 -> 分层拆解 -> 证据/案例 -> 建议 -> 总结”的结构。
6. 标题要有明确对象和判断，避免夸张标题党。
7. 正文段落保持短而清楚，每段只承载一个意思。
8. 多使用小标题、编号列表、表格来降低阅读成本。
9. 技术内容要保留关键参数、版本、链路、失败条件和排查过程。
10. 产品/组织内容要把抽象判断落到具体机制、场景和下一步动作。
11. 结尾要回到可执行建议或清晰判断，不写泛泛的励志收束。
`.trim(),
  },
  {
    id: "style_product_review",
    name: "产品复盘风格",
    version: "2026-07-05",
    description: "强判断、短开场、保留具体排查过程，适合产品和组织机制复盘。",
    body: `
1. 开头直接交代问题现场和核心判断，不写宏大背景。
2. 用“现象 -> 原因 -> 机制 -> 代价 -> 下一步”的结构推进。
3. 保留具体角色、流程、失败条件、权衡和决策依据。
4. 多写“为什么会这样”和“下次怎么避免”，少写情绪评价。
5. 标题要像一个复盘结论，而不是营销口号。
6. 结尾必须给出一条可执行的机制调整或产品动作。
`.trim(),
  },
  {
    id: "style_technical_note",
    name: "技术排查笔记风格",
    version: "2026-07-05",
    description: "保留环境、命令、错误、假设和验证证据，适合技术文章。",
    body: `
1. 开头说明问题、影响范围、环境版本和最终结论。
2. 按时间线或假设树写清排查过程，保留关键命令、日志和错误码。
3. 区分事实、推断和未验证假设，不把猜测写成结论。
4. 对每个方案说明为什么采用或放弃。
5. 代码和配置片段要短，解释它解决了什么问题。
6. 结尾列出验证结果、剩余风险和后续动作。
`.trim(),
  },
  {
    id: "style_public_explainer",
    name: "通俗解释风格",
    version: "2026-07-05",
    description: "面向更广泛读者，少术语，多类比，适合观点解释和科普。",
    body: `
1. 用一个具体生活化场景开头，把抽象问题落到读者能理解的画面。
2. 每次只解释一个概念，必要术语要马上翻译成人话。
3. 多使用类比、对照和小例子，但不要编造不存在的数据。
4. 结构清晰，段落短，小标题要像路标。
5. 语气自然、克制，不用夸张形容词制造紧张感。
6. 结尾回到读者可以怎么判断或怎么行动。
`.trim(),
  },
];

export const DEFAULT_LAYOUT_PROFILES: LayoutProfile[] = [
  {
    id: "wechat_clean_article",
    name: "微信公众号克制长文排版",
    version: "2026-07-05",
    description: "使用微信兼容 HTML 片段、短段落、小标题和必要表格。",
    body: `
1. content_html 必须是适合微信公众号草稿的 HTML 片段，不要包含完整 html/body/head。
2. 只使用微信公众号兼容的基础标签：section、p、strong、em、blockquote、ul、ol、li、table、thead、tbody、tr、th、td、hr、code、pre。
3. 样式尽量使用 inline style；整体克制，适合长文阅读。
4. 正文段落建议使用 16px 字号、1.75-1.9 行高、适当段前段后留白。
5. 小标题要清晰承担逻辑推进，可以使用编号标题，但不要过度装饰。
6. 重点句可以单独成段并加粗，不要全篇大量加粗。
7. 如果原始材料里存在对比、测试、版本、方案优缺点，优先整理成表格。
8. 不要编造原始文字中没有出现的事实、数据、案例、引用或参考资料。
9. 如果信息不足，用稳妥的表达保留不确定性，不要强行写成定论。
10. cover_title 是公众号封面主标题短句，必须从 title 压缩而来，2-3 行，每行尽量不超过 8 个中文字或 1 个英文短语。
11. cover_subtitle 是可选封面副标题，12 字以内，用来表达核心反差或风险判断。
12. image_prompt 仅作为未来生成无字底图的备用字段，必须要求无文字、无 logo、无水印、无暗黑氛围、无纯抽象渐变。
`.trim(),
  },
];

export function findStyleProfile(id: string | undefined): StyleProfile | undefined {
  const profileId = id?.trim() || DEFAULT_STYLE_PROFILES[0].id;
  return DEFAULT_STYLE_PROFILES.find(profile => profile.id === profileId);
}

export function findLayoutProfile(id: string | undefined): LayoutProfile | undefined {
  const profileId = id?.trim() || DEFAULT_LAYOUT_PROFILES[0].id;
  return DEFAULT_LAYOUT_PROFILES.find(profile => profile.id === profileId);
}

export function publicStyleProfile(profile: StyleProfile): Omit<StyleProfile, "body"> {
  const { body: _body, ...publicProfile } = profile;
  return publicProfile;
}

export function publicLayoutProfile(profile: LayoutProfile): Omit<LayoutProfile, "body"> {
  const { body: _body, ...publicProfile } = profile;
  return publicProfile;
}
