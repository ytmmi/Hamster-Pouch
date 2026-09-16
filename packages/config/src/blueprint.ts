/**
 * 蓝图（RFC 0007 / D28-D32）前端共享配置：
 * 节点/边类型、常量、内置默认蓝图（复现现状硬编码联动，保证零回归）。
 *
 * 蓝图文档整 JSON 存储（save = 整文档替换），语义校验由后端 `blueprint.validate` 承担；
 * 本文件只承载图结构类型、枚举常量与内置默认图。
 */

export const BLUEPRINT_SCHEMA_VERSION = 1;

// ============================== 类型 ==============================

export type BlueprintNodeType =
  | "control"
  | "class"
  | "object"
  | "group"
  | "event"
  | "condition"
  | "action";

export type BlueprintTrigger = "click" | "double_click" | "selection_change";

export type BlueprintActionOp = "show" | "hide" | "toggle" | "collapse" | "expand";

export type BlueprintGroupMode = "exclusive" | "independent";

export type BlueprintEdgeKind = "contains" | "memberOf" | "fires" | "guards";

export type BlueprintMediaType = "image" | "video" | "audio";

/** 组/控件目标锚点（画布编辑器定位 + 浮动/停靠）。 */
export interface BlueprintPosition {
  x: number;
  y: number;
}

/** 蓝图节点（扁平结构，按 type 各取所需字段，与后端 hp-core 模型一致）。 */
export interface BlueprintNode {
  key: string;
  type: BlueprintNodeType;
  /** 显示名称（用户自定义）；缺省时前端按类型本地化生成（如「控件 1」）。 */
  name?: string;
  // control
  panel_id?: string;
  title_key?: string;
  // class
  control?: string;
  media_type?: string;
  // object
  class?: string;
  scope?: string;
  // group
  mode?: BlueprintGroupMode;
  default_visible?: string[];
  hide_direction?: string;
  position?: BlueprintPosition;
  // event
  trigger?: BlueprintTrigger;
  target?: string;
  // condition
  expr?: string;
  // action
  op?: BlueprintActionOp;
  payload?: unknown;
}

/** 蓝图边（与后端 hp-core 模型一致）。 */
export interface BlueprintEdge {
  from: string;
  to: string;
  kind: BlueprintEdgeKind;
  order: number;
}

/** 蓝图图文档（整 JSON 存储）。 */
export interface BlueprintGraph {
  schema_version: number;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

/** 引擎求值目标引用（预览条目单击/双击/选中时上报）。 */
export interface BlueprintTargetRef {
  /** 条目媒体类型（image/video/audio）。 */
  mediaType?: string;
  /** 条目文件 ID。 */
  fileId?: string;
  /** 显式 scope（clicked / double_clicked / selected）；缺省按 trigger 推导。 */
  scope?: string;
}

// ============================== 常量 ==============================

/** 隐藏方向可选值（用于编辑器下拉）。 */
export const HIDE_DIRECTIONS = ["left", "right", "up", "down"] as const;

/** 条件表达式支持的前缀（用于编辑器提示）。 */
export const CONDITION_EXPR_HINTS = [
  "media_type == image",
  "media_type == video",
  "media_type == audio",
  "selection != empty",
  "rating >= 3",
  "has_tag == 示例标签",
] as const;

// ============================== 内置默认蓝图 ==============================

/**
 * 内置默认蓝图：复现现状硬编码联动（RFC 0007 决策 5），保持零回归——
 * 双击预览图像 → 显示图像查看器（互斥组保证播放器/元数据隐藏）；
 * 双击视频 → 显示播放器；双击音频 → 显示元数据。
 *
 * 注意：默认蓝图仅含现状行为（双击联动）；「单击→元数据」「双击视频自动播放」等
 * 增强行为不属于现状，用户可在编辑器中添加（互斥组与基础条件已就绪）。
 */
export const DEFAULT_BLUEPRINT: BlueprintGraph = {
  schema_version: BLUEPRINT_SCHEMA_VERSION,
  nodes: [
    { key: "c_preview", type: "control", panel_id: "media", title_key: "panel.media" },
    { key: "c_viewer", type: "control", panel_id: "viewer", title_key: "panel.viewer" },
    { key: "c_player", type: "control", panel_id: "player", title_key: "panel.player" },
    { key: "c_meta", type: "control", panel_id: "metadata", title_key: "panel.metadata" },

    { key: "k_image", type: "class", control: "c_preview", media_type: "image" },
    { key: "k_video", type: "class", control: "c_preview", media_type: "video" },
    { key: "k_audio", type: "class", control: "c_preview", media_type: "audio" },

    { key: "o_img", type: "object", class: "k_image", scope: "double_clicked" },
    { key: "o_vid", type: "object", class: "k_video", scope: "double_clicked" },
    { key: "o_aud", type: "object", class: "k_audio", scope: "double_clicked" },

    { key: "g_viewers", type: "group", mode: "exclusive", default_visible: [], hide_direction: "left", position: { x: 0, y: 0 } },

    { key: "e_dbl_img", type: "event", trigger: "double_click", target: "o_img" },
    { key: "e_dbl_vid", type: "event", trigger: "double_click", target: "o_vid" },
    { key: "e_dbl_aud", type: "event", trigger: "double_click", target: "o_aud" },

    { key: "a_show_viewer", type: "action", op: "show", target: "c_viewer" },
    { key: "a_show_player", type: "action", op: "show", target: "c_player" },
    { key: "a_show_meta", type: "action", op: "show", target: "c_meta" },
  ],
  edges: [
    { from: "e_dbl_img", to: "a_show_viewer", kind: "fires", order: 1 },
    { from: "e_dbl_vid", to: "a_show_player", kind: "fires", order: 1 },
    { from: "e_dbl_aud", to: "a_show_meta", kind: "fires", order: 1 },

    { from: "c_preview", to: "k_image", kind: "contains", order: 1 },
    { from: "k_image", to: "o_img", kind: "contains", order: 1 },
    { from: "c_viewer", to: "g_viewers", kind: "memberOf", order: 1 },
    { from: "c_player", to: "g_viewers", kind: "memberOf", order: 1 },
    { from: "c_meta", to: "g_viewers", kind: "memberOf", order: 1 },
  ],
};

/** 空蓝图文档（新建蓝图起步用）。 */
export function makeEmptyBlueprint(): BlueprintGraph {
  return { schema_version: BLUEPRINT_SCHEMA_VERSION, nodes: [], edges: [] };
}
