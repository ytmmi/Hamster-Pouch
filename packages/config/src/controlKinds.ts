/**
 * 控件取值域（`docs/spec/control-standard.md`「控件 schema 规范」第 4/6 节）。
 *
 * 与 Rust `crates/hp-core/src/control_types.rs` 的枚举逐项对齐；**类型注册表**在
 * `controlRegistry.ts`，结构/校验在 `control.ts`，宿主渲染骨架在
 * `apps/desktop/src/app_ui/shared/ControlRenderer.tsx`。一致性由 `pnpm check:controls` 守住。
 */

/** 控件 schema 的 API 版本（与宿主 API 版本同源）。 */
export const CONTROL_API_VERSION = 1;

/** 面板 schema 节点数建议上限（超出只软告警）。 */
export const CONTROL_NODE_SOFT_LIMIT = 64;

/** 表格控件列数上限（硬错误）。 */
export const TABLE_COLUMN_MAX = 8;

/** 控件类别（仅用于编辑器分组，不是 JSON 字段）。 */
export const CONTROL_CATEGORIES = [
  "layout",
  "display",
  "input",
  "collection",
  "feedback",
] as const;
export type ControlCategory = (typeof CONTROL_CATEGORIES)[number];

/** 控件类型白名单（第一版 26 种，宿主内置；插件不得扩展）。 */
export const CONTROL_KINDS = [
  // 布局容器
  "row",
  "column",
  "panel",
  "section",
  "spacer",
  // 展示
  "text",
  "icon",
  "image",
  "progress",
  "keyValue",
  // 输入
  "button",
  "switch",
  "textInput",
  "numberInput",
  "select",
  "slider",
  "checkbox",
  // 集合
  "list",
  "tree",
  "table",
  "tagChain",
  "thumbGrid",
  // 反馈
  "status",
  "notice",
  "empty",
  "divider",
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/**
 * 控件可声明的事件名（固定谓词表，第 6 节）。
 * 宿主统一构造回传载荷，插件不得自定义结构。
 */
export const CONTROL_EVENTS = [
  "click",
  "double_click",
  "selection_change",
  "value_change",
  "submit",
  "toggle",
] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];

/** 间距档位（取宿主设计 token，不写像素）。 */
export const CONTROL_GAP_VALUES = ["none", "sm", "md", "lg"] as const;
export type ControlGap = (typeof CONTROL_GAP_VALUES)[number];

/** 对齐档位。 */
export const CONTROL_ALIGN_VALUES = ["start", "center", "end", "stretch"] as const;
export type ControlAlign = (typeof CONTROL_ALIGN_VALUES)[number];

/** 文本样式档位。 */
export const CONTROL_TEXT_VARIANTS = ["body", "dim", "heading", "code"] as const;

/** 按钮样式档位。 */
export const CONTROL_BUTTON_VARIANTS = ["default", "primary", "danger"] as const;

/** 图像填充方式。 */
export const CONTROL_FIT_VALUES = ["contain", "cover"] as const;

/** 下拉选项来源：静态（宿主渲染占位）或绑定查询结果。 */
export const CONTROL_OPTIONS_KINDS = ["static", "bound"] as const;

/** 集合项显示内容。 */
export const CONTROL_ITEM_TEXTS = ["none", "name", "hex"] as const;

/** 状态/提示语义档位。 */
export const CONTROL_STATUS_VARIANTS = ["info", "ok", "warn", "error"] as const;

/** 空态变体。 */
export const CONTROL_EMPTY_VARIANTS = ["empty", "loading", "error"] as const;

/** 数据绑定来源：`panel`（插件面板只读查询）/ `selection`（当前选中文件）。 */
export const CONTROL_BIND_KINDS = ["panel", "selection"] as const;

/** 显隐谓词（第一版仅四个，不接受任意表达式）。 */
export const CONTROL_PREDICATE_TESTS = ["zero", "empty", "truthy", "exists"] as const;
export type ControlPredicateTest = (typeof CONTROL_PREDICATE_TESTS)[number];
