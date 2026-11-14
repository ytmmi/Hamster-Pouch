/**
 * 控件取值域（`docs/spec/control-standard.md`「控件 schema 规范」第 4/6 节）。
 *
 * **取值域不再手抄**（D191）：类型联合、事件表、枚举取值数组全部来自
 * `controlFacts.generated.ts`——由 `cargo run -p hp-core --bin dump-control-facts`
 * 从 `crates/hp-core/src/control_types.rs` 的 `CONTROL_REGISTRY` 产出，真值只在那里，
 * `pnpm check:control-facts` 逐字节比对（同 `check:types` 的手法）。
 *
 * 本文件只剩**前端独有的结构约定**（bind 来源、显隐谓词）：Rust 侧不声明它们的取值域。
 */

export {
  CONTROL_API_VERSION,
  CONTROL_NODE_SOFT_LIMIT,
  TABLE_COLUMN_MAX,
  CONTROL_CATEGORIES,
  CONTROL_KINDS,
  CONTROL_EVENTS,
  CONTROL_GAP_VALUES,
  CONTROL_ALIGN_VALUES,
  CONTROL_TEXT_VARIANTS,
  CONTROL_BUTTON_VARIANTS,
  CONTROL_FIT_VALUES,
  CONTROL_OPTIONS_KINDS,
  CONTROL_ITEM_TEXTS,
  CONTROL_STATUS_VARIANTS,
  CONTROL_EMPTY_VARIANTS,
} from "./controlFacts.generated";

export type {
  ControlCategory,
  ControlKind,
  ControlEvent,
  ControlPropTypeName,
  ControlPropFact,
  ControlKindFact,
} from "./controlFacts.generated";

/** 间距档位（取宿主设计 token，不写像素）。 */
export type ControlGap = (typeof import("./controlFacts.generated").CONTROL_GAP_VALUES)[number];

/** 对齐档位。 */
export type ControlAlign = (typeof import("./controlFacts.generated").CONTROL_ALIGN_VALUES)[number];

/** 数据绑定来源：`panel`（插件面板只读查询）/ `selection`（当前选中文件）。 */
export const CONTROL_BIND_KINDS = ["panel", "selection"] as const;
export type ControlBindKind = (typeof CONTROL_BIND_KINDS)[number];

/** 显隐谓词（第一版仅四个，不接受任意表达式）。 */
export const CONTROL_PREDICATE_TESTS = ["zero", "empty", "truthy", "exists"] as const;
export type ControlPredicateTest = (typeof CONTROL_PREDICATE_TESTS)[number];
