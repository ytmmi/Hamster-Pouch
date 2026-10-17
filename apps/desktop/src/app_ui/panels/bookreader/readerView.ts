/**
 * 图书阅读器（`panel.bookreader`）的**纯逻辑**：取值域、夹紧、进度与翻页算术。
 *
 * ## 为什么单独立一个文件
 *
 * 取值域（字号范围、背景预设、对齐方式…）有两处权威会漂移：
 * 1. **面板设置声明**（`packages/config/src/panels.ts` 的 `settings[]`）——「全部设置」
 *    界面按它渲染，也是落库取值的白名单；
 * 2. **面板自己的「阅读选项」栏**——同一批键的可视化控件。
 *
 * 提取到本文件后，两处都从这里取值；`pnpm check:panels` 断言声明里的 `select` 候选
 * 与这里的枚举**逐项一致**（与 `mediaPreviewView` / `bookPreviewView` 同款做法）。
 *
 * **本文件不导入 React / Tauri**：它只做算术与取值域，能在 Node 里直接单测
 * （`tools/check-panels.mjs` 就是这么验的）。
 */

// ============================== 阅读选项的取值域 ==============================

/** 翻页方式：连续滚动 / 单页 / 双页（「阅读选项」顶部三个视图图标）。 */
export const READER_VIEW_MODES = ["scroll", "page", "spread"] as const;
export type ReaderViewMode = (typeof READER_VIEW_MODES)[number];

/**
 * 背景预设（面板按预设套 CSS 类，不落任意色值）。
 *
 * 为什么是**封闭预设**而不是取色器：面板设置的值是标量（面板标准第 5.3 节），
 * 任意色值要额外一套校验与回退；而阅读背景真正需要的是"几档对比度"，
 * 深色档与浅色档各三档已经覆盖（含夜间阅读）。
 */
export const READER_BG_PRESETS = ["paper", "sepia", "green", "gray", "dark", "black"] as const;
export type ReaderBgPreset = (typeof READER_BG_PRESETS)[number];

/** 文字颜色预设；`auto` = 跟随背景（默认，保证对比度）。 */
export const READER_TEXT_PRESETS = ["auto", "ink", "gray", "sepia", "white"] as const;
export type ReaderTextPreset = (typeof READER_TEXT_PRESETS)[number];

/** 字体（**只用系统字体栈**，不捆绑字体文件：D20 不把字体目录变成运行期前提）。 */
export const READER_FONT_FAMILIES = ["system", "serif", "sans", "kai", "mono"] as const;
export type ReaderFontFamily = (typeof READER_FONT_FAMILIES)[number];

/** 文字对齐（`default` = 跟随格式：正文两端对齐、诗歌/标题左对齐交给 CSS 自己算）。 */
export const READER_TEXT_ALIGNS = ["default", "justify", "start", "center"] as const;
export type ReaderTextAlign = (typeof READER_TEXT_ALIGNS)[number];

/** 数值项的范围与缺省（面板夹紧 + 声明缺省**同源**）。 */
export const READER_FONT_SIZE = { min: 12, max: 48, default: 20 } as const;
/** 行间距按**百分比**存（170 = 1.7 倍）；行高是字号的比例，百分比是唯一的无量纲写法。 */
export const READER_LINE_HEIGHT = { min: 100, max: 240, default: 170 } as const;
export const READER_PAGE_MARGIN = { min: 0, max: 80, default: 24 } as const;
/** 正文栏最大宽度**占面板宽度的百分比**（100 = 铺满；<100 时两侧留白更多）。 */
export const READER_PAGE_WIDTH = { min: 30, max: 100, default: 100 } as const;
export const READER_LETTER_SPACING = { min: 0, max: 20, default: 0 } as const;
/**
 * 段落间距（px）。
 *
 * **缺省 0**（2026-10-18 改为 0，原为 12）：中文 / 英文书刊都用**首行缩进**分段，
 * 再叠一段间距就是双重分隔。参考实现：Readium CSS 的 `--RS__paraSpacing: 0`。
 * 容器块（引用 / 列表 / 代码 / 表格）的间距也读它，因此 0 时它们靠自身的内边距分隔。
 */
export const READER_PARAGRAPH_SPACING = { min: 0, max: 100, default: 0 } as const;
/** 屏幕亮度（百分比）→ CSS `filter: brightness()`；下限 30% 防止调到看不见。 */
export const READER_BRIGHTNESS = { min: 30, max: 100, default: 100 } as const;

/**
 * 纸张外的**桌面**留白（px，单侧）——分页模式下纸张与阅读区边缘的距离。
 *
 * 用户 2026-10-18 口径："**书页大一点，底下的'桌面'露出的占比少一点**"。
 * 此前这份留白实际等于「页边距」设置（默认 24px，环绕纸张一圈 48px），
 * 于是纸张比可用区小一圈、四周都是桌面。现在桌面是**固定的小留白**，
 * 「页边距」改为纸张**内部**的正文外边距（见 [`readerPagedLayout`]），两件事不再共用一个数。
 */
export const READER_DESK_PADDING = 8;

/**
 * 全屏时**纵向**的桌面留白（px）——用户 2026-10-18 裁决 **B**：
 * "让纸张铺满上下（全屏时不露桌面）"。
 *
 * 只改纵向：横向仍保留一个薄桌面（[`READER_DESK_PADDING`]），
 * 于是全屏时书页上下是纸色、左右是桌面色，与窗口模式同源。
 */
export const READER_DESK_PADDING_FULLSCREEN_Y = 0;

/**
 * 一栏正文的**最小可读宽**（px）：夹紧「页边距」时用。
 *
 * 页边距现在直接决定纸张内的正文外边距，若它大到把一栏挤得比这还窄，
 * 正文会变成一行一个字。夹紧保证任何设置下都还读得下去。
 */
export const READER_MIN_COLUMN_WIDTH = 48;

/** 书脊缝的绘制宽度（px，单侧）：双页相贴处那道内侧阴影的尺寸。 */
export const READER_SPINE_SHADOW_PX = 12;

/** 估算阅读速度（字/分钟）：中文默读的常用量级，用于"读完本章约需 N 分钟"。 */
export const READER_CHARS_PER_MINUTE = 400;

// ============================== 正文字体排印（EPUB 排版口径）==============================

/**
 * **段落首行缩进**（em）：按语言分档，取自 Readium CSS 的默认样式表。
 *
 * > `--RS__paraIndent: 1em;`（拉丁）
 * > `:root:lang(zh) { --RS__paraIndent: 2em; }`（中日韩方块字）
 *
 * 为什么中文是 **2em**：方块字一个字符就是一个字宽，"空两格"是中文书刊的行文约定；
 * 拉丁文按词排版，`1em` 已经足够把首行与后续行区分开。
 * 参考实现：Readium CSS（<https://github.com/readium/css>）的
 * `ReadiumCSS-default-cjk-horizontal.css`。**不随仓库携带副本**（第三方样式表，
 * 体积与许可都不适合入库），这里直接写出用到的原值，出处给上游地址可查。
 */
export const READER_PARA_INDENT_EM = { cjk: 2, latin: 1 } as const;

/**
 * 正文语言档：`cjk`（方块字）与 `latin`。
 *
 * 阅读器不解析书里的 `xml:lang`（我们的块模型是纯文本，没有语言字段），
 * 因此**按正文自身的字符构成判定**（见 [`readerBodyProfile`]）：正文里方块字
 * 占可视字符的多数就是 `cjk`，否则 `latin`。这个判据比"读标签属性"更稳——
 * 实测语料里有书的 `xml:lang` 是 `zh-CN`、正文却大段日文汉字，
 * 而两种语言的首行缩进口径**一致**（都是 2em），所以按内容判定即可。
 */
export type ReaderBodyProfile = "cjk" | "latin";

/**
 * 判断一组正文文字属于哪种语言档。
 *
 * 判据是**方块字（CJK 统一表意文字 + 假名 + 谚文）占比**：
 * - 总可视字符不足 [`READER_PROFILE_MIN_CHARS`]（章节开头的一行短标题）时**沿用**
 *   `fallback`——单看一行「序章」判不出整本书的语言，而章节之间必须用**同一档**，
 *   否则同一本书的缩进会在章与章之间跳变；
 * - 方块字占比 ≥ [`READER_PROFILE_CJK_RATIO`] 判 `cjk`。
 *
 * 纯函数（零依赖）：门禁按行为直接驱动它。
 */
export const READER_PROFILE_MIN_CHARS = 24;
export const READER_PROFILE_CJK_RATIO = 0.3;

export function readerBodyProfile(
  text: string,
  fallback: ReaderBodyProfile = "latin",
): ReaderBodyProfile {
  let visible = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 空白与不可见控制字符不参与判定（它们与语言无关）。
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
    visible += 1;
    if (isCjkCodePoint(code)) cjk += 1;
  }
  if (visible < READER_PROFILE_MIN_CHARS) return fallback;
  return cjk / visible >= READER_PROFILE_CJK_RATIO ? "cjk" : "latin";
}

/**
 * 是否方块字码位。覆盖 Readium CSS 的 i18n 名单里的东亚三语：
 * 汉字（含扩展 A）、假名、谚文、全角标点与 CJK 符号。
 * 范围取 Unicode 官方区块（标准依据，不是"看着像"）。
 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 汉字扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 汉字基本区
    (code >= 0xf900 && code <= 0xfaff) || // 汉字兼容区
    (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
    (code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点
    (code >= 0xff00 && code <= 0xffef) // 全角形式
  );
}

/** 把任意输入夹进 `[min, max]`（非有限数回落缺省）。 */
export function clampReaderNumber(
  value: number,
  range: { min: number; max: number; default: number },
): number {
  if (!Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** 取值域成员判定（声明层解析出来的值必须落在域内，否则回落缺省）。 */
export function isReaderViewMode(value: unknown): value is ReaderViewMode {
  return typeof value === "string" && (READER_VIEW_MODES as readonly string[]).includes(value);
}

export function isReaderBgPreset(value: unknown): value is ReaderBgPreset {
  return typeof value === "string" && (READER_BG_PRESETS as readonly string[]).includes(value);
}

export function isReaderTextPreset(value: unknown): value is ReaderTextPreset {
  return typeof value === "string" && (READER_TEXT_PRESETS as readonly string[]).includes(value);
}

export function isReaderFontFamily(value: unknown): value is ReaderFontFamily {
  return typeof value === "string" && (READER_FONT_FAMILIES as readonly string[]).includes(value);
}

export function isReaderTextAlign(value: unknown): value is ReaderTextAlign {
  return typeof value === "string" && (READER_TEXT_ALIGNS as readonly string[]).includes(value);
}

// ============================== 左侧栏的标签页 ==============================

/**
 * 左侧内置面板的标签页（「更多」图标展开的那一栏）。
 *
 * 顺序即界面顺序（与用户给的参考图一致：目录 / 书签 / 笔记 / 高亮）。
 */
export const READER_TABS = ["toc", "bookmarks", "notes", "highlights"] as const;
export type ReaderTab = (typeof READER_TABS)[number];

export function isReaderTab(value: unknown): value is ReaderTab {
  return typeof value === "string" && (READER_TABS as readonly string[]).includes(value);
}

// ============================== 满屏与进度 ==============================

/** 是不是"书"（与 `ViewerPanel` 同口径：文本类 + PDF）。 */
export function isBookMediaType(mediaType: string | undefined | null): boolean {
  return mediaType === "text" || mediaType === "pdf";
}

/**
 * 目录项缩进（层级 → 左侧内边距 px）。
 *
 * 层级从 1 起算（后端口径），缩进按 `(level - 1) × 单级` 累计并**封顶**
 * （畸形目录里 level=99 不该把标题推出可视区）。
 */
export function tocIndent(level: number): number {
  const depth = Math.max(0, Math.min(4, (Number.isFinite(level) ? level : 1) - 1));
  return depth * 14;
}

/**
 * 目录项的展示标题：标题为空串时按 i18n 显示序号（后端**不内联**用户可见文案）。
 *
 * 返回 `null` = 调用方自己渲染（用 `t(...)` 拼序号）。
 */
export function tocTitleOrNull(title: string | null | undefined): string | null {
  const trimmed = (title ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 当前阅读位置落在目录的哪一项上（**章节数的唯一判据**）。
 *
 * 判据用**游标数值比较**而不是字符串相等：`cursor` 是"序号 / 字符偏移"，
 * 当前页的游标往往落在两条目录项之间（例如第 2 章的第 3 页），
 * 因此取"最后一条 cursor ≤ 当前游标的项"。
 *
 * **必须传入整数页起点**（调用方负责取整）：章是离散的，页内读了多少不该改变
 * 章号。传入带小数的"页内插值位置"时，只要小数越过下一条目录项，章号就会提前
 * 跳一位——这正是"章节数和目录对不上"的来源。
 *
 * `toc` 必须已按书内顺序排列（后端保证）。返回 `-1` = 还没进入任何一章
 * （例如目录第一条之前的前言）。
 */
export function currentTocIndex(entries: { cursor: string }[], cursor: string | null): number {
  if (!cursor) return -1;
  const target = Number(cursor);
  if (!Number.isFinite(target)) return -1;
  let found = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const at = Number(entries[i].cursor);
    if (!Number.isFinite(at)) continue;
    if (at <= target) found = i;
    else break;
  }
  return found;
}

/**
 * 相对位置的变化是否**值得**通知父级（避免每一帧滚动都让整个面板重渲染）。
 *
 * 阈值取 `1e-4`：当前进度显示两位小数（0.01% = 1e-4），比这更小的变化在界面上
 * 看不出来，重渲染却是实打实的开销。
 */
export function fractionWorthReporting(prev: number, next: number): boolean {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return true;
  return Math.abs(next - prev) >= 1e-4;
}

/**
 * **每一页的游标区间** `[start, end)`（与 `book.content` 的游标同语义）。
 *
 * ## 为什么这张表是"章节数和目录对得上"的关键
 *
 * `BookContentResult` 自带 `next_cursor`，于是**每页的起点是精确已知的**，
 * 不需要任何估算：
 *
 * ```
 * page[0].start = segmentStart
 * page[i].start = page[i-1].next_cursor      （i > 0）
 * page[i].end   = page[i].next_cursor ?? (start + 本页单位数)
 * ```
 *
 * 有了这张表，"我在哪儿"就变成"我在**哪一页**、离这一页开头多远"，
 * 只在**单页内部**做比例插值——不再需要"跨页的像素比例 × 已载入章数"那种
 * 两种度量混乘（章节长短不等时它必然错位，这是章节数乱跳的根因）。
 *
 * epub / pdf 的每页就是一个 `section`，`[section, section+1)` 与目录项游标
 * **同一坐标**，所以章节号能逐项对上。
 */
export function readerPageCursors(
  pages: {
    format: string;
    text: string | null;
    blocks: unknown[] | null;
    section: number;
    next_cursor: string | null;
  }[],
  segmentStart: string,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cursor = Number(segmentStart);
  if (!Number.isFinite(cursor)) cursor = 0;
  for (const page of pages) {
    // epub / pdf：`section` 是绝对序号，直接就是这一页的起点（与目录游标同坐标）。
    if (page.format === "epub" || page.format === "pdf") {
      const section = Number.isFinite(page.section) ? page.section : 0;
      out.push({ start: section, end: section + 1 });
      // 后续纯文本页的基准跟着走（同一本里格式不会混，这里只是保持自洽）。
      cursor = section + 1;
      continue;
    }
    const start = cursor;
    const next = page.next_cursor === null ? null : Number(page.next_cursor);
    let end: number;
    if (next !== null && Number.isFinite(next) && next > start) {
      end = next;
    } else {
      // 最后一页（没有 `next_cursor`）：用本页自身的单位数收口。
      end =
        start +
        (page.format === "markdown"
          ? (page.blocks ?? []).length
          : (page.text ?? "").length);
    }
    out.push({ start, end });
    cursor = end;
  }
  return out;
}

/**
 * 由"第几页 + 页内比例"得到**绝对位置**（游标单位）。
 *
 * 只在**单页内部**插值：`start + offset × (end - start)`。跨页位置由页序号精确给出，
 * 因此章节号与目录逐项对上；页内比例只影响"本章进度"的小数部分。
 *
 * @param visibleIndex 可见页在 `pages` 数组里的下标（`-1` = 没能判定 → 退回第一页）
 * @param offsetInPage 页内比例（0–1）
 * @param cursors [`readerPageCursors`] 的结果
 */
export function readerPositionFromPage(
  visibleIndex: number,
  offsetInPage: number,
  cursors: { start: number; end: number }[],
): number | null {
  if (cursors.length === 0) return null;
  if (!Number.isFinite(visibleIndex)) return null;
  const index =
    visibleIndex < 0 || visibleIndex >= cursors.length ? 0 : Math.floor(visibleIndex);
  const { start, end } = cursors[index];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const span = Math.max(0, end - start);
  return start + clamp01(offsetInPage) * span;
}

/** 夹到 [0, 1]（位置与比例共用；非有限值按 0 处理）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 本书当前章的进度（0–1）与章序号（-1 = 还没进入任何一章）。
 *
 * 章的范围由**目录**给出（`toc[i].cursor` → `toc[i+1].cursor`，最后一章到全书末尾）：
 * 目录游标与正文游标同语义，所以这里**不做换算**，只做区间比例。
 *
 * 三处刻意的处理：
 * 1. **位置用连续值**（含章内的滚动 / 翻页），不是"当前取数游标"——否则章内进度
 *    同样会卡住不动，等于没加这一项；
 * 2. **目录第一条之前**（前言 / 版权页）按 `[0, 第一条)` 算作一个区间，而不是返回
 *    `null`：此时"本章进度"仍是有意义的"读到这里了多少"；
 * 3. **末章没有下一条**时用 `total` 收口；`total` 拿不到（打不开的书）返回 `null`
 *    ——编一个 100% 会让"读完了"和"算不出"看起来一样。
 *
 * 目录为空（PDF / 没有可识别章节的 txt）返回 `null`：没有章，就没有"本章进度"。
 */
export function readerChapterProgress(
  toc: { cursor: string }[],
  position: number | null,
  total: number | null,
): { index: number; progress: number } | null {
  if (position === null || toc.length === 0) return null;
  const index = currentTocIndex(toc, String(position));
  const start = index >= 0 ? Number(toc[index].cursor) : 0;
  if (!Number.isFinite(start)) return null;
  // 下一条**严格大于**起点的游标才是本章的终点。
  //
  // 为什么不能只取 `toc[index + 1]`：EPUB 的 nav / NCX 允许**多条目录项指向同一章**
  // （同一段文字挂两个锚点），此时相邻两条的游标相等，`end <= start` 会让"本章进度"
  // 整项消失。往回找第一条严格更大的，才是这一章真正结束的位置。
  let end: number | null = null;
  for (let i = index + 1; i < toc.length; i += 1) {
    const at = Number(toc[i].cursor);
    if (Number.isFinite(at) && at > start) {
      end = at;
      break;
    }
  }
  if (end === null) end = total;
  if (end === null || !Number.isFinite(end) || end <= start) return null;
  return { index, progress: clamp01((position - start) / (end - start)) };
}

/**
 * 进度百分比文案。
 *
 * `digits` 是**小数位数**：当前进度 2 位（`00.00%`）、本章进度 1 位（`00.0%`）
 * ——用户 2026-10-17 明确了两处不同的精度，所以精度是**参数**而不是写死。
 */
export function formatProgressPercent(progress: number | null, digits: 1 | 2 = 2): string | null {
  if (progress === null) return null;
  return `${(progress * 100).toFixed(digits)}%`;
}

/**
 * 估算"读完本章约需几分钟"（向上取整，最少 1 分钟）。
 *
 * 估算的是**已取回的正文**（阅读器一次只取若干页），不是整章——因此文案用"约"。
 * 字数为 0（纯图片章）时返回 `null`，界面不显示这一项。
 */
export function estimateReadMinutes(chars: number): number | null {
  if (!Number.isFinite(chars) || chars <= 0) return null;
  return Math.max(1, Math.ceil(chars / READER_CHARS_PER_MINUTE));
}

// ============================== 分页模式的纸张几何 ==============================

/**
 * 分页模式（单页 / 双页）的**纸张几何**——"纸张多宽、每张纸多宽、每栏多宽"的唯一一份算术。
 *
 * ## 界面形状（用户 2026-10-17 口径 + 2026-10-18 三项修订）
 *
 * > "单页应为一个居中容器，双页应为一对居中的容器，并且都是跟随自适应大小的。"
 * > 2026-10-18："**书页大一点，底下的『桌面』露出的占比少一点**"
 * > + "**正文外边距大一点，当前正文和书页边缘太近了**"。
 *
 * 分页模式的可视结构是**一张纸**，居中摆放在阅读区里：
 * - **单页**：一张纸（`N = 1` 栏）；
 * - **双页**：两张纸**相贴**（书脊处无缝），合成一张更宽的纸（`N = 2` 栏）。
 *
 * ## 三个量各自唯一（本轮最重要的一步简化）
 *
 * | 量 | 含义 | 由谁定 |
 * | --- | --- | --- |
 * | `paperWidth` | 整张纸（= 一屏）的宽 | 可用宽 × 「页面宽度」 |
 * | `faceWidth` | **一张纸**的绘制宽 | `paperWidth / N`（**逐像素等分**） |
 * | `margin` | 正文到纸边的距离 | 「页边距」设置 |
 *
 * **纸页不再需要"外扩一个 inset"**：`N` 张纸按 `paperWidth / N` **等分铺满**纸张，
 * 相邻两张天然无缝（相贴）——"一对相贴的居中容器"因此是**切分**出来的，
 * 而不是靠"各外扩半个栏间距"凑出来的。上一版用 `inset` 凑相贴，多了一个
 * 必须与栏间距联动的常数（改一个忘一个就裂缝），这一版把它整个去掉。
 *
 * ## 书脊缝为什么等于 `2 × 页边距`
 *
 * 正文在纸里按 `N` 栏排布，栏间距 `g` 落在两张纸的**接缝**上。要让每一栏都
 * **在它自己的那张纸里居中**，可以精确解出 `g = 2·margin`：
 *
 * ```
 * 纸内正文宽 W_c = paperWidth - 2·margin
 * 栏宽      c   = (W_c - (N-1)·g) / N
 * 第 i 栏起点 = margin + i·(c + g)，其中心 = margin + i·(c+g) + c/2
 * 第 i 张纸中心 = (i + 0.5)·paperWidth/N
 * 令两者相等 ⇒ 2·margin·(N-1) = (N-1)·g ⇒ g = 2·margin
 * ```
 *
 * 这个 `g = 2·margin` **正是实体书的接缝**：左页的右边距 + 右页的左边距
 * （两侧各留一个页边距）相叠就是书脊处的空隙。它不是"为了好算"凑的常数，
 * 而是"每栏在自己的纸上居中"这一条几何要求的解。
 *
 * **副产品**：一屏（`N` 栏 + `N-1` 个间距）恰好等于 `W_c`，于是
 * `screenPitch = W_c + g = paperWidth`——**翻一页正好推进一张纸的宽**，干净。
 *
 * ## "跟随自适应大小"是重排不是缩放
 *
 * `availableWidth` / `availableHeight` 是阅读区**去掉桌面留白**后的可用空间；
 * 纸张宽 = 可用宽 ×「页面宽度」、高 = 可用高（全屏时纵向桌面为 0 ⇒ 纸铺满上下）。
 * 面板一大，纸就一大、栏宽变大、**正文按新栏宽重排**（`ResizeObserver` 驱动）。
 */
export interface ReaderPagedLayout {
  /** 整张纸（也就是分页模式的裁剪视口）= **一屏**宽。 */
  paperWidth: number;
  /** **一张纸**的绘制宽 = `paperWidth / columns`（`N` 张逐像素铺满，无缝相贴）。 */
  faceWidth: number;
  /** 纸内正文宽（`paperWidth - 2·margin`）。 */
  contentWidth: number;
  /** 单栏宽（= 浏览器等分出来的实际栏宽，可为小数）。 */
  columnWidth: number;
  /** 栏间距 = **书脊缝** = `2·margin`（见上文推导）。 */
  gap: number;
  /** 正文到纸边的距离（「页边距」）。 */
  margin: number;
  /** 纸高（= 可用高，"跟随自适应"；全屏时铺满上下）。 */
  height: number;
  /** 每屏显示的栏数（单页 1 / 双页 2）。 */
  columns: 1 | 2;
}

export function readerPagedLayout(input: {
  availableWidth: number;
  availableHeight: number;
  /** 「页面宽度」设置（占可用宽度的百分比，30–100）。 */
  pageWidthPercent: number;
  /** 「页边距」设置（px，0–80）：正文到纸边的距离。 */
  pageMargin: number;
  columns: 1 | 2;
}): ReaderPagedLayout {  const columns = input.columns;
  const availableWidth = Number.isFinite(input.availableWidth)
    ? Math.max(0, input.availableWidth)
    : 0;
  const availableHeight = Number.isFinite(input.availableHeight)
    ? Math.max(0, input.availableHeight)
    : 0;
  // 百分比夹进 30–100（声明层没有 min/max，夹紧只在面板侧做，与 `clampReaderNumber` 同口径）。
  const percent = Number.isFinite(input.pageWidthPercent)
    ? Math.min(100, Math.max(READER_PAGE_WIDTH.min, input.pageWidthPercent))
    : READER_PAGE_WIDTH.default;
  // 纸张宽：可用宽 × 百分比，并**不得**超过可用宽（否则会顶出阅读区）。
  const paperWidth = Math.max(
    1,
    Math.floor(Math.min(availableWidth, (availableWidth * percent) / 100)),
  );
  /**
   * 页边距**按可用空间夹紧**：设置上限是 80px，但窄面板里 80px 的双页边距
   * 会把一栏挤到负宽。夹紧保证任何组合下每栏都至少 [`READER_MIN_COLUMN_WIDTH`]，
   * 代入 `gap = 2·margin` 后整套几何**塌缩成一个极简形式**：
   *
   * ```
   * usable      = contentWidth - gap·(N-1) = paperWidth - 2·margin·N
   * columnWidth = usable / N               = paperWidth/N - 2·margin
   *             = faceWidth - 2·margin      （因为 faceWidth = paperWidth/N）
   * ```
   *
   * 也就是说：**栏宽 = 一张纸的宽 - 两侧页边距**。这条等式让"夹紧"也变得直接：
   * 要保持栏宽 ≥ `READER_MIN_COLUMN_WIDTH`，只需 `margin ≤ (faceWidth - MIN) / 2`。
   */
  const requested = Number.isFinite(input.pageMargin)
    ? Math.min(READER_PAGE_MARGIN.max, Math.max(READER_PAGE_MARGIN.min, input.pageMargin))
    : READER_PAGE_MARGIN.default;
  /*
   * 页边距**按可读性夹紧**（上限 80px 在窄面板 + 双页下会吃掉大半张纸）。
   *
   * 为什么上限是 `(faceWidth - MIN)/2` 而不是 `(paperWidth - N·MIN)/2`：
   * 由上一条等式 `columnWidth = faceWidth - 2·margin`，约束是
   * `faceWidth - 2·margin ≥ MIN`，解出 `margin ≤ (faceWidth - MIN)/2`。
   * （写成 `(paperWidth - N·MIN)/2` 会**放大 N 倍**——双页时夹得太松，
   * 实测 320px 面板 / 页边距 80 会算出栏宽 1px，正文变成一行一个字。）
   */
  const faceWidth = paperWidth / columns;
  const marginLimit = Math.max(0, (faceWidth - READER_MIN_COLUMN_WIDTH) / 2);
  const margin = Math.max(0, Math.min(requested, marginLimit));
  // 纸内正文宽 = 纸宽 - 两侧页边距。
  const contentWidth = Math.max(1, paperWidth - margin * 2);
  // 栏间距 = 2·margin（书脊缝；见文件头的推导）。单页用不到它（只有一栏）。
  const gap = margin * 2;
  /*
   * 栏宽取**精确值**（不取整）：浏览器用 `column-count` 分栏时是把宽度**等分**的，
   * 小数位不丢。这里若取整，纸页的绘制宽就会与真实栏宽差一个像素，
   * 双页相贴处会露出 1–2px 的底（同一类"算出来的几何 ≠ 真实绘制几何"，
   * 与缺陷 0027 同源）。`readerPageWidth` 的取整只服务栏数估算（要 round，差 1px 无影响）。
   */
  const usable = contentWidth - gap * (columns - 1);
  const columnWidth = usable > 0 ? usable / columns : 1;
  return {
    paperWidth,
    // 等分铺满：双页的 `faceWidth * 2` 恰等于 `paperWidth`（逐像素无缝）。
    faceWidth,
    contentWidth,
    columnWidth,
    gap,
    margin,
    // 高度跟随可用高；未测量时给 1，避免 0 高让分栏退化。
    height: Math.max(1, Math.floor(availableHeight)),
    columns,
  };
}

/**
 * 分页模式下的**翻页算术**（内容排成多少栏 / 一共几页 / 每次平移多少）。
 *
 * ## 步进 = **整张纸的宽**（`screenPitch = contentWidth + gap`，恒等于 `paperWidth`）
 *
 * 旧实现把 `pitch` 定义成**一栏**的列距（`columnWidth + gap`），而 JSX 里又拿它当
 * **一屏**用（`translateX(-page · pitch)`）——单页模式两者恰好相等（`N = 1`）**掩盖了它**，
 * 双页模式下页面只推进半屏，正文在两屏之间**重叠一栏**。
 *
 * 现在的口径由 [`readerPagedLayout`] 的几何直接给出：屏内 `N` 栏 + `N-1` 个间距
 * 恰好铺满纸内正文宽 `W_c`，因此下一屏第一栏的起点就在 `W_c + g = paperWidth`——
 * 与浏览器等分产生的小数栏宽**无关**，不需要任何"逐像素凑"。
 * 传 `contentWidth`（= `paperWidth - 2·margin`）与 `gap`（= `2·margin`）即可。
 */
export interface ReaderPagination {
  /** 单栏宽度（= 浏览器等分出来的实际栏宽）。 */
  columnWidth: number;
  /** 内容一共排成多少栏。 */
  columnCount: number;
  /** 一共多少页（一页 = `columns` 栏）。 */
  pageCount: number;
  /** 每次翻页 `translateX` 平移的像素（= **整张纸** = `contentWidth + gap`）。 */
  screenPitch: number;
}

export function readerPagination(
  scrollWidth: number,
  /** 纸内正文宽（`paperWidth - 2·margin`）。 */
  contentWidth: number,
  columns: 1 | 2,
  /** 栏间距（= 书脊缝 = `2·margin`）。 */
  gap: number,
): ReaderPagination {
  const columnWidth = readerPageWidth(contentWidth, columns, gap);
  const perColumn = columnWidth + gap;
  const screenPitch = contentWidth + gap;
  // 空内容 / 尚未测量：给"1 栏 1 页"，避免 0 页让翻页按钮直接失效。
  if (!Number.isFinite(scrollWidth) || scrollWidth <= 0 || columnWidth <= 0 || perColumn <= 0) {
    return {
      columnWidth,
      columnCount: 1,
      pageCount: 1,
      screenPitch: screenPitch > 0 ? screenPitch : 1,
    };
  }
  const columnCount = Math.max(1, Math.round((scrollWidth + gap) / perColumn));
  return {
    columnWidth,
    columnCount,
    pageCount: Math.max(1, Math.ceil(columnCount / columns)),
    screenPitch,
  };
}

/** 翻页夹紧：不越界、不回到负数（滚轮连滚也不会翻出内容之外）。 */
export function clampReaderPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, pageCount - 1), Math.max(0, Math.round(page)));
}

/** 分页模式下每屏显示几栏（`page` = 1 栏、`spread` = 2 栏、`scroll` = 不适用）。 */
export function readerColumnsPerScreen(viewMode: ReaderViewMode): 1 | 2 {
  return viewMode === "spread" ? 2 : 1;
}

/**
 * 单栏宽度：纸内正文宽按屏内栏数等分（并扣掉栏间距）。
 *
 * 分页模式下这一栏就是"一页正文"；滚动模式下不调用它（正文按面板宽度自适应）。
 * 取**整**只服务栏数估算（`readerPagination` 要 round，差 1px 无影响）；
 * 真实绘制用的精确栏宽由 [`readerPagedLayout`] 给出。
 */
export function readerPageWidth(
  contentWidth: number,
  columns: 1 | 2,
  gap: number,
): number {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return 0;
  const usable = contentWidth - gap * (columns - 1);
  return Math.max(1, Math.floor(usable / columns));
}

/**
 * 阅读区是否该继续取下一页。
 *
 * 滚动模式：滚到接近底部（提前 400px）。
 * 分页模式：**已经在最后一页**时也要继续取（否则读到最后一页就再也翻不动了）——
 * 这是分页与滚动最大的差别：分页模式没有"滚动到底部"这个信号。
 */
export function shouldLoadMorePages(
  viewMode: ReaderViewMode,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  hasMore: boolean,
  atLastPage: boolean,
  threshold = 400,
): boolean {
  if (!hasMore) return false;
  if (viewMode !== "scroll") return atLastPage;
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

// ============================== 点击正文收起两栏 ==============================

/**
 * **点击正文是否应当收起左右两栏**（用户 2026-10-17 口径："点击更多后，点击正文区域
 * 可以隐藏两栏（等同于再次点击更多）"）。
 *
 * ## "两栏没开"为什么不在这里判
 *
 * 那是**结构性**条件，不是这次点击的属性：面板只在两栏展开时才把 `onBodyClick`
 * 交给阅读区（`onBodyClick={railsOpen ? collapseRails : undefined}`）。写进本函数
 * 反而会得到一个"生产调用点恒传真值"的参数——那正是项目记过的"断言被 import 行
 * 满足"的同类假象（D113 ⑫）。因此这里只判**这次点击本身**的两条否决条件：
 *
 * | 情况 | 为什么不能收起 |
 * | --- | --- |
 * | 点在**可交互元素**里 | 正文里的链接（`<a class="vr-link">`）与分页按钮（`‹ ›`）有各自的语义——点链接是要跳走，不是要关目录 |
 * | 有**非空选区** | 用户正在划词（准备加高亮）。划完松手那一下同样会触发 `click`，此时选区非空——把它当成"点正文"就会把刚打开的目录关掉 |
 *
 * 纯函数（零依赖）才能被 `pnpm check:panels` 按行为逐条钉住；组件里只做
 * "从事件与 DOM 取值 → 问这个函数"这一步。
 */
export function bodyClickHidesRails(input: {
  /** 点击目标是否落在可交互元素（按钮 / 链接 / 输入框）里。 */
  interactive: boolean;
  /** 当前是否有**非空**选区（用户正在或刚刚划词）。 */
  hasSelection: boolean;
}): boolean {
  if (input.interactive) return false;
  if (input.hasSelection) return false;
  return true;
}

/**
 * 判断一个点击目标是否落在**可交互元素**里（用于 {@link bodyClickHidesRails}）。
 *
 * 用 `closest` 而不是 `tagName`：正文里真正可点的往往是 `<a>` 内部的 `<span>`，
 * 只比 tagName 会把"点在链接文字上"判成"点在正文空白处"。
 *
 * 参数用**结构化声明**（不是 `HTMLElement`）——纯逻辑层不依赖 DOM 类型，
 * 门禁可以在 Node 里直接喂一个假对象。
 */
export function isInteractiveTarget(
  target: { closest?: (selector: string) => unknown } | null | undefined,
): boolean {
  if (!target || typeof target.closest !== "function") return false;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * 正文里算作"可交互"的元素（与 `BookBlocks` 实际渲染的标签一致）。
 *
 * 翻页按钮已随悬浮翻页器一并删除（用户 2026-10-18），但 `button` 仍在名单里：
 * 正文本身可能带链接 / 表单类元素，且注释块里也可能出现按钮。
 */
const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, label";

// ============================== 分页模式：滚轮翻页 ==============================

/**
 * "滚了一次"的**像素当量**阈值。
 *
 * 为什么需要累积而不是"一个事件翻一页"（用户 2026-10-16 实测反馈：
 * "单页和双页滚轮滚动一次应该是一页，现在的方式和普通滚动无区别"）：
 * **一次物理滚动不等于一个 `wheel` 事件**。鼠标滚轮一格通常给 100–120（`deltaMode=0`），
 * 但高精度触控板/平滑滚动会把它拆成几十个 3–10 的小事件；反过来，
 * 有些设备一次给 300+。按"事件数"翻页就会出现两种都错的表现：
 * 触控板轻轻一滑翻十几页（看起来像连续滚动），而大增量设备一格翻三页。
 *
 * 因此口径是**按增量累积**：累积到本阈值算"滚了一次"，翻**一页**并把累积清零
 * （不是把超出的量折成多页——那又变回"一次滚动翻好几页"）。
 */
export const READER_WHEEL_STEP_PX = 60;

/** `deltaMode = 1`（按行）时一行折算的像素当量。 */
export const READER_WHEEL_LINE_PX = 16;

/** `deltaMode = 2`（按页）时一页折算的像素当量（远大于阈值 ⇒ 一次即翻页）。 */
export const READER_WHEEL_PAGE_PX = 400;

/**
 * 把一次 `wheel` 事件的增量归一化成**像素当量**。
 *
 * `deltaMode` 三档的含义（DOM 规范）：0 = 像素、1 = 行、2 = 页。
 * 不归一化就会按设备产生数量级差异：Firefox 在部分配置下给 `deltaMode = 1`、
 * 一次只报 3（"3 行"），不折算的话永远攒不到阈值 ⇒ 滚轮像失灵。
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY * READER_WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * READER_WHEEL_PAGE_PX;
  return deltaY;
}

/**
 * 累积滚轮增量 → 决定这一次是否翻页（**每次最多翻一页**）。
 *
 * 返回剩余累积量：未到阈值时留着（触控板的小增量因此能攒成一次翻页），
 * 到阈值即**清零**并把超出的部分一并丢掉——这是"一次滚动 = 一页"的关键：
 * 若改成"除以阈值取整"，一格 300 的鼠标就会一次翻 5 页。
 */
export function accumulateWheelStep(
  accumulated: number,
  delta: number,
  threshold: number = READER_WHEEL_STEP_PX,
): { accumulated: number; step: -1 | 0 | 1 } {
  const next = accumulated + delta;
  if (next >= threshold) return { accumulated: 0, step: 1 };
  if (next <= -threshold) return { accumulated: 0, step: -1 };
  return { accumulated: next, step: 0 };
}

/**
 * **一张纸**的翻页步进（= 纸内正文宽 + 栏间距 = `paperWidth`）。
 *
 * `translateX` 每一步要平移的距离。它必须与浏览器**真实的**分栏结果逐像素一致，
 * 否则翻几页之后正文就会错位（露出半栏）。之所以能保证一致：分页用
 * `column-count`（**不是** `column-width`）——列数固定时浏览器把可用宽度**等分**；
 * 而 `column-width` 只是"建议值"，浏览器会按容器宽度把栏拉宽到放得下。
 *
 * **与栏宽的小数位无关**：屏内 `N` 栏 + `N-1` 个间距恰好铺满纸内正文宽，
 * 因此下一屏第一栏的起点恒为 `contentWidth + gap`（见 [`readerPagination`]）。
 * 这也是"翻一页正好推进一张纸"的算术——不再需要单独的"屏宽"概念。
 */
export function readerScreenPitch(contentWidth: number, gap: number): number {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return 1;
  return contentWidth + gap;
}
