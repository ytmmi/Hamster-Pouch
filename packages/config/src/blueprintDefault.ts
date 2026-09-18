/**
 * 蓝图**内置默认图**（RFC 0007 决策 5 / D32 / D47 / D51）。
 *
 * 权威来源只有这一处：本文件的 `DEFAULT_BLUEPRINT` 常量；Rust 侧夹具由
 * `pnpm generate:blueprint-fixture` 从它生成（`crates/hp-store/tests/default_blueprint.json`，
 * `include_str!` 引用，测试断言 27 节点 / 26 边）。两侧不得手工各写一份。
 *
 * `makeEmptyBlueprint` 是新建蓝图起步用的空文档；`forUserSave` / `isObsoleteDefaultBlueprint`
 * 属版本升级语义，留在 `blueprint.ts`（与 `DEFAULT_BLUEPRINT_VERSION` 同处）。
 */

import {
  BLUEPRINT_SCHEMA_VERSION,
  DEFAULT_BLUEPRINT_VERSION,
  type BlueprintGraph,
  type BlueprintNode,
} from "./blueprint";

// ============================== 内置默认蓝图 ==============================

/**
 * 内置默认蓝图 v7：如实表达当前默认「媒体-测试」布局（RFC 0007 决策 5 / D32 / D47 / D51）。
 *
 * 结构（**单层**「主界面」：层 ⊃ 界面 ⊃ 布局块 ⊃ 标签组 ⊃ 面板控件；面板控件 ⊃ 类 ⊃ 对象）
 * —— 与仓库默认布局逐栏对应：
 * - 分层（D51）：`layers = [{ key: "l_main", name: "主界面" }]`，**每个节点都带 `layer`**；
 *   一个层 = 一张画布 = 一个界面（页面）；多页面由用户新增层与界面节点，
 *   并用 `navigate`（界面跳转，D48）连接；
 * - 层内的根是**界面节点** `ui`（界面显示名取自层名，D51：不再另存 `name`）；
 * - 左栏（blk_left）：**三个独立面板**，故直接含 仓库、图像源、相册 三个面板控件
 *   （该栏没有 dockview 标签组）；
 * - 中栏（blk_center）：**只有一个标签组** `g_media`，其成员为 媒体预览 / 查看器 /
 *   媒体播放（布局里就是同一个 leaf 的三个标签页）；媒体预览内部再分
 *   图像/视频/音频 类 → 各一个「双击」对象；
 * - 右栏（blk_right）：**只有一个标签组** `g_inspector`，成员为 色彩参考 /
 *   标签·评分 / 元数据（布局里同样是同一个 leaf 的三个标签页）。
 *
 * 术语（D46）：节点类型 `control` 在文档与 UI 中显示为**面板控件**，
 * 与 `docs/spec/control-standard.md` 的「控件」（宿主标准 UI 单元）区分；
 * 浮层（`overlay`，D50）是**容器**，直接包含面板控件/标签组（2026-09 取消「浮动控件」绑定），
 * 默认蓝图不含浮层。
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
 * - 旧版内置默认由引擎按 `default_version` 自动升级（v6 → v7 即引入分层那次升级）；
 *   不保留旧模式兼容。
 */
export const DEFAULT_BLUEPRINT: BlueprintGraph = {
  schema_version: BLUEPRINT_SCHEMA_VERSION,
  default_version: DEFAULT_BLUEPRINT_VERSION,
  layers: [{ key: "l_main", name: "主界面" }],
  nodes: [
    // 界面（顶层容器 / 页面）：一行，居中于三栏之上
    { key: "ui", type: "interface", layer: "l_main", position: { x: 460, y: 40 } },

    // 布局块（各栏一列，位于界面之下）
    { key: "blk_left", type: "layout_block", layer: "l_main", name: "左栏", position: { x: 40, y: 170 } },
    { key: "blk_center", type: "layout_block", layer: "l_main", name: "中栏", position: { x: 460, y: 170 } },
    { key: "blk_right", type: "layout_block", layer: "l_main", name: "右栏", position: { x: 880, y: 170 } },

    // 左栏面板控件（仓库 / 图像源 / 相册）
    { key: "c_repo", type: "control", layer: "l_main", panel_id: "repo", title_key: "panel.repo", position: { x: 40, y: 300 } },
    { key: "c_sources", type: "control", layer: "l_main", panel_id: "sources", title_key: "panel.sources", position: { x: 40, y: 430 } },
    { key: "c_albums", type: "control", layer: "l_main", panel_id: "albums", title_key: "panel.albums", position: { x: 40, y: 560 } },

    // 中栏：**只有标签组** g_media（媒体预览 / 查看器 / 媒体播放同属一个 dockview
    // 标签组，对应布局里的一个 leaf），媒体预览内部再分 图像/视频/音频 类 → 对象。
    { key: "g_media", type: "group", layer: "l_main", mode: "exclusive", name: "媒体·查看器·播放", position: { x: 460, y: 300 } },
    { key: "c_media", type: "control", layer: "l_main", panel_id: "media", title_key: "panel.media", position: { x: 760, y: 300 } },
    { key: "c_viewer", type: "control", layer: "l_main", panel_id: "viewer", title_key: "panel.viewer", position: { x: 760, y: 430 } },
    { key: "c_player", type: "control", layer: "l_main", panel_id: "player", title_key: "panel.player", position: { x: 760, y: 560 } },
    { key: "k_image", type: "class", layer: "l_main", control: "c_media", media_type: "image", position: { x: 1060, y: 300 } },
    { key: "k_video", type: "class", layer: "l_main", control: "c_media", media_type: "video", position: { x: 1060, y: 430 } },
    { key: "k_audio", type: "class", layer: "l_main", control: "c_media", media_type: "audio", position: { x: 1060, y: 560 } },
    { key: "o_img", type: "object", layer: "l_main", class: "k_image", scope: "double_clicked", position: { x: 1360, y: 300 } },
    { key: "o_vid", type: "object", layer: "l_main", class: "k_video", scope: "double_clicked", position: { x: 1360, y: 430 } },
    { key: "o_aud", type: "object", layer: "l_main", class: "k_audio", scope: "double_clicked", position: { x: 1360, y: 560 } },

    // 右栏：**只有标签组** g_inspector（色彩参考 / 标签·评分 / 元数据同属一个 dockview 标签组）
    { key: "g_inspector", type: "group", layer: "l_main", mode: "exclusive", name: "色彩·标签·元数据", position: { x: 460, y: 720 } },
    { key: "c_color", type: "control", layer: "l_main", panel_id: "color", title_key: "panel.color", position: { x: 760, y: 720 } },
    { key: "c_tags", type: "control", layer: "l_main", panel_id: "tags", title_key: "panel.tags", position: { x: 760, y: 850 } },
    { key: "c_metadata", type: "control", layer: "l_main", panel_id: "metadata", title_key: "panel.metadata", position: { x: 760, y: 980 } },

    // 规则三元组：操作（由对象 on 边驱动）→ 状态
    { key: "e_dbl_img", type: "event", layer: "l_main", trigger: "double_click", position: { x: 1660, y: 300 } },
    { key: "e_dbl_vid", type: "event", layer: "l_main", trigger: "double_click", position: { x: 1660, y: 430 } },
    { key: "e_dbl_aud", type: "event", layer: "l_main", trigger: "double_click", position: { x: 1660, y: 560 } },
    { key: "a_show_viewer", type: "action", layer: "l_main", op: "show", target: "c_viewer", position: { x: 1960, y: 300 } },
    { key: "a_show_player", type: "action", layer: "l_main", op: "show", target: "c_player", payload: { play: true }, position: { x: 1960, y: 430 } },
    { key: "a_show_meta", type: "action", layer: "l_main", op: "show", target: "c_metadata", position: { x: 1960, y: 560 } },
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
 * 用户保存前的规范化：**去掉内置默认标记 `default_version`**，
 * 并清掉已取消的旧字段（`control_id`：2026-09 取消「浮动控件」绑定后不再有意义）。
 *
 * `default_version` 的语义是"这份文档是随应用分发的内置默认蓝图、可按版本自动升级"。
 * 用户一旦在编辑器中编辑并保存（哪怕编辑的就是默认蓝图），它就不再是内置默认，
 * 必须停止自动升级，否则下次装载会被新版内置默认静默覆盖，用户改动白丢。
 */
export function forUserSave(doc: BlueprintGraph): BlueprintGraph {
  const nodes = doc.nodes.map((node) => {
    if (!("control_id" in node)) {
      return node;
    }
    const { control_id: _retired, ...rest } = node as BlueprintNode & {
      control_id?: string;
    };
    return rest as BlueprintNode;
  });
  const cleaned: BlueprintGraph = { ...doc, nodes };
  if (cleaned.default_version === undefined) {
    return cleaned;
  }
  const { default_version: _ignored, ...rest } = cleaned;
  return rest;
}

/**
 * 旧版内置默认蓝图识别（用于自动升级为新版）。
 *
 * 规则：
 * - 带 `default_version` 且小于当前版本 → 旧库存内置默认（引擎种子写入，仅内置默认携带）；
 *   **v6 → v7** 的差异是引入**分层**（`layers` + 每个节点的 `layer`，D51），
 *   因此 v6 库存默认会被升级补齐分层；**v5 → v6** 是引入界面节点（D47）；
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
