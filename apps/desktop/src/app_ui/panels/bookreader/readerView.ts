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

/**
 * 分页模式下的**完整几何**（一页 = 一屏 = `columns` 栏）。
 *
 * ## 为什么要有这一个函数
 *
 * 分页的三件事——每栏多宽、共几页、每次平移多少——**必须出自同一份算术**。
 * 之前它们分散在三处（`readerPageWidth` / `readerPageCount` / JSX 里的
 * `page * (pageWidth + gap)`），于是"双页"模式下页数与步进都按**单栏**算：
 * 一次滚轮只挪一栏（正文在屏幕里横向漂半格），页数也翻倍。用户实测反馈
 * "单页和双页滚轮滚动一次应该是一页，现在的方式和普通滚动无区别"正是这一处。
 *
 * ## 几何推导（分页用 `column-count`，列数固定）
 *
 * 设容器可用宽 `W`、屏内栏数 `N`、栏间距 `g`：
 * - 浏览器把宽度**等分**：`colW = (W - (N-1)g) / N`（= [`readerPageWidth`]）；
 * - 内容排成 `C` 栏，总宽 `scrollWidth = C·colW + (C-1)·g`；
 * - 反解栏数：`C = (scrollWidth + g) / (colW + g)`；
 * - 一屏看 `N` 栏 ⇒ 页数 `= ceil(C / N)`；
 * - 第 k 屏的左边缘 = `k · N · (colW + g)` ⇒ 步进 `pitch = N·(colW + g)`。
 *
 * 注意 `N = 1` 时 `pitch = W + g`（**含**栏间距）：下一栏的起点就是
 * "容器宽 + 一个间距"，不是"容器宽"——少了这个 `g`，翻几页就会露出半栏。
 */
export interface ReaderPagination {
  /** 单栏宽度（= 浏览器等分出来的实际栏宽）。 */
  columnWidth: number;
  /** 内容一共排成多少栏。 */
  columnCount: number;
  /** 一共多少页（一页 = `columns` 栏）。 */
  pageCount: number;
  /** 每次翻页 `translateX` 平移的像素（= 一屏 + 屏间的一个栏间距）。 */
  pitch: number;
}

export function readerPagination(
  scrollWidth: number,
  containerWidth: number,
  columns: 1 | 2,
  gap: number = READER_COLUMN_GAP,
): ReaderPagination {
  const columnWidth = readerPageWidth(containerWidth, columns, gap);
  const pitch = columnWidth + gap;
  // 空内容 / 尚未测量：给"1 栏 1 页"，避免 0 页让翻页按钮直接失效。
  if (!Number.isFinite(scrollWidth) || scrollWidth <= 0 || columnWidth <= 0) {
    return { columnWidth, columnCount: 1, pageCount: 1, pitch: pitch > 0 ? pitch : 1 };
  }
  const columnCount = Math.max(1, Math.round((scrollWidth + gap) / pitch));
  return {
    columnWidth,
    columnCount,
    pageCount: Math.max(1, Math.ceil(columnCount / columns)),
    pitch,
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

/** 正文里算作"可交互"的元素（与 `BookBlocks` / `br-pager` 实际渲染的标签一致）。 */
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
 * 分页模式下"一页"的**实际列距**（= 栏宽 + 栏间距）。
 *
 * 这是 `translateX` 每一步要平移的距离。它必须与浏览器**真实的**列距逐像素一致，
 * 否则翻几页之后正文就会错位（露出半栏）。
 *
 * 之所以能保证一致：分页用 `column-count`（**不是** `column-width`）——
 * 列数固定时浏览器把可用宽度**等分**，每栏宽恰好是 [`readerPageWidth`] 算出的值；
 * 而 `column-width` 只是"建议值"，浏览器会按容器宽度把栏拉宽到放得下，
 * 实际列距与算出来的对不上（这正是"翻页后错位"的根因）。
 *
 * **注意这是"一栏"的步进**；翻页要平移**一屏**，用 [`readerPagination`] 的 `pitch`。
 */
export function readerPagePitch(
  containerWidth: number,
  columns: 1 | 2,
  gap: number = READER_COLUMN_GAP,
): number {
  return readerPageWidth(containerWidth, columns, gap) + gap;
}
