/**
 * 画布「一键整理」纯算法（RFC 0007 决策 7）。
 *
 * 以选中节点为根，沿边（**任意类型**）BFS 分层，按"列 = 层级、行 = 同层顺序"
 * 树状展开；只重排**与根连通**的节点，其余保持原位（不把孤立节点吸进网格）。
 *
 * 纯函数、无 React/宿主依赖：单独成文件的原因与 `blueprintGeometry` / `blueprintSlots`
 * 一致——几何/布局算法不进面板组件，面板只负责把结果落库。
 */

import type { BlueprintGraph } from "@hamster-pouch/config";

/** 列间距（x：每深一层向右推进）。 */
const H_GAP = 260;
/** 行间距（y：同层节点自上而下排列）。 */
const V_GAP = 84;
/** 起始坐标（与内置默认蓝图的排布口径一致）。 */
const ORIGIN = { x: 40, y: 40 };

/** 整理后的节点坐标（key → position）；不在表内的节点表示未与根连通。 */
export function arrangeTreePositions(
  doc: BlueprintGraph,
  rootKey: string,
): Map<string, { x: number; y: number }> {
  const adjacency = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from)!.push(edge.to);
  }

  const depth = new Map<string, number>([[rootKey, 0]]);
  const order: string[] = [rootKey];
  const seen = new Set<string>([rootKey]);
  const queue: { key: string; depth: number }[] = [{ key: rootKey, depth: 0 }];
  while (queue.length > 0) {
    const { key, depth: d } = queue.shift()!;
    for (const next of adjacency.get(key) ?? []) {
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      depth.set(next, d + 1);
      order.push(next);
      queue.push({ key: next, depth: d + 1 });
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  const rowCursor = new Map<number, number>();
  for (const key of order) {
    const d = depth.get(key) ?? 0;
    const y = rowCursor.get(d) ?? 0;
    rowCursor.set(d, y + V_GAP);
    positions.set(key, { x: ORIGIN.x + d * H_GAP, y: ORIGIN.y + y });
  }
  return positions;
}

/**
 * 整理：返回坐标已更新的**新文档**；未与根连通的节点保持原位。
 * 调用方负责落库（面板在整理后静默保存整文档，RFC 0007 决策 7）。
 */
export function arrangeTree(doc: BlueprintGraph, rootKey: string): BlueprintGraph {
  const positions = arrangeTreePositions(doc, rootKey);
  if (positions.size === 0) {
    return doc;
  }
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      positions.has(node.key) ? { ...node, position: positions.get(node.key)! } : node,
    ),
  };
}
