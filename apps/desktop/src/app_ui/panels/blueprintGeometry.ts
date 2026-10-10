/**
 * 蓝图画布几何工具（RFC 0007 编辑器）。
 *
 * 承载刀痕命中判定（右键"划线删除"）与连线采样：从右键按下点到当前指针是一条
 * **直线**，判定这条线段扫过了哪些连线/节点。命中是**即时**的（跟随指针重算），
 * 指针移开即取消标记，放开才真正删除。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-geometry-check.mjs）。
 */

/** 画布本地坐标点。 */
export interface Point {
  x: number;
  y: number;
}

/** 矩形（左上角 + 宽高）。 */
export interface RectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 点到线段的最短距离。 */
export function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 两线段是否相交（含端点接触视为不相交，避免共线抖动误判）。 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 点是否在矩形内（含边界）。 */
export function pointInRect(p: Point, rect: RectBox): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/** 线段是否与矩形相交（端点落入，或与任一边相交）。 */
export function segmentHitsRect(a: Point, b: Point, rect: RectBox): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) {
    return true;
  }
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
  for (let i = 0; i < 4; i += 1) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) {
      return true;
    }
  }
  return false;
}

/** 线段是否穿过折线（含容差：端点靠近任一折线段也算命中）。 */
export function segmentHitsPolyline(
  a: Point,
  b: Point,
  polyline: Point[],
  tolerance: number,
): boolean {
  if (polyline.length === 0) {
    return false;
  }
  if (polyline.length === 1) {
    return pointToSegmentDistance(polyline[0], a, b) <= tolerance;
  }
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const c = polyline[i];
    const d = polyline[i + 1];
    if (segmentsIntersect(a, b, c, d)) {
      return true;
    }
    if (pointToSegmentDistance(c, a, b) <= tolerance) {
      return true;
    }
  }
  return false;
}

/** 点到折线的最小距离（空折线 = `Infinity`）。 */
export function pointToPolylineDistance(p: Point, polyline: readonly Point[]): number {
  if (polyline.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (polyline.length === 1) {
    return Math.hypot(p.x - polyline[0].x, p.y - polyline[0].y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    best = Math.min(best, pointToSegmentDistance(p, polyline[i], polyline[i + 1]));
  }
  return best;
}

/** 点到矩形的最小距离（矩形内 = 0）。 */
export function pointToRectDistance(p: Point, rect: RectBox): number {
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/**
 * 半径内**最近**的一项（无 = `null`）。
 *
 * 判据是纯几何（点距），与 DOM 命中无关：端口只有 12–14 px，靠 `elementFromPoint`
 * 要求指针精确压在那个圆点上，稍微偏到旁边的标签文字就落空（用户报的"看着能连、
 * 放开却没连上"）。改成"**半径内就近吸附**"后，手感由半径这个**可调常数**决定，
 * 而不是由 DOM 盒子的边界决定。距离相等时取列表靠前者（确定性，便于门禁断言）。
 */
export function nearestWithin<T>(
  items: readonly { point: Point; value: T }[],
  p: Point,
  maxDistance: number,
): { value: T; point: Point; distance: number } | null {
  let best: { value: T; point: Point; distance: number } | null = null;
  for (const item of items) {
    const distance = Math.hypot(item.point.x - p.x, item.point.y - p.y);
    if (distance > maxDistance) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { value: item.value, point: item.point, distance };
    }
  }
  return best;
}

/** 世界坐标 ↔ 画布局部坐标的视口参数（与画布的 `translate/scale` 同源）。 */
export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

/** 世界坐标 → 画布局部坐标（`view` 变换的正向；`toWorld` 的逆）。 */
export function worldToCanvas(p: Point, view: CanvasView): Point {
  const zoom = view.zoom || 1;
  return { x: view.x + p.x * zoom, y: view.y + p.y * zoom };
}

/** 连线端点锚点的四级候选（按**可信度**从高到低）。 */
export interface EdgeAnchorInput {
  /** ① 端口元素量出的画布局部坐标（最准：含卡片实际高度与缩放）。 */
  measured?: Point;
  /** ② 端点所在节点卡片的量出矩形（端口此刻没量到时用）。 */
  card?: RectBox;
  /** ③ 该端口**相对卡片左上角**的偏移（上一次量到时记下的）。 */
  offset?: Point;
  /** ④ 节点世界坐标（连卡片都没量到时用；未布局的画布也能画对位置）。 */
  world?: Point;
  /** 端点在哪一侧（决定卡片兜底是左沿还是右沿）。 */
  side: "in" | "out";
  view: CanvasView;
}

/**
 * 连线端点的画布坐标：**任何情况下只要节点还在画布上，就一定能算出一个点**。
 *
 * 这条是"数据里有边、画布上没线"的结构性修复：早前渲染侧只认①（`portMap` 查表），
 * 查不到就 `return null` 把整条线丢掉——而查不到的原因有很多（端口未渲染、类型无注册项、
 * 面板尚未布局量到 0、文档里的边引用了别的层的节点…），每一种都会表现成"线没了"。
 * 现在逐级回落：端口测量 → 卡片 + 端口偏移 → 卡片边沿 → 节点世界坐标。
 *
 * 四级都拿不到（节点不在文档里）才返回 `null`。
 */
export function resolveEdgeAnchor(input: EdgeAnchorInput): Point | null {
  const { measured, card, offset, world, side, view } = input;
  if (measured) {
    return measured;
  }
  if (card) {
    const edgeX = side === "in" ? card.x : card.x + card.w;
    return {
      x: offset ? card.x + offset.x : edgeX,
      y: card.y + (offset ? offset.y : card.h / 2),
    };
  }
  return world ? worldToCanvas(world, view) : null;
}

/**
 * 画布视口中心对应的世界坐标（新增节点应落在这里——**渲染出来的可见区域**中间，
 * 而不是世界原点）。
 *
 * 画布把世界坐标按 `translate(view.x, view.y) scale(zoom)` 渲染，
 * 因此视口中心 `(w/2, h/2)` 反解为世界坐标即 `((w/2 - view.x)/zoom, (h/2 - view.y)/zoom)`。
 */
export function viewportCenterToWorld(
  viewport: { width: number; height: number },
  view: { x: number; y: number; zoom: number },
): Point {
  const zoom = view.zoom || 1;
  return {
    x: (viewport.width / 2 - view.x) / zoom,
    y: (viewport.height / 2 - view.y) / zoom,
  };
}

/**
 * 把画布上的贝塞尔连线采样成折线。
 * 控制点与 `BlueprintCanvas.edgePath` 保持一致（水平外扩 `max(24, |dx|/2)`）。
 */
export function sampleEdgeCurve(a: Point, b: Point, segments = 16): Point[] {
  const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  const points: Point[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const mt = 1 - t;
    points.push({
      x: mt ** 3 * a.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * b.x,
      y: mt ** 3 * a.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * b.y,
    });
  }
  return points;
}
