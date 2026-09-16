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
