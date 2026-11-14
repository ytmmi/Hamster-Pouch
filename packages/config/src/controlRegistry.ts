/**
 * 控件类型注册表（`docs/spec/control-standard.md` 第 4 节的表）。
 *
 * **不再手抄第二份表**（D191）：26 条定义来自 `controlFacts.generated.ts`，后者由
 * `cargo run -p hp-core --bin dump-control-facts` 从 `crates/hp-core/src/control_types.rs`
 * 的 `CONTROL_REGISTRY` 产出（真值仍在 Rust：校验方在 Rust，前端只渲染）。
 * 本文件只保留结构接口与查询函数；一致性由 `pnpm check:control-facts`（逐字节）
 * 与 `pnpm check:controls`（覆盖/文档/渲染映射）守住。
 */

import {
  CONTROL_EVENTS,
  CONTROL_FACTS,
  CONTROL_KINDS,
  type ControlCategory,
  type ControlEvent,
  type ControlKind,
  type ControlPropTypeName,
} from "./controlFacts.generated";

export type { ControlCategory, ControlEvent, ControlKind };

/** 专属属性的取值类型（校验据此决定怎么检查值）。 */
export type ControlPropType = ControlPropTypeName;

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

/** 26 种控件类型（顺序与 Rust 注册表一致）。 */
export const CONTROL_REGISTRY: readonly ControlKindSpec[] = CONTROL_FACTS;

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
