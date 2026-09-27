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
  type BlueprintNodeType,
} from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";

/** 端口定义：`id` 既是 DOM 标记（`node::side::id`）也是边类型判定依据。 */
export interface PortDef {
  id: string;
  side: "in" | "out";
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
  on: ["control", "class", "object"],
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
