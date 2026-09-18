/**
 * 蓝图图文档分析（RFC 0007）：把"未接通"状态从图结构里**派生**出来。
 *
 * 产品规则：删除节点/断线后，**关联节点保留、不级联删除**；无法工作的节点在画布上
 * 显示为灰色（"不通"），重新接好后自动恢复。因此"是否接通"不落库、不靠额外标记，
 * 而是由图本身推导——这样保存/装载后状态一致，接回引用即恢复彩色。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-lint-check.mjs）。
 */

import type {
  BlueprintGraph,
  BlueprintNode,
  BlueprintUnlinkedMap,
  BlueprintUnlinkedReason,
} from "@hamster-pouch/config";

/** 求值链节点（操作/条件/状态）必须有触发来源，否则不会被执行。 */
const CHAIN_TYPES: BlueprintNode["type"][] = ["event", "condition", "action"];

/** 节点是否还有触发来源（与后端校验口径一致）。 */
function hasSource(node: BlueprintNode, graph: BlueprintGraph): boolean {
  switch (node.type) {
    case "event":
      return (
        node.target !== undefined ||
        graph.edges.some((e) => e.kind === "on" && e.to === node.key)
      );
    case "condition":
      return graph.edges.some((e) => e.kind === "fires" && e.to === node.key);
    case "action":
      return graph.edges.some(
        (e) => (e.kind === "fires" || e.kind === "guards") && e.to === node.key,
      );
    default:
      return true;
  }
}

/**
 * 计算"未接通"节点：返回 key → 原因。
 *
 * 判定（与后端软告警口径一致，**不阻塞保存**）：
 * - 控件缺 `panel_id`、类缺 `control`、对象缺 `class`、状态缺 `target`；
 * - 引用指向**已不存在的节点**（删除关联节点后的常见状态）；
 * - 操作缺对象来源、条件/状态缺触发来源。
 *
 * 引用指向"存在但类型不对"的节点仍属硬错误（由后端拒绝），不算"未接通"。
 */
export function analyzeUnlinked(graph: BlueprintGraph): BlueprintUnlinkedMap {
  const byKey = new Set(graph.nodes.map((n) => n.key));
  const result: BlueprintUnlinkedMap = {};
  const mark = (key: string, reason: BlueprintUnlinkedReason) => {
    if (!result[key]) {
      result[key] = reason;
    }
  };

  for (const node of graph.nodes) {
    switch (node.type) {
      case "control":
        if (!node.panel_id) {
          mark(node.key, "missing-control");
        }
        break;
      case "class":
        if (!node.control || !byKey.has(node.control)) {
          mark(node.key, "missing-control");
        }
        break;
      case "object":
        if (!node.class || !byKey.has(node.class)) {
          mark(node.key, "missing-class");
        }
        break;
      case "action":
        if (!node.target || !byKey.has(node.target)) {
          mark(node.key, "missing-target");
        }
        break;
      case "overlay":
        // 浮层必须连在界面上（`界面 --contains--> 浮层`）才算"属于本页"；
        // 断开连接 = 未接通（与 hp-core `warnings` 口径一致），运行时也不显示。
        if (
          !graph.edges.some((e) => {
            if (e.kind !== "contains" || e.to !== node.key) {
              return false;
            }
            return graph.nodes.find((n) => n.key === e.from)?.type === "interface";
          })
        ) {
          mark(node.key, "missing-interface");
        }
        break;
      default:
        break;
    }
    if (CHAIN_TYPES.includes(node.type) && !hasSource(node, graph)) {
      mark(
        node.key,
        node.type === "event" ? "missing-object-source" : "missing-trigger",
      );
    }
  }
  return result;
}

/** 便捷：把分析结果写回节点（供画布渲染，返回新文档；不落库）。 */
export function withUnlinkedFlags(graph: BlueprintGraph): BlueprintGraph {
  const unlinked = analyzeUnlinked(graph);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const next = { ...n, unlinked: undefined } as BlueprintNode;
      if (unlinked[n.key]) {
        next.unlinked = true;
      } else {
        delete next.unlinked;
      }
      return next;
    }),
  };
}
