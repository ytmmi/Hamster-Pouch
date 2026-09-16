/**
 * 蓝图运行时引擎（RFC 0007 决策 3 / D29）。
 *
 * 职责：加载当前生效蓝图（仓库默认或内置默认），订阅 UI 事件（单击/双击/选中），
 * 按图求值（fires/guards DAG）→ 输出 dockview 操作序列（面板显隐 + 组收起/展开），
 * 由外部注入的 Executor 执行。
 *
 * 求值语义：
 * - 事件节点按 trigger + target（类/对象）匹配 dispatch 上报的目标；
 * - 沿 fires/guards 边按 order 升序执行；条件为真才继续；
 * - 互斥组不自动隐藏成员：同 dockview 组的成员共享显示区域，标签激活天然保证
 *   同一时间仅一个激活；跨 dockview 组的成员不做自动隐藏/收缩（避免破坏用户布局），
 *   如需隐藏/收起请用显式 hide/collapse 动作；
 * - 幂等：重复触发不产生额外副作用（show 已存在面板 = 激活）。
 *
 * 组收起/拉伸（collapse/expand）与隐藏方向（hide_direction）的 dockview 映射属于
 * 实现期开放点（RFC 0007）：本引擎把组收起翻译为对其成员面板的最小化/恢复操作，
 * 具体尺寸策略由 Executor 决定。
 */

import type {
  BlueprintActionOp,
  BlueprintEdge,
  BlueprintGraph,
  BlueprintNode,
  BlueprintTargetRef,
  BlueprintTrigger,
} from "@hamster-pouch/config";

/** 引擎对外执行器（由应用装配层注入，与 dockview/媒体命令解耦）。 */
export interface BlueprintExecutor {
  /** 显示控件：已存在则激活，不存在则按浮动创建。 */
  showPanel: (panelId: string, floating: boolean) => void;
  /** 隐藏控件（关闭面板）。 */
  hidePanel: (panelId: string) => void;
  /** 切换控件显隐。 */
  togglePanel: (panelId: string, floating: boolean) => void;
  /** 收起组：把组内成员面板最小化至最小尺寸（标签条保留，D25）。 */
  collapsePanels: (panelIds: string[]) => void;
  /** 展开组：恢复成员面板尺寸。 */
  expandPanels: (panelIds: string[]) => void;
  /** 播放文件（action payload { play: true } 联动）。 */
  playFile: (fileId: string) => void;
}

/** dispatch 入参（单击/双击/选中变化 + 目标条目）。 */
export interface BlueprintDispatchInput {
  trigger: BlueprintTrigger;
  target: BlueprintTargetRef;
  /** 条件求值上下文（rating / has_tag 用；缺省按 false 处理）。 */
  context?: { rating?: number; tags?: string[] };
}

const SCOPE_FOR_TRIGGER: Record<BlueprintTrigger, string> = {
  click: "clicked",
  double_click: "double_clicked",
  selection_change: "selected",
};

/** 蓝图运行时引擎实现。 */
export class BlueprintEngine {
  private graph: BlueprintGraph | null = null;
  private executor: BlueprintExecutor | null = null;

  /** 注入执行器（应用装配层调用）。 */
  setExecutor(executor: BlueprintExecutor | null): void {
    this.executor = executor;
  }

  /** 设置当前生效蓝图（仓库默认或内置默认；null = 无蓝图）。 */
  setGraph(graph: BlueprintGraph | null): void {
    this.graph = graph;
  }

  /** 当前是否已装载蓝图。 */
  hasGraph(): boolean {
    return this.graph !== null;
  }

  /** 事件分发入口：按 trigger + target 匹配事件节点并求值。 */
  dispatch(input: BlueprintDispatchInput): void {
    const graph = this.graph;
    const executor = this.executor;
    if (!graph || !executor) {
      return;
    }
    const scope = input.target.scope ?? SCOPE_FOR_TRIGGER[input.trigger];
    const events = graph.nodes.filter(
      (n) =>
        n.type === "event" &&
        n.trigger === input.trigger &&
        this.eventMatches(n, input.target, scope, graph),
    );
    for (const ev of events) {
      this.evalChain(ev.key, new Set<string>(), graph, input);
    }
  }

  /** 事件 target（类或对象）与上报目标是否匹配。 */
  private eventMatches(
    event: BlueprintNode,
    target: BlueprintTargetRef,
    scope: string,
    graph: BlueprintGraph,
  ): boolean {
    if (!event.target) {
      return false;
    }
    const node = graph.nodes.find((n) => n.key === event.target);
    if (!node) {
      return false;
    }
    if (node.type === "class") {
      return node.media_type === target.mediaType;
    }
    if (node.type === "object") {
      if (node.scope && node.scope !== scope) {
        return false;
      }
      const classNode = node.class
        ? graph.nodes.find((n) => n.key === node.class)
        : undefined;
      if (!classNode || classNode.type !== "class") {
        return false;
      }
      return classNode.media_type === target.mediaType;
    }
    return false;
  }

  /** 沿 fires/guards 边求值（order 升序；条件为真才继续；visited 防环）。 */
  private evalChain(
    fromKey: string,
    visited: Set<string>,
    graph: BlueprintGraph,
    input: BlueprintDispatchInput,
  ): void {
    if (visited.has(fromKey)) {
      return;
    }
    visited.add(fromKey);
    const out = graph.edges
      .filter(
        (e) =>
          e.from === fromKey &&
          (e.kind === "fires" || e.kind === "guards"),
      )
      .sort((a, b) => a.order - b.order);
    for (const edge of out) {
      const node = graph.nodes.find((n) => n.key === edge.to);
      if (!node) {
        continue;
      }
      if (node.type === "condition") {
        if (this.evaluateCondition(node, input)) {
          this.evalChain(node.key, visited, graph, input);
        }
        continue;
      }
      if (node.type === "action") {
        this.executeAction(node, input);
      }
    }
  }

  /** 基础条件求值（RFC 0007 决策 1：media_type / selection / rating / has_tag）。 */
  private evaluateCondition(node: BlueprintNode, input: BlueprintDispatchInput): boolean {
    const tokens = (node.expr ?? "").split(/\s+/);
    if (tokens.length !== 3) {
      return false;
    }
    const [lhs, op, rhs] = tokens;
    switch (lhs) {
      case "media_type":
        return op === "==" && input.target.mediaType === rhs;
      case "selection":
        return op === "!=" && rhs === "empty" && !!input.target.fileId;
      case "rating": {
        if (op !== ">=" || input.context?.rating === undefined) {
          return false;
        }
        const threshold = Number(rhs);
        return Number.isFinite(threshold) && input.context.rating >= threshold;
      }
      case "has_tag": {
        if (op !== "==" || !input.context?.tags) {
          return false;
        }
        return input.context.tags.includes(rhs);
      }
      default:
        return false;
    }
  }

  /** 执行动作：show/hide/toggle（控件）+ collapse/expand（组）+ play 联动。 */
  private executeAction(action: BlueprintNode, input: BlueprintDispatchInput): void {
    const executor = this.executor;
    if (!executor) {
      return;
    }
    const op = action.op as BlueprintActionOp | undefined;
    if (!op || !action.target) {
      return;
    }
    const graph = this.graph;
    if (!graph) {
      return;
    }
    const target = graph.nodes.find((n) => n.key === action.target);

    switch (op) {
      case "show": {
        if (target?.type !== "control" || !target.panel_id) {
          return;
        }
        // 显示目标控件：已存在则激活，不存在则创建。
        // 互斥组不在此处自动隐藏其他成员：同 dockview 组的成员共享显示区域，
        // 标签激活天然保证同一时间仅一个激活；跨 dockview 组的成员不做自动
        // 隐藏/收缩（避免破坏用户布局）。如需隐藏/收起请用显式 hide/collapse 动作。
        executor.showPanel(target.panel_id, true);
        break;
      }
      case "hide": {
        if (target?.type === "control" && target.panel_id) {
          executor.hidePanel(target.panel_id);
        }
        break;
      }
      case "toggle": {
        if (target?.type === "control" && target.panel_id) {
          executor.togglePanel(target.panel_id, true);
        } else if (target?.type === "group") {
          const members = this.groupMemberPanelIds(target.key, graph);
          if (members.length > 0) {
            executor.collapsePanels(members);
          }
        }
        break;
      }
      case "collapse": {
        if (target?.type === "group") {
          const members = this.groupMemberPanelIds(target.key, graph);
          if (members.length > 0) {
            executor.collapsePanels(members);
          }
        }
        break;
      }
      case "expand": {
        if (target?.type === "group") {
          const members = this.groupMemberPanelIds(target.key, graph);
          if (members.length > 0) {
            executor.expandPanels(members);
          }
        }
        break;
      }
    }

    // payload.play 联动（显示播放器时同时发起播放，RFC 0007 默认蓝图）。
    const payload = action.payload as { play?: boolean } | undefined;
    if (payload?.play && input.target.fileId) {
      executor.playFile(input.target.fileId);
    }
  }

  /** 组内成员控件对应的面板 ID 列表。 */
  private groupMemberPanelIds(groupKey: string, graph: BlueprintGraph): string[] {
    const ids: string[] = [];
    for (const edge of graph.edges) {
      if (edge.kind !== "memberOf" || edge.to !== groupKey) {
        continue;
      }
      const node = graph.nodes.find(
        (n) => n.key === edge.from && n.type === "control",
      );
      if (node?.panel_id) {
        ids.push(node.panel_id);
      }
    }
    return ids;
  }

  /** 蓝图图文档解析（容错：失败返回 null）。 */
  static parse(json: string): BlueprintGraph | null {
    try {
      return JSON.parse(json) as BlueprintGraph;
    } catch {
      return null;
    }
  }
}

/** 全局单例引擎（应用装配层注入 executor，仓库切换时装载蓝图）。 */
export const blueprintEngine = new BlueprintEngine();

/** 供调试/测试：边按 (from, kind, to) 定位。 */
export function edgeSignature(e: BlueprintEdge): string {
  return `${e.from}--${e.kind}-->${e.to}`;
}
