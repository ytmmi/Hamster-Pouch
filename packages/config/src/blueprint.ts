/**
 * 蓝图（RFC 0007 / D28-D32）前端共享配置：
 * 节点/边类型、常量、内置默认蓝图（复现现状硬编码联动，保证零回归）。
 *
 * 蓝图文档整 JSON 存储（save = 整文档替换），语义校验由后端 `blueprint.validate` 承担；
 * 本文件只承载图结构类型、枚举常量与内置默认图。
 */

export const BLUEPRINT_SCHEMA_VERSION = 1;

/** 当前内置默认蓝图版本（引擎据此自动升级旧库存默认）。 */
export const DEFAULT_BLUEPRINT_VERSION = 6;

// ============================== 类型 ==============================

export type BlueprintNodeType =
  | "interface"
  | "layout_block"
  | "control"
  | "class"
  | "object"
  | "group"
  | "event"
  | "condition"
  | "action";

export type BlueprintTrigger = "click" | "double_click" | "selection_change";

export type BlueprintActionOp =
  | "show"
  | "hide"
  | "toggle"
  | "collapse"
  | "expand"
  /** 界面跳转：切换到目标界面（页面），D48。 */
  | "navigate";

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
  /**
   * 未接通（画布渲染用的**派生标记**，不落库）：
   * 删除/断线后节点自身缺少必要引用或触发来源，因而**不生效**，
   * 画布以灰色呈现，重新接好后自动恢复。由 `blueprintLint` 计算。
   */
  unlinked?: boolean;
}

/** 节点未接通的原因（画布提示文案用）。 */
export type BlueprintUnlinkedReason =
  | "missing-control"
  | "missing-class"
  | "missing-target"
  | "missing-object-source"
  | "missing-trigger";

/** 派生分析结果：未接通节点 key → 原因。 */
export type BlueprintUnlinkedMap = Record<string, BlueprintUnlinkedReason>;

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
 * 内置默认蓝图 v6：如实表达当前默认「媒体-测试」布局（RFC 0007 决策 5 / D32 / D47）。
 *
 * 结构（界面 ⊃ 布局块 ⊃ 标签组 ⊃ 面板控件；面板控件 ⊃ 类 ⊃ 对象）—— 与仓库默认布局逐栏对应：
 * - 顶层 `ui`：**界面节点**（一个界面 = 一个页面；多页面由用户自行新增界面节点并用
 *   `navigate`（界面跳转）连接，D47/D48）；
 * - 左栏（blk_left）：**三个独立面板**，故直接含 仓库、图像源、相册 三个面板控件
 *   （该栏没有 dockview 标签组）；
 * - 中栏（blk_center）：**只有一个标签组** `g_media`，其成员为 媒体预览 / 查看器 /
 *   媒体播放（布局里就是同一个 leaf 的三个标签页）；媒体预览内部再分
 *   图像/视频/音频 类 → 各一个「双击」对象；
 * - 右栏（blk_right）：**只有一个标签组** `g_inspector`，成员为 色彩参考 /
 *   标签·评分 / 元数据（布局里同样是同一个 leaf 的三个标签页）。
 *
 * 术语（D46）：节点类型 `control` 在文档与 UI 中显示为**面板控件**，
 * 与 `docs/spec/control-standard.md` 的「控件」（宿主标准 UI 单元）区分。
 *
 * 规则（对象 → 操作 → 状态，全部连线）：
 * - 双击 图像·双击对象 → 显示 查看器；
 * - 双击 视频·双击对象 → 显示 播放器并播放（`payload.play`）；
 * - 双击 音频·双击对象 → 显示 元数据。
 *
 * 说明：
 * - **标签组优先**：某栏在布局里是一个 dockview 标签组时，布局块只连标签组，
 *   成员面板控件由标签组 `contains`；只有该栏由多个独立面板组成（如左栏）时，
 *   布局块才直接连面板控件。
 * - **界面节点只连布局块**（`ui → blk_left/blk_center/blk_right`），不直接连标签组/面板控件。
 * - 「媒体-测试」默认布局中 `tagtable`（tag表）与 `tasks`（任务）未挂载，故默认蓝图
 *   不含它们；用户需要时在编辑器中加 `control` 节点并放进标签组即可。
 * - `default_visible` 留空（不指定默认可见成员）：对账时保留布局自身的激活标签；
 *   `media` 与查看器/播放器同属 `g_media`，双击动作由「激活已存在面板」完成，
 *   不会因切换标签而把面板销毁。
 * - 节点 `position` 为画布世界坐标（界面一行、布局块一行、各栏一列），**互不重叠**，
 *   打开编辑器即可读清结构；拖拽后位置随文档落库（D30）。
 * - 旧版内置默认由引擎按 `default_version` 自动升级（v5 → v6 即引入界面节点的那次升级）；
 *   不保留旧模式兼容。
 */
export const DEFAULT_BLUEPRINT: BlueprintGraph = {
  schema_version: BLUEPRINT_SCHEMA_VERSION,
  default_version: DEFAULT_BLUEPRINT_VERSION,
  nodes: [
    // 界面（顶层容器 / 页面）：一行，居中于三栏之上
    { key: "ui", type: "interface", name: "主界面", position: { x: 460, y: 40 } },

    // 布局块（各栏一列，位于界面之下）
    { key: "blk_left", type: "layout_block", name: "左栏", position: { x: 40, y: 170 } },
    { key: "blk_center", type: "layout_block", name: "中栏", position: { x: 460, y: 170 } },
    { key: "blk_right", type: "layout_block", name: "右栏", position: { x: 880, y: 170 } },

    // 左栏面板控件（仓库 / 图像源 / 相册）
    { key: "c_repo", type: "control", panel_id: "repo", title_key: "panel.repo", position: { x: 40, y: 300 } },
    { key: "c_sources", type: "control", panel_id: "sources", title_key: "panel.sources", position: { x: 40, y: 430 } },
    { key: "c_albums", type: "control", panel_id: "albums", title_key: "panel.albums", position: { x: 40, y: 560 } },

    // 中栏：**只有标签组** g_media（媒体预览 / 查看器 / 媒体播放同属一个 dockview
    // 标签组，对应布局里的一个 leaf），媒体预览内部再分 图像/视频/音频 类 → 对象。
    { key: "g_media", type: "group", mode: "exclusive", name: "媒体·查看器·播放", position: { x: 460, y: 300 } },
    { key: "c_media", type: "control", panel_id: "media", title_key: "panel.media", position: { x: 760, y: 300 } },
    { key: "c_viewer", type: "control", panel_id: "viewer", title_key: "panel.viewer", position: { x: 760, y: 430 } },
    { key: "c_player", type: "control", panel_id: "player", title_key: "panel.player", position: { x: 760, y: 560 } },
    { key: "k_image", type: "class", control: "c_media", media_type: "image", position: { x: 1060, y: 300 } },
    { key: "k_video", type: "class", control: "c_media", media_type: "video", position: { x: 1060, y: 430 } },
    { key: "k_audio", type: "class", control: "c_media", media_type: "audio", position: { x: 1060, y: 560 } },
    { key: "o_img", type: "object", class: "k_image", scope: "double_clicked", position: { x: 1360, y: 300 } },
    { key: "o_vid", type: "object", class: "k_video", scope: "double_clicked", position: { x: 1360, y: 430 } },
    { key: "o_aud", type: "object", class: "k_audio", scope: "double_clicked", position: { x: 1360, y: 560 } },

    // 右栏：**只有标签组** g_inspector（色彩参考 / 标签·评分 / 元数据同属一个 dockview 标签组）
    { key: "g_inspector", type: "group", mode: "exclusive", name: "色彩·标签·元数据", position: { x: 460, y: 720 } },
    { key: "c_color", type: "control", panel_id: "color", title_key: "panel.color", position: { x: 760, y: 720 } },
    { key: "c_tags", type: "control", panel_id: "tags", title_key: "panel.tags", position: { x: 760, y: 850 } },
    { key: "c_metadata", type: "control", panel_id: "metadata", title_key: "panel.metadata", position: { x: 760, y: 980 } },

    // 规则三元组：操作（由对象 on 边驱动）→ 状态
    { key: "e_dbl_img", type: "event", trigger: "double_click", position: { x: 1660, y: 300 } },
    { key: "e_dbl_vid", type: "event", trigger: "double_click", position: { x: 1660, y: 430 } },
    { key: "e_dbl_aud", type: "event", trigger: "double_click", position: { x: 1660, y: 560 } },
    { key: "a_show_viewer", type: "action", op: "show", target: "c_viewer", position: { x: 1960, y: 300 } },
    { key: "a_show_player", type: "action", op: "show", target: "c_player", payload: { play: true }, position: { x: 1960, y: 430 } },
    { key: "a_show_meta", type: "action", op: "show", target: "c_metadata", position: { x: 1960, y: 560 } },
  ],
  edges: [
    // 界面 → 布局块（顶层容器收纳区域）
    { from: "ui", to: "blk_left", kind: "contains", order: 1 },
    { from: "ui", to: "blk_center", kind: "contains", order: 2 },
    { from: "ui", to: "blk_right", kind: "contains", order: 3 },

    // 布局块 → 内容（**标签组优先**：某栏在布局里就是一个 dockview 标签组时，
    // 布局块只连该组，成员面板控件由标签组 contains；只有该栏由多个独立面板组成时，
    // 布局块才直接连面板控件，如左栏）
    { from: "blk_left", to: "c_repo", kind: "contains", order: 4 },
    { from: "blk_left", to: "c_sources", kind: "contains", order: 5 },
    { from: "blk_left", to: "c_albums", kind: "contains", order: 6 },
    { from: "blk_center", to: "g_media", kind: "contains", order: 7 },
    { from: "blk_right", to: "g_inspector", kind: "contains", order: 8 },

    // 标签组 → 面板控件（标签组包含面板控件；中栏的媒体预览/查看器/播放同属一个标签组）
    { from: "g_media", to: "c_media", kind: "contains", order: 9 },
    { from: "g_media", to: "c_viewer", kind: "contains", order: 10 },
    { from: "g_media", to: "c_player", kind: "contains", order: 11 },
    { from: "g_inspector", to: "c_color", kind: "contains", order: 12 },
    { from: "g_inspector", to: "c_tags", kind: "contains", order: 13 },
    { from: "g_inspector", to: "c_metadata", kind: "contains", order: 14 },

    // 面板控件 → 类（媒体预览内的类）
    { from: "c_media", to: "k_image", kind: "contains", order: 15 },
    { from: "c_media", to: "k_video", kind: "contains", order: 16 },
    { from: "c_media", to: "k_audio", kind: "contains", order: 17 },

    // 类 → 对象（类内的对象）
    { from: "k_image", to: "o_img", kind: "contains", order: 18 },
    { from: "k_video", to: "o_vid", kind: "contains", order: 19 },
    { from: "k_audio", to: "o_aud", kind: "contains", order: 20 },

    // 规则：对象 → 操作（on）→ 状态（fires）
    { from: "o_img", to: "e_dbl_img", kind: "on", order: 21 },
    { from: "o_vid", to: "e_dbl_vid", kind: "on", order: 22 },
    { from: "o_aud", to: "e_dbl_aud", kind: "on", order: 23 },
    { from: "e_dbl_img", to: "a_show_viewer", kind: "fires", order: 24 },
    { from: "e_dbl_vid", to: "a_show_player", kind: "fires", order: 25 },
    { from: "e_dbl_aud", to: "a_show_meta", kind: "fires", order: 26 },
  ],
};

/** 空蓝图文档（新建蓝图起步用）。 */
export function makeEmptyBlueprint(): BlueprintGraph {
  return { schema_version: BLUEPRINT_SCHEMA_VERSION, nodes: [], edges: [] };
}

/**
 * 用户保存前的规范化：**去掉内置默认标记 `default_version`**。
 *
 * 该字段语义是"这份文档是随应用分发的内置默认蓝图、可按版本自动升级"。
 * 用户一旦在编辑器中编辑并保存（哪怕编辑的就是默认蓝图），它就不再是内置默认，
 * 必须停止自动升级，否则下次装载会被新版内置默认静默覆盖，用户改动白丢。
 */
export function forUserSave(doc: BlueprintGraph): BlueprintGraph {
  if (doc.default_version === undefined) {
    return doc;
  }
  const { default_version: _ignored, ...rest } = doc;
  return rest;
}

/**
 * 旧版内置默认蓝图识别（用于自动升级为新版）。
 *
 * 规则：
 * - 带 `default_version` 且小于当前版本 → 旧库存内置默认（引擎种子写入，仅内置默认携带）；
 *   **v5 → v6** 的差异是引入顶层**界面节点**（D47），因此 v5 库存默认会被升级补齐界面节点；
 * - 无版本号时只在**结构特征明确指向旧默认**（存在 `blk_*` → 旧分组 key 的 contains 边）
 *   才判定为旧默认。仅"有分组但无布局块"不算——那是用户自建的合法图，
 *   不能被静默覆盖；用户一旦在编辑器保存，`default_version` 会被移除（`forUserSave`）。
 */
export function isObsoleteDefaultBlueprint(g: BlueprintGraph): boolean {
  if (g.default_version !== undefined) {
    return g.default_version < DEFAULT_BLUEPRINT_VERSION;
  }
  const legacyGroupKeys = ["g_viewers", "g_tags", "g_player"];
  return g.edges.some(
    (e) =>
      e.kind === "contains" &&
      e.from.startsWith("blk_") &&
      legacyGroupKeys.includes(e.to),
  );
}
