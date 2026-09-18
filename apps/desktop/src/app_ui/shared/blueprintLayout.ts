/**
 * 蓝图 → dockview 布局对账（RFC 0007 决策 3 / D29 / D51）。
 *
 * 蓝图在 `layout.*`（D1）给出的面板位置/大小/分组结构**基准**之上叠加：
 * 标签组（互斥组）默认可见成员、组的收起/展开（= 最小化至 `PANEL_MIN_SIZE`，
 * 标签条保留、组结构不删除）。本模块只做"对账"：把蓝图语义套到**当前** dockview
 * 布局上，不重写布局持久化机制本身。
 *
 * 对账时机（防漂移）：仓库切换 / 蓝图保存后热更新 / 套用布局 / 切层 / 语言或主题引起的重渲染。
 * **只对账当前层**（D51/D54）：非当前层的组与动作属于别的页面，套到当前布局上就是漂移。
 *
 * 设计取舍：
 * - 收起（collapse）由 `group.api.setSize(PANEL_MIN_SIZE)` 表达：dockview 会把释放的
 *   空间按网格规则分给相邻组（D29「组拉伸」）；`hide_direction` 的精确邻居选择属
 *   实现期开放点，当前映射为"缩小本组 → 由网格吸收"。
 * - 只动成员面板齐全的组；不碰浮动组（避免把用户浮动出来的面板塞回网格）。
 * - 收起/展开的尺寸记忆集中在 `collapseGroup` / `expandGroup`，供引擎的
 *   `collapse`/`expand`/`hide` 动作共用（同一份实现，避免"恢复不了原尺寸"）。
 */

import type { BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";
import { PANEL_MIN_SIZE, edgesOfLayer, nodeLayerKey, nodesOfLayer } from "@hamster-pouch/config";
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";

/** 收起前的组尺寸（按 dockview 组 id 记忆，`expand` 时恢复）。 */
const expandedSizes = new Map<string, { width: number; height: number }>();

/** 诊断日志回调（应用装配层注入；null = 不记录）。 */
let logger: ((message: string) => void) | null = null;

/** 注入诊断日志回调（用于打包运行下排查对账行为）。 */
export function setLayoutReconcileLogger(
  next: ((message: string) => void) | null,
): void {
  logger = next;
}

/** 收起时的目标尺寸：正文 6px、标签条保留（D25 `PANEL_MIN_SIZE` 机制）。 */
const COLLAPSED_SIZE = {
  width: PANEL_MIN_SIZE.minimumWidth,
  height: PANEL_MIN_SIZE.minimumHeight,
};

/** 展开时的兜底尺寸（无记录时使用）。 */
const EXPAND_FALLBACK = { width: 480, height: 320 };

/**
 * 取**某一层**的图视图（`layerKey` 为空 = 不限层，单层兜底文档与旧调用照旧）。
 *
 * 对账只作用于当前层：别的层的组节点与动作节点不属于正在显示的页面（D51/D54）。
 */
function scopedGraph(
  graph: BlueprintGraph,
  layerKey: string | null | undefined,
): BlueprintGraph {
  if (!layerKey) {
    return graph;
  }
  return {
    ...graph,
    nodes: nodesOfLayer(graph, layerKey),
    edges: edgesOfLayer(graph, layerKey),
  };
}

/** 蓝图组 → 当前 dockview 组的映射（取命中成员最多的那个组）。 */
function matchGroups(
  graph: BlueprintGraph,
  dv: DockviewApi,
): { node: BlueprintNode; group: DockviewGroupPanel }[] {
  const panelKeys = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.type === "control" && n.panel_id) {
      panelKeys.set(n.key, n.panel_id);
    }
  }
  // 标签组 → 成员控件 key（contains）
  const members = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== "contains") {
      continue;
    }
    const from = graph.nodes.find((n) => n.key === e.from);
    if (from?.type !== "group") {
      continue;
    }
    const list = members.get(e.from) ?? [];
    list.push(e.to);
    members.set(e.from, list);
  }

  const groups = dv.groups.filter((g) => g.api.location.type !== "floating");
  const out: { node: BlueprintNode; group: DockviewGroupPanel }[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "group") {
      continue;
    }
    const wanted = (members.get(node.key) ?? [])
      .map((k) => panelKeys.get(k))
      .filter((v): v is string => !!v);
    if (wanted.length === 0) {
      continue;
    }
    let best: DockviewGroupPanel | null = null;
    let bestScore = 0;
    for (const group of groups) {
      const ids = new Set(group.panels.map((p) => p.id));
      const score = wanted.filter((id) => ids.has(id)).length;
      if (score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) {
      out.push({ node, group: best });
    }
  }
  return out;
}

/** 动作节点是否位于「操作/条件 → 状态」求值链上（可达即视为生效）。 */
function reachableActionKeys(graph: BlueprintGraph): Set<string> {
  const reachable = new Set<string>();
  const roots = graph.nodes
    .filter((n) => n.type === "event" || n.type === "condition")
    .map((n) => n.key);
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== key || (e.kind !== "fires" && e.kind !== "guards")) {
        continue;
      }
      if (reachable.has(e.to)) {
        continue;
      }
      reachable.add(e.to);
      queue.push(e.to);
    }
  }
  return reachable;
}

/** 蓝图里对组声明了 collapse / expand 的组 key（仅求值链可达的动作）。 */
function declaredGroupStates(graph: BlueprintGraph): {
  collapsed: Set<string>;
  expanded: Set<string>;
} {
  const reachable = reachableActionKeys(graph);
  const collapsed = new Set<string>();
  const expanded = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== "action" || !n.target || !reachable.has(n.key)) {
      continue;
    }
    const target = graph.nodes.find((x) => x.key === n.target);
    if (target?.type !== "group") {
      continue;
    }
    if (n.op === "collapse") {
      collapsed.add(n.target);
    } else if (n.op === "expand") {
      expanded.add(n.target);
    }
  }
  return { collapsed, expanded };
}

/**
 * 收起一个 dockview 组：记忆原尺寸并压到 `PANEL_MIN_SIZE`（正文 6px、标签条保留）。
 *
 * 供本模块的对账与引擎的 `collapse` / `hide` 动作**共用**（同一份尺寸记忆，
 * 否则 `expand` 恢复不到收起前的尺寸分布，RFC 0007 决策 3）。
 * 重复收起不会覆盖已记忆的原尺寸（第二次的 boundingBox 已经是收起后的）。
 */
export function collapseGroup(group: DockviewGroupPanel): void {
  const box = group.api.boundingBox;
  if (!expandedSizes.has(group.id) && box && box.width > 0 && box.height > 0) {
    expandedSizes.set(group.id, { width: box.width, height: box.height });
  }
  try {
    group.api.setSize({ ...COLLAPSED_SIZE });
  } catch {
    // dockview 网格约束下忽略：**不关闭面板**（RFC 0007：隐藏 = 收起，不是关闭）。
  }
}

/** 展开一个 dockview 组：恢复收起前的尺寸（无记录用兜底尺寸），并清掉记忆。 */
export function expandGroup(group: DockviewGroupPanel): void {
  const saved = expandedSizes.get(group.id) ?? EXPAND_FALLBACK;
  expandedSizes.delete(group.id);
  try {
    group.api.setSize({ width: saved.width, height: saved.height });
  } catch {
    /* 忽略 */
  }
}

/**
 * 按蓝图对账当前布局（幂等；无蓝图或无可映射组时不动布局）。
 *
 * `layerKey` = 当前层（D51/D54）：只对账该层的组；`null`/省略 = 不限层
 * （单层兜底文档，或调用方明确要对账整篇文档）。
 * 返回对账摘要（供状态栏/调试，不参与业务）。
 */
export function reconcileLayout(
  graph: BlueprintGraph | null,
  dv: DockviewApi | null,
  layerKey?: string | null,
): {
  groups: number;
  activated: number;
  collapsed: number;
} {
  if (!graph || !dv) {
    return { groups: 0, activated: 0, collapsed: 0 };
  }
  const scoped = scopedGraph(graph, layerKey);
  const matched = matchGroups(scoped, dv);
  const { collapsed, expanded } = declaredGroupStates(scoped);

  let activated = 0;
  let collapsedCount = 0;
  for (const { node, group } of matched) {
    // 互斥组：默认可见成员存在时激活其标签（非互斥组保留用户当前标签）。
    const activeBefore = group.activePanel?.id ?? "-";
    if (node.mode === "exclusive" && (node.default_visible?.length ?? 0) > 0) {
      for (const key of node.default_visible ?? []) {
        const panelId = scoped.nodes.find((n) => n.key === key)?.panel_id;
        const panel = panelId ? group.panels.find((p) => p.id === panelId) : undefined;
        if (panel) {
          panel.api.setActive();
          activated += 1;
          break;
        }
      }
    }
    logger?.(
      `[reconcile] layer=${layerKey ?? "(all)"} group=${node.key} mode=${node.mode ?? "-"} default=${(node.default_visible ?? []).join("|") || "-"} dockviewGroup=${group.id} active=${activeBefore}→${group.activePanel?.id ?? "-"} members=[${group.panels
        .map((p) => p.id)
        .join(", ")}] collapse=${collapsed.has(node.key)} expand=${expanded.has(node.key)}`,
    );
    // 组收起/展开：expanded 优先（同一组两者都有时以展开为准，避免"存了收起态却打不开"）。
    if (expanded.has(node.key)) {
      expandGroup(group);
    } else if (collapsed.has(node.key)) {
      collapseGroup(group);
      collapsedCount += 1;
    }
  }
  return { groups: matched.length, activated, collapsed: collapsedCount };
}

/** 某层的组节点数（供状态/调试；不计入对账副作用）。 */
export function groupCountOfLayer(
  graph: BlueprintGraph | null,
  layerKey: string | null | undefined,
): number {
  if (!graph) {
    return 0;
  }
  return scopedGraph(graph, layerKey).nodes.filter((n) => n.type === "group").length;
}

/** 当前层内"某节点是否属于该层"（供面板按层过滤候选时复用同一口径）。 */
export function isInLayer(
  graph: BlueprintGraph,
  node: BlueprintNode,
  layerKey: string | null | undefined,
): boolean {
  return !layerKey || nodeLayerKey(graph, node) === layerKey;
}

/** 清空收起尺寸记忆（仓库切换 / 套用布局后调用）。 */
export function resetLayoutReconcileState(): void {
  expandedSizes.clear();
}
