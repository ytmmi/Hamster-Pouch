/**
 * 蓝图小地图（minimap）—— 画布右下角的缩略导航框（RFC 0007 编辑器）。
 *
 * 只做展示与指针交互，不持有图数据：入参是**当前层可见的节点/边**、画布视口尺寸与
 * 视图变换；指针按下/拖动时把落点反解成世界坐标上抛（`onFocus`），由画布把视口中心
 * 移到该处。几何全在纯模块 `blueprintMinimapGeometry` 里。
 *
 * 注意：小地图是画布的子元素，必须 `stopPropagation`——否则指针事件会冒泡到画布的
 * 平移/刀痕判定（在小地图上拖拽会变成平移画布或划线删除）。
 */

import { useCallback, useMemo, useRef } from "react";

import type { BlueprintEdge, BlueprintNode } from "@hamster-pouch/config";

import type { Translate } from "../i18n";
import type { Point } from "./blueprintGeometry";
import {
  MINIMAP_SIZE,
  minimapLayout,
  miniToWorld,
} from "./blueprintMinimapGeometry";
import { edgeColor, nodeColor } from "./blueprintNodeColors";

export interface BlueprintMinimapProps {
  /** 当前层**可见**的节点（与画布一致）。 */
  nodes: BlueprintNode[];
  /** 当前层**可见**的边（两端都在本层）。 */
  edges: BlueprintEdge[];
  /** 画布可见区域尺寸（像素）。 */
  viewport: { width: number; height: number };
  /** 画布视图变换（与 `.bp-canvas-world` 的 transform 同源）。 */
  view: { x: number; y: number; zoom: number };
  /** 未接通节点（小地图同样灰显）。 */
  unlinked?: ReadonlySet<string>;
  /** 把画布视口中心移到该世界坐标。 */
  onFocus: (world: Point) => void;
  t: Translate;
}

/** 节点在小地图里的矩形（留最小 3px 边长，避免缩放太小时看不见）。 */
const MIN_RECT = 3;

export function BlueprintMinimap({
  nodes,
  edges,
  viewport,
  view,
  unlinked,
  onFocus,
  t,
}: BlueprintMinimapProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);

  const layout = useMemo(
    () => minimapLayout(nodes, viewport, view),
    [nodes, viewport, view],
  );
  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    nodes.forEach((n, i) => map.set(n.key, i));
    return map;
  }, [nodes]);

  /** 把指针位置（相对小地图框）反解成世界坐标并上抛。 */
  const focusAt = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      const local = { x: clientX - rect.left, y: clientY - rect.top };
      onFocus(miniToWorld(local, layout.transform));
    },
    [layout.transform, onFocus],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // 画布在小地图上也有指针语义（平移/刀痕）：这里先截断，避免误触。
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = true;
    svgRef.current?.setPointerCapture(e.pointerId);
    focusAt(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) {
      return;
    }
    e.stopPropagation();
    focusAt(e.clientX, e.clientY);
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggingRef.current) {
      e.stopPropagation();
    }
    draggingRef.current = false;
  };

  /** 节点中心的世界坐标 → 小地图坐标（画连线用）。 */
  const centerOf = (i: number): Point => {
    const r = layout.nodeRects[i];
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };

  return (
    <div className="bp-minimap" title={t("blueprint.minimapHint")}>
      <svg
        ref={svgRef}
        className="bp-minimap-svg"
        width={MINIMAP_SIZE.width}
        height={MINIMAP_SIZE.height}
        viewBox={`0 0 ${MINIMAP_SIZE.width} ${MINIMAP_SIZE.height}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
      >
        <rect
          className="bp-minimap-bg"
          x={0}
          y={0}
          width={MINIMAP_SIZE.width}
          height={MINIMAP_SIZE.height}
        />
        {/* 连线（细线，按类型着色；端点取节点矩形中心） */}
        {edges.map((edge, i) => {
          const a = indexOf.get(edge.from);
          const b = indexOf.get(edge.to);
          if (a === undefined || b === undefined) {
            return null;
          }
          const p = centerOf(a);
          const q = centerOf(b);
          return (
            <line
              key={`${edge.from}->${edge.to}:${i}`}
              className="bp-minimap-edge"
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={edgeColor(edge.kind)}
            />
          );
        })}
        {/* 节点（小矩形，按类型着色；未接通灰显） */}
        {nodes.map((node, i) => {
          const r = layout.nodeRects[i];
          const w = Math.max(MIN_RECT, r.w);
          const h = Math.max(MIN_RECT, r.h);
          return (
            <rect
              key={node.key}
              className="bp-minimap-node"
              x={r.x}
              y={r.y}
              width={w}
              height={h}
              rx={2}
              fill={nodeColor(node.type, unlinked?.has(node.key) ?? false)}
            />
          );
        })}
        {/* 当前视口指示框 */}
        <rect
          className="bp-minimap-view"
          x={layout.viewportRect.x}
          y={layout.viewportRect.y}
          width={Math.max(MIN_RECT, layout.viewportRect.w)}
          height={Math.max(MIN_RECT, layout.viewportRect.h)}
        />
      </svg>
      <span className="bp-minimap-label">{t("blueprint.minimap")}</span>
    </div>
  );
}
