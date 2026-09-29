/**
 * 图像查看器：导航器**四角**、胶片栏**四边**与缩放中心点的**取值域与纯函数**。
 *
 * 本文件**无框架依赖**（不 import React / Tauri），因此：
 * 1. 面板组件只消费这里的判定函数，不自己写 `if (pos === "left")` 之类的散落分支；
 * 2. 门禁 `pnpm check:panels` 可**直接导入**它，断言面板声明里的 `select` 候选
 *    与本文件的枚举逐项一致（声明与实现漂移会被当场拦下）。
 *
 * 取值域与 `packages/config/src/panels.ts` 的 `imageviewer.settings` 一一对应，
 * 也镜像到 `crates/hp-core/src/setting_registry.rs` 的 `PANEL_SETTING_DECLS`。
 */

/** 导航器停靠的**四角**（缺省右下角）。 */
export const NAVIGATOR_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type NavigatorCorner = (typeof NAVIGATOR_CORNERS)[number];

/** 胶片栏停靠的**四边**（缺省右边）。 */
export const FILMSTRIP_EDGES = ["left", "right", "top", "bottom"] as const;
export type FilmstripEdge = (typeof FILMSTRIP_EDGES)[number];

/**
 * 胶片栏尺寸（px）的取值范围与兜底值。
 *
 * **一个数值两用**（用户口径）：停靠左右边时它是**宽**，停靠上下边时它是**高**——
 * 即"胶片栏厚度"。因此只有一项设置（`imageviewer.settings.filmstripSize`），
 * 数值在这里夹紧：设置项是通用 `numberInput`（声明层没有 min/max 字段），
 * 任由用户输入 0 或 100000 会把面板布局压塌，夹紧是**面板的**责任。
 */
export const FILMSTRIP_SIZE_MIN = 40;
export const FILMSTRIP_SIZE_MAX = 400;
export const FILMSTRIP_SIZE_FALLBACK = 76;

/** 夹紧胶片栏尺寸（非数值/非法值回落兜底值；四舍五入到整像素）。 */
export function clampFilmstripSize(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return FILMSTRIP_SIZE_FALLBACK;
  return Math.min(FILMSTRIP_SIZE_MAX, Math.max(FILMSTRIP_SIZE_MIN, Math.round(num)));
}

/**
 * 滚轮缩放的**中心点**：
 * - `pointer`：以**指针位置**为中心（缺省）——指针下的像素在缩放前后保持不动；
 * - `center`：以**舞台中心**（≈ 图像显示区域中心）为中心。
 */
export const ZOOM_ANCHORS = ["pointer", "center"] as const;
export type ZoomAnchor = (typeof ZOOM_ANCHORS)[number];

/**
 * 胶片栏**视图**：
 * - `adaptive`（缺省，自适应）：缩略图按**图像自身宽高比**完整显示（不裁剪、不留黑边），
 *   主尺寸随每张图变化；
 * - `tile`（平铺）：缩略图统一为**方形**并裁剪填满（`cover`），排成整齐的一列/一行。
 */
export const FILMSTRIP_VIEWS = ["adaptive", "tile"] as const;
export type FilmstripView = (typeof FILMSTRIP_VIEWS)[number];

export function isFilmstripView(value: unknown): value is FilmstripView {
  return typeof value === "string" && (FILMSTRIP_VIEWS as readonly string[]).includes(value);
}

export function isNavigatorCorner(value: unknown): value is NavigatorCorner {
  return typeof value === "string" && (NAVIGATOR_CORNERS as readonly string[]).includes(value);
}

export function isFilmstripEdge(value: unknown): value is FilmstripEdge {
  return typeof value === "string" && (FILMSTRIP_EDGES as readonly string[]).includes(value);
}

export function isZoomAnchor(value: unknown): value is ZoomAnchor {
  return typeof value === "string" && (ZOOM_ANCHORS as readonly string[]).includes(value);
}

/** 导航器的 CSS 定位类（四角；样式表 `.iv-nav-top-left` 等与之同名）。 */
export function navigatorCornerClass(corner: NavigatorCorner): string {
  return `iv-nav-${corner}`;
}

/** 胶片栏的 CSS 定位类（四边；样式表 `.iv-film-left` 等与之同名）。 */
export function filmstripEdgeClass(edge: FilmstripEdge): string {
  return `iv-film-${edge}`;
}

/** 胶片栏主轴是否为**纵向**（左右边为纵向，上下边为横向）。 */
export function isFilmstripVertical(edge: FilmstripEdge): boolean {
  return edge === "left" || edge === "right";
}

/**
 * 序列内相对移动（图像查看器的上一张/下一张）。
 *
 * 越界**不环绕**（到头就停在原处），与"相册/源顺序即浏览顺序"的直觉一致；
 * 空序列或非法下标返回 `-1`（调用方据此禁用动作）。
 */
export function stepIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : total - 1;
  const next = current + delta;
  if (next < 0 || next >= total) return current;
  return next;
}
