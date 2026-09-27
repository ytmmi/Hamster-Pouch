/**
 * 蓝图节点画布（ComfyUI 风格，RFC 0007 决策 7 / D31）。
 *
 * 深色画布 + 点阵网格；节点为圆角卡片、按类型着色头部，正文展示关键字段摘要；
 * 输入端口在左、输出端口在右；从输出端口拖拽到兼容输入端口建立边，
 * **边类型按端口自动判定**（contains / memberOf / fires / guards）；边以 SVG
 * 贝塞尔曲线绘制并按类型着色。支持节点拖拽摆放（落库 `position {x,y}`）、
 * 画布平移（拖空白）与缩放（滚轮）。
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  BlueprintEdge,
  BlueprintGraph,
  BlueprintNode,
  BlueprintNodeType,
} from "@hamster-pouch/config";
import { nodeLayerKey } from "@hamster-pouch/config";
import type { Translate, TranslationKey } from "../i18n";
import {
  kindForEdge,
  portIdFor,
  portLabel,
  PORT_DEFS,
  type PortDef,
} from "./blueprintPorts";
// 节点显示名/摘要等**本地化文案**由纯模块 `blueprintLabels` 承载（画布与属性面板共用）。
import { nodeDisplayName, nodeSummary, nodeTypeLabel } from "./blueprintLabels";
import {
  sampleEdgeCurve,
  segmentHitsPolyline,
  segmentHitsRect,
  viewportCenterToWorld,
  type Point,
} from "./blueprintGeometry";

/** 节点类型 → 头部颜色（ComfyUI 风格高对比色板）。 */
export const NODE_TYPE_COLORS: Record<BlueprintNodeType, string> = {
  interface: "#7f8cff",
  layout_block: "#b085f5",
  overlay: "#8fd0c0",
  control: "#4a90d9",
  class: "#6bbf59",
  object: "#d9b45b",
  group: "#c98bdb",
  event: "#e0655a",
  condition: "#e2a94f",
  action: "#5ab0c9",
};

/** 边类型 → 颜色。 */
export const EDGE_COLORS: Record<BlueprintEdge["kind"], string> = {
  contains: "#9aa0a6",
  memberOf: "#c98bdb",
  on: "#7ec3ff",
  fires: "#e0655a",
  guards: "#e2a94f",
};

/** 节点世界坐标（缺失时回退 0,0；加载时由面板统一补齐）。 */
function nodePos(node: BlueprintNode): { x: number; y: number } {
  return node.position ?? { x: 0, y: 0 };
}

export interface BlueprintCanvasProps {
  doc: BlueprintGraph;
  onChange: (doc: BlueprintGraph) => void;
  /** 节点拖拽结束/一键整理后，由面板持久化位置（保存整个文档）。 */
  onPersist?: (doc: BlueprintGraph) => void;
  /** 删除节点（Delete/Backspace 键或刀痕划中触发；面板负责软删除）。 */
  onRemoveNode?: (key: string) => void;
  /** 删除一条边（刀痕划过连线后放开触发）。 */
  onRemoveEdge?: (index: number) => void;
  /**
   * 建立连线后的回调：面板据此把**子节点的引用字段自动落好**
   * （控件→类 写 `class.control`；类→对象 写 `object.class`；对象→操作 写 `event.target`…），
   * 用户不需要手填这些 key。
   */
  onConnect?: (edge: { from: string; to: string; kind: BlueprintEdge["kind"] }) => void;
  /**
   * 画布视口（**渲染出来的可见区域**）中心的世界坐标：新增节点应落在这里，
   * 而不是隐藏的世界原点。
   */
  onViewCenterChange?: (world: Point) => void;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** 未接通节点 key（画布灰显"不通"；由面板用 `blueprintLint` 计算）。 */
  unlinked?: ReadonlySet<string>;
  /**
   * 当前渲染的层（D51：画布同一时刻只画**一个层**）。缺省渲染整个文档
   * （兼容单层兜底文档；编辑器始终传入当前层）。
   */
  layerKey?: string | null;
  t: Translate;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

/** 刀痕命中容差（画布本地像素）：线段到连线的容许距离。 */
const BLADE_HIT_TOLERANCE = 10;

/** 节点卡片近似尺寸（刀痕命中用；与样式中的卡片尺寸一致）。 */
const NODE_CARD = { w: 216, h: 110 };

/** 刀痕状态：起点固定为右键按下处，终点跟随指针（**直线**）。 */
interface BladeState {
  from: Point;
  to: Point;
  /** 当前扫中的连线索引 / 节点 key（跟随指针即时重算，移开即取消）。 */
  edges: number[];
  nodes: string[];
}

/** 节点画布（纯展示与交互，数据变更通过 onChange 上抛）。 */
export function BlueprintCanvas({
  doc,
  onChange,
  onPersist,
  onRemoveNode,
  onRemoveEdge,
  onConnect,
  onViewCenterChange,
  selectedKey,
  onSelect,
  unlinked,
  layerKey,
  t,
}: BlueprintCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [tempEdge, setTempEdge] = useState<{
    fromKey: string;
    fromPort: string;
    x: number;
    y: number;
  } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  /** 刀痕状态：右键长按拖拽（起点固定，终点跟随指针的**直线**删除线）。 */
  const [blade, setBlade] = useState<BladeState | null>(null);
  const [, setTick] = useState(0);
  const portMap = useRef<Map<string, { x: number; y: number }>>(new Map());
  /** 最近一次节点拖拽计算出的文档（拖拽结束用于持久化位置）。 */
  const lastDragDoc = useRef<BlueprintGraph | null>(null);
  const dragRef = useRef<
    | { kind: "node"; key: string; offX: number; offY: number }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
    | { kind: "blade" }
    | null
  >(null);

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  /**
   * 层内可见节点/边（D51：画布同一时刻只渲染一个层）。
   *
   * 边不带 `layer`，其归属由**端点**推导；这里保留边在 `doc.edges` 中的**原始下标**，
   * 因为删除边（刀痕）按整文档下标回调给面板。
   */
  const visibleNodes = useMemo(
    () =>
      layerKey ? doc.nodes.filter((n) => nodeLayerKey(doc, n) === layerKey) : doc.nodes,
    [doc, layerKey],
  );
  const visibleEdges = useMemo(() => {
    const indexed = doc.edges.map((edge, index) => ({ edge, index }));
    if (!layerKey) {
      return indexed;
    }
    const keys = new Set(visibleNodes.map((n) => n.key));
    return indexed.filter(({ edge }) => keys.has(edge.from) && keys.has(edge.to));
  }, [doc.edges, layerKey, visibleNodes]);

  /** 节点按 key 索引：边渲染时按端点类型推导端口 id（避免每帧线性查找文档）。 */
  const byKey = useMemo(() => new Map(doc.nodes.map((n) => [n.key, n])), [doc.nodes]);

  /**
   * 一条边某侧的端口坐标（`portMap` 里查不到 = `undefined`）。
   *
   * **必须与画布渲染的端口标记一致**（`${key}::${side}::${PORT_DEFS 里的 id}`）：
   * 连线绘制、刀痕命中判定都走这一个函数，避免两处各推一次导致"数据里有边、画布上没线"。
   */
  const portPointFor = useCallback(
    (edge: BlueprintEdge, side: "in" | "out"): { x: number; y: number } | undefined => {
      const key = side === "in" ? edge.to : edge.from;
      const type = byKey.get(key)?.type;
      if (!type) {
        return undefined;
      }
      const portId = portIdFor(type, side, edge.kind);
      return portId ? portMap.current.get(`${key}::${side}::${portId}`) : undefined;
    },
    [byKey],
  );

  const toWorld = useCallback(
    (local: { x: number; y: number }) => ({
      x: (local.x - view.x) / view.zoom,
      y: (local.y - view.y) / view.zoom,
    }),
    [view],
  );

  /** 测量全部端口在画布局部坐标系中的位置（含变换后的最终位置）。 */
  const measurePorts = useCallback(() => {
    const vp = canvasRef.current;
    if (!vp) {
      return;
    }
    const rect = vp.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    vp.querySelectorAll<HTMLElement>("[data-port]").forEach((el) => {
      const id = el.dataset.port;
      if (!id) {
        return;
      }
      const r = el.getBoundingClientRect();
      next.set(id, {
        x: r.left - rect.left + r.width / 2,
        y: r.top - rect.top + r.height / 2,
      });
    });
    portMap.current = next;
    setTick((n) => n + 1);
  }, []);

  useLayoutEffect(() => {
    measurePorts();
  }, [doc, view, selectedKey, measurePorts]);

  /**
   * 上报**渲染画布**的视口中心（世界坐标）：新增节点据此落在当前可见区域中间，
   * 而不是世界原点/隐藏区域。容器尺寸变化与平移缩放都会重新上报。
   */
  const reportViewCenter = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !onViewCenterChange) {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    onViewCenterChange(
      viewportCenterToWorld({ width: rect.width, height: rect.height }, view),
    );
  }, [onViewCenterChange, view]);

  useLayoutEffect(() => {
    reportViewCenter();
  }, [reportViewCenter]);

  // 容器尺寸变化时重测端口。
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const obs = new ResizeObserver(() => {
      measurePorts();
      reportViewCenter();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [measurePorts, reportViewCenter]);

  const edgePath = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    },
    [],
  );

  /**
   * 计算刀痕（直线段 from→to）当前扫中的边与节点。
   * 每次指针移动重算，因此**移开即取消**；边按端口连线的贝塞尔采样折线判定，
   * 节点按卡片矩形判定。
   */
  const bladeHits = useCallback(
    (from: Point, to: Point) => {
      const edges: number[] = [];
      // 只对**层内可见**的边/节点判定（不可见的元素不该被刀痕删掉）。
      visibleEdges.forEach(({ edge, index }) => {
        const a = portPointFor(edge, "out");
        const b = portPointFor(edge, "in");
        if (!a || !b) {
          return;
        }
        if (segmentHitsPolyline(from, to, sampleEdgeCurve(a, b), BLADE_HIT_TOLERANCE)) {
          edges.push(index);
        }
      });

      const nodes: string[] = [];
      for (const node of visibleNodes) {
        const pos = nodePos(node);
        // 刀痕在视口坐标、节点在世界坐标：把节点矩形换算到视口坐标后再判交。
        const screenRect = {
          x: view.x + pos.x * view.zoom,
          y: view.y + pos.y * view.zoom,
          w: NODE_CARD.w * view.zoom,
          h: NODE_CARD.h * view.zoom,
        };
        if (segmentHitsRect(from, to, screenRect)) {
          nodes.push(node.key);
        }
      }
      return { edges, nodes };
    },
    [visibleEdges, visibleNodes, doc.nodes, view],
  );

  /** 画布级指针按下：右键=刀痕删除，左键=端口连线 / 节点拖动 / 画布平移。 */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 确保画布获得焦点，Delete/Backspace 键可删除选中节点/边。
    canvasRef.current?.focus();
    const target = e.target as HTMLElement;
    const local = toLocal(e.clientX, e.clientY);
    const nodeKey = target.closest("[data-node]")?.getAttribute("data-node");
    const port = target.closest("[data-port]")?.getAttribute("data-port");

    // 中键按住：平移画布（与空白处左键拖动同效，且不受节点/连线位置影响）。
    if (e.button === 1) {
      e.preventDefault();
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        viewX: view.x,
        viewY: view.y,
      };
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    // 右键长按：刀痕删除（起点固定、终点跟随指针，穿过连线/节点即标红，放开即删）。
    if (e.button === 2) {
      e.preventDefault();
      dragRef.current = { kind: "blade" };
      const hits = bladeHits(local, local);
      setBlade({ from: local, to: local, edges: hits.edges, nodes: hits.nodes });
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (port) {
      const [key, side, portId] = port.split("::");
      if (side === "out") {
        setTempEdge({ fromKey: key, fromPort: portId, x: local.x, y: local.y });
        dragRef.current = null;
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      return;
    }
    if (nodeKey) {
      const node = doc.nodes.find((n) => n.key === nodeKey);
      if (!node) {
        return;
      }
      const wp = toWorld(local);
      const pos = nodePos(node);
      dragRef.current = {
        kind: "node",
        key: nodeKey,
        offX: wp.x - pos.x,
        offY: wp.y - pos.y,
      };
      onSelect(nodeKey);
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    // 空白：平移 + 取消选中
    dragRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
    onSelect(null);
    setSelectedEdge(null);
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const local = toLocal(e.clientX, e.clientY);
    if (tempEdge) {
      setTempEdge((prev) => (prev ? { ...prev, x: local.x, y: local.y } : prev));
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    if (drag.kind === "blade") {
      setBlade((prev) => {
        if (!prev) {
          return prev;
        }
        // 每次移动**重算**命中：指针移开就取消标记（不是留下轨迹）。
        const hits = bladeHits(prev.from, local);
        return { from: prev.from, to: local, edges: hits.edges, nodes: hits.nodes };
      });
      return;
    }
    if (drag.kind === "node") {
      const wp = toWorld(local);
      const next = {
        x: Math.round(wp.x - drag.offX),
        y: Math.round(wp.y - drag.offY),
      };
      const nextDoc: BlueprintGraph = {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.key === drag.key ? { ...n, position: next } : n,
        ),
      };
      lastDragDoc.current = nextDoc;
      onChange(nextDoc);
    } else if (drag.kind === "pan") {
      setView({
        ...view,
        x: drag.viewX + (e.clientX - drag.startX),
        y: drag.viewY + (e.clientY - drag.startY),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    // 刀痕放开：删除划中的边与节点（节点为软删除，关联节点保留并灰显）。
    if (dragRef.current?.kind === "blade") {
      const hits = blade;
      dragRef.current = null;
      setBlade(null);
      if (hits) {
        // 先删边再删节点：节点删除会移除其关联边，避免索引错位。
        for (const index of [...hits.edges].sort((a, b) => b - a)) {
          onRemoveEdge?.(index);
        }
        for (const key of hits.nodes) {
          onRemoveNode?.(key);
        }
      }
      return;
    }
    if (tempEdge) {
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-port]");
      const portId = target?.getAttribute("data-port");
      if (portId) {
        const [toKey, side, inPort] = portId.split("::");
        if (side === "in" && toKey !== tempEdge.fromKey) {
          const fromNode = doc.nodes.find((n) => n.key === tempEdge.fromKey);
          const toNode = doc.nodes.find((n) => n.key === toKey);
          // 落点必须是**该节点声明的输入口**：这里只校验"这个输入口属于它"，
          // 不再限定 `contains`——规则边（on/fires/guards）的落点是操作/条件的输入口，
          // 早前用 `portIdFor(toType,"in","contains")` 比对，导致拖到「操作」的输入口
          // 永远判不等（真实缺陷："操作节点接不到触发节点"）。
          const isInputPort =
            !!toNode &&
            PORT_DEFS[toNode.type].some((p) => p.side === "in" && p.id === inPort);
          if (fromNode && toNode && isInputPort) {
            const kind = kindForEdge(
              fromNode.type,
              tempEdge.fromPort,
              toNode.type,
            );
            if (
              kind &&
              !doc.edges.some(
                (ed) => ed.from === tempEdge.fromKey && ed.to === toKey && ed.kind === kind,
              )
            ) {
              const order =
                Math.max(0, ...doc.edges.map((ed) => ed.order)) + 1;
              const created = { from: tempEdge.fromKey, to: toKey, kind, order };
              onChange({
                ...doc,
                edges: [...doc.edges, created],
              });
              // 连线同时把子节点的引用落好（用户不必手填 key）。
              onConnect?.(created);
            }
          }
        }
      }
      setTempEdge(null);
      return;
    }
    // 节点拖拽结束：位置已变更，持久化（保存文档，用户无需手动保存）。
    const drag = dragRef.current;
    if (drag?.kind === "node") {
      const settled = lastDragDoc.current;
      lastDragDoc.current = null;
      if (settled && onPersist) {
        onPersist(settled);
      }
    }
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const local = toLocal(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const k = zoom / v.zoom;
      return {
        zoom,
        x: local.x - (local.x - v.x) * k,
        y: local.y - (local.y - v.y) * k,
      };
    });
  };

  /** 删除选中的边（Delete/Backspace 键）。 */
  const removeSelectedEdge = useCallback(() => {
    if (selectedEdge === null) {
      return;
    }
    const idx = selectedEdge;
    onChange({ ...doc, edges: doc.edges.filter((_, i) => i !== idx) });
    setSelectedEdge(null);
  }, [selectedEdge, doc, onChange]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // 优先删除选中的边；无选边时删除选中的节点。
      if (selectedEdge !== null) {
        removeSelectedEdge();
      } else if (selectedKey) {
        onRemoveNode?.(selectedKey);
      }
    }
  };

  const ports = useRef(new Map<string, PortDef[]>());
  const nodePorts = (node: BlueprintNode) => {
    const key = node.key;
    if (!ports.current.has(key)) {
      ports.current.set(key, PORT_DEFS[node.type]);
    }
    return ports.current.get(key)!;
  };

  const tempFrom = tempEdge
    ? portMap.current.get(`${tempEdge.fromKey}::out::${tempEdge.fromPort}`)
    : null;

  return (
    <div
      ref={canvasRef}
      className="bp-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      onAuxClick={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        // 中键：阻止浏览器进入自动滚动模式（否则平移时会弹出滚动光标）。
        if (e.button === 1) {
          e.preventDefault();
        }
      }}
      tabIndex={0}
    >
      {/* 变换层：节点（世界坐标） */}
      <div
        className="bp-canvas-world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
      >
        {visibleNodes.map((node) => {
          const pos = nodePos(node);
          const ins = nodePorts(node).filter((p) => p.side === "in");
          const outs = nodePorts(node).filter((p) => p.side === "out");
          const isUnlinked = unlinked?.has(node.key) ?? false;
          const bladed = blade?.nodes.includes(node.key) ?? false;
          return (
            <div
              key={node.key}
              data-node={node.key}
              className={`bp-node ${selectedKey === node.key ? "selected" : ""} ${
                isUnlinked ? "unlinked" : ""
              } ${bladed ? "bladed" : ""}`}
              style={{ left: pos.x, top: pos.y }}
            >
              <div
                className="bp-node-header"
                style={{
                  background: isUnlinked ? "#6b7280" : NODE_TYPE_COLORS[node.type],
                }}
              >
                <span className="bp-node-key" title={node.key}>
                  {nodeDisplayName(node, t, doc.nodes, doc.layers)}
                </span>
                <span className="bp-node-type">
                  {isUnlinked && <span className="bp-node-flag">{t("blueprint.unlinkedTag")}</span>}
                  {nodeTypeLabel(node.type, t)}
                </span>
              </div>
              <div className="bp-node-body">{nodeSummary(node, t, doc)}</div>
              <div className="bp-node-ports">
                <div className="bp-ports-in">
                  {ins.map((p) => (
                    <div className="bp-port-row" key={`in:${p.id}`}>
                      <span
                        className="bp-port bp-port-in"
                        data-port={`${node.key}::in::${p.id}`}
                      />
                      <span className="bp-port-label">
                        {portLabel(node.type, p.id, t)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="bp-ports-out">
                  {outs.map((p) => (
                    <div className="bp-port-row right" key={`out:${p.id}`}>
                      <span className="bp-port-label">
                        {portLabel(node.type, p.id, t)}
                      </span>
                      <span
                        className="bp-port bp-port-out"
                        data-port={`${node.key}::out::${p.id}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 边层（**画布坐标系**，不随世界变换）：端口位置由 `measurePorts` 按
          `getBoundingClientRect()` 量出，已经是"画布局部坐标"，所以这一层必须是
          `.bp-canvas` 的直接子级——放进 `.bp-canvas-world` 会被二次变换，且那个容器
          自身尺寸为 0（节点都是绝对定位），`inset:0` 的 SVG 拿到 0×0 盒子把连线裁没。 */}
      <svg className="bp-edges">
        {visibleEdges.map(({ edge, index: i }) => {
          const a = portPointFor(edge, "out");
          const b = portPointFor(edge, "in");
          if (!a || !b) {
            return null;
          }
          return (
            <path
              key={i}
              d={edgePath(a, b)}
              data-edge={i}
              className={`bp-edge ${selectedEdge === i ? "selected" : ""} ${
                blade?.edges.includes(i) ? "bladed" : ""
              }`}
              stroke={blade?.edges.includes(i) ? "#ff4d4f" : EDGE_COLORS[edge.kind]}
              onPointerDown={(ev) => {
                ev.stopPropagation();
                setSelectedEdge(i);
              }}
            />
          );
        })}
        {tempFrom && tempEdge && (
          <path
            className="bp-edge temp"
            d={edgePath(tempFrom, { x: tempEdge.x, y: tempEdge.y })}
            stroke="#ffffff"
          />
        )}
        {/* 刀痕：**直线**，起点为右键按下处（刀头），终点跟随指针（刀尾）。 */}
        {blade && (
          <g className="bp-blade">
            <line
              x1={blade.from.x}
              y1={blade.from.y}
              x2={blade.to.x}
              y2={blade.to.y}
              className="bp-blade-glow"
              strokeWidth={14}
            />
            <line
              x1={blade.from.x}
              y1={blade.from.y}
              x2={blade.to.x}
              y2={blade.to.y}
              className="bp-blade-core"
              strokeWidth={3}
            />
            {/* 刀头：右键按下处（固定） */}
            <circle cx={blade.from.x} cy={blade.from.y} r={6} className="bp-blade-head" />
            <circle cx={blade.from.x} cy={blade.from.y} r={14} className="bp-blade-head-glow" />
            {/* 刀尾：跟随指针 */}
            <circle cx={blade.to.x} cy={blade.to.y} r={3.5} className="bp-blade-tail" />
          </g>
        )}
      </svg>

      {/* 图例（多语言） */}
      <div className="bp-legend">
        {(Object.keys(EDGE_COLORS) as BlueprintEdge["kind"][]).map((k) => (
          <span key={k} className="bp-legend-item">
            <i style={{ background: EDGE_COLORS[k] }} />
            {t(`blueprint.port.${k}` as TranslationKey)}
          </span>
        ))}
        <span className="bp-legend-item bp-legend-hint">{t("blueprint.bladeHint")}</span>
        <span className="bp-legend-item bp-legend-hint">{t("blueprint.panHint")}</span>
      </div>
    </div>
  );
}
