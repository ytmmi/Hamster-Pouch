/**
 * 分块几何与 LOD 判定（RFC 0013 §6.2，**纯函数**，被 `check:render` 逐条断言）。
 *
 * 为什么几何全在这里而不是散在四个后端里：分块坐标一旦各算各的，
 * 「同样一张图在 canvas2d 与 webgpu 里差半个块」这种缺陷只能靠肉眼发现。
 * 这里的所有函数都不碰 DOM、不读全局，输入输出都是数。
 */

import type { Size, ViewTransform } from "./surface";

/** 长边超过它才先出低清档（1280）。`<= 4096` 走单张整纹理快路径（RFC §6.1/§10）。 */
export const LOD0_MIN_LONG_SIDE = 4096;

/**
 * 低清档取缩略图梯的最后一档（D159 的 `1280`）。
 *
 * 为什么复用缩略图梯而不是另生成一套：那张 WebP 已经按需生成、已有缓存键
 * （`fileId@1280`），再开一条「预览低清」链路等于把同一件事做两遍。
 */
export const LOD0_BUCKET_PX = 1280;

/** LOD1 进/出滞回：`zoom × dpr` 与 LOD0 密度的比值（RFC §6.4）。 */
export const LOD1_ENTER_RATIO = 1.15;
export const LOD1_EXIT_RATIO = 0.85;

/** 1 MiB（上传预算的换算单位）。 */
export const MIB = 1024 * 1024;

/** 矩形（图像像素或 CSS 像素，由调用处参数名区分）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 分块网格。`width` / `height` 是**原图像素**，用来裁掉最后一行/列的越界部分
 * ——RFC 的字段表只写了 `tile/cols/rows`，但缺了原图尺寸就算不出 `tileImageRect`
 * 的边界（末尾块会把 9000 的最后一块算成 1024 宽）。多带两个字段是保守修正。
 */
export interface TileGrid {
  tile: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

/** 是否要先出低清档。`natural` 未知按大图处理（先出低清总比白屏好，RFC §10）。 */
export function shouldPrefetchLowRes(natural: Size | null | undefined): boolean {
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return true;
  return Math.max(natural.width, natural.height) > LOD0_MIN_LONG_SIDE;
}

/** 分块网格：`cols = ceil(width / tilePx)`；任一维为 0 时网格为空（0×0）。 */
export function tileGrid(natural: Size, tilePx: number): TileGrid {
  const tile = Math.max(1, Math.floor(tilePx));
  const width = Math.max(0, Math.floor(natural.width));
  const height = Math.max(0, Math.floor(natural.height));
  return {
    tile,
    cols: Math.ceil(width / tile),
    rows: Math.ceil(height / tile),
    width,
    height,
  };
}

/** 第 `index` 块在原图坐标系里的矩形（末尾块按原图边界裁掉）。 */
export function tileImageRect(grid: TileGrid, index: number): Rect {
  const cols = Math.max(1, grid.cols);
  const col = ((index % cols) + cols) % cols;
  const row = Math.floor(index / cols);
  const x = col * grid.tile;
  const y = row * grid.tile;
  return {
    x,
    y,
    width: Math.max(0, Math.min(grid.tile, grid.width - x)),
    height: Math.max(0, Math.min(grid.tile, grid.height - y)),
  };
}

/**
 * 视口在**图像坐标系**里覆盖的矩形（已与图像边界求交）。
 *
 * 反算（RFC §6.2）：`ix = natural.w/2 + (sx - viewport.w/2 - offset.x) / zoom`。
 * `zoom` 非正（视口尚未测量）时返回空矩形：契约里的 `setView` 可能先于首次测量到达。
 */
export function viewportImageRect(
  natural: Size,
  view: ViewTransform,
  viewport: Size,
): Rect {
  const zoom = view.zoom;
  if (!(zoom > 0) || !(natural.width > 0) || !(natural.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const left = natural.width / 2 + (0 - viewport.width / 2 - view.offset.x) / zoom;
  const top = natural.height / 2 + (0 - viewport.height / 2 - view.offset.y) / zoom;
  const right = left + viewport.width / zoom;
  const bottom = top + viewport.height / zoom;
  return intersectRect(
    { x: left, y: top, width: right - left, height: bottom - top },
    { x: 0, y: 0, width: natural.width, height: natural.height },
  );
}

/** 图像坐标矩形 → 舞台坐标矩形（CSS 像素）。`canvas2d` 与 `webgpu` 都用它落点。 */
export function imageRectToViewport(
  natural: Size,
  view: ViewTransform,
  viewport: Size,
  rect: Rect,
): Rect {
  const sx = viewport.width / 2 + view.offset.x + (rect.x - natural.width / 2) * view.zoom;
  const sy = viewport.height / 2 + view.offset.y + (rect.y - natural.height / 2) * view.zoom;
  return { x: sx, y: sy, width: rect.width * view.zoom, height: rect.height * view.zoom };
}

/**
 * 视口内可见（含 `margin` 外扩）的块索引，**行主序升序、不重复**。
 *
 * `margin` 是**舞台像素**（不是图像像素）：外扩半屏是为了让滚动/缩放时下一屏已经在传，
 * 用舞台像素表达才能与「屏幕外多远开始预取」这一个直觉量对齐。
 */
export function visibleTiles(
  grid: TileGrid,
  natural: Size,
  view: ViewTransform,
  viewport: Size,
  margin = 0,
): number[] {
  if (grid.cols <= 0 || grid.rows <= 0 || !(view.zoom > 0)) return [];
  const pad = Math.max(0, margin);
  const visible = viewportImageRect(natural, view, viewport);
  const expanded = {
    x: visible.x - pad / view.zoom,
    y: visible.y - pad / view.zoom,
    width: visible.width + (2 * pad) / view.zoom,
    height: visible.height + (2 * pad) / view.zoom,
  };
  if (expanded.width <= 0 || expanded.height <= 0) return [];
  const firstCol = Math.max(0, Math.floor(expanded.x / grid.tile));
  const lastCol = Math.min(grid.cols - 1, Math.ceil((expanded.x + expanded.width) / grid.tile) - 1);
  const firstRow = Math.max(0, Math.floor(expanded.y / grid.tile));
  const lastRow = Math.min(grid.rows - 1, Math.ceil((expanded.y + expanded.height) / grid.tile) - 1);
  const out: number[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) out.push(row * grid.cols + col);
  }
  return out;
}

/**
 * LOD1 是否该上场（滞回，RFC §6.4）。
 *
 * `ratio = 全分辨率密度 / LOD0 密度`：> 1.15 才进、< 0.85 才出。
 * 两条阈值分开是为了挡住「缩放停在阈值上时来回切档」的抖动；同一条阈值进出必然闪。
 */
export function nextLod1State(current: boolean, ratio: number): boolean {
  if (!Number.isFinite(ratio)) return current;
  if (current) return ratio >= LOD1_EXIT_RATIO;
  return ratio > LOD1_ENTER_RATIO;
}

/** 全分辨率相对 LOD0 的采样密度比（`1` = 一个 LOD0 纹素正好铺一个物理像素）。 */
export function lod1DensityRatio(natural: Size, zoom: number, dpr: number): number {
  const longSide = Math.max(natural.width, natural.height);
  if (!(longSide > 0) || !Number.isFinite(zoom) || !Number.isFinite(dpr)) {
    return Number.POSITIVE_INFINITY;
  }
  // LOD0 档把长边缩到 1280（原图更小时不缩）：一个 LOD0 纹素撑起多少个物理像素。
  const lod0LongSide = Math.min(LOD0_BUCKET_PX, longSide);
  return (zoom * dpr * longSide) / lod0LongSide;
}

/** 一块 `tilePx²` 的 RGBA 纹理占多少字节（`rgba8unorm` = 4 B/像素）。 */
export function tileBytes(tilePx: number): number {
  const tile = Math.max(1, Math.floor(tilePx));
  return tile * tile * 4;
}

/**
 * 每帧最多传几块（预算换算，RFC §6.3）：32 MiB / 4 MiB = 8 块。
 *
 * 至少 1 块：预算被设到极小也要有进展，否则视口内的块永远传不上去（等于坏掉）。
 */
export function tilesPerFrame(uploadBudgetBytes: number, tilePx: number): number {
  const budget = Math.max(0, uploadBudgetBytes);
  return Math.max(1, Math.floor(budget / tileBytes(tilePx)));
}

/** 两个矩形求交（无交集返回 0 尺寸，调用方据此跳过绘制）。 */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (!(right > x) || !(bottom > y)) return { x, y, width: 0, height: 0 };
  return { x, y, width: right - x, height: bottom - y };
}
