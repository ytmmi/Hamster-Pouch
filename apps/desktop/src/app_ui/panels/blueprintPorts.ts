/**
 * 蓝图画布连接规则（RFC 0007 决策 1 / D31 / D50 修订）——**纯数据与纯函数**，不含 React/JSX。
 *
 * **节点类型的定义表在 `packages/config/src/blueprintNodes.ts`**（节点标准
 * `docs/spec/blueprint-node-standard.md` 第 2–4 节）：本文件只把那张表**投影**成
 * 画布需要的端口与边判定，避免"端口表 / 推导表 / 后端校验"三处各写一遍。
 *
 * 单独成文件的原因：这里定义"哪类节点有哪些端口、拖哪两个端口能连成什么边"，
 * 是画布交互与自检脚本的共同依据（`tools/blueprint-node-check.mjs` 直接导入断言）。
 */

import {
  BLUEPRINT_BUILTIN_NODE_TYPES,
  containmentAllows,
  nodeSpecOrNull,
  resolveNodePorts,
  type BlueprintEdge,
  type BlueprintNode,
  type BlueprintNodeType,
} from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";

/** 端口定义：`id` 既是 DOM 标记（`node::side::id`）也是边类型判定依据。 */
export interface PortDef {
  id: string;
  side: "in" | "out";
}

/**
 * 端口在画布 DOM 上的标记（`data-port` 属性值）：`${节点 key}::${侧}::${端口 id}`。
 *
 * **这是画布、端口测量与门禁共用的唯一拼法**：早前这段模板在画布与自检脚本里各写一遍，
 * 一旦有一侧改了就出现"数据里有边、画布上找不到端口坐标"的静默丢线。凡是需要
 * "某个端口在 DOM 里叫什么"，一律走本函数。
 */
export function portDomId(
  key: string,
  side: "in" | "out",
  portId: string,
): string {
  return `${key}::${side}::${portId}`;
}

/** 输入端口 id：结构节点用 `contains`，面板/状态用 `in`，规则节点用各自的边名。 */
function inputPortId(type: BlueprintNodeType): string {
  const spec = nodeSpecOrNull(type);
  if (!spec) return "";
  return resolveNodePorts(spec).find((p) => p.side === "in")?.id ?? "";
}

/** 输出端口 id 清单（含规则边端口）。 */
function outputPortIds(type: BlueprintNodeType): string[] {
  const spec = nodeSpecOrNull(type);
  if (!spec) return [];
  return resolveNodePorts(spec)
    .filter((p) => p.side === "out")
    .map((p) => p.id);
}

/** 由定义表推导的端口（内置 10 种在初始化期算好）。 */
function derivedPorts(type: BlueprintNodeType): PortDef[] {
  const ports: PortDef[] = [];
  const input = inputPortId(type);
  if (input) ports.push({ id: input, side: "in" });
  for (const id of outputPortIds(type)) ports.push({ id, side: "out" });
  return ports;
}

/** 每类节点的端口定义（输入在左、输出在右）；标签文案走 i18n（`portLabel`）。 */
export const PORT_DEFS: Record<string, PortDef[]> = Object.fromEntries(
  BLUEPRINT_BUILTIN_NODE_TYPES.map((type) => [type, derivedPorts(type)]),
) as Record<string, PortDef[]>;

/**
 * 取某类型的端口表（**内置 10 种 + 插件注册项**）。
 *
 * 未注册的类型（插件缺失）没有注册项，也就没有端口——画布把它按「未接通」灰显，
 * 连线既不渲染也不参与判定（RFC 0010 决策 6：节点与边**原样保留**）。
 */
export function portsOf(type: BlueprintNodeType): PortDef[] {
  return PORT_DEFS[type] ?? (nodeSpecOrNull(type) ? derivedPorts(type) : []);
}

/** 端口标签（多语言）：contains/memberOf/fires/guards/on；状态输入口为「触发/守卫」。 */
export function portLabel(type: BlueprintNodeType, portId: string, t: Translate): string {
  if (portId === "in") {
    return type === "action" ? t("blueprint.port.firesGuards") : t("blueprint.port.contains");
  }
  return t(`blueprint.port.${portId}` as TranslationKey);
}

/** 节点在指定侧是否暴露某个端口。 */
export function nodeHasPort(
  type: BlueprintNodeType,
  side: "in" | "out",
  portId: string,
): boolean {
  return portsOf(type).some((p) => p.side === side && p.id === portId);
}

/** 规则边（非结构边）的输出侧来源：`边类型 → 允许的输出节点类型`。 */
export const RULE_EDGE_SOURCES: Record<string, readonly BlueprintNodeType[]> = {
  memberOf: ["control"],
  // `on` 的来源含**三条正交轴上的对象父**：类目、子类、标记（都能挂对象，
  // 因此都能由对象发起规则）；与 Rust `RULE_EDGE_SOURCES` 逐项一致。
  on: ["control", "class", "subclass", "mark", "object"],
  fires: ["event"],
  guards: ["condition"],
};

/** 规则边（非结构边）的输入侧目标：`边类型 → 允许的输入节点类型`。 */
export const RULE_EDGE_TARGETS: Record<string, readonly BlueprintNodeType[]> = {
  memberOf: ["group"],
  on: ["event"],
  fires: ["condition", "action"],
  guards: ["action"],
};

/** 由输出端口 → 目标节点类型推导边类型；不兼容返回 null。 */
export function kindForEdge(
  fromType: BlueprintNodeType,
  fromPort: string,
  toType: BlueprintNodeType,
): BlueprintEdge["kind"] | null {
  if (fromPort === "contains") {
    // 结构层级全部由节点定义表（节点标准第 2 节）决定，画布不再自带一份。
    return containmentAllows(fromType, toType) ? "contains" : null;
  }
  const sources = RULE_EDGE_SOURCES[fromPort];
  const targets = RULE_EDGE_TARGETS[fromPort];
  if (!sources || !targets) return null;
  if (!sources.includes(fromType) || !targets.includes(toType)) return null;
  return fromPort as BlueprintEdge["kind"];
}

/**
 * 端口在边上的 ID：输入/输出 + 类型决定。
 *
 * **必须与 `portsOf` 一致**：画布渲染连线时用
 * `portMap.get(`${key}::${side}::${portIdFor(type, side, kind)}`)` 找端口坐标，
 * 而 DOM 上的标记是 `${key}::${side}::${p.id}`（`p.id` 来自端口表）。
 * 因此本函数**只能返回该节点声明（或推导）过的端口 id**；返回一个未声明的 id
 * 会让查表落空、连线被静默丢弃——真实缺陷：输入侧曾被边类型名覆盖
 * （`action.in.fires` 返回 `"fires"`，而操作节点的输入口其实是 `"in"`），
 * 导致"操作 → 状态"的连线在画布上永远画不出来。
 */
export function portIdFor(
  type: BlueprintNodeType,
  side: "in" | "out",
  kind: BlueprintEdge["kind"],
): string {
  const ports = portsOf(type);
  if (side === "in") {
    // 输入侧：节点自身唯一的输入口（结构子节点 `contains`、面板/状态 `in`、
    // 操作 `on`、条件 `fires`）；`memberOf` 落在标签组的结构输入口。
    const id = inputPortId(type);
    return ports.some((p) => p.side === "in" && p.id === id) ? id : "";
  }
  // 输出侧：规则边用边类型同名端口（on/fires/guards/memberOf），结构边用 `contains`。
  return ports.some((p) => p.side === "out" && p.id === kind) ? kind : "";
}

/** 某侧声明过的端口 id（顺序 = 画布渲染顺序）。 */
export function portIdsOn(type: BlueprintNodeType, side: "in" | "out"): string[] {
  return portsOf(type)
    .filter((p) => p.side === side)
    .map((p) => p.id);
}

/**
 * **渲染与测量用**的端口 id：先按边类型找同名端口（`portIdFor`），找不到就**回落**
 * 到该侧声明的第一个端口。
 *
 * 为什么需要它（真实缺陷的根因类别）：`portIdFor` 是**契约函数**——"这条边该落在哪个
 * 端口"说不清时**必须**返回空串，由调用方拒绝该操作（门禁断言它只返回声明过的端口）。
 * 但**画布渲染**不能这么严格：库里已有的边（历史文档、JSON 手写、插件类型、
 * 边类型与端口 id 不同名的自定义类型）一旦查不到端口，整条线就被 `return null` 静默丢掉，
 * 表现为用户报的"连线成功后画布上没有线"。渲染侧的判据因此是"**能不能画出这条线**"，
 * 而不是"这条边合不合规"：不合规的边由校验层拒绝保存，画布只负责如实画出来。
 * 节点在该侧**没有任何端口**时（未注册类型 / 无端口类型）返回空串，由
 * `blueprintGeometry.resolveEdgeAnchor` 回落到卡片锚点，仍然画得出来。
 */
export function portIdForRender(
  type: BlueprintNodeType,
  side: "in" | "out",
  kind: BlueprintEdge["kind"],
): string {
  const exact = portIdFor(type, side, kind);
  if (exact) {
    return exact;
  }
  return portIdsOn(type, side)[0] ?? "";
}

/** 一次拖线可以落到的目标（**画布高亮与落点判定共用同一份清单**）。 */
export interface ConnectTarget {
  /** 目标节点 key。 */
  key: string;
  /** 目标节点的**输入端口 id**（DOM 标记见 `portDomId`）。 */
  portId: string;
  /** 这条连线会落成的边类型。 */
  kind: BlueprintEdge["kind"];
}

/**
 * 从某个**输出端口**拖出的线**可以落在哪些输入端口**上（纯函数）。
 *
 * 判据三条合一（与后端 `can_contain` / 规则边来源目标表同源）：
 * ① `kindForEdge(源类型, 源端口, 目标类型)` 推得出边类型（层级/规则都合法）；
 * ② 目标该侧**确实声明了**这个端口（否则画布上没有那个圆点，无从高亮/落点）；
 * ③ 同 `(from, to, kind)` 的边**尚不存在**（去重，与 `onConnect` 的判据一致）。
 *
 * 同一份清单同时驱动两件事：拖拽时的**绿色高亮**（哪几个端口能连）与放开时的
 * **落点判定**（就近吸附）。早前这两件事分属"DOM 命中"与"画布自己算"两套判据，
 * 表现是"看着能连、放开却没连上"（拖到端口旁边的标签上就落空）。
 */
export function connectTargets(
  from: BlueprintNode,
  fromPort: string,
  nodes: readonly BlueprintNode[],
  edges: readonly BlueprintEdge[],
): ConnectTarget[] {
  if (!nodeHasPort(from.type, "out", fromPort)) {
    return [];
  }
  const targets: ConnectTarget[] = [];
  for (const node of nodes) {
    if (node.key === from.key) {
      continue;
    }
    const kind = kindForEdge(from.type, fromPort, node.type);
    if (!kind) {
      continue;
    }
    const portId = portIdFor(node.type, "in", kind);
    if (!portId || !nodeHasPort(node.type, "in", portId)) {
      continue;
    }
    if (edges.some((e) => e.from === from.key && e.to === node.key && e.kind === kind)) {
      continue;
    }
    targets.push({ key: node.key, portId, kind });
  }
  return targets;
}

/**
 * 允许的"父容器 → 子节点"关系（与 hp-core 校验层级一致）。
 * 画布落在子节点的输入口时，边类型由此表与 `kindForEdge` 共同决定。
 *
 * **只含宿主内置类型**：插件注册的节点类型暂不能参与结构边（节点标准开放点）。
 */
export const CONTAINMENT: { parent: BlueprintNodeType; children: BlueprintNodeType[] }[] =
  BLUEPRINT_BUILTIN_NODE_TYPES.map((type) => ({
    parent: type,
    children: [...(nodeSpecOrNull(type)?.children ?? [])],
  })).filter((entry) => entry.children.length > 0);
