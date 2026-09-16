/**
 * 蓝图节点画布（ComfyUI 风格，RFC 0007 决策 7 / D31）。
 *
 * 深色画布 + 点阵网格；节点为圆角卡片、按类型着色头部，正文展示关键字段摘要；
 * 输入端口在左、输出端口在右；从输出端口拖拽到兼容输入端口建立边，
 * **边类型按端口自动判定**（contains / memberOf / fires / guards）；边以 SVG
 * 贝塞尔曲线绘制并按类型着色。支持节点拖拽摆放（落库 `position {x,y}`）、
 * 画布平移（拖空白）与缩放（滚轮）。
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type {
  BlueprintEdge,
  BlueprintGraph,
  BlueprintNode,
  BlueprintNodeType,
} from "@hamster-pouch/config";
import type { Translate, TranslationKey } from "../i18n";

/** 节点类型 → 头部颜色（ComfyUI 风格高对比色板）。 */
export const NODE_TYPE_COLORS: Record<BlueprintNodeType, string> = {
  layout_block: "#b085f5",
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
  fires: "#e0655a",
  guards: "#e2a94f",
};

export interface PortDef {
  id: string;
  side: "in" | "out";
}

/** 每类节点的端口定义（输入在左、输出在右）；标签文案走 i18n（portLabel）。 */
const PORT_DEFS: Record<BlueprintNodeType, PortDef[]> = {
  layout_block: [{ id: "contains", side: "out" }],
  control: [
    { id: "in", side: "in" },
    { id: "contains", side: "out" },
    { id: "memberOf", side: "out" },
  ],
  class: [
    { id: "contains", side: "in" },
    { id: "contains", side: "out" },
  ],
  object: [{ id: "contains", side: "in" }],
  group: [{ id: "memberOf", side: "in" }],
  event: [{ id: "fires", side: "out" }],
  condition: [
    { id: "fires", side: "in" },
    { id: "guards", side: "out" },
  ],
  action: [{ id: "in", side: "in" }],
};

/** 端口标签（多语言）：contains/memberOf/fires/guards；action 输入口为「触发/守卫」。 */
export function portLabel(
  type: BlueprintNodeType,
  portId: string,
  t: Translate,
): string {
  if (portId === "in") {
    return type === "action"
      ? t("blueprint.port.firesGuards")
      : t("blueprint.port.contains");
  }
  return t(`blueprint.port.${portId}` as TranslationKey);
}

/** 由输出端口 → 目标节点类型推导边类型；不兼容返回 null。 */
export function kindForEdge(
  fromType: BlueprintNodeType,
  fromPort: string,
  toType: BlueprintNodeType,
): BlueprintEdge["kind"] | null {
  switch (fromPort) {
    case "contains":
      if (fromType === "layout_block" && (toType === "group" || toType === "control")) {
        return "contains";
      }
      if (fromType === "control" && toType === "class") return "contains";
      if (fromType === "class" && toType === "object") return "contains";
      return null;
    case "memberOf":
      return fromType === "control" && toType === "group" ? "memberOf" : null;
    case "fires":
      return fromType === "event" && (toType === "condition" || toType === "action")
        ? "fires"
        : null;
    case "guards":
      return fromType === "condition" && toType === "action" ? "guards" : null;
    default:
      return null;
  }
}

/** 端口在边上的 ID：输入/输出 + 类型决定。 */
function portIdFor(
  type: BlueprintNodeType,
  side: "in" | "out",
  kind: BlueprintEdge["kind"],
): string {
  if (side === "in") {
    switch (type) {
      case "control":
        return "in";
      case "class":
      case "object":
        return "contains";
      case "group":
        return "memberOf";
      case "condition":
        return "fires";
      case "action":
        return "in";
      default:
        return "";
    }
  }
  switch (type) {
    case "layout_block":
    case "control":
      return kind === "memberOf" ? "memberOf" : "contains";
    case "class":
      return "contains";
    case "event":
      return "fires";
    case "condition":
      return "guards";
    default:
      return "";
  }
}

/** 节点正文摘要（画布卡片展示关键字段；文案多语言）。 */
export function nodeSummary(node: BlueprintNode, t: Translate): string {
  switch (node.type) {
    case "layout_block":
      return `${t("blueprint.port.contains")} 组/控件`;
    case "control":
      return resolveControlTitle(node, t) || node.panel_id || "—";
    case "class":
      return node.media_type ?? "—";
    case "object":
      return `${node.class ?? "?"} · ${node.scope ?? "?"}`;
    case "group":
      return `${node.mode ?? "exclusive"}${
        node.hide_direction ? ` · ${node.hide_direction}` : ""
      }`;
    case "event":
      return `${node.trigger ?? "?"} → ${node.target ?? "?"}`;
    case "condition":
      return node.expr ?? "—";
    case "action":
      return `${node.op ?? "?"} → ${node.target ?? "?"}`;
  }
}

/** 节点世界坐标（缺失时回退 0,0；加载时由面板统一补齐）。 */
function nodePos(node: BlueprintNode): { x: number; y: number } {
  return node.position ?? { x: 0, y: 0 };
}

/**
 * 节点显示名称：用户自定义 `name` 优先；控件节点回退到本地化标签名
 * （`title_key` → 「媒体预览」等，随语言切换）；其余按类型本地化生成
 * （如 zh-CN 下「控件 1」「事件 2」）。
 */
export function nodeDisplayName(
  node: BlueprintNode,
  t: Translate,
  nodes: BlueprintNode[],
): string {
  if (node.name?.trim()) {
    return node.name.trim();
  }
  if (node.type === "control") {
    const title = resolveControlTitle(node, t);
    if (title) {
      return title;
    }
  }
  const sameType = nodes.filter((n) => n.type === node.type);
  const idx = sameType.findIndex((n) => n.key === node.key);
  return `${t(`blueprint.type.${node.type}`)} ${idx + 1}`;
}

/** 控件本地化标签名（`title_key` 解析；失败回退 `panel_id`）。 */
export function resolveControlTitle(node: BlueprintNode, t: Translate): string {
  if (node.title_key) {
    const resolved = t(node.title_key as TranslationKey);
    if (resolved && resolved !== node.title_key) {
      return resolved;
    }
  }
  return node.panel_id ?? "";
}

export interface BlueprintCanvasProps {
  doc: BlueprintGraph;
  onChange: (doc: BlueprintGraph) => void;
  /** 节点拖拽结束/一键整理后，由面板持久化位置（保存整个文档）。 */
  onPersist?: (doc: BlueprintGraph) => void;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  t: Translate;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

/** 节点画布（纯展示与交互，数据变更通过 onChange 上抛）。 */
export function BlueprintCanvas({
  doc,
  onChange,
  onPersist,
  selectedKey,
  onSelect,
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
  const [, setTick] = useState(0);
  const portMap = useRef<Map<string, { x: number; y: number }>>(new Map());
  /** 最近一次节点拖拽计算出的文档（拖拽结束用于持久化位置）。 */
  const lastDragDoc = useRef<BlueprintGraph | null>(null);
  const dragRef = useRef<
    | { kind: "node"; key: string; offX: number; offY: number }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
    | null
  >(null);

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

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

  // 容器尺寸变化时重测端口。
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const obs = new ResizeObserver(() => measurePorts());
    obs.observe(el);
    return () => obs.disconnect();
  }, [measurePorts]);

  const edgePath = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    },
    [],
  );

  /** 画布级指针按下：节点拖动 / 端口连线 / 画布平移 / 空白取消选中。 */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const local = toLocal(e.clientX, e.clientY);
    const nodeKey = target.closest("[data-node]")?.getAttribute("data-node");
    const port = target.closest("[data-port]")?.getAttribute("data-port");
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
          if (fromNode && toNode && inPort === portIdFor(toNode.type, "in", "contains")) {
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
              onChange({
                ...doc,
                edges: [
                  ...doc.edges,
                  { from: tempEdge.fromKey, to: toKey, kind, order },
                ],
              });
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
      removeSelectedEdge();
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
    ? portMap.current.get(`${tempEdge.fromKey}::out:${tempEdge.fromPort}`)
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
      tabIndex={0}
    >
      {/* 变换层：节点（世界坐标） */}
      <div
        className="bp-canvas-world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
      >
        {doc.nodes.map((node) => {
          const pos = nodePos(node);
          const ins = nodePorts(node).filter((p) => p.side === "in");
          const outs = nodePorts(node).filter((p) => p.side === "out");
          return (
            <div
              key={node.key}
              data-node={node.key}
              className={`bp-node ${selectedKey === node.key ? "selected" : ""}`}
              style={{ left: pos.x, top: pos.y }}
            >
              <div
                className="bp-node-header"
                style={{ background: NODE_TYPE_COLORS[node.type] }}
              >
                <span className="bp-node-key" title={node.key}>
                  {nodeDisplayName(node, t, doc.nodes)}
                </span>
                <span className="bp-node-type">{node.type}</span>
              </div>
              <div className="bp-node-body">{nodeSummary(node, t)}</div>
              <div className="bp-node-ports">
                <div className="bp-ports-in">
                  {ins.map((p) => (
                    <div className="bp-port-row" key={`in:${p.id}`}>
                      <span
                        className="bp-port bp-port-in"
                        data-port={`${node.key}::in:${p.id}`}
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
                        data-port={`${node.key}::out:${p.id}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 边层（未变换，使用测量后的局部坐标） */}
      <svg className="bp-edges">
        {doc.edges.map((edge, i) => {
          const a = portMap.current.get(
            `${edge.from}::out:${portIdFor(
              doc.nodes.find((n) => n.key === edge.from)?.type ?? "control",
              "out",
              edge.kind,
            )}`,
          );
          const b = portMap.current.get(
            `${edge.to}::in:${portIdFor(
              doc.nodes.find((n) => n.key === edge.to)?.type ?? "control",
              "in",
              edge.kind,
            )}`,
          );
          if (!a || !b) {
            return null;
          }
          return (
            <path
              key={i}
              d={edgePath(a, b)}
              data-edge={i}
              className={`bp-edge ${selectedEdge === i ? "selected" : ""}`}
              stroke={EDGE_COLORS[edge.kind]}
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
      </svg>

      {/* 图例（多语言） */}
      <div className="bp-legend">
        {(Object.keys(EDGE_COLORS) as BlueprintEdge["kind"][]).map((k) => (
          <span key={k} className="bp-legend-item">
            <i style={{ background: EDGE_COLORS[k] }} />
            {t(`blueprint.port.${k}` as TranslationKey)}
          </span>
        ))}
      </div>
    </div>
  );
}
