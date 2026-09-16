/**
 * 蓝图节点删除——**软删除**（RFC 0007 / 产品规则）。
 *
 * 规则（与早前的级联删除相反，用户明确要求）：
 * - **只删被点名的节点**，以及挂在它身上的边；
 * - **关联节点全部保留**：因引用丢失而无法工作的节点变灰表示"不通"，不再级联删除；
 * - 指向被删节点的字段引用**就地清空**（避免脏 key）；由画布/`blueprintLint` 判定其
 *   为未接通并灰显，用户重新接好即恢复。
 *
 * 这样"删除"不会连带清掉用户辛苦搭的其它节点，未接通状态也一目了然；后端校验把
 * 未接通类问题降级为软告警（不阻塞保存），所以删除后可以直接保存。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-delete-check.mjs）。
 */

import type { BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";

export interface SoftRemoveResult {
  doc: BlueprintGraph;
  /** 实际被移除的节点 key（软删除下就是根节点自身，或其不存在时为空）。 */
  removed: string[];
  /** 因引用被清空而变成"未接通"的节点 key（画布灰显），仅供提示用。 */
  unlinked: string[];
}

/**
 * 软删除：移除 `rootKey` 节点与其关联边；其它节点保留，指向它的字段引用清空。
 * 节点不存在时原样返回。
 */
export function softRemove(doc: BlueprintGraph, rootKey: string): SoftRemoveResult {
  if (!doc.nodes.some((n) => n.key === rootKey)) {
    return { doc, removed: [], unlinked: [] };
  }
  const cleared: string[] = [];
  const nodes: BlueprintNode[] = [];
  for (const node of doc.nodes) {
    if (node.key === rootKey) {
      continue;
    }
    let next = node;
    // 指向被删节点的必填引用就地清空（节点保留 → 后续按"未接通"灰显）。
    if (node.control === rootKey || node.class === rootKey || node.target === rootKey) {
      next = { ...next };
      if (next.control === rootKey) {
        next.control = undefined;
      }
      if (next.class === rootKey) {
        next.class = undefined;
      }
      if (next.target === rootKey) {
        next.target = undefined;
      }
      cleared.push(node.key);
    }
    // 可选引用：组默认可见成员、hide_direction 指定邻居。
    const visible = (next.default_visible ?? []).filter((k) => k !== rootKey);
    if (visible.length !== (next.default_visible ?? []).length) {
      next = { ...next, default_visible: visible };
    }
    if (next.hide_direction === `toward:${rootKey}`) {
      next = { ...next, hide_direction: undefined };
    }
    nodes.push(next);
  }

  return {
    doc: {
      ...doc,
      nodes,
      edges: doc.edges.filter((e) => e.from !== rootKey && e.to !== rootKey),
    },
    removed: [rootKey],
    unlinked: cleared,
  };
}
