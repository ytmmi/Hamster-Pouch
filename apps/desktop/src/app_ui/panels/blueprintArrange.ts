/**
 * 画布「一键整理」纯算法（RFC 0007 决策 7）。
 *
 * 以**选中节点为起始节点**，沿边（**任意类型**）BFS 分层，按"列 = 层级、行 = 同层顺序"
 * 树状展开；只重排**与根连通**的节点，其余保持原位（不把孤立节点吸进网格）。
 *
 * 三条硬约束（用户口径）：
 * 1. **起始节点位置不变**：整理以它为中心展开，不会把它搬回世界原点
 *    （旧实现把根固定落在 `ORIGIN`，表现为"整理后选中节点跳回原点"）；
 * 2. **不拥挤、不重叠**：同列节点按 `V_GAP` 递增，且落位时**避让**任何已占用位置
 *    （包括不参与整理的孤立节点）——间距按节点卡片实测尺寸 + 余量判定；
 * 3. **间距只在这里放大**：新增节点的槽位（`blueprintSlots`）保持原样，
 *    间距差异**仅限整理**。
 *
 * 纯函数、无 React/宿主依赖：单独成文件的原因与 `blueprintGeometry` / `blueprintSlots`
 * 一致——几何/布局算法不进面板组件，面板只负责把结果落库。
 */

import type { BlueprintGraph } from "@hamster-pouch/config";

/** 列间距（x：每深一层向右推进）。 */
const H_GAP = 300;
/**
 * 行间距（y：同层节点自上而下排列）。
 *
 * 必须**大于**节点卡片高度 + 余量，否则同列节点会视觉重叠（旧值 84 < 卡片高 110，
 * 正是"整理后节点挤在一起"的根因）。
 */
const V_GAP = 170;
/** 节点卡片近似尺寸（与画布 `NODE_CARD` 同口径；整理时据此判定重叠）。 */
const CARD = { w: 216, h: 110 };
/** 卡片之间的最小余量（px）：判定重叠时的膨胀量。 */
const MARGIN = 24;
/** 起始节点缺失 `position` 时的兜底坐标（与内置默认蓝图的排布口径一致）。 */
const ORIGIN = { x: 40, y: 40 };

/** 两个位置是否会视觉重叠（按卡片尺寸 + 余量膨胀后判定）。 */
function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return Math.abs(a.x - b.x) < CARD.w + MARGIN && Math.abs(a.y - b.y) < CARD.h + MARGIN;
}

/**
 * 整理后的节点坐标（key → position）；不在表内的节点表示未与根连通。
 *
 * 起始节点（`rootKey`）的坐标**原样保留**；其余连通节点按列铺开并避让已占用位置。
 */
export function arrangeTreePositions(
  doc: BlueprintGraph,
  rootKey: string,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const root = doc.nodes.find((n) => n.key === rootKey);
  if (!root) {
    return positions;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from)!.push(edge.to);
  }

  const depth = new Map<string, number>([[rootKey, 0]]);
  /** 每层的节点顺序（BFS 发现顺序，决定同列自上而下的次序）。 */
  const order: string[] = [rootKey];
  const seen = new Set<string>([rootKey]);
  const queue: { key: string; depth: number }[] = [{ key: rootKey, depth: 0 }];
  while (queue.length > 0) {
    const { key, depth: d } = queue.shift()!;
    for (const next of adjacency.get(key) ?? []) {
      if (seen.has(next) || !doc.nodes.some((n) => n.key === next)) {
        continue;
      }
      seen.add(next);
      depth.set(next, d + 1);
      order.push(next);
      queue.push({ key: next, depth: d + 1 });
    }
  }

  // 起始节点保持原位（用户口径 1）：整理不搬动它。
  const rootPos = root.position ?? ORIGIN;
  /** 已占用位置：先放**不参与整理**的孤立节点，它们原位不动，新落位必须避让。 */
  const occupied: { x: number; y: number }[] = [];
  for (const node of doc.nodes) {
    if (!depth.has(node.key) && node.position) {
      occupied.push(node.position);
    }
  }

  const rowCursor = new Map<number, number>();
  for (const key of order) {
    const d = depth.get(key) ?? 0;
    const x = rootPos.x + d * H_GAP;
    if (d === 0) {
      positions.set(key, rootPos);
      occupied.push(rootPos);
      rowCursor.set(0, rootPos.y + V_GAP);
      continue;
    }
    let y = rowCursor.get(d) ?? rootPos.y;
    // 避让：与任何已占用位置重叠时继续下移（保证"不拥挤、不重叠"）。
    while (occupied.some((p) => overlaps({ x, y }, p))) {
      y += V_GAP;
    }
    const at = { x, y };
    positions.set(key, at);
    occupied.push(at);
    rowCursor.set(d, y + V_GAP);
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

/** 整理时的间距常量（供自检脚本断言"上下间距足够、不重叠"）。 */
export const ARRANGE_GAPS = { horizontal: H_GAP, vertical: V_GAP, card: CARD, margin: MARGIN } as const;
