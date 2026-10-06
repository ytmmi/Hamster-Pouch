/**
 * 蓝图编辑器配色（RFC 0007 编辑器）。
 *
 * 节点头部颜色与边颜色被**画布**与**小地图**共用：小地图把节点缩成小矩形、边缩成细线，
 * 必须与画布同色，缩略图才能一眼对应上。纯数据，无 React/宿主依赖。
 */

import type { BlueprintEdge, BlueprintNodeType } from "@hamster-pouch/config";

/** 节点类型 → 头部颜色（ComfyUI 风格高对比色板）。 */
export const NODE_TYPE_COLORS: Record<BlueprintNodeType, string> = {
  interface: "#7f8cff",
  layout_block: "#b085f5",
  overlay: "#8fd0c0",
  control: "#4a90d9",
  class: "#6bbf59",
  object: "#d9b45b",
  group: "#c98bdb",
  event: "#e0655a",
  condition: "#e2a94f",
  action: "#5ab0c9",
};

/** 边类型 → 颜色。 */
export const EDGE_COLORS: Record<BlueprintEdge["kind"], string> = {
  contains: "#9aa0a6",
  memberOf: "#c98bdb",
  on: "#7ec3ff",
  fires: "#e0655a",
  guards: "#e2a94f",
};

/** 未接通（灰显）时节点头部使用的灰色（画布与小地图一致）。 */
export const UNLINKED_COLOR = "#6b7280";

/** 未知/插件节点类型的兜底色（插件注册项不声明画布配色，取中性灰）。 */
export const FALLBACK_NODE_COLOR = "#6b7280";

/** 边类型的兜底色（未知边类型）。 */
export const FALLBACK_EDGE_COLOR = "#9aa0a6";

/** 节点颜色：未接通一律灰显；类型无专属色时取中性兜底（画布与小地图同一口径）。 */
export function nodeColor(type: string, unlinked = false): string {
  if (unlinked) {
    return UNLINKED_COLOR;
  }
  return NODE_TYPE_COLORS[type as BlueprintNodeType] ?? FALLBACK_NODE_COLOR;
}

/** 边颜色：未知边类型取中性兜底。 */
export function edgeColor(kind: string): string {
  return EDGE_COLORS[kind as BlueprintEdge["kind"]] ?? FALLBACK_EDGE_COLOR;
}
