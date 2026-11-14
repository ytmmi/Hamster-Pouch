// 由 `cargo run -p hp-core --bin dump-control-facts` 从
// `crates/hp-core/src/control_types.rs` 的控件注册表产出，**勿手改**（D191）。
// 重生成：`pnpm gen:control-facts`；逐字节护栏：`pnpm check:control-facts`。

export const CONTROL_API_VERSION = 1 as const;
export const CONTROL_NODE_SOFT_LIMIT = 64 as const;
export const TABLE_COLUMN_MAX = 8 as const;

export const CONTROL_CATEGORIES = ["layout", "display", "input", "collection", "feedback"] as const;
export type ControlCategory = (typeof CONTROL_CATEGORIES)[number];

export const CONTROL_KINDS = ["row", "column", "panel", "section", "spacer", "text", "icon", "image", "progress", "keyValue", "button", "switch", "textInput", "numberInput", "select", "slider", "checkbox", "list", "tree", "table", "tagChain", "thumbGrid", "status", "notice", "empty", "divider"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const CONTROL_EVENTS = ["click", "double_click", "selection_change", "value_change", "submit", "toggle"] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];

export const CONTROL_GAP_VALUES = ["none", "sm", "md", "lg"] as const;
export const CONTROL_ALIGN_VALUES = ["start", "center", "end", "stretch"] as const;
export const CONTROL_TEXT_VARIANTS = ["body", "dim", "heading", "code"] as const;
export const CONTROL_BUTTON_VARIANTS = ["default", "primary", "danger"] as const;
export const CONTROL_FIT_VALUES = ["contain", "cover"] as const;
export const CONTROL_OPTIONS_KINDS = ["static", "bound"] as const;
export const CONTROL_ITEM_TEXTS = ["none", "name", "hex"] as const;
export const CONTROL_STATUS_VARIANTS = ["info", "ok", "warn", "error"] as const;
export const CONTROL_EMPTY_VARIANTS = ["empty", "loading", "error"] as const;

export type ControlPropTypeName = "string" | "boolean" | "number" | "enum" | "stringArray";

export interface ControlPropFact {
  readonly name: string;
  readonly type: ControlPropTypeName;
  readonly values?: readonly string[];
  readonly required?: true;
}

export interface ControlKindFact {
  readonly kind: ControlKind;
  readonly category: ControlCategory;
  readonly container: boolean;
  readonly props: readonly ControlPropFact[];
  readonly events: readonly ControlEvent[];
}

/** 26 种控件类型的定义（顺序与 Rust `CONTROL_REGISTRY` 一致）。 */
export const CONTROL_FACTS: readonly ControlKindFact[] = [
  {
    kind: "row",
    category: "layout",
    container: true,
    props: [
      { name: "gap", type: "enum", values: ["none", "sm", "md", "lg"] },
      { name: "align", type: "enum", values: ["start", "center", "end", "stretch"] },
    ],
    events: [],
  },
  {
    kind: "column",
    category: "layout",
    container: true,
    props: [
      { name: "gap", type: "enum", values: ["none", "sm", "md", "lg"] },
      { name: "align", type: "enum", values: ["start", "center", "end", "stretch"] },
    ],
    events: [],
  },
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
  {
    kind: "spacer",
    category: "layout",
    container: false,
    props: [],
    events: [],
  },
  {
    kind: "text",
    category: "display",
    container: false,
    props: [
      { name: "text", type: "string" },
      { name: "variant", type: "enum", values: ["body", "dim", "heading", "code"] },
    ],
    events: [],
  },
  {
    kind: "icon",
    category: "display",
    container: false,
    props: [
      { name: "icon", type: "string", required: true },
    ],
    events: [],
  },
  {
    kind: "image",
    category: "display",
    container: false,
    props: [
      { name: "fit", type: "enum", values: ["contain", "cover"] },
    ],
    events: ["click"],
  },
  {
    kind: "progress",
    category: "display",
    container: false,
    props: [
      { name: "max", type: "number" },
    ],
    events: [],
  },
  {
    kind: "keyValue",
    category: "display",
    container: false,
    props: [],
    events: [],
  },
  {
    kind: "button",
    category: "input",
    container: false,
    props: [
      { name: "variant", type: "enum", values: ["default", "primary", "danger"] },
    ],
    events: ["click", "double_click"],
  },
  {
    kind: "switch",
    category: "input",
    container: false,
    props: [],
    events: ["value_change"],
  },
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
    props: [
      { name: "min", type: "number" },
      { name: "max", type: "number" },
      { name: "step", type: "number" },
    ],
    events: ["value_change"],
  },
  {
    kind: "select",
    category: "input",
    container: false,
    props: [
      { name: "options_kind", type: "enum", values: ["static", "bound"] },
    ],
    events: ["value_change"],
  },
  {
    kind: "slider",
    category: "input",
    container: false,
    props: [
      { name: "min", type: "number" },
      { name: "max", type: "number" },
      { name: "step", type: "number" },
    ],
    events: ["value_change"],
  },
  {
    kind: "checkbox",
    category: "input",
    container: false,
    props: [],
    events: ["value_change"],
  },
  {
    kind: "list",
    category: "collection",
    container: false,
    props: [
      { name: "item_text", type: "enum", values: ["none", "name", "hex"] },
    ],
    events: ["click", "double_click", "selection_change"],
  },
  {
    kind: "tree",
    category: "collection",
    container: false,
    props: [
      { name: "item_text", type: "enum", values: ["none", "name", "hex"] },
    ],
    events: ["click", "double_click", "selection_change"],
  },
  {
    kind: "table",
    category: "collection",
    container: false,
    props: [
      { name: "columns", type: "stringArray" },
    ],
    events: ["click", "double_click", "selection_change"],
  },
  {
    kind: "tagChain",
    category: "collection",
    container: false,
    props: [],
    events: [],
  },
  {
    kind: "thumbGrid",
    category: "collection",
    container: false,
    props: [
      { name: "item_text", type: "enum", values: ["none", "name", "hex"] },
    ],
    events: ["click", "double_click", "selection_change"],
  },
  {
    kind: "status",
    category: "feedback",
    container: false,
    props: [
      { name: "variant", type: "enum", values: ["info", "ok", "warn", "error"] },
    ],
    events: [],
  },
  {
    kind: "notice",
    category: "feedback",
    container: true,
    props: [
      { name: "variant", type: "enum", values: ["info", "ok", "warn", "error"] },
    ],
    events: [],
  },
  {
    kind: "empty",
    category: "feedback",
    container: false,
    props: [
      { name: "variant", type: "enum", values: ["empty", "loading", "error"] },
    ],
    events: ["click"],
  },
  {
    kind: "divider",
    category: "feedback",
    container: false,
    props: [],
    events: [],
  },
];
