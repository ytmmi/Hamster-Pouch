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
  | "layout_block"
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

export type BlueprintEdgeKind = "contains" | "memberOf" | "on" | "fires" | "guards";

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
  /** 内置默认蓝图版本（仅 DEFAULT_BLUEPRINT 携带；旧库存默认无此字段）。 */
  default_version?: number;
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
 * 内置默认蓝图（重写版）：完整、自洽、零回归（RFC 0007 决策 5）。
 *
 * 结构（左/中/右 3 个布局块，块内包含标签组与控件）：
 * - 左栏：仓库 / 图像源 / 相册 三个控件；
 * - 中栏：媒体预览控件 → 图像/视频/音频 三个类 → 各类一个「双击」对象；
 * - 右栏：互斥标签组（查看器 / 媒体播放 / 元数据）。
 *
 * 行为（复现现状硬编码联动）：
 * - 双击图像对象 → 显示查看器；双击视频对象 → 显示播放器；双击音频对象 → 显示元数据。
 * 「单击→元数据」「双击自动播放」等增强行为不属于现状，用户在编辑器中自行添加。
 */
export const DEFAULT_BLUEPRINT: BlueprintGraph = {
  schema_version: BLUEPRINT_SCHEMA_VERSION,
  default_version: 2,
  nodes: [
    // 布局块（左/中/右）
    { key: "blk_left", type: "layout_block", position: { x: 40, y: 40 } },
    { key: "blk_center", type: "layout_block", position: { x: 400, y: 40 } },
    { key: "blk_right", type: "layout_block", position: { x: 800, y: 40 } },

    // 左栏控件
    { key: "c_repo", type: "control", panel_id: "repo", title_key: "panel.repo" },
    { key: "c_sources", type: "control", panel_id: "sources", title_key: "panel.sources" },
    { key: "c_albums", type: "control", panel_id: "albums", title_key: "panel.albums" },

    // 中栏：媒体预览（控件 → 类 → 对象，包含链完整）
    { key: "c_preview", type: "control", panel_id: "media", title_key: "panel.media" },
    { key: "k_image", type: "class", control: "c_preview", media_type: "image" },
    { key: "k_video", type: "class", control: "c_preview", media_type: "video" },
    { key: "k_audio", type: "class", control: "c_preview", media_type: "audio" },
    { key: "o_img", type: "object", class: "k_image", scope: "double_clicked" },
    { key: "o_vid", type: "object", class: "k_video", scope: "double_clicked" },
    { key: "o_aud", type: "object", class: "k_audio", scope: "double_clicked" },

    // 右栏：查看器标签组（查看器/媒体播放 互斥标签；元数据是详情面板，不属于该组）
    { key: "g_viewers", type: "group", mode: "exclusive", default_visible: [], hide_direction: "left", name: "查看器", position: { x: 760, y: 160 } },
    { key: "c_viewer", type: "control", panel_id: "viewer", title_key: "panel.viewer" },
    { key: "c_player", type: "control", panel_id: "player", title_key: "panel.player" },
    { key: "c_meta", type: "control", panel_id: "metadata", title_key: "panel.metadata" },

    // 操作与状态（规则三元组：对象 → 操作 → 状态，全部连线）
    { key: "e_dbl_img", type: "event", trigger: "double_click" },
    { key: "e_dbl_vid", type: "event", trigger: "double_click" },
    { key: "e_dbl_aud", type: "event", trigger: "double_click" },
    { key: "a_show_viewer", type: "action", op: "show", target: "c_viewer" },
    { key: "a_show_player", type: "action", op: "show", target: "c_player" },
    { key: "a_show_meta", type: "action", op: "show", target: "c_meta" },
  ],
  edges: [
    // 布局块 → 内容（布局块包含标签组与控件）
    { from: "blk_left", to: "c_repo", kind: "contains", order: 1 },
    { from: "blk_left", to: "c_sources", kind: "contains", order: 2 },
    { from: "blk_left", to: "c_albums", kind: "contains", order: 3 },
    { from: "blk_center", to: "c_preview", kind: "contains", order: 4 },
    { from: "blk_right", to: "g_viewers", kind: "contains", order: 5 },
    { from: "blk_right", to: "c_meta", kind: "contains", order: 6 },

    // 标签组 → 控件（标签组包含控件）
    { from: "g_viewers", to: "c_viewer", kind: "contains", order: 7 },
    { from: "g_viewers", to: "c_player", kind: "contains", order: 8 },

    // 控件 → 类（控件内的类）
    { from: "c_preview", to: "k_image", kind: "contains", order: 9 },
    { from: "c_preview", to: "k_video", kind: "contains", order: 10 },
    { from: "c_preview", to: "k_audio", kind: "contains", order: 11 },

    // 类 → 对象（类内的对象）
    { from: "k_image", to: "o_img", kind: "contains", order: 12 },
    { from: "k_video", to: "o_vid", kind: "contains", order: 13 },
    { from: "k_audio", to: "o_aud", kind: "contains", order: 14 },

    // 规则三元组：对象 → 操作 → 状态（全部连线）
    { from: "o_img", to: "e_dbl_img", kind: "on", order: 15 },
    { from: "o_vid", to: "e_dbl_vid", kind: "on", order: 16 },
    { from: "o_aud", to: "e_dbl_aud", kind: "on", order: 17 },
    { from: "e_dbl_img", to: "a_show_viewer", kind: "fires", order: 18 },
    { from: "e_dbl_vid", to: "a_show_player", kind: "fires", order: 19 },
    { from: "e_dbl_aud", to: "a_show_meta", kind: "fires", order: 20 },
  ],
};

/** 空蓝图文档（新建蓝图起步用）。 */
export function makeEmptyBlueprint(): BlueprintGraph {
  return { schema_version: BLUEPRINT_SCHEMA_VERSION, nodes: [], edges: [] };
}

/**
 * 旧版内置默认蓝图识别（用于自动升级为新版）。
 * 旧库存默认图特征：① 曾存在 `blk_left → g_viewers` 边（带布局块但结构错误的版本）；
 * ② 有 `g_viewers` 标签组但没有任何布局块节点（更早的版本）。命中即视为旧库存默认，
 * 由引擎自动替换，不影响用户编辑的图。
 */
export function isObsoleteDefaultBlueprint(g: BlueprintGraph): boolean {
  const hasBlocks = g.nodes.some((n) => n.type === "layout_block");
  const hasViewerGroup = g.nodes.some((n) => n.key === "g_viewers");
  const badBlockEdge = g.edges.some(
    (e) => e.from === "blk_left" && e.to === "g_viewers" && e.kind === "contains",
  );
  return badBlockEdge || (!hasBlocks && hasViewerGroup);
}
