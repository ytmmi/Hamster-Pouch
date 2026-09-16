/**
 * 蓝图结构骨架生成（RFC 0007）：从**当前布局**推导「布局块 → 标签组 → 控件」三层结构，
 * 作为新建蓝图的基础。
 *
 * 为什么需要：新建蓝图若从空图起步，用户得先把布局结构（左/中/右栏、哪些面板同属一个
 * 标签组）手工搭一遍——而这些信息 dockview 里本来就有。这里把当前布局**读**成结构节点，
 * 用户随后只需补规则（对象→操作→状态）。
 *
 * 口径与内置默认蓝图一致：
 * - 每个 dockview 组 → 一个**布局块**（顶层区域）；
 * - 组内多个面板 → 一个**标签组**（成员由 contains 边表示），布局块只连标签组；
 * - 组内单个面板 → 布局块直接连该**控件**；
 * - 每个面板 → 一个控件节点（panel_id + 本地化标题键）。
 */

import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";
import { makeEmptyBlueprint, PANEL_TITLES, type PanelId } from "@hamster-pouch/config";
import type { DockviewApi } from "dockview-react";

import { uniqueKey } from "./blueprintNodeFactory";

/** 结构骨架的列宽/行高（按列铺开，互不重叠；用户可再拖拽）。 */
const COL_W = 300;
const ROW_H = 130;
const ORIGIN = 40;

/** 结构骨架的跨窗口共享键：主窗口写入，任何窗口（含独立蓝图面板）都能读到。 */
const STRUCTURE_KEY = "hp.layout.structure";
const STRUCTURE_EVENT = "hp:layout-structure";

/** 布局结构快照（跨窗口共享的数据形状）。 */
export interface StructureSnapshot {
  /** 每个区域：面板 id 列表（顺序即标签顺序）。 */
  regions: string[][];
  /** 写入时间戳（用于判断新鲜度）。 */
  at: number;
}

/** 主窗口发布当前布局结构（任何窗口可读）。 */
export function publishStructure(snapshot: StructureSnapshot): void {
  const payload = JSON.stringify(snapshot);
  try {
    localStorage.setItem(STRUCTURE_KEY, payload);
  } catch {
    /* 忽略 */
  }
  try {
    const host: EventTarget | null =
      typeof document !== "undefined" && document ? document : window;
    host?.dispatchEvent(
      new CustomEvent<StructureSnapshot>(STRUCTURE_EVENT, { detail: snapshot }),
    );
  } catch {
    /* 忽略 */
  }
}

/** 读取最近一次发布的布局结构（跨窗口）；无则 null。 */
export function readStructure(): StructureSnapshot | null {
  try {
    const raw = localStorage.getItem(STRUCTURE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StructureSnapshot;
    return Array.isArray(parsed?.regions) ? parsed : null;
  } catch {
    return null;
  }
}

/** 订阅布局结构更新（跨窗口）。 */
export function subscribeStructure(
  onUpdate: (snapshot: StructureSnapshot) => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<StructureSnapshot>).detail;
    if (detail && Array.isArray(detail.regions)) {
      onUpdate(detail);
    }
  };
  let host: EventTarget | null = null;
  try {
    host = typeof document !== "undefined" && document ? document : window;
  } catch {
    host = null;
  }
  host?.addEventListener(STRUCTURE_EVENT, handler);
  return () => host?.removeEventListener(STRUCTURE_EVENT, handler);
}

/** 从当前 dockview 布局抓取结构快照。 */
export function snapshotFromDockview(dv: DockviewApi): StructureSnapshot {
  const regions = dv.groups
    .filter((g) => g.api.location.type !== "floating")
    .map((g) => g.panels.map((p) => p.id))
    .filter((ids) => ids.length > 0);
  return { regions, at: Date.now() };
}

/**
 * 蓝图结构骨架生成（RFC 0007）：从**当前布局**推导「布局块 → 标签组 → 控件」三层结构，
 * 作为新建蓝图的基础。
 *
 * 为什么需要：新建蓝图若从空图起步，用户得先把布局结构（左/中/右栏、哪些面板同属一个
 * 标签组）手工搭一遍——而这些信息 dockview 里本来就有。这里把当前布局**读**成结构节点，
 * 用户随后只需补规则（对象→操作→状态）。
 *
 * 口径与内置默认蓝图一致：
 * - 每个 dockview 组 → 一个**布局块**（顶层区域）；
 * - 组内多个面板 → 一个**标签组**（成员由 contains 边表示），布局块只连标签组；
 * - 组内单个面板 → 布局块直接连该**控件**；
 * - 每个面板 → 一个控件节点（panel_id + 本地化标题键）。
 *
 * 注意：蓝图面板可能开在**独立窗口**，那里没有工作区 dockview。因此主窗口会把结构快照
 * 发布到跨窗口共享存储（`publishStructure`），本函数优先用它，dockview 作为兜底。
 */
export function structureBlueprint(snapshot: StructureSnapshot | null): BlueprintGraph {
  const doc = makeEmptyBlueprint();
  const nodes: BlueprintNode[] = [...doc.nodes];
  const edges: BlueprintEdge[] = [...doc.edges];

  const add = (node: BlueprintNode): string => {
    nodes.push(node);
    return node.key;
  };
  const connect = (from: string, to: string): void => {
    edges.push({ from, to, kind: "contains", order: edges.length + 1 });
  };

  const regions = snapshot?.regions ?? [];
  regions.forEach((panelIds, col) => {
    if (panelIds.length === 0) {
      return;
    }
    const x = ORIGIN + col * COL_W;
    const blockKey = add({
      key: uniqueKey(nodes, `blk_${col + 1}`),
      type: "layout_block",
      name: `区域 ${col + 1}`,
      position: { x, y: ORIGIN },
    });

    const controlKeys = panelIds.map((panelId, row) =>
      add({
        key: uniqueKey(nodes, `c_${panelId}`),
        type: "control",
        panel_id: panelId,
        ...(PANEL_TITLES[panelId as PanelId]
          ? { title_key: PANEL_TITLES[panelId as PanelId] }
          : {}),
        position: { x: x + COL_W, y: ORIGIN + (row + 1) * ROW_H },
      }),
    );

    if (controlKeys.length === 1) {
      // 单面板区域：布局块直接含控件（没有标签组语义）。
      connect(blockKey, controlKeys[0]);
      return;
    }
    // 多面板区域：布局块只连标签组，成员由标签组 contains（与默认蓝图口径一致）。
    const groupKey = add({
      key: uniqueKey(nodes, `g_${col + 1}`),
      type: "group",
      mode: "exclusive",
      position: { x: x + COL_W, y: ORIGIN },
    });
    connect(blockKey, groupKey);
    controlKeys.forEach((key) => {
      edges.push({
        from: groupKey,
        to: key,
        kind: "contains",
        order: edges.length + 1,
      });
    });
  });

  return { ...doc, nodes, edges };
}
