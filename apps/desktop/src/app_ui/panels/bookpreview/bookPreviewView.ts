/**
 * 图书预览面板的**取值域与纯函数**（不 import React / Tauri，也**不 import 任何模块**
 * ——门禁 `pnpm check:panels` 要直接 import 本文件按行为断言，少一层解析就少一处失败面；
 * 参数类型一律**结构化**声明，而不是去引 `shared/types`）。
 *
 * 这一层存在的理由与媒体预览的 `mediaPreviewView.ts` 相同：声明层（
 * `packages/config/src/panels.ts`）只有 `kind` / `default`，没有 min/max，
 * 所以"视图取值域""尺寸范围""文件名怎么截断"只能由**用它的面板**定义一次，
 * 并让 `pnpm check:panels` 直接 import 本文件按行为断言（而不是对源码写正则）。
 */

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；设置落库键 `panel.bookpreview.<key>`）。 */
export const BOOK_PREVIEW_PANEL_ID = "bookpreview";

/**
 * 三种视图（用户 2026-10-09 修订命名，与声明层的 `options` 逐项相等）：
 * - `card`：**卡片模式** —— 封面在上、文件名在下；
 * - `list`：**列表模式** —— 封面在左、右侧自上而下是文件名 / 作者 / 简介，
 *   右栏填充剩余空间（原「封面模式」改名而来，用户口径：它本来就是列表）；
 * - `cover`：**封面模式** —— 规则与列表模式一致，但一行可展示多本（网格），
 *   右栏**不填充剩余空间**，固定为**封面宽度的 2 倍**。
 */
export const BOOK_VIEW_MODES = ["card", "list", "cover"] as const;
export type BookViewMode = (typeof BOOK_VIEW_MODES)[number];

/** 缺省视图（与声明层 `default` 相等）。 */
export const DEFAULT_BOOK_VIEW: BookViewMode = "card";

/** 声明层的缺省值非法/缺失时的收敛（失败关闭，不抛错）。 */
export function resolveBookView(raw: unknown): BookViewMode {
  return BOOK_VIEW_MODES.includes(raw as BookViewMode) ? (raw as BookViewMode) : DEFAULT_BOOK_VIEW;
}

/** 封面宽度的取值范围（声明层没有 min/max，只能在这里夹紧）。 */
export const BOOK_COVER_SIZE_MIN = 96;
export const BOOK_COVER_SIZE_MAX = 400;

/** 缺省封面宽度（与声明层 `default` 相等，且必须落在夹紧范围内）。 */
export const DEFAULT_BOOK_COVER_SIZE = 160;

/**
 * 封面宽度滑条的步进（与媒体预览的 `MEDIA_IMAGE_SIZE_STEP` 同口径：滑条拖起来
 * 有档位感，但不会卡在中间值上）。
 */
export const BOOK_COVER_SIZE_STEP = 8;

/**
 * 封面框的宽高比（宽:高 = 2:3，与 styles.css 的 `.bp-art { aspect-ratio: 2 / 3 }` 相同）。
 * 列表 / 封面模式下，信息列的高度 = 封面框高度（行高由封面撑起）。
 */
export const BOOK_COVER_ASPECT = 2 / 3;

/**
 * 列表 / 封面模式信息列的**固定行高参数**（与 styles.css 的 `.bp-row-*` 逐项相等：
 * 字体 13 / 12 / 12 px × `line-height: 1.5`，列内 gap 4px × 两处）。
 * 简介截断行数要靠这套算术算出来，两处不一致就会算错行数——所以参数只定义一次。
 */
export const BOOK_ROW_NAME_LINE_PX = 13 * 1.5;
export const BOOK_ROW_AUTHOR_LINE_PX = 12 * 1.5;
export const BOOK_ROW_DESC_LINE_PX = 12 * 1.5;
export const BOOK_ROW_INFO_GAP_PX = 4 * 2;

/**
 * 简介可用的**纵向空间**（px）：信息列与封面同高，减去文件名与作者两行的固定高度
 * 与两处间距，剩下的全部给简介。
 */
export function bookDescAvailableHeight(coverSize: number): number {
  return (
    (coverSize / BOOK_COVER_ASPECT) -
    BOOK_ROW_NAME_LINE_PX -
    BOOK_ROW_AUTHOR_LINE_PX -
    BOOK_ROW_INFO_GAP_PX
  );
}

/**
 * 简介的截断行数：**填满到封面图片底部**（用户 2026-10-09 口径——不再固定 3 行，
 * 溢出标准是和封面底部齐平），至少 1 行。
 *
 * 面板把这个数下发成 `--bp-desc-lines`，CSS 用 `-webkit-line-clamp: var(--bp-desc-lines)`
 * 截断：行数由封面尺寸推得，封面变大简介就能多显示几行。
 */
export function bookDescLineCount(coverSize: number): number {
  const lines = Math.floor(bookDescAvailableHeight(coverSize) / BOOK_ROW_DESC_LINE_PX);
  return Math.max(1, lines);
}

/**
 * 封面模式（网格）右栏 = **封面宽度的 2 倍**（用户口径：不填充剩余空间）。
 * 加 10px 是封面与右栏之间的列内间距（与列表模式同款）。
 */
export const BOOK_COVER_INFO_SCALE = 2;
export const BOOK_COVER_ROW_GAP_PX = 10;

/** 封面模式一个单元格的总宽（封面 + 间距 + 2 倍封面的右栏）。 */
export function bookCoverCellWidth(coverSize: number): number {
  return coverSize * (1 + BOOK_COVER_INFO_SCALE) + BOOK_COVER_ROW_GAP_PX;
}

/**
 * 把设置里的任意值夹到合法范围。
 *
 * 两种输入要分开处理，别把"没设置"当成"设成了 0"：
 * - **缺失**（`undefined` / `null` / 空串）→ 回落缺省；
 * - **有值但非法**（非数字、越界）→ 该夹紧就夹紧，数字都不是就用缺省。
 */
export function clampCoverSize(raw: unknown): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_BOOK_COVER_SIZE;
  const rounded = Math.round(parsed);
  if (rounded < BOOK_COVER_SIZE_MIN) return BOOK_COVER_SIZE_MIN;
  if (rounded > BOOK_COVER_SIZE_MAX) return BOOK_COVER_SIZE_MAX;
  return rounded;
}

/**
 * 文件名 → **作品名**（去掉目录与扩展名）。
 *
 * 用户口径是「文件名（作品名）」：下方/右侧显示的就是**文件名**，它同时也是作品名。
 * 因此这里**不读** EPUB 内嵌的 `dc:title`——文件名是用户认得出的东西，
 * 内嵌标题有时反而是编辑残留（实测样本里两者并不一致）。
 */
export function bookDisplayName(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const trimmed = stem.trim();
  return trimmed.length > 0 ? trimmed : base;
}

/** 相对路径的扩展名（小写，不含点）；没有扩展名返回空串。 */
export function extensionOf(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** book 标记的取值名（与 `@hamster-pouch/config` 的 `BOOK_MARK` 同字面量）。 */
const BOOK_MARK_NAME = "book";

/**
 * 该文件是否带 **book 标记**（D102：标记是**可多值**的集合，这里是"含不含 book"）。
 *
 * 它是**标记**而不是"子类型"：与**类目**（`media_type`）正交，且一个文件可以同时带
 * 多个标记（`book` + `manga`）。因此判据是 `marks.includes("book")`，不是"等于某个值"。
 *
 * **旧索引行兜底**：迁移 0010 之前入库的行没有标记（`marks` 为空），若只认标记，
 * 存量 EPUB 在重扫前会全部退化成文字封面。这类行按扩展名兜底，
 * 让"还没重扫"与"面板坏了"看起来不一样。
 */
export function fileBookMark(item: {
  marks: string[];
  relative_path: string;
}): boolean {
  if (item.marks.length > 0) return item.marks.includes(BOOK_MARK_NAME);
  return extensionOf(item.relative_path) === "epub";
}

/**
 * 该条目是否要用**内嵌封面**（= 要去 `book.meta` 取图）。
 *
 * 判据就是 book 标记（见 {@link fileBookMark}）；单列一个名字是为了让封面来源
 * 的调用点读起来是"要不要内嵌封面"，而不是"它是不是书"。
 */
export function usesEmbeddedCover(item: {
  marks: string[];
  relative_path: string;
}): boolean {
  return fileBookMark(item);
}

/**
 * 文本条目的**子类**（`epub` / `txt` / `md`）：与蓝图 `subclass` 节点的 `format` 比对。
 *
 * 扩展名（`markdown` → `md`）归一化到子类取值域；**认不出的扩展名返回空串**
 * （没有子类能表达它，蓝图侧按未接通处理）。非文本类返回空串。
 *
 * 子类与标记是**两条正交的轴**：本函数只管子类，标记由 {@link fileMarks} 给出。
 */
export function fileFormat(item: { media_type: string; relative_path: string }): string {
  if (item.media_type !== "text") return "";
  const ext = extensionOf(item.relative_path);
  if (ext === "epub") return "epub";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt") return "txt";
  return "";
}

/**
 * 条目的**标记集合**（原样透传；D102 起标记可多值）。
 *
 * 与 {@link fileFormat} **正交**：一个被标为 `manga` 的 `txt` 会**同时**命中
 * 「txt 子类」与「manga 标记」——这正是用户口径"标记可以交叉"的落点。
 */
export function fileMarks(item: { marks: string[] }): string[] {
  return item.marks;
}

/**
 * 本面板上报蓝图引擎时的**目标引用**（RFC 0007 决策 1 + D102 的三轴）。
 *
 * 带上**三条轴**，引擎才能按各自的节点类型匹配：
 * - `mediaType` → 类目节点（`class`，如「文本」）；
 * - `format` → 子类节点（`subclass`，如「txt」）；
 * - `marks` → 标记节点（`mark`，如「漫画」）。
 *
 * 后两者**正交**：一个被标为 `manga` 的 `txt` 会同时命中「txt 子类」与「manga 标记」
 * ——这正是用户口径"标记可以交叉"的落点。
 */
export function bookDispatchTarget(item: {
  id: string;
  media_type: string;
  marks: string[];
  relative_path: string;
}): {
  mediaType: string;
  fileId: string;
  format: string;
  marks: string[];
} {
  return {
    mediaType: item.media_type,
    fileId: item.id,
    format: fileFormat(item),
    marks: fileMarks(item),
  };
}

/**
 * 文件名滚轮横向滚动的下一位置。
 *
 * 这是「焦点在文件名上可滚动滚轮查看」的**全部算术**：`deltaY` 同时接受
 * 纵向滚轮（鼠标最常见的形态）与横向滚轮（触控板/倾斜滚轮），越界即夹紧。
 * 放在纯函数里是为了让门禁能按行为断言，而不是去正则匹配事件绑定代码。
 */
export function nextScrollLeft(scrollLeft: number, delta: number, maxScroll: number): number {
  if (!Number.isFinite(maxScroll) || maxScroll <= 0) return 0;
  const next = scrollLeft + delta;
  if (next < 0) return 0;
  return next > maxScroll ? maxScroll : next;
}

/**
 * 文字封面上的名字换行（按**字符数**贪心断行，超出即截断并加省略号）。
 *
 * 中文书名没有空格，按词断行在 CJK 上等于不断行，所以这里按字符数断。
 * 末尾的省略号只在**真的被截断**时出现——否则用户会以为书名本身带省略号。
 */
export function wrapCoverName(
  name: string,
  maxCharsPerLine: number,
  maxLines: number,
): string[] {
  const chars = [...name.trim()];
  if (chars.length === 0) return [];
  const perLine = Math.max(1, Math.floor(maxCharsPerLine));
  const lines: string[] = [];
  for (let at = 0; at < chars.length; at += perLine) {
    lines.push(chars.slice(at, at + perLine).join(""));
    if (lines.length === maxLines) break;
  }
  const truncated = chars.length > lines.length * perLine;
  if (truncated) {
    const last = [...(lines[lines.length - 1] ?? "")];
    lines[lines.length - 1] = `${last.slice(0, Math.max(1, perLine - 1)).join("")}…`;
  }
  return lines;
}

/**
 * 由作品名派生一个**稳定**的封面底色色相（同名恒同色）。
 *
 * 用 FNV-1a：实现短、分布够均匀，且**跨会话稳定**——色相随随机数走的话，
 * 每次打开面板书都是另一个颜色，用户会以为是渲染故障。
 */
export function textCoverHue(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}
