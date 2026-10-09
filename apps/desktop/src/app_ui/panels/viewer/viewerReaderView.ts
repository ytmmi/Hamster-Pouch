/**
 * 查看器：**正文阅读的纯逻辑**（无框架依赖，门禁可直接 import 断言）。
 *
 * 用户口径（2026-10-09）：
 * - 查看器新增 `txt` 与 `epub` 两种查看，显示**开头的内容**，范围为**查看器面板大小**；
 * - epub "根据查看器自适应展示单栏或双栏，**默认为单栏**"——用户进一步裁定
 *   **纯自动、不做设置项**（2026-10-09 追问的答复），因此分栏只由**面板宽度**决定；
 * - 内容"固定上限 + 面板内滚动看更多，字符缓存不需要大、滚动时按需缓存"。
 *
 * 本文件承载其中**可以脱离 DOM 断言**的部分：
 * 分栏判据、阅读宽度换算、按滚动位置决定"该不该再取一页"。
 */

/**
 * 单栏 / 双栏的**判据宽度**（px）：阅读区宽度达到它才分两栏。
 *
 * 取 900 的理由：正文单栏的可读宽度上限约 45 个汉字（13px 字号约 585px）——
 * 再宽就会出现"一行要看很久才换行"的阅读疲劳。900px 意味着**两栏各约 440px**
 * （≈34 个汉字），两栏都在舒适区内；低于 900px 时两栏会各自窄到 300px 以下，
 * 那反而不如单栏好读。这条阈值就是"默认为单栏"的落点：窄面板恒单栏。
 */
export const READER_TWO_COLUMN_MIN_WIDTH = 900;

/** 阅读区左右内边距之和（px）：换算可用宽度时扣掉。 */
export const READER_HORIZONTAL_PADDING = 48;

/** 两栏之间的间距（px）；单栏时不生效。 */
export const READER_COLUMN_GAP = 32;

/** 阅读区的分栏数。 */
export type ReaderColumns = 1 | 2;

/**
 * 按**面板宽度**决定分栏数（纯自动，无设置项）。
 *
 * 判据用**可用宽度**（扣掉左右内边距）而不是容器原宽：否则"面板刚好 900px 但
 * 内边距占 48px"时会分成两栏、每栏只有 410px，比单栏还窄。
 */
export function readerColumns(containerWidth: number): ReaderColumns {
  const usable = containerWidth - READER_HORIZONTAL_PADDING;
  return usable >= READER_TWO_COLUMN_MIN_WIDTH ? 2 : 1;
}

/**
 * 双栏模式下，正文应在**当前栏**内滚动到什么程度才换到下一栏。
 *
 * CSS 多栏布局把内容按**高度**分栏，因此"第一栏读完了"等价于
 * "滚动位置达到 (内容高 − 可视高) / 栏数"。本函数给出这个阈值。
 *
 * 单栏返回 `0`（没有"第一栏读完"这件事，一直滚到底即可）。
 */
export function firstColumnEnd(
  scrollHeight: number,
  clientHeight: number,
  columns: ReaderColumns,
): number {
  if (columns <= 1) return 0;
  const scrollable = Math.max(0, scrollHeight - clientHeight);
  return scrollable / columns;
}

/**
 * 滚动到接近底部时是否该再取一页。
 *
 * `threshold` 是提前量（px）：滚动条离底还有这么多就开始取，用户滚到底时
 * 内容通常已经到了，不会看到空窗。**已经有下一页游标**是前提——没有更多内容时
 * 再怎么滚也不该发请求（否则到底后会反复请求同一个空页）。
 */
export function shouldLoadMore(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  hasMore: boolean,
  threshold = 400,
): boolean {
  if (!hasMore) return false;
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * 阅读区的字号（px）。**随面板宽度**给一档，窄面板用小一号字。
 *
 * 与分栏同一口径：都是"根据查看器自适应"。不做设置项（用户口径）。
 */
export function readerFontSize(containerWidth: number): number {
  if (containerWidth < 520) return 12;
  if (containerWidth < READER_TWO_COLUMN_MIN_WIDTH) return 13;
  return 14;
}

/** 正文是否**只有图片**（如 EPUB 的封面页 / 彩页）：面板据此居中而不是左对齐。 */
export function isImageOnly(blocks: { kind: string }[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.kind === "image");
}
