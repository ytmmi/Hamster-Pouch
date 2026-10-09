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
 * 两种视图（用户 2026-10-08 命名，与声明层的 `options` 逐项相等）：
 * - `card`：**卡片模式** —— 封面在上、文件名在下；
 * - `cover`：**封面模式** —— 封面在左、右侧自上而下是文件名 / 作者 / 简介。
 */
export const BOOK_VIEW_MODES = ["card", "cover"] as const;
export type BookViewMode = (typeof BOOK_VIEW_MODES)[number];

/** 缺省视图（与声明层 `default` 相等）。 */
export const DEFAULT_BOOK_VIEW: BookViewMode = "card";

/** 声明层的缺省值非法/缺失时的收敛（失败关闭，不抛错）。 */
export function resolveBookView(raw: unknown): BookViewMode {
  return BOOK_VIEW_MODES.includes(raw as BookViewMode) ? (raw as BookViewMode) : DEFAULT_BOOK_VIEW;
}

/** 封面上限尺寸的取值范围（声明层没有 min/max，只能在这里夹紧）。 */
export const BOOK_COVER_SIZE_MIN = 96;
export const BOOK_COVER_SIZE_MAX = 400;

/** 缺省封面上限尺寸（与声明层 `default` 相等，且必须落在夹紧范围内）。 */
export const DEFAULT_BOOK_COVER_SIZE = 160;

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

/**
 * 该条目是否要用**内嵌封面**（= 要去 `book.meta` 取图）。
 *
 * 判据是**子类型**（用户口径：子类型是可编辑的标记），因此把某本书的子类型改成
 * `document` 就不再取内嵌封面、改用文字封面——这正是"标记"该有的效果。
 *
 * **旧索引行兜底**：迁移 0008 之前入库的行没有子类型（`null`），若只认子类型，
 * 存量 EPUB 在重扫前会全部退化成文字封面。这类行按扩展名兜底，
 * 让"还没重扫"与"面板坏了"看起来不一样。
 */
export function usesEmbeddedCover(item: {
  subtype: string | null;
  relative_path: string;
}): boolean {
  if (item.subtype) return item.subtype === "book";
  return extensionOf(item.relative_path) === "epub";
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
