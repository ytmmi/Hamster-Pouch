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
 * 内置默认蓝图 v8：**与随包分发的「演示布局」同一份编辑**（RFC 0007 决策 5 / D32 / D47 / D51 / D155）。
 *
 * 这份图取自演示布局所绑定的那份蓝图（2026-11-10 保存「媒体-测试」布局时，
 * `layout.syncBlueprint` 在同一次保存里既写布局、也写蓝图）：**2 层 / 60 节点 / 53 边**。
 * 布局与蓝图必须同源——只更新一半，全新安装就会看到「界面 2」有标签页、蓝图里却没有该层画布。
 * `tools/package-build.mjs` 打包时逐层比对，缺层即失败退出。
 *
 * 结构：层 ⊃ 界面 ⊃ 布局块 ⊃ 标签组 ⊃ 面板；面板 ⊃ 类目 ⊃ 子类 ⊃ 对象；对象 ⊃ 操作 → 状态。
 * - 分层（D51）：`l_main`（主界面，`is_home`）与 `l_2`（界面 2），**每个节点都带 `layer`**；
 *   一个层 = 一张画布 = 一个界面（页面），多页面之间用 `navigate`（D48）连接；
 * - 标签组（`group`）用 `contains` 收纳成员面板；布局块（`layout_block`）只连标签组或
 *   独立面板（**标签组优先**）；浮层（`overlay`，D50）是容器，v8 起随演示布局一起携带；
 * - 节点 `position` 为画布世界坐标，打开编辑器即可读清结构；拖拽后位置随文档落库（D30）。
 *
 * 术语见 D71 / RFC 0010 决策 1：节点类型 `control` 显示为**面板**，`class` 显示为**类目**。
 *
 * 版本：v7 → v8 补齐了随包演示布局的第二层（`l_2`）及随之新增的面板/类目/浮层节点；
 * 旧库里的内置默认由引擎按 `default_version` 静默升级，用户改过的图（`forUserSave` 已去掉该标记）
 * 不会被覆盖。
 */
export const DEFAULT_BLUEPRINT: BlueprintGraph = {
  schema_version: BLUEPRINT_SCHEMA_VERSION,
  default_version: DEFAULT_BLUEPRINT_VERSION,
  layers: [
    { key: "l_main", name: "主界面", is_home: true },
    { key: "l_2", name: "界面 2", is_home: false },
  ],
  nodes: [
    // 层 l_main（主界面）：48 节点
    { key: "blk_left", type: "layout_block", layer: "l_main", name: "左栏", position: { x: 337, y: 40 } },
    { key: "blk_center", type: "layout_block", layer: "l_main", name: "中栏", position: { x: 337, y: 210 } },
    { key: "blk_right", type: "layout_block", layer: "l_main", name: "右栏", position: { x: 337, y: 380 } },
    { key: "c_repo", type: "control", layer: "l_main", panel_id: "repo", title_key: "panel.repo", position: { x: 637, y: 40 } },
    { key: "c_sources", type: "control", layer: "l_main", panel_id: "sources", title_key: "panel.sources", position: { x: 637, y: 210 } },
    { key: "c_albums", type: "control", layer: "l_main", panel_id: "albums", title_key: "panel.albums", position: { x: 637, y: 380 } },
    { key: "g_media", type: "group", layer: "l_main", name: "媒体·查看器·播放", mode: "exclusive", position: { x: 637, y: 550 } },
    { key: "c_media", type: "control", layer: "l_main", panel_id: "media", title_key: "panel.media", position: { x: 937, y: 210 } },
    { key: "c_player", type: "control", layer: "l_main", panel_id: "player", title_key: "panel.player", position: { x: 937, y: 380 } },
    { key: "k_image", type: "class", layer: "l_main", control: "c_media", media_type: "image", position: { x: 1237, y: 210 } },
    { key: "k_video", type: "class", layer: "l_main", control: "c_media", media_type: "video", position: { x: 1237, y: 380 } },
    { key: "k_audio", type: "class", layer: "l_main", control: "c_media", media_type: "audio", position: { x: 1237, y: 550 } },
    { key: "o_img", type: "object", layer: "l_main", class: "k_image", scope: "double_clicked", position: { x: 1537, y: 380 } },
    { key: "o_vid", type: "object", layer: "l_main", class: "k_video", scope: "double_clicked", position: { x: 1537, y: 550 } },
    { key: "o_aud", type: "object", layer: "l_main", class: "k_audio", scope: "double_clicked", position: { x: 1537, y: 720 } },
    { key: "g_inspector", type: "group", layer: "l_main", name: "色彩·标签·元数据", mode: "exclusive", position: { x: 637, y: 720 } },
    { key: "c_color", type: "control", layer: "l_main", panel_id: "color", title_key: "panel.color", position: { x: 637, y: 890 } },
    { key: "c_tags", type: "control", layer: "l_main", panel_id: "tags", title_key: "panel.tags", position: { x: 937, y: 1060 } },
    { key: "c_metadata", type: "control", layer: "l_main", panel_id: "metadata", title_key: "panel.metadata", position: { x: 637, y: 1060 } },
    { key: "e_dbl_img", type: "event", layer: "l_main", position: { x: 1837, y: 380 }, trigger: "double_click", target: "o_img" },
    { key: "e_dbl_vid", type: "event", layer: "l_main", position: { x: 1837, y: 550 }, trigger: "double_click" },
    { key: "e_dbl_aud", type: "event", layer: "l_main", position: { x: 1837, y: 720 }, trigger: "double_click" },
    { key: "a_show_viewer", type: "action", layer: "l_main", position: { x: 2137, y: 380 }, target: "c_1_3", op: "show" },
    { key: "a_show_player", type: "action", layer: "l_main", position: { x: 2137, y: 550 }, target: "c_player", op: "show", payload: { play: true } },
    { key: "a_show_meta", type: "action", layer: "l_main", position: { x: 2137, y: 720 }, target: "c_player", op: "show" },
    { key: "ui", type: "interface", layer: "l_main", position: { x: 37, y: 40 } },
    { key: "ov_1", type: "overlay", layer: "l_main", position: { x: 2737, y: 42 }, visible: true, height: 2, size: { width: 200, height: 600 }, shadow: "sm", radius: "lg", hide_label: true },
    { key: "c_1", type: "control", layer: "l_main", panel_id: "tasks", position: { x: 2737, y: 212 } },
    { key: "c_1_3", type: "control", layer: "l_main", name: "图像查看器", panel_id: "imageviewer", title_key: "panel.imageviewer", position: { x: 937, y: 550 } },
    { key: "c_1_4", type: "control", layer: "l_main", panel_id: "viewer", title_key: "panel.viewer", position: { x: 937, y: 1230 } },
    { key: "c_1_5", type: "control", layer: "l_main", panel_id: "bookpreview", title_key: "panel.bookpreview", position: { x: 937, y: 720 } },
    { key: "c_media_image", type: "class", layer: "l_main", control: "c_1_5", media_type: "text", position: { x: 1237, y: 720 } },
    { key: "k_1", type: "subclass", layer: "l_main", format: "epub", subclass: "c_media_image", position: { x: 1537, y: 890 } },
    { key: "k_1_dbl", type: "object", layer: "l_main", subclass: "k_1", scope: "double_clicked", position: { x: 1837, y: 890 } },
    { key: "k_1_dbl_event", type: "event", layer: "l_main", position: { x: 2137, y: 890 }, trigger: "double_click" },
    { key: "k_1_dbl_event_show", type: "action", layer: "l_main", position: { x: 2437, y: 40 }, target: "c_1_6", op: "show" },
    { key: "c_media_image_dbl", type: "object", layer: "l_main", class: "c_media_image", scope: "double_clicked", position: { x: 1537, y: 1060 } },
    { key: "c_media_image_dbl_event", type: "event", layer: "l_main", position: { x: 1837, y: 1060 }, trigger: "double_click" },
    { key: "c_media_image_dbl_event_show", type: "action", layer: "l_main", position: { x: 2137, y: 1060 }, target: "c_1_6", op: "show" },
    { key: "c_1_6", type: "control", layer: "l_main", panel_id: "bookreader", title_key: "panel.bookreader", position: { x: 937, y: 890 } },
    { key: "c_albums_album", type: "class", layer: "l_main", control: "c_albums", media_type: "album", position: { x: 937, y: 40 } },
    { key: "c_albums_album_media", type: "mark", layer: "l_main", mark: "media", object: "o_1", position: { x: 1537, y: 40 } },
    { key: "c_albums_album_media_dbl_event", type: "event", layer: "l_main", position: { x: 1837, y: 40 }, trigger: "click", target: "c_albums_album_media" },
    { key: "c_albums_album_media_dbl_event_show", type: "action", layer: "l_main", position: { x: 2137, y: 40 }, target: "c_media", op: "show" },
    { key: "o_1", type: "object", layer: "l_main", class: "c_albums_album", scope: "clicked", position: { x: 1237, y: 40 } },
    { key: "o_1_media", type: "mark", layer: "l_main", mark: "document", position: { x: 1537, y: 210 }, object: "o_1" },
    { key: "o_1_event", type: "event", layer: "l_main", trigger: "click", position: { x: 1837, y: 210 }, target: "o_1_media" },
    { key: "o_1_event_show", type: "action", layer: "l_main", op: "show", position: { x: 2137, y: 210 }, target: "c_1_5" },
    // 层 l_2（界面 2）：3 节点
    { key: "ui_2", type: "interface", layer: "l_2", position: { x: 153.33969130004868, y: 1450 } },
    { key: "c_1_2", type: "control", layer: "l_2", panel_id: "sources", position: { x: 753.3396913000487, y: 1450 } },
    { key: "blk_1", type: "layout_block", layer: "l_2", position: { x: 453.3396913000487, y: 1450 } },
  ],
  edges: [
    { from: "blk_left", to: "c_repo", kind: "contains", order: 1 },
    { from: "blk_left", to: "c_sources", kind: "contains", order: 2 },
    { from: "blk_left", to: "c_albums", kind: "contains", order: 3 },
    { from: "blk_center", to: "g_media", kind: "contains", order: 4 },
    { from: "blk_right", to: "g_inspector", kind: "contains", order: 5 },
    { from: "g_media", to: "c_media", kind: "contains", order: 6 },
    { from: "g_media", to: "c_player", kind: "contains", order: 8 },
    { from: "g_inspector", to: "c_tags", kind: "contains", order: 10 },
    { from: "c_media", to: "k_image", kind: "contains", order: 12 },
    { from: "c_media", to: "k_video", kind: "contains", order: 13 },
    { from: "c_media", to: "k_audio", kind: "contains", order: 14 },
    { from: "k_image", to: "o_img", kind: "contains", order: 15 },
    { from: "k_video", to: "o_vid", kind: "contains", order: 16 },
    { from: "k_audio", to: "o_aud", kind: "contains", order: 17 },
    { from: "o_vid", to: "e_dbl_vid", kind: "on", order: 19 },
    { from: "o_aud", to: "e_dbl_aud", kind: "on", order: 20 },
    { from: "e_dbl_img", to: "a_show_viewer", kind: "fires", order: 21 },
    { from: "e_dbl_vid", to: "a_show_player", kind: "fires", order: 22 },
    { from: "e_dbl_aud", to: "a_show_meta", kind: "fires", order: 23 },
    { from: "ui", to: "blk_left", kind: "contains", order: 24 },
    { from: "ui", to: "blk_center", kind: "contains", order: 25 },
    { from: "ui", to: "blk_right", kind: "contains", order: 26 },
    { from: "ov_1", to: "c_1", kind: "contains", order: 28 },
    { from: "ui_2", to: "blk_1", kind: "contains", order: 29 },
    { from: "blk_1", to: "c_1_2", kind: "contains", order: 30 },
    { from: "o_img", to: "e_dbl_img", kind: "on", order: 31 },
    { from: "g_media", to: "c_1_3", kind: "contains", order: 32 },
    { from: "blk_right", to: "c_color", kind: "contains", order: 33 },
    { from: "blk_right", to: "c_metadata", kind: "contains", order: 34 },
    { from: "g_inspector", to: "c_1_4", kind: "contains", order: 35 },
    { from: "g_media", to: "c_1_5", kind: "contains", order: 36 },
    { from: "k_1_dbl", to: "k_1_dbl_event", kind: "on", order: 36 },
    { from: "k_1_dbl_event", to: "k_1_dbl_event_show", kind: "fires", order: 37 },
    { from: "c_1_5", to: "c_media_image", kind: "contains", order: 38 },
    { from: "c_media_image", to: "k_1", kind: "contains", order: 39 },
    { from: "k_1", to: "k_1_dbl", kind: "contains", order: 40 },
    { from: "c_media_image_dbl", to: "c_media_image_dbl_event", kind: "on", order: 41 },
    { from: "c_media_image_dbl_event", to: "c_media_image_dbl_event_show", kind: "fires", order: 42 },
    { from: "c_media_image", to: "c_media_image_dbl", kind: "contains", order: 43 },
    { from: "g_media", to: "c_1_6", kind: "contains", order: 44 },
    { from: "c_albums", to: "c_albums_album", kind: "contains", order: 45 },
    { from: "c_albums_album_media_dbl_event", to: "c_albums_album_media_dbl_event_show", kind: "fires", order: 49 },
    { from: "c_albums_album", to: "o_1", kind: "contains", order: 50 },
    { from: "o_1", to: "c_albums_album_media", kind: "contains", order: 51 },
    { from: "c_albums_album_media", to: "c_albums_album_media_dbl_event", kind: "on", order: 52 },
    { from: "o_1", to: "o_1_media", kind: "contains", order: 53 },
    { from: "o_1_media", to: "o_1_event", kind: "on", order: 54 },
    { from: "o_1_event", to: "o_1_event_show", kind: "fires", order: 55 },
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
