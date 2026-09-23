/**
 * 蓝图运行时引擎（RFC 0007 决策 3 / D29 / D48 / D50 / D51）。
 *
 * 职责：加载当前生效蓝图（仓库默认或内置默认），订阅 UI 事件（单击/双击/选中），
 * 按图求值（fires/guards DAG）→ 输出 dockview 操作序列（面板显隐 + 组收起/展开 +
 * 界面跳转 + 浮层显隐），由外部注入的 Executor 执行。
 *
 * 求值语义：
 * - **只求值"当前层"**（D51）：非当前层的事件不参与匹配（那些页面没在显示）；
 * - 事件节点按 trigger + target（类/对象）匹配 dispatch 上报的目标；
 * - 沿 fires/guards 边按 order 升序执行；条件为真才继续；
 * - 互斥组不自动隐藏成员：同 dockview 组的成员共享显示区域，标签激活天然保证
 *   同一时间仅一个激活；跨 dockview 组的成员不做自动隐藏/收缩（避免破坏用户布局），
 *   如需隐藏/收起请用显式 hide/collapse 动作；
 * - `navigate`（D48）= 切换到目标界面（层），幂等（已在该层无操作）；
 * - `show`/`hide`/`toggle` 指向**浮层**（D50，容器）时，驱动浮层内容（它 contains 的
 *   面板控件）以**浮动**方式显示/隐藏，并把容器期望可见态告知宿主；
 * - 幂等：重复触发不产生额外副作用（show 已存在面板 = 激活）。
 *
 * 组收起/拉伸（collapse/expand）与隐藏方向（hide_direction）的 dockview 映射属于
 * 实现期开放点（RFC 0007）：本引擎把组收起翻译为对其成员面板的最小化/恢复操作，
 * 具体尺寸策略由 Executor 决定。
 */

import type {
  BlueprintActionOp,
  BlueprintGraph,
  BlueprintNode,
  BlueprintTargetRef,
  BlueprintTrigger,
  HideDirectionAxis,
} from "@hamster-pouch/config";
import {
  DEFAULT_OVERLAY_ANCHOR,
  nodeLayerKey,
  parseBlueprintDocument,
  resolveOverlaySize,
} from "@hamster-pouch/config";

/** 引擎对外执行器（由应用装配层注入，与 dockview/媒体命令解耦）。 */
export interface BlueprintExecutor {
  /** 显示控件：已存在则激活，不存在则按浮动创建。 */
  showPanel: (panelId: string, floating: boolean) => void;
  /** 隐藏控件：**收起至最小尺寸**（正文 6px、标签条保留，RFC 0007 决策 3，不是关闭）。 */
  hidePanel: (panelId: string) => void;
  /** 切换控件显隐（取反：不存在则显示、已存在则关闭）。 */
  togglePanel: (panelId: string, floating: boolean) => void;
  /** 收起组：把组内成员面板最小化至最小尺寸（标签条保留，D25）；`absorb` 指定释放空间让给谁（D29）。 */
  collapsePanels: (
    panelIds: string[],
    absorb?: BlueprintCollapseAbsorb,
  ) => void;
  /** 展开组：恢复成员面板尺寸。 */
  expandPanels: (panelIds: string[]) => void;
  /** 播放文件（action payload { play: true } 联动）。 */
  playFile: (fileId: string) => void;
  /** 界面跳转（D48）：切换到目标层（页面）；执行方负责持久化当前层并套用其布局。 */
  navigateLayer: (layerKey: string) => void;
  /**
   * 浮层内容面板的显示（D50，容器语义）：
   * 与普通 `showPanel` 的区别是**必须浮动**——浮层是浮在布局之上的一层，
   * 因此已停靠的面板要移入浮动组、不存在则按浮动创建，并按蓝图的定位与尺寸摆好。
   * 定位换算需要"界面内容区"的实际像素尺寸，属宿主知识，因此由执行器完成
   * （引擎只把蓝图里的锚点/偏移/尺寸原样传下去）。
   */
  showOverlayPanel: (
    panelId: string,
    box: {
      width: number;
      height: number;
      anchor: string;
      offsetX: number;
      offsetY: number;
    },
  ) => void;
  /**
   * 浮层容器显隐（D50）：`overlayKey` = 浮层节点 key（2026-09 取消「浮动控件」，不再有绑定 id）。
   * 引擎已按浮动面板显示/隐藏浮层**内容**（它 contains 的面板控件）；宿主据此刷新浮层容器本身
   * （定位/外观档位：圆角/阴影/标签隐藏）。
   */
  setOverlayVisible: (overlayKey: string, visible: boolean) => void;
}

/** dispatch 入参（单击/双击/选中变化 + 目标条目）。 */
export interface BlueprintDispatchInput {
  trigger: BlueprintTrigger;
  target: BlueprintTargetRef;
  /** 条件求值上下文（rating / has_tag 用；缺省按 false 处理）。 */
  context?: { rating?: number; tags?: string[] };
}

/**
 * `collapse` 动作的隐藏方向（D29）：轴向，或 `toward:<组>` 已由引擎解析为
 * 目标组成员面板 id 列表（引擎持有图，执行器持有 dockview，各解析各自能解析的一半）。
 */
export interface BlueprintCollapseAbsorb {
  direction?: HideDirectionAxis;
  towardPanelIds?: string[];
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
  /** 当前层（D51/D54）：只求值该层的事件；null = 不限层（单层兜底文档）。 */
  private layer: string | null = null;
  /** 浮层期望可见态（`visible` 只是初始值；`toggle` 需要运行时当前态）。 */
  private readonly overlayState = new Map<string, boolean>();
  /**
   * 组收起态记忆（`toggle` 指向标签组时需要"当前态"才能取反；
   * `collapse`/`expand` 会同步它，避免 toggle 与显式动作互相打架）。
   */
  private readonly groupCollapsed = new Map<string, boolean>();

  /**
   * 清空浮层"已应用"记忆。
   *
   * **套用布局（`dv.fromJSON`）会重建整个 dockview 内容**，浮动面板随之消失，
   * 此时旧记忆会让 `applyOverlayDefaults` 误判为"已在目标状态"而不再重显
   * （真实缺陷：`visible: true` 的浮层内容在启动时先被显示、又被随后套用的布局抹掉，之后再不出现）。
   * 与 `resetLayoutReconcileState()` 同理：布局基准已变，旧记忆失效。
   */
  resetOverlayState(): void {
    this.overlayState.clear();
  }
  /** 诊断日志回调（应用装配层注入；null = 不记录）。 */
  private logger: ((message: string) => void) | null = null;

  /** 注入诊断日志回调（用于打包运行下排查"某操作为何仍有/没有联动"）。 */
  setLogger(logger: ((message: string) => void) | null): void {
    this.logger = logger;
  }

  private log(message: string): void {
    this.logger?.(message);
  }

  /** 注入执行器（应用装配层调用）。 */
  setExecutor(executor: BlueprintExecutor | null): void {
    this.executor = executor;
  }

  /** 设置当前层（D51/D54）：只求值该层的事件。 */
  setLayer(layerKey: string | null): void {
    this.layer = layerKey;
    this.log(`[engine] setLayer ${layerKey ?? "(all)"}`);
  }

  /** 设置当前生效蓝图（仓库默认或内置默认；null = 无蓝图）。 */
  setGraph(graph: BlueprintGraph | null): void {
    this.graph = graph;
    this.log(
      `[engine] setGraph nodes=${graph?.nodes.length ?? "null"} edges=${graph?.edges.length ?? "-"} layers=${
        graph?.layers?.length ?? 0
      } events=${
        graph
          ? graph.nodes
              .filter((n) => n.type === "event")
              .map((n) => `${n.key}:${n.trigger ?? "-"}`)
              .join("|") || "(none)"
          : "-"
      }`,
    );
  }

  /** 事件分发入口：按 trigger + target 匹配**当前层**的事件节点并求值。 */
  dispatch(input: BlueprintDispatchInput): void {
    const graph = this.graph;
    const executor = this.executor;
    if (!graph || !executor) {
      this.log(
        `[engine] dispatch ${input.trigger}/${input.target.mediaType ?? "-"} → 跳过（graph=${!!graph} executor=${!!executor}）`,
      );
      return;
    }
    const scope = input.target.scope ?? SCOPE_FOR_TRIGGER[input.trigger];
    const events = graph.nodes.filter(
      (n) =>
        n.type === "event" &&
        this.inCurrentLayer(graph, n) &&
        n.trigger === input.trigger &&
        this.eventMatches(n, input.target, scope, graph),
    );
    this.log(
      `[engine] dispatch ${input.trigger}/${input.target.mediaType ?? "-"} layer=${this.layer ?? "(all)"} → 命中事件=[${
        events.map((e) => e.key).join(", ") || "无"
      }]`,
    );
    for (const ev of events) {
      this.evalChain(ev.key, new Set<string>(), graph, input);
    }
  }

  /** 节点是否属于当前层（D51：非当前层的事件不参与求值）。 */
  private inCurrentLayer(graph: BlueprintGraph, node: BlueprintNode): boolean {
    if (!this.layer) {
      return true;
    }
    return nodeLayerKey(graph, node) === this.layer;
  }

  /** 事件 target（控件/类/对象）与上报目标是否匹配。 */
  private eventMatches(
    event: BlueprintNode,
    target: BlueprintTargetRef,
    scope: string,
    graph: BlueprintGraph,
  ): boolean {
    // 规则三元组：对象 → 操作 → 状态。操作节点的对象来源 = on 入边（优先），
    // 兼容旧图回退 target 字段。
    const objectKeys = graph.edges
      .filter((e) => e.kind === "on" && e.to === event.key)
      .map((e) => e.from);
    const candidates =
      objectKeys.length > 0
        ? objectKeys.map((k) => graph.nodes.find((n) => n.key === k))
        : event.target
          ? [graph.nodes.find((n) => n.key === event.target)]
          : [];
    return candidates.some(
      (node) => node && this.objectNodeMatches(node, target, scope, graph),
    );
  }

  /** 对象节点（控件/类/对象）是否命中上报目标。 */
  private objectNodeMatches(
    node: BlueprintNode,
    target: BlueprintTargetRef,
    scope: string,
    graph: BlueprintGraph,
  ): boolean {
    if (node.type === "control") {
      // 对象 = 控件本身（面板级操作）：无媒体类型的上报即命中。
      return !target.mediaType;
    }
    if (node.type === "class") {
      return node.media_type === target.mediaType;
    }
    if (node.type === "object") {
      // `scope` 既可以是三个交互关键字（clicked / double_clicked / selected），
      // 也可以是**具体 file_id**（RFC 0007 决策 1）：后者只对上报的那个文件生效。
      const scopeMatches =
        !node.scope ||
        node.scope === scope ||
        (target.fileId !== undefined && node.scope === target.fileId);
      if (!scopeMatches) {
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

  /** 执行动作：show/hide/toggle（面板控件/浮层）+ collapse/expand（组）+ navigate（界面）+ play 联动。 */
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

    this.log(
      `[engine] 执行动作 ${action.key}: ${op} → ${action.target}${
        action.payload ? ` payload=${JSON.stringify(action.payload)}` : ""
      }`,
    );

    switch (op) {
      case "show": {
        if (target?.type === "overlay") {
          // 浮层（D50，容器）：显示 = 把浮层内容（它 contains 的面板控件）以**浮动**方式显示。
          this.setOverlay(target, true, graph);
          break;
        }
        if (target?.type !== "control" || !target.panel_id) {
          return;
        }
        // 显示目标控件：已存在则激活，不存在则创建。默认以标签方式加入（避免默认
        // 布局被浮窗堆满）；动作 `payload.floating = true` 时浮动创建。
        // 互斥组不在此处自动隐藏其他成员：同 dockview 组的成员共享显示区域，
        // 标签激活天然保证同一时间仅一个激活；跨 dockview 组的成员不做自动
        // 隐藏/收缩（避免破坏用户布局）。如需隐藏/收起请用显式 hide/collapse 动作。
        const floating = (action.payload as { floating?: boolean } | undefined)?.floating === true;
        executor.showPanel(target.panel_id, floating);
        break;
      }
      case "hide": {
        if (target?.type === "overlay") {
          this.setOverlay(target, false, graph);
        } else if (target?.type === "control" && target.panel_id) {
          executor.hidePanel(target.panel_id);
        }
        break;
      }
      case "toggle": {
        if (target?.type === "overlay") {
          this.toggleOverlay(target, graph);
        } else if (target?.type === "control" && target.panel_id) {
          executor.togglePanel(target.panel_id, true);
        } else if (target?.type === "group") {
          // 标签组的 toggle = 收起/展开**取反**（RFC 0007 决策 7：切换→面板控件/标签组）。
          // 取反需要"当前态"，因此按组记忆（显式 collapse/expand 会同步该记忆）。
          const nextCollapsed = !(this.groupCollapsed.get(target.key) ?? false);
          this.groupCollapsed.set(target.key, nextCollapsed);
          const members = this.groupMemberPanelIds(target.key, graph);
          if (members.length > 0) {
            if (nextCollapsed) {
              executor.collapsePanels(members, this.resolveCollapseAbsorb(target, graph));
            } else {
              executor.expandPanels(members);
            }
          }
        }
        break;
      }
      case "collapse": {
        if (target?.type === "group") {
          this.groupCollapsed.set(target.key, true);
          const members = this.groupMemberPanelIds(target.key, graph);
          if (members.length > 0) {
            executor.collapsePanels(members, this.resolveCollapseAbsorb(target, graph));
          }
        }
        break;
      }
      case "expand": {
        if (target?.type === "group") {
          this.groupCollapsed.set(target.key, false);
          const members = this.groupMemberPanelIds(target.key, graph);
          if (members.length > 0) {
            executor.expandPanels(members);
          }
        }
        break;
      }
      case "navigate": {
        // 界面跳转（D48）：目标是界面节点；界面与层 1:1（D51），因此跳转 = 切到该层。
        // 层归属走 `nodeLayerKey`（含单层兜底，D58）：旧/兜底文档的界面节点可以没有 `layer`
        // 字段，直接读裸字段会把这类文档的跳转误判为"未接通"。
        if (target?.type === "interface") {
          const layerKey = nodeLayerKey(graph, target);
          if (this.layer === layerKey) {
            this.log(`[engine] navigate 幂等：已在层 ${layerKey}`);
            break;
          }
          executor.navigateLayer(layerKey);
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

  /**
   * 浮层显隐（D50，容器语义 / 2026-09 取消「浮动控件」）：
   * 浮层的内容就是它 `contains` 的**面板控件**（含经标签组间接包含的），
   * 因此 `show` = 把这些面板以浮动方式显示、`hide` = 关闭它们；
   * 同时把浮层容器的期望可见态告诉宿主（宿主负责容器本身的外观档位渲染）。
   */
  private setOverlay(node: BlueprintNode, visible: boolean, graph: BlueprintGraph): void {
    // 未连接到界面（未接通）时**不允许显示**；隐藏仍然执行，用于断开连接后的收尾。
    if (visible && !this.isOverlayAttached(graph, node)) {
      this.log(`[engine] 浮层 ${node.key} 未连接到界面（未接通）→ 不显示`);
      return;
    }
    this.overlayState.set(node.key, visible);
    const panelIds = this.overlayPanelIds(node.key, graph);
    const size = resolveOverlaySize(node.size);
    const box = {
      width: size.width,
      height: size.height,
      anchor: node.anchor ?? DEFAULT_OVERLAY_ANCHOR,
      offsetX: node.offset_x ?? 0,
      offsetY: node.offset_y ?? 0,
    };
    for (const panelId of panelIds) {
      if (visible) {
        // 浮层 = 浮动层：内容面板以**浮动**方式显示（已停靠的移入浮动组，不存在则浮动创建），
        // 并按蓝图定位/尺寸摆好（尺寸不足最小值时按最小值）。
        this.executor?.showOverlayPanel(panelId, box);
      } else {
        this.executor?.hidePanel(panelId);
      }
    }
    this.executor?.setOverlayVisible(node.key, visible);
    this.log(
      `[engine] 浮层 ${node.key} ${visible ? "显示" : "隐藏"}：内容面板=[${panelIds.join(", ") || "（空浮层）"}] ${size.width}×${size.height} @${box.anchor}(${box.offsetX}, ${box.offsetY})`,
    );
  }

  /**
   * 按蓝图对账**浮层的初始显隐**（装载/套用布局/切层时调用）。
   *
   * 这是"浮层不会自己出现"缺陷的修复：`visible` 过去只是数据，没有任何一处在装载时应用它。
   * 对账规则（保守，不打扰使用者）：
   * - **未连接到界面**（没有 `界面 --contains--> 浮层`）= 未接通 → 视为"不显示"；
   * - 首次见到某浮层且 `visible === true`（且已连到界面）→ 显示它；
   * - 之前显示过、现在不该显示（蓝图改成不显示，或**连接被断开**）→ 隐藏它；
   * - `visible !== true` 且从未显示过 → **什么都不做**（不去关掉使用者布局里本来就有的面板）。
   */
  applyOverlayDefaults(graph: BlueprintGraph, layerKey: string | null): void {
    for (const node of graph.nodes) {
      if (node.type !== "overlay") {
        continue;
      }
      if (layerKey && nodeLayerKey(graph, node) !== layerKey) {
        continue;
      }
      const attached = this.isOverlayAttached(graph, node);
      const desired = attached && node.visible === true;
      const prev = this.overlayState.get(node.key);
      if (prev === undefined && desired) {
        this.setOverlay(node, true, graph);
      } else if (prev !== undefined && prev !== desired) {
        // 覆盖"蓝图改为不显示"与"**界面断开与浮层的连接**"两种情况：都要收起来。
        this.setOverlay(node, desired, graph);
      }
    }
  }

  /**
   * 浮层是否仍属于该页：必须存在 `界面 --contains--> 浮层`。
   *
   * 断开连接后浮层就是"未接通"（与 hp-core 的 `warnings` 口径一致），
   * 因此既不能显示，也不能响应显隐动作。
   */
  private isOverlayAttached(graph: BlueprintGraph, node: BlueprintNode): boolean {
    return graph.edges.some((e) => {
      if (e.kind !== "contains" || e.to !== node.key) {
        return false;
      }
      const from = graph.nodes.find((n) => n.key === e.from);
      return from?.type === "interface";
    });
  }

  /** 浮层切换：以引擎记录的期望可见态为准（`visible` 只是初始值）。 */
  private toggleOverlay(node: BlueprintNode, graph: BlueprintGraph): void {
    const current = this.overlayState.get(node.key) ?? node.visible ?? false;
    this.setOverlay(node, !current, graph);
  }

  /** 浮层内容：它 contains 的面板控件（也支持 浮层→标签组→面板控件 的间接包含）。 */
  private overlayPanelIds(overlayKey: string, graph: BlueprintGraph): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const walk = (keys: string[]): void => {
      for (const key of keys) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const node = graph.nodes.find((n) => n.key === key);
        if (!node) {
          continue;
        }
        if (node.type === "control") {
          if (node.panel_id) {
            ids.push(node.panel_id);
          }
        } else if (node.type === "group") {
          walk(
            graph.edges
              .filter((e) => e.kind === "contains" && e.from === key)
              .map((e) => e.to),
          );
        }
      }
    };
    walk(
      graph.edges
        .filter((e) => e.kind === "contains" && e.from === overlayKey)
        .map((e) => e.to),
    );
    return ids;
  }

  /** 标签组内成员控件对应的面板 ID 列表（contains 组→控件；兼容旧 memberOf）。 */
  private groupMemberPanelIds(groupKey: string, graph: BlueprintGraph): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const edge of graph.edges) {
      const isGroupContains =
        edge.kind === "contains" && edge.from === groupKey;
      const isMemberOf =
        edge.kind === "memberOf" && edge.to === groupKey;
      const controlKey = isGroupContains ? edge.to : isMemberOf ? edge.from : null;
      if (!controlKey || seen.has(controlKey)) {
        continue;
      }
      seen.add(controlKey);
      const node = graph.nodes.find(
        (n) => n.key === controlKey && n.type === "control",
      );
      if (node?.panel_id) {
        ids.push(node.panel_id);
      }
    }
    return ids;
  }

  /**
   * 把组节点的 `hide_direction` 解析为执行器可消费的吸收指令（D29）：
   * 轴向原样透传；`toward:<groupKey>` 解析为目标组的成员面板 id（执行器据此找 dockview 组）。
   */
  private resolveCollapseAbsorb(
    groupNode: BlueprintNode,
    graph: BlueprintGraph,
  ): BlueprintCollapseAbsorb | undefined {
    const hd = groupNode.hide_direction;
    if (!hd) {
      return undefined;
    }
    if (hd.startsWith("toward:")) {
      const towardKey = hd.slice("toward:".length);
      const towardPanelIds = this.groupMemberPanelIds(towardKey, graph);
      return towardPanelIds.length > 0 ? { towardPanelIds } : undefined;
    }
    return { direction: hd as HideDirectionAxis };
  }

  /**
   * 蓝图图文档解析（**解析层校验**，RFC 0007 决策 6）。
   *
   * 非法文档返回 `null`：调用方（`blueprintRuntime`）据此回退内置默认蓝图并提示用户，
   * 而不是把一个取值域非法的文档直接执行（RFC 0007 决策 3）。
   */
  static parse(json: string): BlueprintGraph | null {
    return parseBlueprintDocument(json);
  }
}

/** 全局单例引擎（应用装配层注入 executor，仓库切换时装载蓝图）。 */
export const blueprintEngine = new BlueprintEngine();
