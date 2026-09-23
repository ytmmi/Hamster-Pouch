/**
 * 蓝图**取值域**（枚举清单与固定常量）——纯数据 + 纯判定函数，无任何依赖。
 *
 * 单独成文件的原因：取值域被三方共用，谁都不该 import 谁：
 * - `blueprint.ts`（图文档类型、分层工具、解析层校验）**再导出**本文件的取值域，保持既有引用不变；
 * - `blueprintNodes.ts`（节点定义表）需要取值域来声明字段规格；
 * - 编辑器与画布按类型取候选值。
 *
 * 因此把取值域下沉到这里，避免 `blueprint.ts ↔ blueprintNodes.ts` 形成模块级循环
 * （循环会让 `blueprintNodes.ts` 在初始化期读到尚未初始化的常量，直接抛
 * `Cannot access 'OVERLAY_HEIGHT_MIN' before initialization`）。
 *
 * 与 Rust `crates/hp-core/src/blueprint_types.rs` 的枚举逐项对齐。
 */

import { OVERLAY_ANCHORS, TOKEN_LEVELS } from "./blueprintOverlay";

/** 蓝图 schema 版本（与 hp-core `BLUEPRINT_SCHEMA_VERSION` 同源）。 */
export const BLUEPRINT_SCHEMA_VERSION = 2;

/** 当前内置默认蓝图版本（引擎据此自动升级旧库存默认）。 */
export const DEFAULT_BLUEPRINT_VERSION = 7;

/**
 * 节点类型取值域（RFC 0007 决策 1 / D46/D47/D50）——编辑器下拉、画布端口表、
 * 节点定义表与**解析层校验**共用同一份清单，避免多处各写一遍。
 */
export const BLUEPRINT_NODE_TYPES = [
  "interface",
  "layout_block",
  /**
   * 浮层（D50 修订）：与布局块同级的**容器**（界面 ⊃ 浮层 ⊃ 面板控件/标签组），
   * 承载外观档位与相对定位；2026-09 取消「浮动控件」绑定。
   */
  "overlay",
  "control",
  "class",
  "object",
  "group",
  "event",
  "condition",
  "action",
] as const;

export type BlueprintNodeType = (typeof BLUEPRINT_NODE_TYPES)[number];

/** 触发取值域（事件节点 `trigger`）。 */
export const BLUEPRINT_TRIGGERS = ["click", "double_click", "selection_change"] as const;
export type BlueprintTrigger = (typeof BLUEPRINT_TRIGGERS)[number];

/** 动作取值域（动作节点 `op`；含界面跳转 `navigate`，D48）。 */
export const BLUEPRINT_ACTION_OPS = [
  "show",
  "hide",
  "toggle",
  "collapse",
  "expand",
  "navigate",
] as const;
export type BlueprintActionOp = (typeof BLUEPRINT_ACTION_OPS)[number];

/** 组模式取值域（组节点 `mode`）。 */
export const BLUEPRINT_GROUP_MODES = ["exclusive", "independent"] as const;
export type BlueprintGroupMode = (typeof BLUEPRINT_GROUP_MODES)[number];

/** 边类型取值域（RFC 0007 决策 1）。 */
export const BLUEPRINT_EDGE_KINDS = ["contains", "memberOf", "on", "fires", "guards"] as const;
export type BlueprintEdgeKind = (typeof BLUEPRINT_EDGE_KINDS)[number];

/** 媒体类型取值域（类节点 `media_type`；与后端校验同一最小集）。 */
export const BLUEPRINT_MEDIA_TYPES = ["image", "video", "audio"] as const;
export type BlueprintMediaType = (typeof BLUEPRINT_MEDIA_TYPES)[number];

/** 组隐藏方向的四个轴向取值（`toward:<groupKey>` 由 `isHideDirection` 单独判定）。 */
export const HIDE_DIRECTIONS = ["left", "right", "up", "down"] as const;
export type BlueprintHideDirection = (typeof HIDE_DIRECTIONS)[number] | `toward:${string}`;

/** 浮层高度参数范围（D57：默认 1，范围 1–10，值大者在上；不是像素高度）。 */
export const OVERLAY_HEIGHT_MIN = 1;
export const OVERLAY_HEIGHT_MAX = 10;

/** 单层兜底时使用的层 key / 层名（与 hp-core `BlueprintGraph::FALLBACK_LAYER_*` 一致）。 */
export const FALLBACK_LAYER_KEY = "l_main";
export const FALLBACK_LAYER_NAME = "主界面";

/** 取值是否在给定清单内。 */
export function inList<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * `hide_direction` 是否合法：四个轴向之一，或 `toward:<groupKey>`（D29）。
 *
 * `HIDE_DIRECTIONS` 只是编辑器下拉提供的轴向值；`toward:<组 key>` 属合法取值，
 * 编辑器会原样保留（不认识的取值不允许进文档）。
 */
export function isHideDirection(value: unknown): boolean {
  return (
    inList(HIDE_DIRECTIONS, value) ||
    (typeof value === "string" &&
      value.startsWith("toward:") &&
      value.length > "toward:".length)
  );
}

/** 节点是否有这个取值域受控的枚举字段；返回 `true` 表示该字段不在取值域总表内（另有判定）。 */
export function enumAllows(field: string, value: string): boolean {
  switch (field) {
    case "trigger":
      return inList(BLUEPRINT_TRIGGERS, value);
    case "op":
      return inList(BLUEPRINT_ACTION_OPS, value);
    case "mode":
      return inList(BLUEPRINT_GROUP_MODES, value);
    case "media_type":
      return inList(BLUEPRINT_MEDIA_TYPES, value);
    case "anchor":
      return inList(OVERLAY_ANCHORS, value);
    case "shadow":
    case "radius":
      return inList(TOKEN_LEVELS, value);
    default:
      // 定义表里未登记取值域的枚举（如 `hide_direction`）由调用方单独判定。
      return true;
  }
}
