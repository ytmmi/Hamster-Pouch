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

/** 瀑布流的**列间距 / 单元间距**（与 `.mp-masonry` / `.mp-masonry-col` 的 `gap: 8px` 一致）。 */
export const MEDIA_MASONRY_GAP = 8;

/**
 * 瀑布流**单个单元**的高度（px），**不含单元间距**。
 *
 * 与平铺的差别只有一处：缩略图高度由**图片自身宽高比**推出（`.mp-masonry .mp-thumb`
 * 的 `height: auto` + `img` 的 `height: auto`），而不是方形。
 *
 * 因此单元高度 = 上下内边距/边框 + 缩略图高 +（可选）文件名行。
 * `ratio` 来自宽高比缓存（`mediaPreviewCell.tsx` 的 `ratioCache`）——
 * 索引里没有图片尺寸，只有 `<img>` 解码后才量得到，量之前用 `DEFAULT_CELL_RATIO` 占位。
 *
 * ## 盒模型是**实测反推**的，不是按 CSS 猜的
 *
 * 这个函数原先按"内边距 4+4、边框 1+1、缩略图高 = (列宽−10)/宽高比、文件名 16px"
 * 估算。按列虚拟化上线后，**绝对定位**让偏移精确落在预测值上，于是"高度猜错"不再
 * 表现为错位、而是表现为**相邻单元重叠/留白**——实测抓到了：间距应为 8px，
 * 实际 minGap = **−18px**（重叠）、maxGap = **148px**。
 *
 * 用真实渲染反推（列宽 160、`box-sizing: border-box`）：
 *
 * ```text
 * thumbW = 列宽 − 8(内边距) − 2(单元边框) = 150
 * imgW   = thumbW − 2(缩略图边框)         = 148
 * imgH   = imgW / 宽高比
 * thumbH = imgH + 2(缩略图边框)
 * 单元高 = 8(内边距) + 2(单元边框) + thumbH + 4(gap) + 文件名行高
 * ```
 *
 * 而**文件名实际行高是 12px**（`font-size: 11px` 的行盒），不是猜的 16px。
 * 合并后：`单元高 = 28 + (列宽 − 12) / 宽高比`（有文件名时）。
 * 该式对实测样本的误差 ≤ 0.05px（见 `mediaPreviewVirtual` 的门禁断言与
 * `apps/desktop/perf` 的 `minGap` / `maxGap` 探针）。
 *
 * **`nameLineHeight` 缺省 12**：这是 `.mp-name`（`font-size: 11px`、`white-space: nowrap`）
 * 在默认字体度量下的行盒高度，实测值；传错会让每个单元累积误差。
 */
export function masonryCellHeight(
  columnWidth: number,
  ratio: number,
  showName: boolean,
  nameLineHeight = 12,
): number {
  const column = Math.max(1, columnWidth);
  // 列宽减去：单元左右内边距 4+4、单元左右边框 1+1、缩略图左右边框 1+1 = 12。
  const inner = Math.max(1, column - 12);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  // 缩略图高 = 图片高 + 缩略图上下边框 2；再加单元上下内边距 8 与边框 2。
  const thumb = inner / safeRatio + 2;
  const vertical = 4 + 4 + 2;
  const nameBlock = showName ? 4 + nameLineHeight : 0;
  return Math.round(vertical + thumb + nameBlock);
}

/**
 * 瀑布流：**按列累计**每项的偏移与每列的内容总高。
 *
 * `distributeColumns` 已把条目分到各列（按序号 `i % columns`，与高度无关——这样
 * 阅读顺序与排序结果一致、同一次排序的布局稳定）。这里给每列累计出"每一项距列顶的
 * 偏移"以及每列的**内容总高**（末项不留间距，否则容器底部会多出一条空档）。
 *
 * 瀑布流的"列"是**明确的**（固定列宽），不像自适应要复现 CSS 断行，因此按列虚拟化
 * 只需要这个纯函数 + 一个窗口判定，不必测量。
 *
 * **高度会随解码变化**：`ratioCache` 在 `<img>` 解码后写入真实宽高比，未解码时是
 * `DEFAULT_CELL_RATIO`。调用方（面板）把 `ratioCache` 的**版本号**放进依赖，
 * 量到新宽高比就重算一次——这与既有行为一致（`mediaPreviewCell` 量到即 `setRatio`）。
 */
export function masonryColumnLayout<T>(
  columns: readonly (readonly T[])[],
  heightOf: (item: T) => number,
  gap = MEDIA_MASONRY_GAP,
): { offsets: number[][]; heights: number[][]; columnHeights: number[] } {
  const offsets: number[][] = [];
  const heights: number[][] = [];
  const columnHeights: number[] = [];
  for (const column of columns) {
    const columnOffsets: number[] = [];
    const columnHeightsList: number[] = [];
    let cursor = 0;
    for (const item of column) {
      const height = Math.max(1, Math.round(heightOf(item)));
      columnOffsets.push(cursor);
      columnHeightsList.push(height);
      cursor += height + gap;
    }
    offsets.push(columnOffsets);
    heights.push(columnHeightsList);
    // 最后一项后面不留间距。
    columnHeights.push(Math.max(0, cursor - gap));
  }
  return { offsets, heights, columnHeights };
}

/**
 * 瀑布流**某一列**在当前滚动窗口内要渲染的条目区间（`[start, end)`，end 开区间）。
 *
 * 按列虚拟化的核心：列内是**线性偏移**（`offsets` 单调递增），因此用二分找出
 * 第一条"底边越过窗口顶"的项，再向后走到"顶边越过窗口底"为止。
 *
 * @param offsets 该列每项距列顶的偏移（单调不减）
 * @param heights 该列每项的高度（与 `offsets` 等长）
 * @param scrollTop 滚动容器的当前滚动位置
 * @param viewportHeight 滚动容器的可视高度
 * @param overscan 窗口上下各多渲染的像素（滚动时不会出现"滚到才渲染"的白边）
 *
 * 返回的区间**一定在 `[0, offsets.length]` 内**：越界的输入退化成空区间或整列，
 * 不抛错（虚拟化算错时宁可多渲染，也不要让面板崩掉）。
 */
export function masonryVisibleRange(
  offsets: readonly number[],
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 0,
): { start: number; end: number } {
  const count = Math.min(offsets.length, heights.length);
  if (count === 0) return { start: 0, end: 0 };

  const top = (Number.isFinite(scrollTop) ? scrollTop : 0) - Math.max(0, overscan);
  const bottom =
    (Number.isFinite(scrollTop) ? scrollTop : 0) +
    Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0) +
    Math.max(0, overscan);

  // 二分：第一条「底边 > top」的项（前面那些整条都在窗口上方）。
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] + heights[mid] > top) hi = mid;
    else lo = mid + 1;
  }
  const start = lo;

  // 从 start 起第一条「顶边 >= bottom」的项（它和它之后的都在窗口下方）。
  let end = start;
  while (end < count && offsets[end] < bottom) end += 1;

  return { start, end };
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

