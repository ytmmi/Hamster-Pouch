/**
 * 蓝图画布连接规则（RFC 0007 决策 1 / D31 / D50 修订）——**纯数据与纯函数**，不含 React/JSX。
 *
 * 单独成文件的原因：这里定义"哪类节点有哪些端口、拖哪两个端口能连成什么边"，
 * 是画布交互与自检脚本的共同依据。放在纯模块里可以被 `tools/blueprint-node-check.mjs`
 * 直接导入断言（避免再出现"界面连不上布局块/浮层"这类端口表与推导表不一致的缺陷）。
 *
 * 层级（与 hp-core 校验规则一一对应）：
 * 界面 ⊃ 布局块/浮层；布局块 ⊃ 标签组/面板控件；**浮层 ⊃ 面板控件/标签组**；
 * 标签组 ⊃ 面板控件；面板控件 ⊃ 类；类 ⊃ 对象；对象/面板控件/类 → 操作 → 条件/状态。
 */

import type { BlueprintEdge, BlueprintNodeType } from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";

/** 端口定义：`id` 既是 DOM 标记（`node::side::id`）也是边类型判定依据。 */
export interface PortDef {
  id: string;
  side: "in" | "out";
}

/** 每类节点的端口定义（输入在左、输出在右）；标签文案走 i18n（`portLabel`）。 */
export const PORT_DEFS: Record<BlueprintNodeType, PortDef[]> = {
  // 界面是层的根（页面），只有输出：收纳布局块与浮层。
  interface: [{ id: "contains", side: "out" }],
  // 布局块是界面上的区域：接收界面的 contains，输出标签组/面板控件。
  layout_block: [
    { id: "contains", side: "in" },
    { id: "contains", side: "out" },
  ],
  // 浮层（D50 修订）：与布局块同级、且是容器（可含面板控件/标签组）。
  overlay: [
    { id: "contains", side: "in" },
    { id: "contains", side: "out" },
  ],
  group: [
    { id: "contains", side: "in" },
    { id: "contains", side: "out" },
  ],
  control: [
    { id: "in", side: "in" },
    { id: "contains", side: "out" },
    { id: "memberOf", side: "out" },
    { id: "on", side: "out" },
  ],
  class: [
    { id: "contains", side: "in" },
    { id: "contains", side: "out" },
    { id: "on", side: "out" },
  ],
  object: [
    { id: "contains", side: "in" },
    { id: "on", side: "out" },
  ],
  event: [
    { id: "on", side: "in" },
    { id: "fires", side: "out" },
  ],
  condition: [
    { id: "fires", side: "in" },
    { id: "guards", side: "out" },
  ],
  // 状态（动作）是链尾：只有输入（触发/守卫）。
  action: [{ id: "in", side: "in" }],
};

/** 端口标签（多语言）：contains/memberOf/fires/guards/on；action 输入口为「触发/守卫」。 */
export function portLabel(
  type: BlueprintNodeType,
  portId: string,
  t: Translate,
): string {
  if (portId === "in") {
    return type === "action"
      ? t("blueprint.port.firesGuards")
      : t("blueprint.port.contains");
  }
  return t(`blueprint.port.${portId}` as TranslationKey);
}

/** 节点在指定侧是否暴露某个端口。 */
export function nodeHasPort(
  type: BlueprintNodeType,
  side: "in" | "out",
  portId: string,
): boolean {
  return PORT_DEFS[type].some((p) => p.side === side && p.id === portId);
}

/** 由输出端口 → 目标节点类型推导边类型；不兼容返回 null。 */
export function kindForEdge(
  fromType: BlueprintNodeType,
  fromPort: string,
  toType: BlueprintNodeType,
): BlueprintEdge["kind"] | null {
  switch (fromPort) {
    case "contains":
      // 层级：界面 → 布局块/浮层 → 标签组/面板控件 → 类 → 对象（RFC 0007 决策 1 / D50）
      if (
        fromType === "interface" &&
        (toType === "layout_block" || toType === "overlay")
      ) {
        return "contains";
      }
      // 浮层是容器（D50 修订）：可包含面板控件与标签组。
      if (fromType === "overlay" && (toType === "control" || toType === "group")) {
        return "contains";
      }
      if (fromType === "layout_block" && (toType === "group" || toType === "control")) {
        return "contains";
      }
      if (fromType === "group" && toType === "control") return "contains";
      if (fromType === "control" && toType === "class") return "contains";
      if (fromType === "class" && toType === "object") return "contains";
      return null;
    case "memberOf":
      return fromType === "control" && toType === "group" ? "memberOf" : null;
    case "fires":
      return fromType === "event" && (toType === "condition" || toType === "action")
        ? "fires"
        : null;
    case "guards":
      return fromType === "condition" && toType === "action" ? "guards" : null;
    case "on":
      return (
        (fromType === "control" ||
          fromType === "class" ||
          fromType === "object") &&
        toType === "event"
      )
        ? "on"
        : null;
    default:
      return null;
  }
}

/**
 * 端口在边上的 ID：输入/输出 + 类型决定。
 *
 * **必须与 `PORT_DEFS` 及 `kindForEdge` 三者一致**：连线落点校验用
 * `portIdFor(toType, "in", kind)` 与落点端口 id 比对，返回空串即"该节点没有这个输入口"，
 * 连不上。回归案例：界面→布局块/浮层连不上，就是这里漏了 `layout_block`/`overlay`。
 */
export function portIdFor(
  type: BlueprintNodeType,
  side: "in" | "out",
  kind: BlueprintEdge["kind"],
): string {
  if (side === "in") {
    switch (type) {
      // 面板控件/状态（动作）的输入口 id 是 "in"，其余结构节点是 "contains"。
      case "control":
      case "action":
        return "in";
      case "layout_block":
      case "overlay":
      case "group":
      case "class":
      case "object":
        return "contains";
      case "event":
        return "on";
      case "condition":
        return "fires";
      default:
        return "";
    }
  }
  // 输出侧：对象→操作 的 on 边取 on 端口
  if (kind === "on") {
    return type === "control" || type === "class" || type === "object" ? "on" : "";
  }
  switch (type) {
    case "interface":
    case "layout_block":
    case "overlay":
    case "group":
    case "control":
      return kind === "memberOf" ? "memberOf" : "contains";
    case "class":
      return "contains";
    case "event":
      return "fires";
    case "condition":
      return "guards";
    default:
      return "";
  }
}

/**
 * 允许的"父容器 → 子节点"关系（与 hp-core 校验层级一致）。
 * 画布落在子节点的输入口时，边类型由此表与 `kindForEdge` 共同决定。
 */
export const CONTAINMENT: { parent: BlueprintNodeType; children: BlueprintNodeType[] }[] = [
  { parent: "interface", children: ["layout_block", "overlay"] },
  { parent: "layout_block", children: ["group", "control"] },
  { parent: "overlay", children: ["control", "group"] },
  { parent: "group", children: ["control"] },
  { parent: "control", children: ["class"] },
  { parent: "class", children: ["object"] },
];
