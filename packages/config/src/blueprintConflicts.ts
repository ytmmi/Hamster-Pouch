/**
 * 蓝图**状态冲突**检测（`docs/spec/blueprint-node-standard.md` 第 6 节新增规则）。
 *
 * 规则：同**界面（层）** + 同**对象** + 同**触发**下，一次交互不可能同时落到两个互斥状态：
 * 1. **互斥状态**：同一目标被同时赋予互斥操作 —— `show`/`hide`、`show`/`toggle`；
 *    标签组同时 `collapse`/`expand`；界面同时 `navigate` 到两个不同界面。
 *    重复同一操作（`show` 两次）不算冲突；`toggle` 与 `hide` 的组合允许。
 * 2. **互斥组多成员同时显示**：同一次交互把同一互斥组（`mode = exclusive`）的两个不同
 *    成员面板都置为 `show`/`toggle`。
 *
 * 这是 **Rust `blueprint_validate::find_state_conflicts` 的前端镜像**：后端仍是权威
 * （保存前 `blueprint.validate` 拒绝），前端这份用于**解析层拦截 + 画布定位**，
 * 两侧口径必须一致（`pnpm check:blueprint-nodes` 断言两侧一致）。
 *
 * 纯函数：不依赖 React/dockview。
 */

import {
  MUTUALLY_EXCLUSIVE_OPS,
  VISIBLE_OPS as VISIBLE_OP_VALUES,
} from "./blueprintNodes";
import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from "./blueprint";

/** 互斥的一对操作（顺序无关）；清单来自节点定义表，与 Rust 校验同源。 */
const EXCLUSIVE_OPS: readonly (readonly [string, string])[] = MUTUALLY_EXCLUSIVE_OPS;

/** 表示"让目标可见"的操作。 */
const VISIBLE_OPS = new Set<string>(VISIBLE_OP_VALUES);

/** 两个操作是否互斥。 */
export function opsAreExclusive(a: string, b: string): boolean {
  return EXCLUSIVE_OPS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** 一次交互落到的一个状态。 */
interface ActionState {
  action: string;
  op: string;
  target: string;
  /** 目标面板 id（互斥组判定用）。 */
  panelId?: string;
}

/** 冲突描述（供编辑器提示与画布标红）。 */
export interface BlueprintStateConflict {
  /** 触发来源对象/类/面板控件的 key。 */
  source: string;
  trigger: string;
  /** 冲突原因（已本地化前的中文描述，与后端报错同口径）。 */
  message: string;
  /** 涉及的动作节点 key（画布可据此标红）。 */
  actions: string[];
  /** 涉及的互斥组 key（互斥组成员冲突时给出）。 */
  group?: string;
}

/** 找出一份蓝图里的全部状态冲突（同界面同对象同触发下的多状态冲突）。 */
export function findStateConflicts(graph: BlueprintGraph): BlueprintStateConflict[] {
  const conflicts: BlueprintStateConflict[] = [];
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));

  /** 沿 `fires`/`guards` 收集可达动作（带环保护）。 */
  const reachableActions = (eventKeys: string[]): BlueprintNode[] => {
    const seen = new Set(eventKeys);
    const queue = [...eventKeys];
    const actions: BlueprintNode[] = [];
    while (queue.length > 0) {
      const key = queue.pop()!;
      for (const edge of graph.edges) {
        if (edge.from !== key || (edge.kind !== "fires" && edge.kind !== "guards")) continue;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        const node = byKey.get(edge.to);
        if (node?.type === "action") actions.push(node);
        else if (node?.type === "condition") queue.push(node.key);
      }
    }
    return actions;
  };

  const onEdges = (): BlueprintEdge[] => graph.edges.filter((e) => e.kind === "on");

  for (const source of graph.nodes) {
    if (source.type !== "control" && source.type !== "class" && source.type !== "object") {
      continue;
    }
    // 本对象触发的事件节点，按 trigger 分组。
    const events = onEdges()
      .filter((e) => e.from === source.key)
      .map((e) => byKey.get(e.to))
      .filter((n): n is BlueprintNode => n?.type === "event" && !!n.trigger);
    const triggers = [...new Set(events.map((n) => n.trigger as string))];

    for (const trigger of triggers) {
      const eventKeys = events
        .filter((n) => n.trigger === trigger)
        .map((n) => n.key);
      const states: ActionState[] = [];
      for (const action of reachableActions(eventKeys)) {
        const target = action.target;
        if (!target) continue;
        const targetNode = byKey.get(target);
        states.push({
          action: action.key,
          op: String(action.op ?? ""),
          target,
          panelId: targetNode?.panel_id,
        });
      }

      // 1. 同一目标的互斥状态。
      for (let i = 0; i < states.length; i += 1) {
        for (let j = i + 1; j < states.length; j += 1) {
          const a = states[i];
          const b = states[j];
          if (a.target !== b.target || !opsAreExclusive(a.op, b.op)) continue;
          conflicts.push({
            source: source.key,
            trigger,
            actions: [a.action, b.action],
            message:
              `同界面同对象同触发「${trigger}」状态冲突：对象 ${source.key} 的两个状态同时作用于 ` +
              `${a.target}（${a.action}:${a.op} / ${b.action}:${b.op}）`,
          });
        }
      }

      // 2. 同一互斥组里的两个成员被同时显示。
      for (let i = 0; i < states.length; i += 1) {
        const a = states[i];
        if (!VISIBLE_OPS.has(a.op) || !a.panelId) continue;
        for (let j = i + 1; j < states.length; j += 1) {
          const b = states[j];
          if (!VISIBLE_OPS.has(b.op) || !b.panelId || a.panelId === b.panelId) continue;
          const group = graph.nodes.find(
            (g) =>
              g.type === "group" &&
              g.mode === "exclusive" &&
              graph.edges.some(
                (e) => e.kind === "contains" && e.from === g.key && e.to === a.target,
              ) &&
              graph.edges.some(
                (e) => e.kind === "contains" && e.from === g.key && e.to === b.target,
              ),
          );
          if (!group) continue;
          conflicts.push({
            source: source.key,
            trigger,
            group: group.key,
            actions: [a.action, b.action],
            message:
              `同界面同对象同触发「${trigger}」状态冲突：互斥组 ${group.key} 的成员 ` +
              `${a.target} 与 ${b.target} 被同时置为显示`,
          });
        }
      }
    }
  }
  return conflicts;
}
