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
import { nodeSpecOrNull, panelSpec } from "@hamster-pouch/config";

/** 求值链节点（操作/条件/状态）必须有触发来源，否则不会被执行。 */
const CHAIN_TYPES: BlueprintNode["type"][] = ["event", "condition", "action"];

/**
 * 该面板是否**有类目**（RFC 0010 决策 4 / 面板标准第 5.1 节）。
 *
 * 返回值语义：`true` / `false` = 有明确声明；`undefined` = 面板当前无注册项
 * （插件未安装/未启用/API 不兼容）或未填 `panel_id` —— 无从判定，不在此处标记
 * （面板缺失本身已按"未接通"处理）。
 */
function panelHasClass(graph: BlueprintGraph, controlKey: string): boolean | undefined {
  const control = graph.nodes.find((n) => n.key === controlKey);
  if (!control || control.type !== "control") return undefined;
  const panelId = control.panel_id?.trim();
  if (!panelId) return undefined;
  return panelSpec(panelId)?.hasClass;
}

/**
 * 该节点类型当前是否**有注册项**（RFC 0010 决策 6）。
 *
 * 插件注册的节点类型在插件缺失时没有注册项 → 画布灰显「未接通」、**允许保存**、
 * 插件恢复后自动恢复。
 */
function nodeTypeRegistered(node: BlueprintNode): boolean {
  return nodeSpecOrNull(node.type) !== undefined;
}

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
 * - 操作缺对象来源、条件/状态缺触发来源；
 * - 节点类型**当前无注册项**（插件缺失，RFC 0010 决策 6）；
 * - 类目挂在**无类目**的面板下（`has_class = false`，RFC 0010 决策 4）。
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
    // RFC 0010 决策 6：节点类型**当前无注册项**（插件未安装 / 未启用 / 宿主 API 不兼容）
    // → 未接通（灰显、允许保存、恢复后自动恢复）。命名不合规则的类型是**硬错误**，
    // 由解析层/后端拒绝，不在"未接通"之列。
    if (!nodeTypeRegistered(node)) {
      mark(node.key, "missing-registration");
    }
    switch (node.type) {
      case "control":
        if (!node.panel_id) {
          mark(node.key, "missing-control");
        }
        break;
      case "class": {
        if (!node.control || !byKey.has(node.control)) {
          mark(node.key, "missing-control");
        } else if (panelHasClass(graph, node.control) === false) {
          // 类目挂在**无类目**的面板下：宿主内置面板是硬错误（保存时被拒），
          // 插件注册面板是未接通——两种情况在画布上都先灰显提示。
          mark(node.key, "panel-has-no-class");
        }
        break;
      }
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
