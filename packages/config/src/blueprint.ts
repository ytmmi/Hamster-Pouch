/**
 * 蓝图（RFC 0007 / D28-D32）前端共享配置：
 * 节点/边类型、常量、内置默认蓝图（复现现状硬编码联动，保证零回归）。
 *
 * 蓝图文档整 JSON 存储（save = 整文档替换），语义校验由后端 `blueprint.validate` 承担；
 * 本文件只承载图结构类型、枚举常量与内置默认图。
 */

export const BLUEPRINT_SCHEMA_VERSION = 1;

/** 当前内置默认蓝图版本（引擎据此自动升级旧库存默认）。 */
export const DEFAULT_BLUEPRINT_VERSION = 3;

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
 * 内置默认蓝图 v3：如实表达当前默认「媒体-测试」布局（RFC 0007 决策 5）。
 *
 * 结构（布局块 ⊃ 标签组/控件；标签组 ⊃ 控件）：
 * - 左栏：仓库 / 图像源 / 相册；
 * - 中栏：媒体预览（含 图像/视频/音频 类 → 各一个「双击」对象）+ 查看器；
 * - 右栏：元数据、标签·色彩 标签组（tags/color）、tag表、播放·任务 标签组（player/tasks）。
 *
 * 规则（对象 → 操作 → 状态，全部连线）：
 * - 双击 图像·双击对象 → 显示 查看器；
 * - 双击 视频·双击对象 → 显示 播放器；
 * - 双击 音频·双击对象 → 显示 元数据。
 */
export const DEFAULT_BLUEPRINT: BlueprintGraph = {
  schema_version: BLUEPRINT_SCHEMA_VERSION,
  default_version: 3,
  nodes: [
    // 布局块（左/中/右）
    { key: "blk_left", type: "layout_block", name: "左栏", position: { x: 40, y: 40 } },
    { key: "blk_center", type: "layout_block", name: "中栏", position: { x: 430, y: 40 } },
    { key: "blk_right", type: "layout_block", name: "右栏", position: { x: 820, y: 40 } },

    // 左栏控件（仓库 / 图像源 / 相册）
    { key: "c_repo", type: "control", panel_id: "repo", title_key: "panel.repo" },
    { key: "c_sources", type: "control", panel_id: "sources", title_key: "panel.sources" },
    { key: "c_albums", type: "control", panel_id: "albums", title_key: "panel.albums" },

    // 中栏：媒体预览（控件 → 类 → 对象）+ 查看器
    { key: "c_media", type: "control", panel_id: "media", title_key: "panel.media" },
    { key: "k_image", type: "class", control: "c_media", media_type: "image" },
    { key: "k_video", type: "class", control: "c_media", media_type: "video" },
    { key: "k_audio", type: "class", control: "c_media", media_type: "audio" },
    { key: "o_img", type: "object", class: "k_image", scope: "double_clicked" },
    { key: "o_vid", type: "object", class: "k_video", scope: "double_clicked" },
    { key: "o_aud", type: "object", class: "k_audio", scope: "double_clicked" },
    { key: "c_viewer", type: "control", panel_id: "viewer", title_key: "panel.viewer" },

    // 右栏：元数据 / 标签·色彩 标签组 / tag表 / 播放·任务 标签组
    { key: "c_metadata", type: "control", panel_id: "metadata", title_key: "panel.metadata" },
    { key: "g_tags", type: "group", mode: "exclusive", name: "标签·色彩", position: { x: 780, y: 250 } },
    { key: "c_tags", type: "control", panel_id: "tags", title_key: "panel.tags" },
    { key: "c_color", type: "control", panel_id: "color", title_key: "panel.color" },
    { key: "c_tagtable", type: "control", panel_id: "tagtable", title_key: "panel.tagtable" },
    { key: "g_player", type: "group", mode: "exclusive", name: "播放·任务", position: { x: 780, y: 470 } },
    { key: "c_player", type: "control", panel_id: "player", title_key: "panel.player" },
    { key: "c_tasks", type: "control", panel_id: "tasks", title_key: "panel.tasks" },

    // 规则三元组：对象 → 操作 → 状态
    { key: "e_dbl_img", type: "event", trigger: "double_click" },
    { key: "e_dbl_vid", type: "event", trigger: "double_click" },
    { key: "e_dbl_aud", type: "event", trigger: "double_click" },
    { key: "a_show_viewer", type: "action", op: "show", target: "c_viewer" },
    { key: "a_show_player", type: "action", op: "show", target: "c_player" },
    { key: "a_show_meta", type: "action", op: "show", target: "c_metadata" },
  ],
  edges: [
    // 布局块 → 内容
    { from: "blk_left", to: "c_repo", kind: "contains", order: 1 },
    { from: "blk_left", to: "c_sources", kind: "contains", order: 2 },
    { from: "blk_left", to: "c_albums", kind: "contains", order: 3 },
    { from: "blk_center", to: "c_media", kind: "contains", order: 4 },
    { from: "blk_center", to: "c_viewer", kind: "contains", order: 5 },
    { from: "blk_right", to: "c_metadata", kind: "contains", order: 6 },
    { from: "blk_right", to: "g_tags", kind: "contains", order: 7 },
    { from: "blk_right", to: "c_tagtable", kind: "contains", order: 8 },
    { from: "blk_right", to: "g_player", kind: "contains", order: 9 },

    // 标签组 → 控件（标签组包含控件）
    { from: "g_tags", to: "c_tags", kind: "contains", order: 10 },
    { from: "g_tags", to: "c_color", kind: "contains", order: 11 },
    { from: "g_player", to: "c_player", kind: "contains", order: 12 },
    { from: "g_player", to: "c_tasks", kind: "contains", order: 13 },

    // 控件 → 类（媒体预览内的类）
    { from: "c_media", to: "k_image", kind: "contains", order: 14 },
    { from: "c_media", to: "k_video", kind: "contains", order: 15 },
    { from: "c_media", to: "k_audio", kind: "contains", order: 16 },

    // 类 → 对象（类内的对象）
    { from: "k_image", to: "o_img", kind: "contains", order: 17 },
    { from: "k_video", to: "o_vid", kind: "contains", order: 18 },
    { from: "k_audio", to: "o_aud", kind: "contains", order: 19 },

    // 规则：对象 → 操作 → 状态（on + fires）
    { from: "o_img", to: "e_dbl_img", kind: "on", order: 20 },
    { from: "o_vid", to: "e_dbl_vid", kind: "on", order: 21 },
    { from: "o_aud", to: "e_dbl_aud", kind: "on", order: 22 },
    { from: "e_dbl_img", to: "a_show_viewer", kind: "fires", order: 23 },
    { from: "e_dbl_vid", to: "a_show_player", kind: "fires", order: 24 },
    { from: "e_dbl_aud", to: "a_show_meta", kind: "fires", order: 25 },
  ],
};

/** 空蓝图文档（新建蓝图起步用）。 */
export function makeEmptyBlueprint(): BlueprintGraph {
  return { schema_version: BLUEPRINT_SCHEMA_VERSION, nodes: [], edges: [] };
}

/**
 * 旧版内置默认蓝图识别（用于自动升级为新版）。
 * 命中规则：带 default_version 且小于当前版本 → 旧库存默认；不带版本号时按结构特征
 * 识别更早的默认（曾有 g_viewers 但无布局块，或存在 blk_left→g_viewers 边）。
 * 不影响用户编辑的图（无版本号且无上述特征）。
 */
export function isObsoleteDefaultBlueprint(g: BlueprintGraph): boolean {
  if (g.default_version !== undefined) {
    return g.default_version < DEFAULT_BLUEPRINT_VERSION;
  }
  const hasBlocks = g.nodes.some((n) => n.type === "layout_block");
  const hasViewerGroup = g.nodes.some((n) => n.key === "g_viewers");
  const badBlockEdge = g.edges.some(
    (e) => e.from === "blk_left" && e.to === "g_viewers" && e.kind === "contains",
  );
  return badBlockEdge || (!hasBlocks && hasViewerGroup);
}
