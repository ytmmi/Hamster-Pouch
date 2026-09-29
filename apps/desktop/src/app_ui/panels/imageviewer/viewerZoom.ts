/**
 * 图像查看器：缩放 / 平移 / 视口矩形的**纯几何**。
 *
 * 坐标系约定（全文件统一）：
 * - **舞台坐标**：以舞台（面板内的图像显示区）左上角为原点，单位 px，y 向下；
 * - **图像坐标**：以原图像素为单位，原点在图像左上角；
 * - `zoom` = **1 图像像素对应多少 CSS 像素**（`zoom = 1` 即 1:1，`zoom = 0.5` 即 50%）；
 * - `offset` = 舞台正中相对"图像居中"的位移（`{0,0}` = 图像居中，不做任何平移）。
 *
 * 无框架依赖：门禁可直接导入做断言。
 */

/** 最小/最大缩放（1 图像像素 ← → N CSS 像素）。 */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/** 舞台尺寸（px）。 */
export interface Size {
  width: number;
  height: number;
}

/** 平移量（px，舞台坐标）。 */
export interface Offset {
  x: number;
  y: number;
}

/** 一次完整的视图变换。 */
export interface ViewTransform {
  zoom: number;
  offset: Offset;
}

/** 归一化矩形（`0..1`，图像坐标系），供导航器画视口框。 */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY_TRANSFORM: ViewTransform = { zoom: 1, offset: { x: 0, y: 0 } };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 缩放夹紧（`MIN_ZOOM`..`MAX_ZOOM`；非法值按 1 处理）。 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

/** 图像按 `zoom` 缩放后的显示尺寸（px）。 */
export function scaledSize(natural: Size, zoom: number): Size {
  return { width: natural.width * zoom, height: natural.height * zoom };
}

/**
 * 「适应窗口」缩放：完整容纳图像（contain，不裁剪）。
 *
 * 大图缩到窗口内；小图**允许放大**到刚好铺满较紧的一边（这样"适应窗口"后
 * 图像总是尽可能地大）。视图一旦超出舞台即为"已放大"，导航器据此出现。
 */
export function fitZoom(natural: Size, viewport: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1;
  }
  return clampZoom(Math.min(viewport.width / natural.width, viewport.height / natural.height));
}

/**
 * 平移夹紧：图像比舞台小的那一轴**强制居中**；比舞台大的那一轴允许在
 * `±(显示尺寸 - 舞台尺寸)/2` 内移动，从而**图像边缘不会离开舞台边缘**（没有露底）。
 */
export function clampOffset(offset: Offset, scaled: Size, viewport: Size): Offset {
  const limitX = Math.max(0, (scaled.width - viewport.width) / 2);
  const limitY = Math.max(0, (scaled.height - viewport.height) / 2);
  return {
    x: clamp(offset.x, -limitX, limitX),
    y: clamp(offset.y, -limitY, limitY),
  };
}

/** 像素尺寸超出舞台（任一轴）→ 存在"需要导航"的隐藏区域。 */
export function isOverflowing(transform: ViewTransform, natural: Size, viewport: Size): boolean {
  const scaled = scaledSize(natural, transform.zoom);
  // 半像素容差：浮点误差不该让导航器在"刚好铺满"时闪现。
  const epsilon = 0.5;
  return (
    scaled.width > viewport.width + epsilon || scaled.height > viewport.height + epsilon
  );
}

/** 图像左上角在舞台坐标中的位置。 */
function imageOrigin(transform: ViewTransform, natural: Size, viewport: Size): Offset {
  const scaled = scaledSize(natural, transform.zoom);
  return {
    x: viewport.width / 2 - scaled.width / 2 + transform.offset.x,
    y: viewport.height / 2 - scaled.height / 2 + transform.offset.y,
  };
}

/**
 * 以 `anchor`（舞台坐标）为中心缩放到 `nextZoom`。
 *
 * 约束：`anchor` 下的那一点图像在缩放前后**停留在同一舞台位置**——这正是
 * 「以指针位置为中心缩放」的数学定义；传舞台中心即得「以图像中心缩放」。
 */
export function zoomAround(
  transform: ViewTransform,
  nextZoom: number,
  natural: Size,
  viewport: Size,
  anchor: Offset,
): ViewTransform {
  if (natural.width <= 0 || natural.height <= 0) {
    return { zoom: clampZoom(nextZoom), offset: { ...transform.offset } };
  }
  const zoom = clampZoom(nextZoom);
  const prevScaled = scaledSize(natural, transform.zoom);
  const origin = imageOrigin(transform, natural, viewport);
  // 锚点在图像上的归一化位置（舞台外时允许越界：夹紧由平移夹紧完成）。
  const u = prevScaled.width > 0 ? (anchor.x - origin.x) / prevScaled.width : 0.5;
  const v = prevScaled.height > 0 ? (anchor.y - origin.y) / prevScaled.height : 0.5;
  const nextScaled = scaledSize(natural, zoom);
  const offset: Offset = {
    x: anchor.x - viewport.width / 2 + nextScaled.width / 2 - u * nextScaled.width,
    y: anchor.y - viewport.height / 2 + nextScaled.height / 2 - v * nextScaled.height,
  };
  return { zoom, offset: clampOffset(offset, nextScaled, viewport) };
}

/** 舞台中心（`center` 缩放模式与"回到中心"的锚点）。 */
export function centerAnchor(viewport: Size): Offset {
  return { x: viewport.width / 2, y: viewport.height / 2 };
}

/**
 * 把图像上的归一化点 `(u, v)` 移到舞台正中（导航器点击/拖动）。
 *
 * `u` / `v` 由调用方夹紧到 `0..1`；本函数只负责换算并夹紧平移。
 */
export function centerOn(
  transform: ViewTransform,
  natural: Size,
  viewport: Size,
  u: number,
  v: number,
): ViewTransform {
  const scaled = scaledSize(natural, transform.zoom);
  const offset: Offset = {
    x: (0.5 - clamp(u, 0, 1)) * scaled.width,
    y: (0.5 - clamp(v, 0, 1)) * scaled.height,
  };
  return { zoom: transform.zoom, offset: clampOffset(offset, scaled, viewport) };
}

/** 舞台当前可见区域在图像上的归一化矩形（供导航器画视口框）。 */
export function visibleRect(
  transform: ViewTransform,
  natural: Size,
  viewport: Size,
): NormalizedRect {
  if (natural.width <= 0 || natural.height <= 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const scaled = scaledSize(natural, transform.zoom);
  const origin = imageOrigin(transform, natural, viewport);
  const x0 = clamp((0 - origin.x) / scaled.width, 0, 1);
  const x1 = clamp((viewport.width - origin.x) / scaled.width, 0, 1);
  const y0 = clamp((0 - origin.y) / scaled.height, 0, 1);
  const y1 = clamp((viewport.height - origin.y) / scaled.height, 0, 1);
  // 图像远小于舞台时可见矩形会退化成"整幅"（宽/高为 1），这是期望行为。
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/**
 * 滚轮 → 缩放倍率。
 *
 * 用指数映射（`exp(-deltaY * k)`）而不是线性加减：触控板/鼠标的 `deltaY` 量级差异极大，
 * 指数映射在两种设备上都得到"每格一步、可快可慢"的手感，且**永不为 0 或负**。
 * 单次事件仍夹在 `1/2`..`2` 之间，避免某些设备一次滚出巨大 `deltaY` 时跳变。
 */
export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  return clamp(Math.exp(-deltaY * 0.0015), 0.5, 2);
}

/** 按比例缩放（键盘/按钮的固定步进），`factor` 由调用方给定。 */
export function stepZoom(transform: ViewTransform, natural: Size, viewport: Size, factor: number): ViewTransform {
  return zoomAround(transform, transform.zoom * factor, natural, viewport, centerAnchor(viewport));
}

/** 视图是否已与"适应窗口"一致（容差 0.5%）。 */
export function isFitted(transform: ViewTransform, natural: Size, viewport: Size): boolean {
  const fit = fitZoom(natural, viewport);
  return Math.abs(transform.zoom - fit) / fit < 0.005;
}
