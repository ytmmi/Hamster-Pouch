/**
 * 媒体预览面板：**虚拟化的行模型**（纯逻辑，无框架依赖）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 条目容器要把"数万个条目"变成"视口内几十个 DOM 单元"，就必须先把条目**切成行**，
 * 这件事本身与 React 无关，因此单独放这里——
 * `pnpm check:panels` 可以**直接 import** 并按行为断言。
 *
 * ## 为什么是"行"而不是"条目"
 *
 * - **平铺**（`.mp-grid.mp-view-tile`）：一行 `--mp-tile-columns` 个单元，行高由
 *   单元格宽度决定（**定高**）；
 * - **文件名列表**（`.mp-list`）：一行一条，行高由文字度量决定（**定高**）；
 * - **自适应 / 瀑布流**：行高随图片宽高比变化（**变高**），见后续阶段。
 *
 * 定高的两种视图可以按"行"整块虚拟化：行的 `top` 是 `行号 × 行高` 的简单乘积，
 * 不需要测量，也就不会出现"测量结果回流导致滚动条抖动"。
 */

/**
 * 把条目按 `perRow` 个一行切开（最后一行可能不满）。
 *
 * `perRow <= 0` 时按 1 处理：否则会切出无穷多空行（或除零）。
 * 返回的每一行都非空，且**保序、不丢项、不重复**——这三条由门禁按行为断言。
 */
export function chunkRows<T>(items: readonly T[], perRow: number): T[][] {
  const width = Math.max(1, Math.floor(perRow) || 1);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += width) {
    rows.push(items.slice(i, i + width));
  }
  return rows;
}

/**
 * 平铺视图的**行盒**高度（px），**不含行间距**。
 *
 * 与样式表逐项对齐（`styles.css`）：
 * - `.mp-cell` 有 `padding: 4px` 与 `1px` 边框，且全局 `box-sizing: border-box`；
 * - `.mp-thumb` 在平铺下 `aspect-ratio: 1 / 1`，宽度 = 单元格宽 − 左右内边距与边框；
 * - 缩略图与文件名之间 `gap: 4px`；`.mp-name` 为 `font-size: 11px` 的单行省略号。
 *
 * 行间距由虚拟化库的 `gap` 选项统一加上（`MEDIA_TILE_ROW_GAP`），不在这里重复计算。
 *
 * 取整到像素：分数高度会让 `行号 × 行高` 与浏览器的实际布局逐渐错位，
 * 滚到列表深处时表现为"越滚越偏"。
 */
export function tileRowHeight(
  cellWidth: number,
  showName: boolean,
  nameLineHeight = 16,
): number {
  const cell = Math.max(1, cellWidth);
  // 左右各 4px 内边距 + 各 1px 边框（border-box，故从单元格宽度里扣除）。
  const inner = Math.max(1, cell - 10);
  const vertical = 4 + 4 + 2; // 上下内边距 + 上下边框
  const nameBlock = showName ? 4 + nameLineHeight : 0; // gap + 一行文件名
  return Math.round(vertical + inner + nameBlock);
}

/**
 * 文件名列表的**行盒**高度（px），**不含行间距**。
 *
 * `.mp-row` 的 `padding: 3px 6px` + `1px` 边框 + 单行文字。行间距由虚拟化库的
 * `gap` 选项统一加上（`MEDIA_LIST_ROW_GAP`），因此不在这里重复计算。
 *
 * 文字高度用 `lineHeight` 传入（缺省与浏览器正文一致），因为字体度量不该在这里猜死；
 * 列表视图实际用**测量值**（`useMeasuredRowVirtualizer`），这里只是首帧的估计。
 */
export function listRowHeight(lineHeight = 16): number {
  return Math.round(3 + 3 + 2 + lineHeight);
}

/** 平铺视图的**行间距**（与 `.mp-grid` 的 `gap: 8px` 一致）。 */
export const MEDIA_TILE_ROW_GAP = 8;

/** 文件名列表的**行间距**（与 `.mp-list` 的 `gap: 2px` 一致）。 */
export const MEDIA_LIST_ROW_GAP = 2;

/**
 * 瀑布流**单个单元**的高度（px），**不含单元间距**。
 *
 * 与平铺的差别只有一处：缩略图高度由**图片自身宽高比**推出（`.mp-masonry .mp-thumb`
 * 的 `height: auto` + `img` 的 `height: auto`），而不是方形。
 *
 * 因此单元高度 = 上下内边距/边框 + 缩略图高 +（可选）文件名行。
 * `ratio` 来自宽高比缓存（`mediaPreviewCell.tsx` 的 `ratioCache`）——
 * 索引里没有图片尺寸，只有 `<img>` 解码后才量得到，量之前用 `DEFAULT_CELL_RATIO` 占位。
 */
export function masonryCellHeight(
  columnWidth: number,
  ratio: number,
  showName: boolean,
  nameLineHeight = 16,
): number {
  const column = Math.max(1, columnWidth);
  const inner = Math.max(1, column - 10);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const thumb = inner / safeRatio;
  const vertical = 4 + 4 + 2;
  const nameBlock = showName ? 4 + nameLineHeight : 0;
  return Math.round(vertical + thumb + nameBlock);
}

/**
 * 自适应视图**单个单元**的占位高度（px）——给 `contain-intrinsic-size` 用。
 *
 * 自适应视图的行内宽度按宽高比分配，单元**实际**高度 = 该行最终行高（各行不同），
 * 单看一个单元是算不出来的。但行高被 `--mp-row-max-factor: 2` 封顶，且"铺满一行"时
 * 行高就约等于图片尺寸——所以用图片尺寸作估计，误差远小于原先写死的 140px。
 *
 * 这个值只影响**被跳过渲染**的单元（`content-visibility: auto`）在滚动中占多高：
 * 估计得越准，滚动条越不会抖。真正渲染出来的单元由 CSS 按真实宽高比排版。
 */
export function adaptiveCellIntrinsicHeight(
  imageSize: number,
  showName: boolean,
  nameLineHeight = 16,
): number {
  const base = Math.max(1, imageSize);
  return Math.round(base + (showName ? 4 + nameLineHeight : 0));
}

