/**
 * 蓝图结构骨架生成（RFC 0007）：从**当前布局**推导「布局块 → 标签组 → 控件」三层结构，
 * 作为新建蓝图的基础。
 *
 * 术语（与使用者口径一致）：
 * - **布局块 = 界面上的一个区域（一栏）**，例如默认「媒体-测试」布局的左/中/右三栏。
 *   一栏里可能堆叠**多个**标签组或独立面板，它们都属于这**一个**布局块。
 * - **标签组 = 同一 dockview 组内的多个标签页**（如中栏的 媒体预览/查看器/媒体播放器）。
 * - **控件 = 单个面板**（一个标签页）。
 *
 * 因此生成时先按 dockview 组的**几何位置**把组聚成区域（同一栏 = 水平区间重叠的组），
 * 每个区域一个布局块；区域内的多面板组再生成标签组节点。
 *
 * 跨窗口：蓝图面板可能开在独立窗口（那里没有工作区 dockview），所以主窗口会把结构快照
 * 发布到共享存储（`publishStructure`），结构生成只吃快照。
 */

import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";
import {
  FALLBACK_LAYER_KEY,
  FALLBACK_LAYER_NAME,
  makeEmptyBlueprint,
  panelTitleKeyOf,
} from "@hamster-pouch/config";
import type { DockviewApi } from "dockview-react";

import { uniqueKey } from "./blueprintNodeFactory";

/** 结构骨架的列宽/行高（按列铺开，互不重叠；用户可再拖拽）。 */
const COL_W = 300;
const ROW_H = 130;
const ORIGIN = 40;

/** 结构骨架的跨窗口共享键：主窗口写入，任何窗口（含独立蓝图面板）都能读到。 */
const STRUCTURE_KEY = "hp.layout.structure";
const STRUCTURE_EVENT = "hp:layout-structure";

/** 布局里的一个 dockview 组（一个标签组 / 单个面板）。 */
export interface StructureRegion {
  /** 面板 id 列表（顺序即标签顺序）。 */
  panels: string[];
  /** 该组在**屏幕上的**水平区间（用于把同栏的组聚成一个布局块）；取不到时为 undefined。 */
  left?: number;
  right?: number;
  /** 垂直位置（用于同栏内的先后顺序）。 */
  top?: number;
}

/** 布局结构快照（跨窗口共享的数据形状）。 */
export interface StructureSnapshot {
  /** 各 dockview 组（含几何），按容器顺序。 */
  regions: StructureRegion[];
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

/** 从当前 dockview 布局抓取结构快照（带几何，供区域聚类）。 */
export function snapshotFromDockview(dv: DockviewApi): StructureSnapshot {
  const regions: StructureRegion[] = [];
  for (const group of dv.groups) {
    if (group.api.location.type === "floating") {
      continue;
    }
    const panels = group.panels.map((p) => p.id);
    if (panels.length === 0) {
      continue;
    }
    const box = group.api.boundingBox;
    regions.push({
      panels,
      ...(box ? { left: box.left, right: box.left + box.width, top: box.top } : {}),
    });
  }
  return { regions, at: Date.now() };
}

/**
 * 把 dockview 组按**几何**聚成区域（布局块）：
 * 水平区间显著重叠的组属于同一栏（同一布局块），再按垂直位置排序。
 *
 * 取不到几何（旧宿主/未布局）时退化为"每组一个区域"，保证仍能生成结构。
 */
export function clusterRegions(
  regions: StructureRegion[],
): StructureRegion[][] {
  const withBox = regions.filter(
    (r) => r.left !== undefined && r.right !== undefined,
  );
  if (withBox.length !== regions.length) {
    return regions.map((r) => [r]);
  }
  const sorted = [...regions].sort((a, b) => a.left! - b.left!);
  const clusters: StructureRegion[][] = [];
  for (const region of sorted) {
    const width = Math.max(1, region.right! - region.left!);
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push([region]);
      continue;
    }
    // 与当前栏的水平区间重叠超过较小者宽度的一半 → 视为同一栏。
    const overlap = Math.max(
      0,
      Math.min(current[0].right!, region.right!) -
        Math.max(current[0].left!, region.left!),
    );
    const currentWidth = Math.max(1, current[0].right! - current[0].left!);
    if (overlap > Math.min(width, currentWidth) * 0.5) {
      current.push(region);
    } else {
      clusters.push([region]);
    }
  }
  // 栏内按垂直位置（上 → 下）排序
  for (const cluster of clusters) {
    cluster.sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  }
  return clusters;
}

/**
 * 生成结构骨架图文档：**一个层**（层名即界面显示名，D51）内顶层一个**界面节点**
 * （层的根 / 页面，收纳布局块）；**每个区域（栏）一个布局块**（界面 contains 布局块）；
 * 区域内多面板组 → 标签组节点（布局块只连标签组），单面板组 → 布局块直连面板控件。
 * 多页面由使用者后续新增层自建（跨层用 `navigate` 连接，D48）。
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

  const clusters = clusterRegions(snapshot?.regions ?? []);

  // 空快照 / 无区域 → 空图（不凭空空造界面节点，保持"从空图起步"语义）。
  if (clusters.length === 0) {
    return { ...doc, nodes, edges };
  }

  // 骨架自带**一个层**（D51：一个层 = 一张画布 = 一个界面）。
  const layerKey = FALLBACK_LAYER_KEY;
  const layers = [{ key: layerKey, name: FALLBACK_LAYER_NAME }];

  // 层内的根：界面节点（页面；只连布局块，RFC 0007 决策 1 / D47）。
  const structureX = ORIGIN + ((clusters.length - 1) * COL_W) / 2;
  const interfaceKey = add({
    key: uniqueKey(nodes, "ui"),
    type: "interface",
    layer: layerKey,
    position: { x: structureX, y: ORIGIN },
  });

  clusters.forEach((cluster, col) => {
    const x = ORIGIN + col * COL_W;
    const blockKey = add({
      key: uniqueKey(nodes, `blk_${col + 1}`),
      type: "layout_block",
      layer: layerKey,
      name: `区域 ${col + 1}`,
      position: { x, y: ORIGIN + ROW_H },
    });
    connect(interfaceKey, blockKey);

    // 区域内的每个组：多面板 → 标签组（成员面板控件），单面板 → 面板控件。
    let row = 2;
    for (const region of cluster) {
      if (region.panels.length === 0) {
        continue;
      }
      const controlKeys = region.panels.map((panelId) => {
        const key = add({
          key: uniqueKey(nodes, `c_${panelId}`),
          type: "control",
          layer: layerKey,
          panel_id: panelId,
          ...(panelTitleKeyOf(panelId) ? { title_key: panelTitleKeyOf(panelId)! } : {}),
          position: { x: x + COL_W, y: ORIGIN + row * ROW_H },
        });
        row += 1;
        return key;
      });
      if (controlKeys.length === 1) {
        connect(blockKey, controlKeys[0]);
        continue;
      }
      const groupKey = add({
        key: uniqueKey(nodes, `g_${col + 1}_${row}`),
        type: "group",
        layer: layerKey,
        mode: "exclusive",
        position: { x: x + COL_W, y: ORIGIN + row * ROW_H },
      });
      row += 1;
      connect(blockKey, groupKey);
      controlKeys.forEach((key) => {
        edges.push({
          from: groupKey,
          to: key,
          kind: "contains",
          order: edges.length + 1,
        });
      });
    }
  });

  return { ...doc, layers, nodes, edges };
}
