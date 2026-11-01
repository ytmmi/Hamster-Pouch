/**
 * 蓝图「同步布局」（D133）：把**当前页面布局**同步进当前层的节点结构。
 *
 * 一个域：吃一份布局结构快照（`blueprintStructure.snapshotFromDockview`），把
 * 「布局块（一栏）→ 标签组（同一个 dockview 组里的多个标签页）→ 控件（单个面板）」
 * 这套结构写回节点与边。面板**换了标签组**时，把它和它的**后续（尾部）节点**当成
 * 一个整体平移——尾部保持原有相对形状，不会被拆散（用户口径 m00001 / m00071）。
 *
 * 与相邻模块的分工：
 * - `blueprintStructure`：**新建蓝图**时从布局生成整套骨架（本模块复用它做区域聚类）；
 * - `shared/blueprintSync`：**保存布局**时把新出现的面板补进蓝图（只增不改归属）；
 * - 本模块：**使用者显式触发的一次同步**——改归属、补缺失面板、搬动面板 + 尾部。
 *
 * 边界（有意不做，写下来避免被当成缺陷）：
 * - 不动界面根节点，也不动**没出现在布局里**的控件（后者的原结构父原样保留，
 *   否则一次同步就会把别的页面的节点变成"未接通"，见 D108）；
 * - 不做全图重排——那是「一键整理」（`blueprintArrange`）的职责。本模块只搬动
 *   归属真的变了的面板簇，并把它落在**新标签组子树的下沿之下**，因此不会盖住
 *   既有节点；
 * - 复用到的既有标签组不改 `mode`（用户可能有意改成 `independent`），只有新建的
 *   标签组按 dockview 标签页语义取 `exclusive`；
 * - **浮层（`overlay`）拥有的子树整体排除**：浮层是界面直接子级的**容器**（D50 修订），
 *   它的内容面板在 dockview 里可能正**停靠在某个标签组**（引擎的 `show` 是把内容面板
 *   按尺寸浮动显示，面板本身仍可能停靠着），于是会出现在布局快照里。规范第 2 节的
 *   **结构父唯一**是硬约束，所以这些节点不参与页面结构规划：不挂第二个结构父、不搬运、
 *   也不被当作可复用的既有标签组——否则一次同步就会让"浮层连接的面板"同时连上不属于
 *   浮层的标签组（用户实测回归）。
 */

import {
  effectiveLayers,
  hasLayers,
  interfaceOfLayer,
  nodesOfLayer,
  panelTitleKeyOf,
  type BlueprintEdge,
  type BlueprintGraph,
  type BlueprintNode,
} from "@hamster-pouch/config";

import { uniqueKey } from "./blueprintNodeFactory";
import { clusterRegions, type StructureSnapshot } from "./blueprintStructure";

/** 卡片高（与 `blueprintArrange` 的 `CARD.h` 同口径）与纵向间距。 */
const CARD_H = 110;
const GAP_Y = 30;

/** 新建布局块的落点（与 `blueprintStructure` 同一套网格）。 */
const ORIGIN = 40;
const COL_W = 300;
const BLOCK_Y = ORIGIN + 130;

/** 可以作为 `contains` 父 / 子的结构类型（用来界定"哪些边属于本次同步重写范围"）。 */
const STRUCT_PARENT: ReadonlySet<string> = new Set([
  "interface",
  "layout_block",
  "group",
]);
const STRUCT_CHILD: ReadonlySet<string> = new Set([
  "layout_block",
  "group",
  "control",
]);

/**
 * 尾部遍历的**停止类型**：走到另一个面板控件就停——那是它自己的簇；
 * 容器类型不会出现在某个控件的下游，一并停掉以求稳。
 */
const TAIL_STOP: ReadonlySet<string> = new Set([
  "interface",
  "layout_block",
  "group",
  "control",
]);

/** 一次同步的输入。 */
export interface LayoutSyncInput {
  doc: BlueprintGraph;
  /** 当前布局的结构快照；`null` / 无区域时视为"没有可同步的布局"。 */
  snapshot: StructureSnapshot | null;
  /** 当前层（页面）；缺省取有效层的第一层。 */
  layerKey?: string | null;
}

/** 被当作整体搬运的一个**面板簇**（锚点 + 尾部）。 */
export interface TailMove {
  /** 簇的锚点：面板控件节点 key。 */
  anchor: string;
  /** 参与原子平移的节点 key（锚点 + 其后续节点）。 */
  keys: string[];
  dx: number;
  dy: number;
  /** 平移前 / 后的锚点位置。 */
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** 一次同步的结果。 */
export interface LayoutSyncOutcome {
  doc: BlueprintGraph;
  /** 新增的节点 key（布局里有、图里没有的面板控件，以及新建的容器）。 */
  added: string[];
  /** 所属标签组真的变了的面板控件 key。 */
  regrouped: string[];
  /** 作为整体被平移的尾部簇。 */
  moves: TailMove[];
  /** 被平移的节点 key（去重；含锚点与其尾部）。 */
  moved: string[];
  /** 参与同步的布局面板数。 */
  panels: number;
  /** 结构（`contains` / `memberOf` 归属边）是否发生变化。 */
  structureChanged: boolean;
  /** 变更节点数（新增 + 平移）。 */
  count: number;
}

/**
 * 把当前布局同步进当前层的节点结构（纯函数，不落库）。
 *
 * 步骤：① 备好可写节点副本与旧归属索引；② 为布局里有、图里没有的面板补控件节点；
 * ③ 按「列 → 标签组 → 标签页」规划容器（标签组优先复用成员重合最多的既有节点）；
 * ④ 重写本层结构边（顺带把旧图 `memberOf` 归一成 `contains`）；⑤ 归属真的变了的面板
 * 连同尾部整体平移到**新容器子树下沿之下**。
 */
export function syncLayoutIntoGraph(input: LayoutSyncInput): LayoutSyncOutcome {
  const { doc, snapshot } = input;
  const scopeKey = input.layerKey ?? effectiveLayers(doc)[0].key;
  const clusters = clusterRegions(snapshot?.regions ?? []);
  if (clusters.length === 0) {
    return {
      doc,
      added: [],
      regrouped: [],
      moves: [],
      moved: [],
      panels: 0,
      structureChanged: false,
      count: 0,
    };
  }

  // ---------- ① 可写副本与索引 ----------

  const next: BlueprintNode[] = doc.nodes.map((n) => ({ ...n }));
  const indexOf = new Map<string, number>();
  next.forEach((n, i) => indexOf.set(n.key, i));

  const getNode = (key: string): BlueprintNode | undefined => {
    const i = indexOf.get(key);
    return i === undefined ? undefined : next[i];
  };
  const replaceNode = (node: BlueprintNode): void => {
    const i = indexOf.get(node.key);
    if (i !== undefined) {
      next[i] = node;
    }
  };
  const pushNode = (node: BlueprintNode): string => {
    indexOf.set(node.key, next.length);
    next.push(node);
    return node.key;
  };
  const typeOf = (key: string): BlueprintNode["type"] | undefined =>
    getNode(key)?.type;

  const sourceEdges = doc.edges;
  const scopeNodes = nodesOfLayer(doc, scopeKey);
  const scopeKeys = new Set(scopeNodes.map((n) => n.key));
  const layerField = hasLayers(doc) ? { layer: scopeKey } : {};

  /** 旧归属：`contains` 入边优先，其次兼容旧图的 `control --memberOf--> group`（D59）。 */
  const oldParent = new Map<string, string>();
  for (const e of sourceEdges) {
    if (e.kind !== "contains") continue;
    if (!scopeKeys.has(e.from) || !scopeKeys.has(e.to)) continue;
    if (!STRUCT_PARENT.has(typeOf(e.from) ?? "")) continue;
    if (!STRUCT_CHILD.has(typeOf(e.to) ?? "")) continue;
    if (!oldParent.has(e.to)) {
      oldParent.set(e.to, e.from);
    }
  }
  for (const e of sourceEdges) {
    if (e.kind !== "memberOf") continue;
    if (!scopeKeys.has(e.from) || !scopeKeys.has(e.to)) continue;
    if (typeOf(e.from) !== "control" || typeOf(e.to) !== "group") continue;
    if (!oldParent.has(e.from)) {
      oldParent.set(e.from, e.to);
    }
  }

  /**
   * 浮层（`overlay`）**拥有的子树**：`overlay --contains--> group/control` 逐层往下收。
   *
   * 浮层内容面板的归属由浮层说了算；同一个面板又可能正停靠在某个标签组里、因而出现在
   * 布局快照中（引擎 `show` 只是把它按尺寸浮动显示）。结构父**唯一**（规范第 2 节硬
   * 约束），所以这些节点在页面结构规划里整体排除：不挂第二个父、不参与搬运，已有归属
   * 由下面"不属重写范围"的过滤原样保留。
   */
  const overlayOwned = new Set<string>();
  {
    const queue: string[] = [];
    for (const e of sourceEdges) {
      if (e.kind !== "contains") continue;
      if (!scopeKeys.has(e.from) || !scopeKeys.has(e.to)) continue;
      if (typeOf(e.from) !== "overlay") continue;
      if (!STRUCT_CHILD.has(typeOf(e.to) ?? "")) continue;
      if (overlayOwned.has(e.to)) continue;
      overlayOwned.add(e.to);
      queue.push(e.to);
    }
    while (queue.length > 0) {
      const parent = queue.pop() as string;
      for (const e of sourceEdges) {
        if (e.kind !== "contains" || e.from !== parent) continue;
        const childType = typeOf(e.to) ?? "";
        if (childType !== "group" && childType !== "control") continue;
        if (overlayOwned.has(e.to)) continue;
        overlayOwned.add(e.to);
        queue.push(e.to);
      }
    }
  }

  // ---------- ② 补出布局里有、图里没有的面板控件 ----------

  const added: string[] = [];
  const panelsInLayout = new Set<string>();
  const controlByPanel = new Map<string, string>();
  for (const node of scopeNodes) {
    // 浮层拥有的面板不参与页面结构（否则它会同时挂在浮层和标签组下——结构父唯一）。
    if (overlayOwned.has(node.key)) continue;
    if (node.type === "control" && node.panel_id && !controlByPanel.has(node.panel_id)) {
      controlByPanel.set(node.panel_id, node.key);
    }
  }
  /** 归浮层所有的面板 id：不新建控件节点，也不计入 `panelsInLayout`（同步没碰它们）。 */
  const overlayPanels = new Set<string>();
  for (const node of scopeNodes) {
    if (node.type === "control" && node.panel_id && overlayOwned.has(node.key)) {
      overlayPanels.add(node.panel_id);
    }
  }
  for (const cluster of clusters) {
    for (const region of cluster) {
      for (const panelId of region.panels) {
        if (overlayPanels.has(panelId)) {
          continue;
        }
        panelsInLayout.add(panelId);
        if (controlByPanel.has(panelId)) {
          continue;
        }
        const titleKey = panelTitleKeyOf(panelId);
        const key = pushNode({
          key: uniqueKey(next, `c_${panelId}`),
          type: "control",
          panel_id: panelId,
          // 临时落点；真要搬的簇会在第 ⑤ 步按新容器归位。
          position: { x: ORIGIN, y: ORIGIN },
          ...layerField,
          ...(titleKey ? { title_key: titleKey } : {}),
        });
        controlByPanel.set(panelId, key);
        added.push(key);
      }
    }
  }

  // ---------- ③ 规划「列 → 标签组 → 标签页」 ----------

  const sortByPosition = (keys: string[]): string[] =>
    [...keys].sort((a, b) => {
      const pa = getNode(a)?.position ?? { x: 0, y: 0 };
      const pb = getNode(b)?.position ?? { x: 0, y: 0 };
      return pa.x - pb.x || pa.y - pb.y;
    });

  const existingBlocks = sortByPosition(
    scopeNodes.filter((n) => n.type === "layout_block").map((n) => n.key),
  );
  const existingGroups = scopeNodes
    .filter((n) => n.type === "group" && !overlayOwned.has(n.key))
    .map((n) => n.key);

  /** 既有标签组的当前成员面板（用于"成员重合最多"的复用判断）。 */
  const groupMembers = new Map<string, Set<string>>();
  for (const node of scopeNodes) {
    if (node.type !== "control" || !node.panel_id) continue;
    if (overlayOwned.has(node.key)) continue;
    const parent = oldParent.get(node.key);
    if (!parent || typeOf(parent) !== "group") continue;
    if (overlayOwned.has(parent)) continue;
    const members = groupMembers.get(parent) ?? new Set<string>();
    members.add(node.panel_id);
    groupMembers.set(parent, members);
  }

  interface PlannedRegion {
    container: string;
    controls: string[];
  }
  interface PlannedColumn {
    blockKey: string;
    regions: PlannedRegion[];
  }

  const usedGroups = new Set<string>();
  const plannedContainers = new Set<string>();
  const columns: PlannedColumn[] = [];
  clusters.forEach((cluster, col) => {
    // 先把这一栏的每个区域解析成控件：**归浮层所有的面板不参与**（结构父唯一），
    // 但区域的**面板数**照旧按布局算——它决定这里"是不是一个标签组"（见下）。
    const planned: { panels: number; controls: string[] }[] = [];
    for (const region of cluster) {
      const controls: string[] = [];
      for (const panelId of region.panels) {
        const key = controlByPanel.get(panelId);
        if (key) {
          controls.push(key);
        }
      }
      planned.push({ panels: region.panels.length, controls });
    }
    // 整栏面板都归浮层 → 这一栏不进页面结构，也不为它新建空区域。
    if (planned.every((r) => r.controls.length === 0)) {
      return;
    }

    let blockKey = existingBlocks[col];
    if (!blockKey) {
      blockKey = pushNode({
        key: uniqueKey(next, `blk_${col + 1}`),
        type: "layout_block",
        name: `区域 ${col + 1}`,
        position: { x: ORIGIN + col * COL_W, y: BLOCK_Y },
        ...layerField,
      });
      added.push(blockKey);
    }
    plannedContainers.add(blockKey);

    const regions: PlannedRegion[] = [];
    planned.forEach(({ panels, controls }) => {
      if (controls.length === 0) {
        return;
      }
      // 单面板区域：布局块直连控件（不凭空空造一个只有一个成员的标签组）。
      // 注意判据是**布局里的面板数**：浮层拥有的面板已经不在 `controls` 里，
      // 但它所在的标签组在 dockview 里确实存在，不能因此把标签组拆掉。
      if (panels === 1) {
        regions.push({ container: blockKey, controls });
        return;
      }
      // 多面板区域：标签组。优先复用成员重合最多的既有标签组（保持用户命名与位置）。
      let best: string | null = null;
      let bestScore = 0;
      for (const groupKey of existingGroups) {
        if (usedGroups.has(groupKey)) continue;
        const members = groupMembers.get(groupKey);
        if (!members || members.size === 0) continue;
        let score = 0;
        for (const controlKey of controls) {
          const panelId = getNode(controlKey)?.panel_id;
          if (panelId && members.has(panelId)) {
            score += 1;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = groupKey;
        }
      }
      const groupKey =
        best ??
        pushNode({
          key: uniqueKey(next, `g_${col + 1}_${regions.length + 1}`),
          type: "group",
          mode: "exclusive",
          ...layerField,
        });
      if (!best) {
        added.push(groupKey);
      }
      usedGroups.add(groupKey);
      plannedContainers.add(groupKey);
      regions.push({ container: groupKey, controls });
    });
    columns.push({ blockKey, regions });
  });

  // ---------- ④ 重写本层结构边 ----------

  const isScopeStructural = (e: BlueprintEdge): boolean => {
    if (!scopeKeys.has(e.from) || !scopeKeys.has(e.to)) return false;
    const from = typeOf(e.from) ?? "";
    const to = typeOf(e.to) ?? "";
    // 浮层子树（`overlay` 本身 + 它 contains 的 group / control）**不属**页面结构重写范围：
    // 否则浮层里那条 `og_1 --contains--> c_media` 会被当成页面结构边删掉，浮层内容面板
    // 当场失去结构父（结构父唯一，浮层的归属只由浮层自己那张图说了算）。
    if (from === "overlay" || overlayOwned.has(e.from) || overlayOwned.has(e.to)) {
      return false;
    }
    if (e.kind === "contains") {
      return STRUCT_PARENT.has(from) && STRUCT_CHILD.has(to);
    }
    if (e.kind === "memberOf") {
      return from === "control" && to === "group";
    }
    return false;
  };

  const beforeStructural = new Set(
    sourceEdges
      .filter(isScopeStructural)
      .map((e) => `${e.kind}|${e.from}|${e.to}`),
  );

  const edges: BlueprintEdge[] = sourceEdges.filter((e) => !isScopeStructural(e));
  let edgeOrder = 0;
  const structParent = new Map<string, string>();
  const structChildren = new Map<string, string[]>();
  const connect = (from: string, to: string): void => {
    edgeOrder += 1;
    edges.push({ from, to, kind: "contains", order: edgeOrder });
    structParent.set(to, from);
    const kids = structChildren.get(from);
    if (kids) {
      kids.push(to);
    } else {
      structChildren.set(from, [to]);
    }
  };

  const interfaceKey = interfaceOfLayer(doc, scopeKey)?.key;
  for (const column of columns) {
    if (interfaceKey) {
      connect(interfaceKey, column.blockKey);
    }
    for (const region of column.regions) {
      if (region.container !== column.blockKey) {
        connect(column.blockKey, region.container);
      }
      for (const controlKey of region.controls) {
        connect(region.container, controlKey);
      }
    }
  }
  // 没被这次规划接管的**结构节点**按旧结构父原样保留：
  //   · 布局里没出现的控件（否则一次同步会把别的页面的节点变成"未接通"，D108）；
  //   · 布局里已经没有对应标签组 / 列的旧容器（保留它和上级的那条边，它只是空了，
  //     **不是**失去了结构父；要不要删由用户决定，同步不替用户删节点）。
  for (const node of scopeNodes) {
    if (
      node.type !== "layout_block" &&
      node.type !== "group" &&
      node.type !== "control"
    ) {
      continue;
    }
    if (node.type === "control" && node.panel_id && panelsInLayout.has(node.panel_id)) {
      continue;
    }
    // 浮层拥有的节点：归属由浮层说了算，页面结构不再给它挂父（`overlay --contains-->`
    // 那条边本来就不属重写范围，原样留着）。
    if (overlayOwned.has(node.key)) {
      continue;
    }
    if (plannedContainers.has(node.key)) {
      continue;
    }
    const parent = oldParent.get(node.key);
    if (parent && getNode(parent) && STRUCT_PARENT.has(typeOf(parent) ?? "")) {
      connect(parent, node.key);
    }
  }

  // 前后都按**同一个**判据比：浮层子树不算页面结构边，否则浮层里那条
  // `og_1 --contains--> c_media` 会只在"后"里被算进去，平白报一次"结构变了"。
  const afterStructural = new Set(
    edges.filter(isScopeStructural).map((e) => `${e.kind}|${e.from}|${e.to}`),
  );
  const structureChanged =
    beforeStructural.size !== afterStructural.size ||
    [...beforeStructural].some((k) => !afterStructural.has(k));

  // ---------- ⑤ 把归属变了的面板簇整体搬走 ----------

  const bottoms = new Map<string, number>();
  const nodeBottom = (key: string): number =>
    (getNode(key)?.position?.y ?? ORIGIN) + CARD_H;

  /** 容器子树的下沿（可排除正在搬动的簇，避免"目标落点参照自己"）。 */
  const subtreeBottom = (
    key: string,
    excluded?: ReadonlySet<string>,
    guard: Set<string> = new Set<string>(),
  ): number => {
    if (excluded?.has(key)) return 0;
    if (guard.has(key)) return 0;
    guard.add(key);
    let bottom = Math.max(nodeBottom(key), bottoms.get(key) ?? 0);
    for (const child of structChildren.get(key) ?? []) {
      bottom = Math.max(bottom, subtreeBottom(child, excluded, guard));
    }
    return bottom;
  };

  /** 把一个簇的新下沿抬给它的祖先，后续搬动据此继续向下排。 */
  const raiseBottom = (key: string, value: number): void => {
    let cur: string | undefined = key;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      bottoms.set(cur, Math.max(bottoms.get(cur) ?? 0, value));
      cur = structParent.get(cur);
    }
  };

  /** 给没有位置的容器补一个位置（落在其父容器子树下沿之下）。 */
  const place = (
    key: string,
    excluded?: ReadonlySet<string>,
    guard: Set<string> = new Set<string>(),
  ): { x: number; y: number } => {
    const node = getNode(key);
    if (!node) return { x: ORIGIN, y: ORIGIN };
    if (node.position) return node.position;
    if (guard.has(key)) return { x: ORIGIN, y: ORIGIN };
    guard.add(key);
    const parent = structParent.get(key);
    let pos = { x: ORIGIN, y: ORIGIN };
    if (parent) {
      const parentPos = place(parent, excluded, guard);
      pos = { x: parentPos.x, y: subtreeBottom(parent, excluded) + GAP_Y };
    }
    replaceNode({ ...node, position: pos });
    return pos;
  };

  /**
   * 面板的**尾部**：沿出边走到底（类目 / 对象 / 事件 / 条件 / 动作），
   * 走到另一个面板控件即停——那是它自己的簇。
   */
  const tailOf = (anchorKey: string): string[] => {
    const out: string[] = [];
    const visited = new Set<string>([anchorKey]);
    const queue: string[] = [anchorKey];
    for (let i = 0; i < queue.length; i += 1) {
      const key = queue[i]!;
      for (const e of sourceEdges) {
        if (e.from !== key || visited.has(e.to)) continue;
        const target = getNode(e.to);
        if (!target || TAIL_STOP.has(target.type)) continue;
        visited.add(e.to);
        out.push(e.to);
        queue.push(e.to);
      }
    }
    return out;
  };

  const regrouped: string[] = [];
  const moves: TailMove[] = [];
  const movedSet = new Set<string>();

  for (const column of columns) {
    for (const region of column.regions) {
      for (const anchorKey of region.controls) {
        const previous = oldParent.get(anchorKey);
        // 归属没变 → 一个节点都不动（同步是增量的，不是重整）。
        if (previous === region.container) continue;
        const anchor = getNode(anchorKey);
        if (!anchor) continue;
        if (previous) {
          regrouped.push(anchorKey);
        }

        // 「面板及其后续（尾部）节点当作整体移动」：一次求出簇，下面逐节点同一位移。
        const clusterKeys = [anchorKey, ...tailOf(anchorKey)];
        const excluded = new Set(clusterKeys);
        const parentPos = place(region.container, excluded);
        const target = {
          x: parentPos.x,
          y: subtreeBottom(region.container, excluded) + GAP_Y,
        };
        const base = anchor.position ?? { x: ORIGIN, y: ORIGIN };
        const dx = target.x - base.x;
        const dy = target.y - base.y;

        let bottom = target.y + CARD_H;
        for (const key of clusterKeys) {
          const node = getNode(key);
          if (!node) continue;
          const current = node.position ?? base;
          const position = { x: current.x + dx, y: current.y + dy };
          replaceNode({ ...node, position });
          movedSet.add(key);
          bottom = Math.max(bottom, position.y + CARD_H);
        }
        raiseBottom(region.container, bottom + GAP_Y);
        moves.push({
          anchor: anchorKey,
          keys: clusterKeys,
          dx,
          dy,
          from: { ...base },
          to: target,
        });
      }
    }
  }

  const moved = [...movedSet];
  return {
    doc: { ...doc, nodes: next, edges },
    added,
    regrouped,
    moves,
    moved,
    panels: panelsInLayout.size,
    structureChanged,
    count: added.length + moved.length,
  };
}
