/**
 * 蓝图节点画布（ComfyUI 风格，RFC 0007 决策 7 / D31）。
 *
 * 深色画布 + 点阵网格；节点为圆角卡片、按类型着色头部，正文展示关键字段摘要；
 * 输入端口在左、输出端口在右；从输出端口拖拽到**可连的输入端口**建立边，
 * **边类型按端口自动判定**（contains / memberOf / fires / guards）；边以 SVG
 * 贝塞尔曲线绘制并按类型着色。支持节点拖拽摆放（落库 `position {x,y}`）、
 * 画布平移（拖空白）与缩放（滚轮）。
 *
 * **拖线体验（2026-10-10，D107）**：拖出线时，所有**可连的输入端口**亮绿圈、
 * 指针最近的那个加亮（就近吸附），放开即连到它——落点判据是**几何距离**，
 * 不是"指针必须精确压在那个 12px 圆点上"（早前用 `elementFromPoint`，偏到旁边的
 * 端口标签上就静默落空）。同理，连线与节点的**点选/抓取**也走几何命中：
 * 线只有 3px，DOM 命中太窄，而 SVG 压在节点之上又会在交叉处挡住节点拖动。
 *
 * **连线一定画得出来**：端点坐标逐级回落（端口测量 → 卡片+端口偏移 → 卡片边沿 →
 * 节点世界坐标，见 `blueprintGeometry.resolveEdgeAnchor`），不再出现"数据里有边、
 * 画布上没线"。
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  BlueprintEdge,
  BlueprintGraph,
  BlueprintNode,
} from "@hamster-pouch/config";
import { nodeLayerKey } from "@hamster-pouch/config";
import type { Translate, TranslationKey } from "../i18n";
import {
  connectTargets,
  portDomId,
  portIdForRender,
  portLabel,
  portsOf,
  type ConnectTarget,
  type PortDef,
} from "./blueprintPorts";
// 节点显示名/摘要等**本地化文案**由纯模块 `blueprintLabels` 承载（画布与属性面板共用）。
import { nodeDisplayName, nodeSummary, nodeTypeLabel } from "./blueprintLabels";
// 配色由纯模块 `blueprintNodeColors` 承载（画布与小地图共用同一份色板）。
import { EDGE_COLORS, edgeColor, nodeColor } from "./blueprintNodeColors";
import { BlueprintMinimap } from "./BlueprintMinimap";
import {
  nearestWithin,
  pointToPolylineDistance,
  pointToRectDistance,
  resolveEdgeAnchor,
  sampleEdgeCurve,
  segmentHitsPolyline,
  segmentHitsRect,
  viewportCenterToWorld,
  type Point,
  type RectBox,
} from "./blueprintGeometry";

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
  /**
   * 一次划线（右键直线刀痕）删除**多处**：节点 key 列表 + 整文档边下标列表。
   * **必须一次给全**——分多次回调会各自基于同一份旧文档，只剩最后一次生效。
   */
  onRemoveBlade?: (nodeKeys: string[], edgeIndexes: number[]) => void;
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
  /**
   * 刷新计数（工具栏「刷新」）：变化时强制重新测量端口位置。
   * 端口测量依赖 DOM 布局，节点卡片高度会随摘要文案变化，重新量一次才能让
   * 连线坐标与节点状态一起对齐（用户反馈的"连线后状态没刷新"）。
   */
  refreshKey?: number;
  t: Translate;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

/** 刀痕命中容差（画布本地像素）：线段到连线的容许距离。 */
const BLADE_HIT_TOLERANCE = 10;

/**
 * 连线**点选**命中容差（画布本地像素）：指针到连线的容许距离。
 * 连线画出来只有 3px 宽，若按笔画命中就等于要求"精确压线"；这里给 10px 的宽容带。
 */
const EDGE_HIT_TOLERANCE = 10;

/**
 * 拖线时的**端口吸附半径**（画布本地像素）：指针进入这个距离就吸附到最近的
 * **可连端口**上。这是"连线敏感度"的可调旋钮——手感由它决定，而不是由 12px 的
 * 圆点边界决定。
 */
const PORT_SNAP_RADIUS = 34;

/** 节点抓取余量（画布本地像素）：卡片外扩这么多也算抓住卡片（边框/阴影上也能拖）。 */
const NODE_GRAB_MARGIN = 6;

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
  onRemoveBlade,
  onRemoveEdge,
  onConnect,
  onViewCenterChange,
  selectedKey,
  onSelect,
  unlinked,
  layerKey,
  refreshKey = 0,
  t,
}: BlueprintCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  /** 渲染出来的画布可见区域尺寸（小地图据此画视口指示框）。 */
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewportSizeRef = useRef(viewportSize);
  const [tempEdge, setTempEdge] = useState<{
    fromKey: string;
    fromPort: string;
    x: number;
    y: number;
  } | null>(null);
  /**
   * 拖线时**就近吸附**到的目标端口（`data-port` 标记，见 `portDomId`）。
   * 它就是放开时真正落点的那一个——绿圈加亮的那个。
   */
  const [hotPort, setHotPort] = useState<string | null>(null);
  /** 指针悬停的连线下标（空闲时高亮，便于"点一下选中、Delete 删除"）。 */
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  /** 刀痕状态：右键长按拖拽（起点固定，终点跟随指针的**直线**删除线）。 */
  const [blade, setBlade] = useState<BladeState | null>(null);
  const [, setTick] = useState(0);
  /** 端口元素的实测坐标（`data-port` → 画布局部坐标）。 */
  const portMap = useRef<Map<string, { x: number; y: number }>>(new Map());
  /** 节点卡片的实测矩形（节点 key → 画布局部矩形）：端口没量到时用来兜底定位。 */
  const cardMap = useRef<Map<string, RectBox>>(new Map());
  /**
   * 端口相对**所在卡片左上角**的偏移（`data-port` → 偏移）。跨渲染保留：
   * 端口这一帧没量到（隐藏、刚创建、卡片高度正在变）时，仍能用卡片位置 + 这个偏移
   * 算出连线端点，而不是把线丢掉。
   */
  const portOffsets = useRef<Map<string, { x: number; y: number }>>(new Map());
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
   * 一条边某侧的端口坐标（`undefined` = 连节点都不在图里）。
   *
   * **四级回落**（`resolveEdgeAnchor`）：端口实测 → 卡片矩形 + 端口偏移 → 卡片边沿 →
   * 节点世界坐标。因此"数据里有边、画布上没线"在结构上不可能出现——只要两个端点
   * 节点还在画布上，就一定算得出坐标。早前这里只认端口实测，查不到就 `return null`
   * 把整条边丢掉（端口未渲染 / 类型无注册项 / 面板尚未布局量到 0 都会命中）。
   */
  const portPoint = useCallback(
    (
      key: string,
      side: "in" | "out",
      portId: string,
    ): { x: number; y: number } | undefined => {
      const node = byKey.get(key);
      const id = portId ? portDomId(key, side, portId) : "";
      return (
        resolveEdgeAnchor({
          measured: id ? portMap.current.get(id) : undefined,
          card: cardMap.current.get(key),
          offset: id ? portOffsets.current.get(id) : undefined,
          world: node?.position,
          side,
          view,
        }) ?? undefined
      );
    },
    [byKey, view],
  );

  /**
   * 一条边某侧的端口坐标：端口 id 由**渲染用**推导给出（`portIdForRender`），
   * 与画布画出来的端口标记同一来源，避免"边类型推不出端口 id → 线被丢掉"。
   */
  const portPointFor = useCallback(
    (edge: BlueprintEdge, side: "in" | "out"): { x: number; y: number } | undefined => {
      const key = side === "in" ? edge.to : edge.from;
      const node = byKey.get(key);
      if (!node) {
        return undefined;
      }
      return portPoint(key, side, portIdForRender(node.type, side, edge.kind));
    },
    [byKey, portPoint],
  );

  const toWorld = useCallback(
    (local: { x: number; y: number }) => ({
      x: (local.x - view.x) / view.zoom,
      y: (local.y - view.y) / view.zoom,
    }),
    [view],
  );

  /** 测量全部端口在画布局部坐标系中的位置（含变换后的最终位置），并记下卡片矩形与端口偏移。 */
  const measurePorts = useCallback(() => {
    const vp = canvasRef.current;
    if (!vp) {
      return;
    }
    const rect = vp.getBoundingClientRect();
    // **画布尚未布局**（面板未挂载/尺寸为 0）时**不测量**：此时测出来的每个点都是
    // (0,0)，会把上一份正确的坐标覆盖成"所有连线缩成一个点"（表现为线全没了）。
    // 保留上一次测量结果，等 ResizeObserver 报出真实尺寸后再量。
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    const nextCards = new Map<string, RectBox>();
    vp.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => {
      const key = el.dataset.node;
      if (!key) {
        return;
      }
      const r = el.getBoundingClientRect();
      nextCards.set(key, {
        x: r.left - rect.left,
        y: r.top - rect.top,
        w: r.width,
        h: r.height,
      });
    });
    const next = new Map<string, { x: number; y: number }>();
    vp.querySelectorAll<HTMLElement>("[data-port]").forEach((el) => {
      const id = el.dataset.port;
      if (!id) {
        return;
      }
      const r = el.getBoundingClientRect();
      const point = {
        x: r.left - rect.left + r.width / 2,
        y: r.top - rect.top + r.height / 2,
      };
      next.set(id, point);
      const card = nextCards.get(id.split("::")[0]);
      if (card) {
        portOffsets.current.set(id, { x: point.x - card.x, y: point.y - card.y });
      }
    });
    portMap.current = next;
    cardMap.current = nextCards;
    setTick((n) => n + 1);
  }, []);

  useLayoutEffect(() => {
    measurePorts();
  }, [doc, view, selectedKey, refreshKey, measurePorts]);

  /**
   * 同步画布可见区域尺寸（小地图画视口指示框用）。
   * 只在尺寸真的变化时 `setState`，避免 ResizeObserver 反复触发渲染。
   */
  const syncViewportSize = useCallback(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    viewportSizeRef.current = { width: rect.width, height: rect.height };
    setViewportSize((prev) =>
      prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height },
    );
  }, []);

  useLayoutEffect(() => {
    syncViewportSize();
  }, [syncViewportSize, doc]);

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

  // 容器尺寸变化时重测端口 + 同步视口尺寸。
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const obs = new ResizeObserver(() => {
      measurePorts();
      syncViewportSize();
      reportViewCenter();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [measurePorts, syncViewportSize, reportViewCenter]);

  /**
   * 小地图导航：把画布视口**中心**移到给定世界坐标（`view` 的分辨率不变，只改平移）。
   * 依赖用 ref 取当前视口尺寸，因此回调保持稳定（小地图不会因 `view` 变化重建）。
   */
  const focusWorld = useCallback((world: Point) => {
    setView((v) => {
      const { width, height } = viewportSizeRef.current;
      if (width === 0 || height === 0) {
        return v;
      }
      return {
        ...v,
        x: width / 2 - world.x * v.zoom,
        y: height / 2 - world.y * v.zoom,
      };
    });
  }, []);

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

  /**
   * 画布局部坐标命中的**连线**（半径 `EDGE_HIT_TOLERANCE` 内最近的一条，无 = `null`）。
   *
   * 为什么不靠 DOM 命中：连线只有 3px 宽，`pointer-events: stroke` 的命中区等于线宽，
   * 点选手感极差（用户反馈的"连线敏感度"）；而把命中区靠加一条透明粗描边撑大，
   * 又会因为 SVG 层压在节点之上，在连线与节点交叉处**抢走节点拖动**。几何判定两头都避开：
   * 命中宽度随容差可调，且只在"没点到端口、也没抓到节点"时才算连线。
   */
  const edgeHitAt = useCallback(
    (p: Point): number | null => {
      let bestIndex: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const { edge, index } of visibleEdges) {
        const a = portPointFor(edge, "out");
        const b = portPointFor(edge, "in");
        if (!a || !b) {
          continue;
        }
        const distance = pointToPolylineDistance(p, sampleEdgeCurve(a, b));
        if (distance <= EDGE_HIT_TOLERANCE && distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      return bestIndex;
    },
    [visibleEdges, portPointFor],
  );

  /** 画布局部坐标命中的**节点**（卡片矩形外扩 `NODE_GRAB_MARGIN`；DOM 未命中时兜底）。 */
  const nodeHitAt = useCallback(
    (p: Point): string | null => {
      for (const node of visibleNodes) {
        const card = cardMap.current.get(node.key);
        if (card && pointToRectDistance(p, card) <= NODE_GRAB_MARGIN) {
          return node.key;
        }
      }
      return null;
    },
    [visibleNodes],
  );

  /**
   * 当前拖线**可落到的全部端口**（`data-port` 标记 → 目标）。
   *
   * 同一份清单驱动两件事：拖拽时的**绿圈高亮**与放开时的**落点判定**。
   * 判据在纯模块 `blueprintPorts.connectTargets`（层级 + 端口存在 + 去重），
   * 因此"亮着绿圈"与"放开真能连上"不可能不一致。
   */
  const linkTargets = useMemo(() => {
    const map = new Map<string, ConnectTarget>();
    if (!tempEdge) {
      return map;
    }
    const from = byKey.get(tempEdge.fromKey);
    if (!from) {
      return map;
    }
    for (const t of connectTargets(from, tempEdge.fromPort, visibleNodes, doc.edges)) {
      map.set(portDomId(t.key, "in", t.portId), t);
    }
    return map;
  }, [tempEdge, byKey, visibleNodes, doc.edges]);

  /** 半径内**最近的可连端口**（拖线吸附目标；无 = `null`）。 */
  const nearestLinkTargetId = useCallback(
    (p: Point): string | null => {
      const items: { point: Point; value: string }[] = [];
      for (const [id, target] of linkTargets) {
        const point = portPoint(target.key, "in", target.portId);
        if (point) {
          items.push({ point, value: id });
        }
      }
      return nearestWithin(items, p, PORT_SNAP_RADIUS)?.value ?? null;
    },
    [linkTargets, portPoint],
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
        setHotPort(null);
        dragRef.current = null;
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      // 输入端口：线一律**从输出端口拉出**（方向确定，落点判据唯一），因此这里不开连线；
      // 但也**不吞掉**这次按下——继续走下面的节点拖动分支，否则端口周围那圈扩大的
      // 命中区会变成"点了没反应"的死区。
    }
    // 节点：DOM 命中优先，其次按卡片矩形几何兜底（边框/圆角外的 6px 内也能抓住）。
    const grabbedKey = nodeKey ?? nodeHitAt(local);
    const node = grabbedKey ? doc.nodes.find((n) => n.key === grabbedKey) : undefined;
    if (node) {
      const wp = toWorld(local);
      const pos = nodePos(node);
      dragRef.current = {
        kind: "node",
        key: node.key,
        offX: wp.x - pos.x,
        offY: wp.y - pos.y,
      };
      onSelect(node.key);
      setSelectedEdge(null);
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    // 空白：平移 + 取消选中；若压在某条连线上（10px 宽容带内）则顺带选中它
    // （点一下选中、Delete 删除；同时保留拖动平移，不牺牲画布手感）。
    dragRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
    onSelect(null);
    setSelectedEdge(edgeHitAt(local));
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const local = toLocal(e.clientX, e.clientY);
    if (tempEdge) {
      setTempEdge((prev) => (prev ? { ...prev, x: local.x, y: local.y } : prev));
      // 就近吸附：指针半径内最近的可连端口 → 绿圈加亮，放开即连到它。
      const nextHot = nearestLinkTargetId(local);
      setHotPort((prev) => (prev === nextHot ? prev : nextHot));
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      // 空闲悬停：几何命中连线 → 加亮（选中/删除前的可见反馈）。
      const hit = edgeHitAt(local);
      setHoverEdge((prev) => (prev === hit ? prev : hit));
      return;
    }
    setHoverEdge(null);
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
    // 刀痕放开：删除划中的**全部**边与节点（节点为软删除，关联节点保留并灰显）。
    if (dragRef.current?.kind === "blade") {
      const hits = blade;
      dragRef.current = null;
      setBlade(null);
      if (hits) {
        if (onRemoveBlade) {
          // 一次给全：面板在**一份文档**上原子应用（分多次回调会只剩最后一次生效）。
          onRemoveBlade(hits.nodes, hits.edges);
        } else {
          // 兜底（未接批量回调时）：先删边再删节点，避免索引在节点删除后错位。
          for (const index of [...hits.edges].sort((a, b) => b - a)) {
            onRemoveEdge?.(index);
          }
          for (const key of hits.nodes) {
            onRemoveNode?.(key);
          }
        }
      }
      return;
    }
    if (tempEdge) {
      // 落点 = **就近吸附到的那个可连端口**（绿圈加亮的那一个）。几何吸附在
      // `nearestLinkTargetId` 里算好（半径 `PORT_SNAP_RADIUS`），这里只需查表。
      // 兜底再问一次 DOM：万一端口这一帧没量到（面板刚显示/卡片正在变高），吸附点会
      // 回落到卡片锚点、可能错过半径——此时"指针正压着端口元素"仍应算数。
      const domId =
        document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest("[data-port]")
          ?.getAttribute("data-port") ?? null;
      const target =
        (hotPort ? linkTargets.get(hotPort) : undefined) ??
        (domId ? linkTargets.get(domId) : undefined) ??
        null;
      setTempEdge(null);
      setHotPort(null);
      if (target) {
        const edge = { from: tempEdge.fromKey, to: target.key, kind: target.kind };
        // **一次原子编辑**：边与子节点的引用字段由 `onConnect` 在**同一份文档**上落好。
        // 早前这里先 `onChange({...doc, edges})` 再回调 `onConnect`，而后者又从同一份
        // 调用前的 `doc` 派生 → 刚加的边被覆盖掉，表现为"连完线节点状态没刷新"
        // （用户反馈：连线后节点状态为未接通，得手动刷新）。
        if (onConnect) {
          onConnect(edge);
        } else {
          // 兜底（未接 `onConnect` 时）：只落这条边，引用字段交由调用方后续处理。
          // 保留它是因为 `onConnect` 是可选属性——缺了它不该变成"连线完全无效"。
          const order = Math.max(0, ...doc.edges.map((ed) => ed.order)) + 1;
          onChange({ ...doc, edges: [...doc.edges, { ...edge, order }] });
        }
      }
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

  /**
   * 某类型节点的端口表。**必须走 `portsOf`**（不是 `PORT_DEFS[type]`）：未注册的类型
   * （插件未安装/未启用，RFC 0010 决策 6：节点原样保留、灰显未接通）没有端口项，
   * 直接下标取会得到 `undefined`，随后 `.filter` 抛错把整个画布打崩——而"插件缺失"
   * 本就是**允许保存**的常态。
   */
  const nodePorts = (node: BlueprintNode): PortDef[] => portsOf(node.type);

  /** 拖线起点（输出端口）的画布坐标：同样走四级回落，起点也画得出来。 */
  const tempFrom = tempEdge
    ? portPoint(tempEdge.fromKey, "out", tempEdge.fromPort)
    : undefined;

  /** 吸附目标会落成的边类型：临时线据此着色，放开前就看出"这条线会是什么边"。 */
  const hotKind = hotPort ? (linkTargets.get(hotPort)?.kind ?? null) : null;

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
          const isSelected = selectedKey === node.key;
          // 拖线时：这个节点上**有没有可落点**、以及指针是否正吸附在它的某个端口上。
          // 端口绿圈之外，把**承载可连端口的整个节点**也点亮——用户先看到"哪个节点能连"，
          // 再看"落在哪个圆点"（用户口径："高亮可以连接的端口节点"）。
          const inPorts = ins.map((p) => ({
            id: p.id,
            domId: portDomId(node.key, "in", p.id),
          }));
          const hasTarget = inPorts.some((p) => linkTargets.has(p.domId));
          const isHotNode =
            hotPort !== null && inPorts.some((p) => p.domId === hotPort);
          return (
            <div
              key={node.key}
              data-node={node.key}
              className={`bp-node ${isSelected ? "selected" : ""} ${
                isUnlinked ? "unlinked" : ""
              } ${bladed ? "bladed" : ""} ${
                hasTarget ? "link-target" : ""
              } ${isHotNode ? "link-target-hot" : ""}`}
              // 选中的节点抬到同层其它节点之上：它多半是下一步要接线/拖动的那个，
              // 被压在别的卡片下面会让"点一下就抓到别的节点"。
              style={{ left: pos.x, top: pos.y, zIndex: isSelected ? 2 : 1 }}
            >
              <div
                className="bp-node-header"
                style={{
                  background: nodeColor(node.type, isUnlinked),
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
                  {ins.map((p) => {
                    const domId = portDomId(node.key, "in", p.id);
                    // 拖线时：**可连的输入端口**亮绿圈（`compatible`），
                    // 就近吸附到的那一个再加亮（`compatible-hot`）。
                    const compatible = linkTargets.has(domId);
                    const hot = hotPort === domId;
                    return (
                      <div className="bp-port-row" key={`in:${p.id}`}>
                        <span
                          className={`bp-port bp-port-in ${
                            compatible ? "compatible" : ""
                          } ${hot ? "compatible-hot" : ""}`}
                          data-port={domId}
                        />
                        <span className="bp-port-label">
                          {portLabel(node.type, p.id, t)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="bp-ports-out">
                  {outs.map((p) => {
                    const dragging =
                      tempEdge?.fromKey === node.key && tempEdge.fromPort === p.id;
                    return (
                      <div className="bp-port-row right" key={`out:${p.id}`}>
                        <span className="bp-port-label">
                          {portLabel(node.type, p.id, t)}
                        </span>
                        <span
                          className={`bp-port bp-port-out ${dragging ? "linking" : ""}`}
                          data-port={portDomId(node.key, "out", p.id)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 边层（**画布坐标系**，不随世界变换）：端口位置由 `measurePorts` 按
          `getBoundingClientRect()` 量出，已经是"画布局部坐标"，所以这一层必须是
          `.bp-canvas` 的直接子级——放进 `.bp-canvas-world` 会被二次变换，且那个容器
          自身尺寸为 0（节点都是绝对定位），`inset:0` 的 SVG 拿到 0×0 盒子把连线裁没。
          连线**不接收指针事件**（命中改走几何判定 `edgeHitAt`：3px 的笔画命中太窄，
          而给每条线加一条透明粗描边又会在交叉处抢走节点拖动）。 */}
      <svg className="bp-edges">
        {visibleEdges.map(({ edge, index: i }) => {
          const a = portPointFor(edge, "out");
          const b = portPointFor(edge, "in");
          if (!a || !b) {
            return null;
          }
          const bladed = blade?.edges.includes(i) ?? false;
          return (
            <path
              key={i}
              d={edgePath(a, b)}
              data-edge={i}
              className={`bp-edge ${selectedEdge === i ? "selected" : ""} ${
                hoverEdge === i ? "hovered" : ""
              } ${bladed ? "bladed" : ""}`}
              stroke={bladed ? "#ff4d4f" : edgeColor(edge.kind)}
            />
          );
        })}
        {tempFrom && tempEdge && (
          <path
            className="bp-edge temp"
            d={edgePath(tempFrom, { x: tempEdge.x, y: tempEdge.y })}
            // 已吸附到可连端口时按**将建立的边类型**着色（放开前就知道会连成什么边）。
            stroke={hotKind ? edgeColor(hotKind) : "#ffffff"}
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

      {/* 图例（多语言；画布左下角，右下角留给小地图） */}
      <div className="bp-legend">
        {(Object.keys(EDGE_COLORS) as BlueprintEdge["kind"][]).map((k) => (
          <span key={k} className="bp-legend-item">
            <i style={{ background: EDGE_COLORS[k] }} />
            {t(`blueprint.port.${k}` as TranslationKey)}
          </span>
        ))}
        <span className="bp-legend-item bp-legend-hint">{t("blueprint.connectHint")}</span>
        <span className="bp-legend-item bp-legend-hint">{t("blueprint.bladeHint")}</span>
        <span className="bp-legend-item bp-legend-hint">{t("blueprint.panHint")}</span>
      </div>

      {/* 小地图（画布右下角）：缩略全层节点/连线 + 当前视口指示框，可拖动定位 */}
      <BlueprintMinimap
        nodes={visibleNodes}
        edges={visibleEdges.map(({ edge }) => edge)}
        viewport={viewportSize}
        view={view}
        unlinked={unlinked}
        onFocus={focusWorld}
        t={t}
      />
    </div>
  );
}
