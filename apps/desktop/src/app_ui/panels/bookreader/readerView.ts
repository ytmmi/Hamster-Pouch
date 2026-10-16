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
export const READER_PARAGRAPH_SPACING = { min: 0, max: 100, default: 12 } as const;
/** 屏幕亮度（百分比）→ CSS `filter: brightness()`；下限 30% 防止调到看不见。 */
export const READER_BRIGHTNESS = { min: 30, max: 100, default: 100 } as const;

/** 双页模式的栏间距（px；与「页边距」不是一个东西：那是正文内边距）。 */
export const READER_COLUMN_GAP = 32;

/** 估算阅读速度（字/分钟）：中文默读的常用量级，用于"读完本章约需 N 分钟"。 */
export const READER_CHARS_PER_MINUTE = 400;

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
 * 当前阅读位置落在目录的哪一项上。
 *
 * 判据用**游标数值比较**而不是字符串相等：`cursor` 是"序号 / 字符偏移"，
 * 当前页的游标往往落在两条目录项之间（例如第 2 章的第 3 页），
 * 因此取"最后一条 cursor ≤ 当前游标的项"。
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
 * 阅读进度（0–1）；拿不到总量时返回 `null`（界面显示 `—` 而不是假装 0%）。
 *
 * 三种格式的**位置单位**不同（见 `hp_book::toc` 的模块文档），因此这里分开算：
 * - `epub` / `pdf`：位置 = `section`（章节 / 页码），总量 = `section_count`；
 * - `text` / `markdown`：位置 = 当前页游标（字符偏移 / 块序号），总量 = 目录接口给的 `total`。
 *
 * 为什么不用"当前页 + 一页"来算：进度条要的是"读到哪儿了"，
 * 而一页的尾部会让进度凭空多跳一格。
 */
export function readerProgress(
  format: string,
  section: number,
  sectionCount: number | null,
  cursor: string | null,
  total: number | null,
): number | null {
  if (format === "epub" || format === "pdf") {
    if (!sectionCount || sectionCount <= 0) return null;
    return clamp01((section + 1) / sectionCount);
  }
  if (!total || total <= 0 || !cursor) return null;
  const at = Number(cursor);
  if (!Number.isFinite(at)) return null;
  return clamp01(at / total);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 进度百分比文案（两位小数，与参考图的 `0.00%` 同形）。 */
export function formatProgressPercent(progress: number | null): string | null {
  if (progress === null) return null;
  return `${(progress * 100).toFixed(2)}%`;
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

/**
 * 分页模式下的总页数。
 *
 * 判据是**内容流的总宽**：分页用 CSS 多栏实现（固定高度 → 浏览器按栏宽横向排版），
 * 因此 `scrollWidth / (栏宽 + 栏间距)` 就是页数。返回至少 1 页
 * （内容比一屏还短时仍然是"第 1 页"）。
 */
export function readerPageCount(
  scrollWidth: number,
  pageWidth: number,
  gap: number = READER_COLUMN_GAP,
): number {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 1;
  return Math.max(1, Math.round(scrollWidth / (pageWidth + gap)));
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
 * 单栏宽度：面板可用宽度按屏内栏数等分（并扣掉栏间距）。
 *
 * 分页模式下这一栏就是"一页"；滚动模式下不调用它（正文按面板宽度自适应）。
 */
export function readerPageWidth(
  containerWidth: number,
  columns: 1 | 2,
  gap: number = READER_COLUMN_GAP,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  const usable = containerWidth - gap * (columns - 1);
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
