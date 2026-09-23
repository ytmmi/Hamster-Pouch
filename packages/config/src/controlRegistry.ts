/**
 * 控件类型注册表（`docs/spec/control-standard.md` 第 4 节的表）。
 *
 * **单一事实来源**（前端侧）：每种 `kind` 的类别、是否容器、专属字段与可声明事件都在这里
 * 声明一次；`control.ts` 的解析层校验、属性面板与宿主渲染映射都读它。
 * 与 Rust `crates/hp-core/src/control_types.rs` 的 `CONTROL_REGISTRY` 逐项对应，
 * 由 `pnpm check:controls` 断言一致。
 */

import {
  CONTROL_ALIGN_VALUES,
  CONTROL_BUTTON_VARIANTS,
  CONTROL_EMPTY_VARIANTS,
  CONTROL_EVENTS,
  CONTROL_FIT_VALUES,
  CONTROL_GAP_VALUES,
  CONTROL_ITEM_TEXTS,
  CONTROL_KINDS,
  CONTROL_OPTIONS_KINDS,
  CONTROL_STATUS_VARIANTS,
  CONTROL_TEXT_VARIANTS,
  type ControlCategory,
  type ControlEvent,
  type ControlKind,
} from "./controlKinds";

/** 专属属性的取值类型（校验据此决定怎么检查值）。 */
export type ControlPropType = "string" | "boolean" | "number" | "enum" | "stringArray";

/** 一个专属属性的规格。 */
export interface ControlPropSpec {
  /** JSON 字段名（snake_case）。 */
  name: string;
  type: ControlPropType;
  /** `enum` 型的允许取值。 */
  values?: readonly string[];
  /** 是否必需（缺省即报错）。 */
  required?: boolean;
}

/** 一种控件类型的定义。 */
export interface ControlKindSpec {
  kind: ControlKind;
  category: ControlCategory;
  /** 是否为容器（可带 `children`）。 */
  container: boolean;
  /** 专属字段清单；通用字段（`id`/`kind`/`text_key`/`visible`/`enabled`/`bind`/`on`/`children`）不在此列。 */
  props: readonly ControlPropSpec[];
  /** 可声明的事件。 */
  events: readonly ControlEvent[];
}

const gapAlign: readonly ControlPropSpec[] = [
  { name: "gap", type: "enum", values: CONTROL_GAP_VALUES },
  { name: "align", type: "enum", values: CONTROL_ALIGN_VALUES },
];

const numberRange: readonly ControlPropSpec[] = [
  { name: "min", type: "number" },
  { name: "max", type: "number" },
  { name: "step", type: "number" },
];

const collectionEvents: readonly ControlEvent[] = ["click", "double_click", "selection_change"];

/** 26 种控件类型定义（顺序与 Rust 注册表一致）。 */
export const CONTROL_REGISTRY: readonly ControlKindSpec[] = [
  { kind: "row", category: "layout", container: true, props: gapAlign, events: [] },
  { kind: "column", category: "layout", container: true, props: gapAlign, events: [] },
  {
    kind: "panel",
    category: "layout",
    container: true,
    props: [
      { name: "title_key", type: "string" },
      { name: "bordered", type: "boolean" },
    ],
    events: [],
  },
  {
    kind: "section",
    category: "layout",
    container: true,
    props: [
      { name: "title_key", type: "string" },
      { name: "collapsed", type: "boolean" },
    ],
    events: ["toggle"],
  },
  { kind: "spacer", category: "layout", container: false, props: [], events: [] },
  {
    kind: "text",
    category: "display",
    container: false,
    props: [
      { name: "text", type: "string" },
      { name: "variant", type: "enum", values: CONTROL_TEXT_VARIANTS },
    ],
    events: [],
  },
  {
    kind: "icon",
    category: "display",
    container: false,
    props: [{ name: "icon", type: "string", required: true }],
    events: [],
  },
  {
    kind: "image",
    category: "display",
    container: false,
    props: [{ name: "fit", type: "enum", values: CONTROL_FIT_VALUES }],
    events: ["click"],
  },
  {
    kind: "progress",
    category: "display",
    container: false,
    props: [{ name: "max", type: "number" }],
    events: [],
  },
  { kind: "keyValue", category: "display", container: false, props: [], events: [] },
  {
    kind: "button",
    category: "input",
    container: false,
    props: [{ name: "variant", type: "enum", values: CONTROL_BUTTON_VARIANTS }],
    events: ["click", "double_click"],
  },
  { kind: "switch", category: "input", container: false, props: [], events: ["value_change"] },
  {
    kind: "textInput",
    category: "input",
    container: false,
    props: [
      { name: "placeholder_key", type: "string" },
      { name: "multiline", type: "boolean" },
    ],
    events: ["value_change", "submit"],
  },
  {
    kind: "numberInput",
    category: "input",
    container: false,
    props: numberRange,
    events: ["value_change"],
  },
  {
    kind: "select",
    category: "input",
    container: false,
    props: [{ name: "options_kind", type: "enum", values: CONTROL_OPTIONS_KINDS }],
    events: ["value_change"],
  },
  {
    kind: "slider",
    category: "input",
    container: false,
    props: numberRange,
    events: ["value_change"],
  },
  { kind: "checkbox", category: "input", container: false, props: [], events: ["value_change"] },
  {
    kind: "list",
    category: "collection",
    container: false,
    props: [{ name: "item_text", type: "enum", values: CONTROL_ITEM_TEXTS }],
    events: collectionEvents,
  },
  {
    kind: "tree",
    category: "collection",
    container: false,
    props: [{ name: "item_text", type: "enum", values: CONTROL_ITEM_TEXTS }],
    events: collectionEvents,
  },
  {
    kind: "table",
    category: "collection",
    container: false,
    props: [{ name: "columns", type: "stringArray" }],
    events: collectionEvents,
  },
  { kind: "tagChain", category: "collection", container: false, props: [], events: [] },
  {
    kind: "thumbGrid",
    category: "collection",
    container: false,
    props: [{ name: "item_text", type: "enum", values: CONTROL_ITEM_TEXTS }],
    events: collectionEvents,
  },
  {
    kind: "status",
    category: "feedback",
    container: false,
    props: [{ name: "variant", type: "enum", values: CONTROL_STATUS_VARIANTS }],
    events: [],
  },
  {
    kind: "notice",
    category: "feedback",
    container: true,
    props: [{ name: "variant", type: "enum", values: CONTROL_STATUS_VARIANTS }],
    events: [],
  },
  {
    kind: "empty",
    category: "feedback",
    container: false,
    props: [{ name: "variant", type: "enum", values: CONTROL_EMPTY_VARIANTS }],
    events: ["click"],
  },
  { kind: "divider", category: "feedback", container: false, props: [], events: [] },
];

const BY_KIND = new Map<string, ControlKindSpec>(CONTROL_REGISTRY.map((s) => [s.kind, s]));

/** 取某类型的定义（`kind` 已由白名单保证存在）。 */
export function controlSpec(kind: ControlKind): ControlKindSpec {
  const spec = BY_KIND.get(kind);
  if (!spec) throw new Error(`控件类型不在白名单内: ${kind}`);
  return spec;
}

/** 该 `kind` 是否是白名单内的控件类型。 */
export function isControlKind(value: unknown): value is ControlKind {
  return typeof value === "string" && (CONTROL_KINDS as readonly string[]).includes(value);
}

/** 该字段名是否是某类型的**合法专属字段**。 */
export function isControlProp(kind: ControlKind, name: string): boolean {
  return controlSpec(kind).props.some((p) => p.name === name);
}

/** 该事件名是否可用于某类型。 */
export function controlAllowsEvent(kind: ControlKind, event: ControlEvent): boolean {
  return controlSpec(kind).events.includes(event);
}

/** 类型清单（校验与自检脚本共用；顺序与 Rust 一致）。 */
export const CONTROL_KIND_NAMES: readonly string[] = CONTROL_REGISTRY.map((s) => s.kind);

/** 事件谓词表清单（与 Rust `CONTROL_EVENTS` 对齐）。 */
export const CONTROL_EVENT_NAMES: readonly string[] = CONTROL_EVENTS;
