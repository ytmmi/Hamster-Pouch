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
  BLUEPRINT_GROUP_MODES,
  BLUEPRINT_MEDIA_TYPES,
  BLUEPRINT_NODE_TYPES,
  BLUEPRINT_TRIGGERS,
  OVERLAY_HEIGHT_MAX,
  OVERLAY_HEIGHT_MIN,
  type BlueprintActionOp,
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

/** 一种节点类型的定义。 */
export interface BlueprintNodeSpec {
  type: BlueprintNodeType;
  /** 中文名（与文档一致）。 */
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
}

const STRUCT_ANY: readonly BlueprintNodeType[] = ["layout_block", "overlay", "group", "control", "class", "object"];

/** 10 种节点类型的定义（顺序与 `BLUEPRINT_NODE_TYPES` 一致）。 */
export const BLUEPRINT_NODE_REGISTRY: readonly BlueprintNodeSpec[] = [
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
    label: "面板控件",
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
    label: "类",
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
        note: "与 op 配对：show/hide→面板控件/浮层，collapse/expand→标签组，toggle→三者，navigate→界面",
      },
      { name: "position", type: "position" },
    ],
    parents: [],
    children: [],
    events: [],
  },
];

const BY_TYPE = new Map<string, BlueprintNodeSpec>(
  BLUEPRINT_NODE_REGISTRY.map((s) => [s.type, s]),
);

/** 取某类型的定义（`type` 已由白名单保证存在）。 */
export function blueprintNodeSpec(type: BlueprintNodeType): BlueprintNodeSpec {
  const spec = BY_TYPE.get(type);
  if (!spec) throw new Error(`蓝图节点类型不在白名单内: ${type}`);
  return spec;
}

/** 该类型是否是结构节点（参与 `contains` 层级）。 */
export function isStructuralNode(type: BlueprintNodeType): boolean {
  const spec = blueprintNodeSpec(type);
  return spec.role !== "logic";
}

/** 该类型是否可带 `children`（结构父）。 */
export function nodeCanBeParent(type: BlueprintNodeType): boolean {
  return blueprintNodeSpec(type).children.length > 0;
}

/** `parent --contains--> child` 是否合法。 */
export function containmentAllows(parent: BlueprintNodeType, child: BlueprintNodeType): boolean {
  return blueprintNodeSpec(parent).children.includes(child);
}

/** 结构父候选（无结构父 = 逻辑节点）。 */
export function structuralParentsOf(child: BlueprintNodeType): readonly BlueprintNodeType[] {
  return blueprintNodeSpec(child).parents;
}

/** 该类型的引用字段（如 `control` / `class` / `target`）规格。 */
export function refFieldOf(type: BlueprintNodeType): BlueprintFieldSpec | undefined {
  return blueprintNodeSpec(type).fields.find(
    (f) => f.type === "ref" || f.type === "refArray",
  );
}

/** 引用字段的目标类型白名单（空数组 = 不限制）。 */
export function refTargetsOf(type: BlueprintNodeType, field: string): BlueprintRefTargets {
  const spec = blueprintNodeSpec(type).fields.find((f) => f.name === field);
  return (spec?.values as BlueprintRefTargets | undefined) ?? [];
}

/** 该类型是否允许某 `trigger`（仅事件节点有事件）。 */
export function nodeAllowsTrigger(type: BlueprintNodeType, trigger: BlueprintTrigger): boolean {
  return blueprintNodeSpec(type).events.includes(trigger);
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
  return blueprintNodeSpec(type)
    .fields.filter((f) => f.required && !f.softWhenMissing)
    .map((f) => f.name);
}

/** 该类型所有字段名（属性面板与 JSON 视图共用）。 */
export function nodeFieldNames(type: BlueprintNodeType): readonly string[] {
  return blueprintNodeSpec(type).fields.map((f) => f.name);
}

/** 节点类型清单（顺序与 `BLUEPRINT_NODE_TYPES` 一致，供自检脚本比对）。 */
export const BLUEPRINT_NODE_TYPE_NAMES: readonly string[] = BLUEPRINT_NODE_REGISTRY.map(
  (s) => s.type,
);

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
  nodeTypes: BLUEPRINT_NODE_TYPES,
  triggers: BLUEPRINT_TRIGGERS,
  actions: BLUEPRINT_ACTION_OPS,
  groupModes: BLUEPRINT_GROUP_MODES,
  mediaTypes: BLUEPRINT_MEDIA_TYPES,
  tokenLevels: TOKEN_LEVELS,
  anchors: OVERLAY_ANCHORS,
};

/** 结构父候选全集（文档第 2 节「可作为 contains 的父」一列的去重并集）。 */
export const BLUEPRINT_STRUCTURAL_CHILD_TYPES: readonly BlueprintNodeType[] = STRUCT_ANY.filter(
  (type) => blueprintNodeSpec(type).parents.length > 0,
) as readonly BlueprintNodeType[];
