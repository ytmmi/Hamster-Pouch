/**
 * 蓝图节点定义表（`docs/spec/blueprint-node-standard.md` 第 2–4 节）。
 *
 * **单一事实来源**（前端侧）：每种节点类型的显示名来源、结构父/子、专属字段、
 * 引用字段目标、端口与可声明事件都在这里声明一次；`blueprintPorts.ts`（画布连接规则）、
 * `parseBlueprintDocument`（解析层校验）与属性面板都从它派生，避免各处手写一遍。
 *
 * 与 Rust `crates/hp-core/src/blueprint_validate.rs`（硬错误）、
 * `blueprint_warnings.rs`（未接通软告警）、`blueprint_types.rs`（取值域）对齐；
 * 一致性由 `pnpm check:blueprint-nodes` 断言。
 *
 * 纯数据 + 纯函数：不含 React/JSX，可被自检脚本直接导入。
 */

import {
  BLUEPRINT_ACTION_OPS,
  BLUEPRINT_BUILTIN_NODE_TYPES,
  BLUEPRINT_EDGE_KINDS,
  BLUEPRINT_GROUP_MODES,
  BLUEPRINT_MEDIA_TYPES,
  BLUEPRINT_TRIGGERS,
  OVERLAY_HEIGHT_MAX,
  OVERLAY_HEIGHT_MIN,
  isNodeTypeRegistered,
  type BlueprintActionOp,
  type BlueprintEdgeKind,
  type BlueprintGroupMode,
  type BlueprintMediaType,
  type BlueprintNodeType,
  type BlueprintTrigger,
} from "./blueprintValues";
import {
  OVERLAY_ANCHORS,
  TOKEN_LEVELS,
  type OverlayAnchor,
  type TokenLevel,
} from "./blueprintOverlay";

/** 结构角色：`root`（层根）/ `structural`（结构中间层）/ `logic`（规则三节点）/ `container`（浮层）。 */
export type BlueprintNodeRole = "root" | "container" | "structural" | "logic";

/** 引擎语义（`evaluation_role`）：是否进结构树、是否为规则节点、是否可做动作目标。 */
export type BlueprintEvaluationRole = "structural" | "trigger" | "condition" | "action";

/** 校验策略档位：硬错误 / 软告警（未接通）。 */
export type BlueprintSeverityLevel = "hard" | "soft";

/** 一个类型的校验策略（`severity`；缺省沿用节点标准第 6 节既有口径）。 */
export interface BlueprintNodeSeverity {
  /** 该类型的**字段问题**算硬错误还是软告警。 */
  fieldIssue: BlueprintSeverityLevel;
  /** 该类型的**引用缺失**算硬错误还是软告警。 */
  missingRef: BlueprintSeverityLevel;
}

/** `severity` 缺省：字段问题 = 硬错误、引用缺失 = 软告警（与内置 10 种现状一致）。 */
export const DEFAULT_NODE_SEVERITY: BlueprintNodeSeverity = {
  fieldIssue: "hard",
  missingRef: "soft",
};

/** 端口声明（`{ id, side, edge }`）：显式声明与「由定义表推导」并存。 */
export interface BlueprintPortSpec {
  id: string;
  side: "in" | "out";
  edge: BlueprintEdgeKind;
}

/** 来源与启用状态（宿主填充，插件不得自称）。 */
export interface BlueprintNodeOrigin {
  kind: "system" | "plugin";
  /** `kind = "plugin"` 时为 manifest `id`。 */
  plugin_id?: string;
}

/** 引用字段的目标类型（空数组 = 不限制）。 */
export type BlueprintRefTargets = readonly BlueprintNodeType[];

/** 一个专属字段的规格。 */
export interface BlueprintFieldSpec {
  /** JSON 字段名（snake_case）。 */
  name: string;
  /** 取值类型。 */
  type: "string" | "number" | "boolean" | "enum" | "ref" | "refArray" | "position" | "size";
  /** 是否必需（缺省视情况：引用型缺失一般是「未接通」软告警，见 `softWhenMissing`）。 */
  required?: boolean;
  /** 缺失时是否只算**未接通软告警**（不阻塞保存）。 */
  softWhenMissing?: boolean;
  /** `enum` 的允许取值；`ref`/`refArray` 的目标类型。 */
  values?: readonly string[];
  /** 中文说明（生成文档/属性面板提示用）。 */
  note?: string;
}

/** 一种节点类型的定义（宿主内置 10 种与插件注册项**同形**，只有 `origin` 不同）。 */
export interface BlueprintNodeSpec {
  type: BlueprintNodeType;
  /** 中文名（内置类型；插件项的显示名走 `label_key`）。 */
  label: string;
  role: BlueprintNodeRole;
  /** 显示名是否取自**层名**（界面节点），而不是自身 `name` 字段。 */
  nameFromLayer?: boolean;
  /** 是否可带 `name`（自定义显示名）。 */
  providesName: boolean;
  /** 专属字段清单。 */
  fields: readonly BlueprintFieldSpec[];
  /** 可作为 `contains` 父（可空 = 不参与结构边）。 */
  parents: BlueprintRefTargets;
  /** 可作为 `contains` 子。 */
  children: BlueprintRefTargets;
  /** 可声明的事件（仅事件节点）。 */
  events: readonly BlueprintTrigger[];
  /**
   * 端口与允许的边类型（RFC 0010 决策 5）。
   * **未声明**时按 `role` + `parents`/`children` **推导**（`resolveNodePorts`），
   * 保证内置 10 种行为完全不变。
   */
  ports?: readonly BlueprintPortSpec[];
  /** 校验策略；缺省 `DEFAULT_NODE_SEVERITY`。 */
  severity?: BlueprintNodeSeverity;
  /** 引擎语义；缺省由 `role` 推导。 */
  evaluationRole?: BlueprintEvaluationRole;
  /** 来源与启用状态。 */
  origin: BlueprintNodeOrigin;
  /** 插件项的 i18n 键（显示名由插件自己的语言资源提供）。 */
  labelKey?: string;
}

const STRUCT_ANY: readonly BlueprintNodeType[] = ["layout_block", "overlay", "group", "control", "class", "object"];

/** 宿主来源（宿主填充；manifest 自称无效，RFC 0004 决策 17 / RFC 0009）。 */
const SYSTEM_ORIGIN: BlueprintNodeOrigin = { kind: "system" };

/** 内置定义的原始清单（`origin` 由下面的映射统一补上，避免逐条重复）。 */
const BUILTIN_SPECS: readonly Omit<BlueprintNodeSpec, "origin">[] = [
  {
    type: "interface",
    label: "界面",
    role: "root",
    nameFromLayer: true,
    providesName: false,
    fields: [
      { name: "position", type: "position", note: "画布坐标" },
    ],
    parents: [],
    children: ["layout_block", "overlay"],
    events: [],
  },
  {
    type: "layout_block",
    label: "布局块",
    role: "structural",
    providesName: true,
    fields: [
      { name: "name", type: "string", required: true, note: "区域名（如「中栏」）" },
      { name: "position", type: "position" },
    ],
    parents: ["interface"],
    children: ["group", "control"],
    events: [],
  },
  {
    type: "overlay",
    label: "浮层",
    role: "container",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "position", type: "position" },
      { name: "visible", type: "boolean", note: "初始显隐（缺省不显示）" },
      { name: "height", type: "number", values: [String(OVERLAY_HEIGHT_MIN), String(OVERLAY_HEIGHT_MAX)] },
      { name: "size", type: "size", note: "框体宽×高 px（默认最小 240×160）" },
      { name: "anchor", type: "enum", values: OVERLAY_ANCHORS },
      { name: "offset_x", type: "number", note: "|v|≤1 为界面宽比例，|v|>1 为像素" },
      { name: "offset_y", type: "number" },
      { name: "shadow", type: "enum", values: TOKEN_LEVELS },
      { name: "radius", type: "enum", values: TOKEN_LEVELS },
      { name: "hide_label", type: "boolean" },
    ],
    parents: ["interface"],
    children: ["group", "control"],
    events: [],
  },
  {
    type: "group",
    label: "标签组",
    role: "structural",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "mode", type: "enum", required: true, values: BLUEPRINT_GROUP_MODES },
      { name: "default_visible", type: "refArray", values: ["control"], note: "互斥组至多一个成员" },
      { name: "hide_direction", type: "enum", values: ["left", "right", "up", "down"], note: "另支持 toward:<groupKey>" },
      { name: "position", type: "position" },
    ],
    parents: ["layout_block", "overlay"],
    children: ["control"],
    events: [],
  },
  {
    type: "control",
    label: "面板",
    role: "structural",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "panel_id", type: "string", softWhenMissing: true, note: "面板注册表 id" },
      { name: "title_key", type: "string", note: "i18n 键" },
      { name: "position", type: "position", note: "画布坐标（所有节点通用）" },
    ],
    parents: ["layout_block", "group", "overlay"],
    children: ["class"],
    events: [],
  },
  {
    type: "class",
    label: "类目",
    role: "structural",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "control", type: "ref", required: true, softWhenMissing: true, values: ["control"] },
      { name: "media_type", type: "enum", required: true, values: BLUEPRINT_MEDIA_TYPES },
      { name: "position", type: "position" },
    ],
    parents: ["control"],
    children: ["object"],
    events: [],
  },
  {
    type: "object",
    label: "对象",
    role: "structural",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "class", type: "ref", required: true, softWhenMissing: true, values: ["class"] },
      { name: "scope", type: "string", required: true, note: "selected / clicked / double_clicked / file_id" },
      { name: "position", type: "position" },
    ],
    parents: ["class"],
    children: [],
    events: [],
  },
  {
    type: "event",
    label: "操作",
    role: "logic",
    evaluationRole: "trigger",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "trigger", type: "enum", required: true, values: BLUEPRINT_TRIGGERS },
      { name: "target", type: "ref", softWhenMissing: true, values: ["class", "object"], note: "兼容旧图；正常来源是 on 入边" },
      { name: "position", type: "position" },
    ],
    parents: [],
    children: [],
    events: BLUEPRINT_TRIGGERS,
  },
  {
    type: "condition",
    label: "条件",
    role: "logic",
    evaluationRole: "condition",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "expr", type: "string", required: true, note: "固定最小集（见节点标准第 5 节）" },
      { name: "position", type: "position" },
    ],
    parents: [],
    children: [],
    events: [],
  },
  {
    type: "action",
    label: "状态",
    role: "logic",
    evaluationRole: "action",
    providesName: true,
    fields: [
      { name: "name", type: "string" },
      { name: "op", type: "enum", required: true, values: BLUEPRINT_ACTION_OPS },
      {
        name: "target",
        type: "ref",
        required: true,
        softWhenMissing: true,
        values: ["control", "group", "overlay", "interface"],
        note: "与 op 配对：show/hide→面板/浮层，collapse/expand→标签组，toggle→三者，navigate→界面",
      },
      { name: "position", type: "position" },
    ],
    parents: [],
    children: [],
    events: [],
  },
];

/**
 * 宿主内置 10 种节点类型的定义表（**单一事实来源**，节点标准第 2 节）。
 *
 * 顺序与 `BLUEPRINT_BUILTIN_NODE_TYPES` 一致；`origin` 恒为宿主。
 * 插件注册项**不在**这里（它们随插件包存在，见 `registerBlueprintNodeSpecs`）。
 */
export const BLUEPRINT_NODE_REGISTRY: readonly BlueprintNodeSpec[] = BUILTIN_SPECS.map(
  (spec) => ({ ...spec, origin: SYSTEM_ORIGIN }),
);

// ============================== 注册表（内置 + 插件注册项） ==============================

/** 插件注册的节点类型定义（宿主按 manifest 贡献点登记）。 */
let pluginNodeSpecs: BlueprintNodeSpec[] = [];

/**
 * 登记插件注册的节点类型。
 *
 * **拒绝**非插件命名空间、或不属于该插件的项（宿主是最终裁决者）；重复 `type` 后者替换
 * 前者。宿主内置类型**不可被覆盖**：它们的 id 是裸 id，形式上也进不了这个表。
 */
export function registerBlueprintNodeSpecs(specs: readonly BlueprintNodeSpec[]): void {
  if (specs.length === 0) return;
  const next = [...pluginNodeSpecs];
  for (const spec of specs) {
    if (spec.origin.kind !== "plugin" || !spec.origin.plugin_id) continue;
    if (!spec.type.startsWith(`plugin.${spec.origin.plugin_id}.`)) continue;
    const at = next.findIndex((s) => s.type === spec.type);
    if (at >= 0) next[at] = spec;
    else next.push(spec);
  }
  pluginNodeSpecs = next;
}

/** 注销某插件的节点类型（卸载/禁用）；不传 `pluginId` 则清空全部插件注册项。 */
export function unregisterBlueprintNodeSpecs(pluginId?: string): void {
  pluginNodeSpecs = pluginId
    ? pluginNodeSpecs.filter((s) => s.origin.plugin_id !== pluginId)
    : [];
}

/** 当前已登记的插件节点类型定义。 */
export function registeredPluginNodeSpecs(): readonly BlueprintNodeSpec[] {
  return pluginNodeSpecs;
}

/** 全部节点类型定义（宿主内置 10 种 + 插件注册项）。 */
export function allNodeSpecs(): readonly BlueprintNodeSpec[] {
  return pluginNodeSpecs.length === 0
    ? BLUEPRINT_NODE_REGISTRY
    : [...BLUEPRINT_NODE_REGISTRY, ...pluginNodeSpecs];
}

/** 取某类型的定义；**未注册**返回 `undefined`（插件缺失时的「未接通」入口）。 */
export function nodeSpecOrNull(type: BlueprintNodeType): BlueprintNodeSpec | undefined {
  return (
    BLUEPRINT_NODE_REGISTRY.find((s) => s.type === type) ??
    pluginNodeSpecs.find((s) => s.type === type)
  );
}

/** 取某类型的定义；未注册即抛（仅用于"注册是前置不变量"的上下文）。 */
export function blueprintNodeSpec(type: BlueprintNodeType): BlueprintNodeSpec {
  const spec = nodeSpecOrNull(type);
  if (!spec) throw new Error(`蓝图节点类型未注册: ${type}`);
  return spec;
}

/** 该类型当前是否有注册项（内置或插件）。 */
export function hasNodeSpec(type: BlueprintNodeType): boolean {
  return nodeSpecOrNull(type) !== undefined;
}

/** 解析类型的校验策略（缺省 `DEFAULT_NODE_SEVERITY`）。 */
export function resolveNodeSeverity(spec: BlueprintNodeSpec): BlueprintNodeSeverity {
  return spec.severity ?? DEFAULT_NODE_SEVERITY;
}

/** 解析类型的引擎语义（缺省由 `role` 推导：`logic` → `condition`，其余 → `structural`）。 */
export function resolveEvaluationRole(spec: BlueprintNodeSpec): BlueprintEvaluationRole {
  if (spec.evaluationRole) return spec.evaluationRole;
  return spec.role === "logic" ? "condition" : "structural";
}

/**
 * 解析类型的端口（`ports` 未声明时**由定义表推导**）。
 *
 * 推导与 Rust `blueprint_registry::derive_ports` **逐项一致**，因此内置 10 种的行为
 * 与 RFC 0010 之前完全相同（由 `pnpm check:blueprint-nodes` 断言）。
 */
export function resolveNodePorts(spec: BlueprintNodeSpec): BlueprintPortSpec[] {
  if (spec.ports && spec.ports.length > 0) return [...spec.ports];
  const role = resolveEvaluationRole(spec);
  const out: BlueprintPortSpec[] = [];
  const push = (id: string, side: "in" | "out", edge: BlueprintEdgeKind) =>
    out.push({ id, side, edge });
  const children = [...spec.children];
  const hasParents = spec.parents.length > 0;
  const isPanelLike = children.length === 1 && children[0] === "class";
  const isClassLike = children.length === 1 && children[0] === "object";
  const isObjectLike = hasParents && children.length === 0;

  if (role === "structural") {
    if (hasParents) push(isPanelLike ? "in" : "contains", "in", "contains");
    if (children.length > 0) push("contains", "out", "contains");
    if (isPanelLike) push("memberOf", "out", "memberOf");
    if (isPanelLike || isClassLike || isObjectLike) push("on", "out", "on");
  } else if (role === "trigger") {
    push("on", "in", "on");
    push("fires", "out", "fires");
  } else if (role === "condition") {
    push("fires", "in", "fires");
    push("guards", "out", "guards");
  } else {
    // action：唯一输入口 `in`（状态节点由操作/条件连入）。
    push("in", "in", "fires");
  }
  return out;
}

/** 该类型是否是结构节点（参与 `contains` 层级）；未注册 = 不参与（未接通）。 */
export function isStructuralNode(type: BlueprintNodeType): boolean {
  const spec = nodeSpecOrNull(type);
  return spec !== undefined && spec.role !== "logic";
}

/** 该类型是否可带 `children`（结构父）。 */
export function nodeCanBeParent(type: BlueprintNodeType): boolean {
  return (nodeSpecOrNull(type)?.children.length ?? 0) > 0;
}

/** `parent --contains--> child` 是否合法。 */
export function containmentAllows(parent: BlueprintNodeType, child: BlueprintNodeType): boolean {
  return nodeSpecOrNull(parent)?.children.includes(child) ?? false;
}

/** 结构父候选（无结构父 = 逻辑节点）；未注册 = 无结构父。 */
export function structuralParentsOf(child: BlueprintNodeType): readonly BlueprintNodeType[] {
  return nodeSpecOrNull(child)?.parents ?? [];
}

/** 该类型的引用字段（如 `control` / `class` / `target`）规格。 */
export function refFieldOf(type: BlueprintNodeType): BlueprintFieldSpec | undefined {
  return nodeSpecOrNull(type)?.fields.find((f) => f.type === "ref" || f.type === "refArray");
}

/** 引用字段的目标类型白名单（空数组 = 不限制）。 */
export function refTargetsOf(type: BlueprintNodeType, field: string): BlueprintRefTargets {
  const spec = nodeSpecOrNull(type)?.fields.find((f) => f.name === field);
  return (spec?.values as BlueprintRefTargets | undefined) ?? [];
}

/** 该类型是否允许某 `trigger`（仅事件节点有事件）。 */
export function nodeAllowsTrigger(type: BlueprintNodeType, trigger: BlueprintTrigger): boolean {
  return nodeSpecOrNull(type)?.events.includes(trigger) ?? false;
}

/**
 * 同一「对象 + 触发」下**互斥**的操作对（节点标准第 6 节的「多状态冲突」规则）。
 *
 * 与 `blueprintConflicts.ts` 的判定、Rust `blueprint_validate::mutually_exclusive` 三者同源；
 * 文档、编辑器提示与后端报错都引用这一份清单，避免口径漂移。
 */
export const MUTUALLY_EXCLUSIVE_OPS: readonly (readonly [BlueprintActionOp, BlueprintActionOp])[] = [
  ["show", "hide"],
  ["show", "toggle"],
  ["collapse", "expand"],
  ["navigate", "navigate"],
] as const;

/** 表示"让目标可见"的操作（互斥组多成员同时显示的判定用）。 */
export const VISIBLE_OPS: readonly BlueprintActionOp[] = ["show", "toggle"] as const;

/** 该类型的必备字段名（`required` 且不是"缺失即软告警"的引用型）。 */
export function hardRequiredFields(type: BlueprintNodeType): readonly string[] {
  return (nodeSpecOrNull(type)?.fields ?? [])
    .filter((f) => f.required && !f.softWhenMissing)
    .map((f) => f.name);
}

/** 该类型所有字段名（属性面板与 JSON 视图共用）。 */
export function nodeFieldNames(type: BlueprintNodeType): readonly string[] {
  return (nodeSpecOrNull(type)?.fields ?? []).map((f) => f.name);
}

/** 宿主内置节点类型清单（顺序与 `BLUEPRINT_BUILTIN_NODE_TYPES` 一致，供自检脚本比对）。 */
export const BLUEPRINT_NODE_TYPE_NAMES: readonly string[] = BLUEPRINT_NODE_REGISTRY.map(
  (s) => s.type,
);

/** 全部节点类型清单（内置 + 插件注册项，供自检脚本比对）。 */
export function allNodeTypeNames(): readonly string[] {
  return allNodeSpecs().map((s) => s.type);
}

/** 枚举取值表的完整清单（供自检脚本与文档比对）。 */
export interface BlueprintValueDomains {
  nodeTypes: readonly BlueprintNodeType[];
  triggers: readonly BlueprintTrigger[];
  actions: readonly BlueprintActionOp[];
  groupModes: readonly BlueprintGroupMode[];
  mediaTypes: readonly BlueprintMediaType[];
  tokenLevels: readonly TokenLevel[];
  anchors: readonly OverlayAnchor[];
}

/** 取值域汇总（文档第 2 节字段表 + 第 5 节条件表达式之外的枚举）。 */
export const BLUEPRINT_VALUE_DOMAINS: BlueprintValueDomains = {
  nodeTypes: BLUEPRINT_BUILTIN_NODE_TYPES,
  triggers: BLUEPRINT_TRIGGERS,
  actions: BLUEPRINT_ACTION_OPS,
  groupModes: BLUEPRINT_GROUP_MODES,
  mediaTypes: BLUEPRINT_MEDIA_TYPES,
  tokenLevels: TOKEN_LEVELS,
  anchors: OVERLAY_ANCHORS,
};

/** 结构父候选全集（文档第 2 节「可作为 contains 的父」一列的去重并集）。 */
export const BLUEPRINT_STRUCTURAL_CHILD_TYPES: readonly BlueprintNodeType[] = STRUCT_ANY.filter(
  (type) => structuralParentsOf(type).length > 0,
) as readonly BlueprintNodeType[];
