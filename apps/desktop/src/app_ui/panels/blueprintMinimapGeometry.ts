/**
 * 蓝图小地图（minimap）几何（RFC 0007 编辑器）。
 *
 * 画布右下角的小地图把**当前层的整张图**缩略成一个小框：节点按类型色画成小矩形、
 * 连线画成细线，并叠一个矩形表示**当前视口**。拖动小地图 = 把画布视口中心移到该处。
 *
 * 这里是纯函数（世界坐标 ↔ 小地图坐标、内容包围盒、视口世界矩形），便于脱离宿主验证
 * （见 tools/blueprint-minimap-check.mjs）。
 */

import type { BlueprintNode } from "@hamster-pouch/config";

import type { Point, RectBox } from "./blueprintGeometry";

/** 小地图框尺寸（画布右下角；CSS 里 `--bp-minimap-w/h` 与此一致）。 */
export const MINIMAP_SIZE = { width: 176, height: 120 };

/** 内边距：内容与框边留出空隙（同时给小地图一点"呼吸感"）。 */
export const MINIMAP_PADDING = 6;

/** 节点卡片近似尺寸（与画布 `.bp-node` 一致；小地图按同一占位画矩形）。 */
export const MINIMAP_CARD = { w: 216, h: 110 };

/** 世界坐标 → 小地图坐标的仿射变换（等比缩放 + 平移）。 */
export interface MiniMapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 单个节点在世界坐标里的近似占位（缺 `position` 时按原点）。 */
export function nodeWorldBox(node: BlueprintNode): RectBox {
  const p = node.position ?? { x: 0, y: 0 };
  return { x: p.x, y: p.y, w: MINIMAP_CARD.w, h: MINIMAP_CARD.h };
}

/** 若干矩形的最小包围盒；没有矩形时返回 `null`（空图不画内容）。 */
export function contentBounds(...groups: RectBox[][]): RectBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const group of groups) {
    for (const r of group) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * 把内容包围盒等比装进小地图框（居中）。
 *
 * `scale` 上限为 1：单个节点/极小图**不会**被放大到铺满整框——小地图只缩小不放大，
 * 这样"小地图里的大小"始终能反映真实相对尺度。
 */
export function fitBounds(
  bounds: RectBox,
  box: { width: number; height: number } = MINIMAP_SIZE,
  padding = MINIMAP_PADDING,
): MiniMapTransform {
  const innerW = Math.max(1, box.width - padding * 2);
  const innerH = Math.max(1, box.height - padding * 2);
  const w = Math.max(1, bounds.w);
  const h = Math.max(1, bounds.h);
  const scale = Math.min(innerW / w, innerH / h, 1);
  return {
    scale,
    offsetX: padding + (innerW - w * scale) / 2 - bounds.x * scale,
    offsetY: padding + (innerH - h * scale) / 2 - bounds.y * scale,
  };
}

/** 世界坐标 → 小地图坐标。 */
export function worldToMini(p: Point, t: MiniMapTransform): Point {
  return { x: p.x * t.scale + t.offsetX, y: p.y * t.scale + t.offsetY };
}

/** 小地图坐标 → 世界坐标（拖动小地图时把落点反解成画布中心）。 */
export function miniToWorld(p: Point, t: MiniMapTransform): Point {
  return { x: (p.x - t.offsetX) / t.scale, y: (p.y - t.offsetY) / t.scale };
}

/** 世界矩形 → 小地图矩形。 */
export function worldRectToMini(rect: RectBox, t: MiniMapTransform): RectBox {
  const a = worldToMini({ x: rect.x, y: rect.y }, t);
  return { x: a.x, y: a.y, w: rect.w * t.scale, h: rect.h * t.scale };
}

/** 当前画布**可见区域**的世界矩形（视口四角反解）。 */
export function viewportWorldRect(
  viewport: { width: number; height: number },
  view: { x: number; y: number; zoom: number },
): RectBox {
  const zoom = view.zoom || 1;
  return {
    x: -view.x / zoom,
    y: -view.y / zoom,
    w: Math.max(0, viewport.width) / zoom,
    h: Math.max(0, viewport.height) / zoom,
  };
}

/** 小地图内容矩形（节点 + 视口）的完整布局：一次算好，供组件直接画。 */
export interface MiniMapLayout {
  transform: MiniMapTransform;
  /** 每个节点的小地图矩形（与入参同序）。 */
  nodeRects: RectBox[];
  /** 当前视口矩形（小地图坐标）。 */
  viewportRect: RectBox;
}

/**
 * 计算小地图布局：包围盒**同时包含节点与当前视口**，因此视口指示框永远可见
 * （平移到空白处时也不会跑出小地图外）。
 */
export function minimapLayout(
  nodes: BlueprintNode[],
  viewport: { width: number; height: number },
  view: { x: number; y: number; zoom: number },
  box: { width: number; height: number } = MINIMAP_SIZE,
): MiniMapLayout {
  const nodeBoxes = nodes.map(nodeWorldBox);
  const vp = viewportWorldRect(viewport, view);
  const bounds = contentBounds(nodeBoxes, [vp]) ?? { x: 0, y: 0, w: 1, h: 1 };
  const transform = fitBounds(bounds, box);
  return {
    transform,
    nodeRects: nodeBoxes.map((r) => worldRectToMini(r, transform)),
    viewportRect: worldRectToMini(vp, transform),
  };
}
