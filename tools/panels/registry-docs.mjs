/**
 * 面板门禁分节 · 注册表文档一致性 / 命名空间 / 全部设置 / 菜单 / 仓库面板（原第 16–23 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList, stripComments } from "./harness.mjs";
import {
  ROOT, builtinIds, config, doc, registrySource, repoDisplay,
  rustPanels, stylesSource,
} from "./shared.mjs";
export default async function run() {
// ============================== 3. 文档一致性 ==============================

const missingInDoc = builtinIds.filter((id) => !doc.includes(`\`${id}\``));
check(
  "面板标准文档列出了全部内置面板 id",
  missingInDoc.length === 0,
  `缺: ${missingInDoc.join(", ") || "无"}`,
);
const missingCategory = config.PANEL_CATEGORIES.filter(
  (category) => !doc.includes(`\`${category}\``),
);
check(
  "面板标准文档列出了全部 category",
  missingCategory.length === 0,
  `缺: ${missingCategory.join(", ") || "无"}`,
);
const missingParam = ["has_class", "blueprint_node", "title_key", "mount", "origin"].filter(
  (name) => !doc.includes(`\`${name}\``),
);
check(
  "面板标准文档列出了关键声明参数",
  missingParam.length === 0,
  `缺: ${missingParam.join(", ") || "无"}`,
);
// 文档声明的「有类目的内置面板」必须与注册表一致（防文档与代码脱节）。
// **四个**面板各自必须出现 `**`true`**` 的写法（D135：albums / sources 由 false 改为 true）——
// 只匹配 media / bookpreview 的旧正则会在"文档已经改、断言没改"时静默放过另外两个。
check(
  "文档与注册表在 has_class 上口径一致（media / bookpreview / albums / sources 是有类目的内置面板）",
  doc.includes("`media`") &&
    /`media`（媒体预览）\s*\|\s*\*\*`true`\*\*/.test(doc) &&
    /`bookpreview`（图书预览）\s*\|\s*\*\*`true`\*\*/.test(doc) &&
    /`albums`（相册）\s*\|\s*\*\*`true`\*\*/.test(doc) &&
    /`sources`（源）\s*\|\s*\*\*`true`\*\*/.test(doc),
);

// ============================== 4. Rust ↔ TS 取值域 ==============================

/** 从 `impl X { fn as_str ... }` 的 match 臂读出「枚举名 → JSON 取值」。 */
function asStrMap(source, enumName) {
  const implStart = source.indexOf(`impl ${enumName} {`);
  if (implStart < 0) throw new Error(`未找到 impl ${enumName}`);
  const block = source.slice(implStart, source.indexOf("\n}", implStart));
  const map = new Map();
  for (const m of block.matchAll(new RegExp(`${enumName}::(\\w+)\\s*=>\\s*"([^"]+)"`, "g"))) {
    map.set(m[1], m[2]);
  }
  if (map.size === 0) throw new Error(`未能解析 ${enumName}::as_str`);
  return map;
}

const rustCategoryMap = asStrMap(rustPanels, "PanelCategory");
const rustCategories = [...rustCategoryMap.values()];
check(
  "Rust PanelCategory ↔ TS PANEL_CATEGORIES 一致（含顺序）",
  eqList(rustCategories, [...config.PANEL_CATEGORIES]),
  `rust=${rustCategories.join(",")} ts=${config.PANEL_CATEGORIES.join(",")}`,
);

const rustSettingKindMap = asStrMap(rustPanels, "PanelSettingKind");
check(
  "Rust 面板设置项输入类白名单 ↔ TS 一致",
  eqList([...rustSettingKindMap.values()], [...config.PANEL_SETTING_KINDS]),
  `rust=${[...rustSettingKindMap.values()].join(",")} ts=${config.PANEL_SETTING_KINDS.join(",")}`,
);
check(
  "设置项控件白名单**不含 button**（设置项是值不是动作）",
  !config.PANEL_SETTING_KINDS.includes("button"),
);

// ============================== 5. 命名空间与插件注册路径 ==============================

const bareOk = ["repo", "media", "plugin_x"].every((id) => config.isValidPanelId(id));
const pluginOk = config.isValidPanelId("plugin.dev.hamsterpouch.palette.palette");
const pluginBad = [
  "plugin.palette",
  "plugin.x.y",
  "Palette",
  "plugin..panel",
].every((id) => !config.isValidPanelId(id));
check(
  "面板 id 命名规则：裸 id 合法、插件项必须 plugin.<plugin_id>.<local_id>",
  bareOk && pluginOk && pluginBad,
);
check(
  "不存在覆盖宿主内置面板的路径（形式保证：裸 id 永不满足插件命名空间）",
  !config.isPluginNamespacedId("media") && config.isPluginNamespacedId(
    "plugin.dev.hamsterpouch.palette.palette",
  ),
);

// 插件面板登记 → 出现在合并注册表 → 注销后消失（插件缺失不得绑架用户数据）。
const pluginPanelId = "plugin.dev.hamsterpouch.palette.palette";
config.registerPluginPanels([
  {
    id: pluginPanelId,
    titleKey: "plugin.palette.panel",
    category: "media",
    hasClass: true,
    blueprintNode: "control",
    origin: { kind: "plugin", plugin_id: "dev.hamsterpouch.palette" },
  },
]);
const afterRegister = config.allPanels().map((p) => p.id);
const registeredOk =
  afterRegister.includes(pluginPanelId) &&
  config.panelTitleKeyOf(pluginPanelId) === "plugin.palette.panel" &&
  // 组件表的**动态注册路径**：面板项清单由注册表派生（不是写死的 16 项），
  // dockview 组件表也走订阅版（插件注册/卸载后重建）。
  /pluginRegisteredPanels\(\)/.test(registrySource) &&
  /export function useDockComponents/.test(registrySource) &&
  /export function allPanelDefs/.test(registrySource);
check(
  "插件面板登记后进入合并注册表（组件表接入动态注册路径）",
  registeredOk,
  `panels=${afterRegister.length}`,
);

config.unregisterPluginPanels("dev.hamsterpouch.palette");
const afterUnregister = config.allPanels().map((p) => p.id);
check(
  "插件卸载后注册项消失（节点与边由蓝图侧按「未接通」保留，不在此删除用户数据）",
  !afterUnregister.includes(pluginPanelId) && afterUnregister.length === 17,
  `panels=${afterUnregister.length}`,
);

// 未注册的 panel_id 仍然是**合法取值**：解析层接受、按未接通处理（不阻塞保存）。
const ghostGraph = JSON.stringify({
  schema_version: 2,
  layers: [{ key: "l_a", name: "主界面" }],
  nodes: [
    { key: "ui", type: "interface", layer: "l_a" },
    { key: "blk", type: "layout_block", layer: "l_a", name: "栏" },
    { key: "c", type: "control", layer: "l_a", panel_id: pluginPanelId },
  ],
  edges: [
    { from: "ui", to: "blk", kind: "contains", order: 1 },
    { from: "blk", to: "c", kind: "contains", order: 2 },
  ],
});
const parsed = config.parseBlueprintDocument(ghostGraph);
check(
  "插件面板缺失时蓝图仍可解析（引用原样保留，不阻塞保存）",
  parsed !== null && parsed.nodes.find((n) => n.key === "c").panel_id === pluginPanelId,
);

// ============================== 6. 「全部设置」覆盖与分组 ==============================

const settingsRegistry = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/settings/settingsRegistry.ts")).href
);
const groups = settingsRegistry.panelSubGroups();
const listed = groups.flatMap((g) => g.items.map((i) => i.anchor));
const listedIds = listed.map((a) => a.slice("panel.".length)).sort();
const withSettingsIds = settingsRegistry
  .panelsWithSettings()
  .map((p) => p.id)
  .sort();
check(
  "「全部设置 → 面板」二级列表只列出声明了 settings 的面板",
  eqList(listedIds, withSettingsIds),
  `listed=${listedIds.length} withSettings=${withSettingsIds.length} 全部面板=${config.PANEL_IDS.length}`,
);
const groupMismatch = [];
for (const group of groups) {
  const category = group.groupKey.replace("settings.panelCategory.", "");
  for (const item of group.items) {
    const id = item.anchor.slice("panel.".length);
    const spec = config.panelSpec(id);
    if (!spec || spec.category !== category) groupMismatch.push(`${id}: ${spec?.category} != ${category}`);
  }
}
check(
  "「全部设置 → 面板」二级分组与面板 category 一致",
  groupMismatch.length === 0,
  groupMismatch.join(" | ") || `${groups.length} 个分类分组逐项一致`,
);

// ==================== 右键菜单与面板边界（2026-09 缺陷修复的守护）====================
//
// 防的是：dockview 在布局动画期给 `.dv-view` 加 `will-change: transform`
// （`dockview.css` 的 `.dv-pane-container.dv-animated .dv-view` /
// `.dv-split-view-container.dv-animation .dv-view`），使它成为 `position: fixed`
// 的**包含块**。菜单若还渲染在面板内部，`left: clientX` 就会被当成"相对面板"的坐标，
// 表现为**菜单跑到面板右下角、离光标很远**，并被 `.dv-groupview { overflow: hidden }`
// **按面板边缘裁掉**。portal 到 `body` 是这条链的唯一解——所以它必须是门禁而不是注释。

const contextMenuSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/menu/ContextMenu.tsx"),
  "utf8",
);
check(
  "右键菜单 portal 到 document.body（否则被 .dv-view 的 transform 俘获、按面板边缘截断）",
  /import\s*\{[^}]*createPortal[^}]*\}\s*from\s*"react-dom"/.test(contextMenuSrc) &&
    /createPortal\(/.test(contextMenuSrc) &&
    /document\.body/.test(contextMenuSrc),
);
check(
  "右键菜单仍是 position: fixed（portal 生效的前提；改回 absolute 会相对滚动容器定位）",
  /\.context-menu\s*\{[^}]*position:\s*fixed/.test(stylesSource),
);
check(
  "右键菜单越界时翻到光标另一侧（不是只贴边内收——那会让菜单离光标很远）",
  /x\s*-\s*width/.test(contextMenuSrc) && /y\s*-\s*contentHeight/.test(contextMenuSrc),
);

// ==================== 「扩展」菜单：已安装插件目录（装了但没启用必须可见）====================
//
// 防的是：装完插件后「扩展」菜单里**什么都不出现**、界面也无任何提示，
// 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。
// 更深的缺陷（issues/0038）：早期目录是「面板目录」——一行一个面板贡献点，
// 无面板的插件用 `panel = null` 哨兵硬塞，「有没有面板」被当成了「有没有启用语义」。
// 随包的 `python-core`（`external-process` + `contributions: []`）因此被归进底部
// 「纯数据扩展」、贴「安装即启用」、不给开关。现重构为**插件目录**：每插件一行、
// 面板内嵌，只按 `stateless` 归组。

const menuBarSrc = readFileSync(join(ROOT, "apps/desktop/src/app_ui/menu/MenuBar.tsx"), "utf8");
const apiPluginSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/api/plugin.ts"),
  "utf8",
);
const catalogSrc = readFileSync(
  join(ROOT, "crates/hp-plugin-host/src/host.rs"),
  "utf8",
);
const catalogBridgeSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/plugin_catalog.rs"),
  "utf8",
);

check(
  "「扩展」菜单不再是占位：渲染插件目录并带启用开关（胶囊）",
  /pluginCatalog\(/.test(menuBarSrc) &&
    /statefulRows\.map\(/.test(menuBarSrc) &&
    /togglePluginEnabled/.test(menuBarSrc) &&
    // 启用开关是宿主统一的胶囊按钮（`shared/SwitchToggle.tsx`），不再是原生复选框。
    /<SwitchToggle/.test(menuBarSrc) &&
    !/type="checkbox"/.test(menuBarSrc),
);
check(
  "面板按钮未启用 → 灰显且不可点击（disabled），由上方开关负责启用",
  /disabled=\{!item\.enabled\}/.test(menuBarSrc) && /\$\{item\.enabled \? "" : " dim"\}/.test(menuBarSrc),
);
check(
  "插件目录**含未启用**（host 侧不按 enabled 过滤，只如实报出该字段）",
  /fn plugin_catalog/.test(catalogSrc) &&
    // 关键：plugin_catalog 里**没有** `if !enabled { continue }` 这种过滤
    !/fn plugin_catalog[\s\S]{0,2000}?if !enabled\s*\{/.test(catalogSrc) &&
    /pub enabled: bool/.test(catalogSrc),
);
check(
  "启用按插件**声明的能力**发起（不得硬编码 repo.read，否则 python-core 报『未声明能力』）",
  /pluginEnable\(repoId, item\.pluginId, item\.capabilities\)/.test(menuBarSrc) &&
    /pluginDisable\(repoId, item\.pluginId\)/.test(menuBarSrc) &&
    // 反向守护：旧的硬编码写法不能回来。
    !/pluginEnable\([^)]*\["repo\.read"\]\)/.test(menuBarSrc),
);
check(
  "插件目录是独立命令（不污染只含已启用的 plugin.contributions 注册表口径）",
  /export function pluginCatalog/.test(apiPluginSrc) &&
    /"plugin_catalog"/.test(apiPluginSrc) &&
    /pub\(crate\) fn plugin_catalog/.test(catalogBridgeSrc) &&
    // 命令名改了，旧的 panel 目录名不该残留。
    !/plugin_panel_catalog/.test(apiPluginSrc) &&
    !/fn plugin_panel_catalog/.test(catalogBridgeSrc),
);
// 目录命令 2026-09 从 `commands/plugin.rs` 拆到 `commands/plugin_catalog.rs`
// （前者越过 1200 行上限），因此上面读的是新文件；这里再守一道"不能又搬回去
// 把 plugin.rs 顶爆"的线。
check(
  "目录命令仍在独立文件里（`commands/plugin.rs` 不得再越过 1200 行）",
  readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/plugin.rs"), "utf8")
    .split("\n").length <= 1200,
);

// ==================== 纯数据扩展（tagdict-* / tagrel-*）：无状态、只列不控 ====================
//
// 防的是 D36.9 那个缺陷：数据包按 D36.1 声明 `contributions: []`，而目录只发
// `kind = panel` 的贡献点 → 装了 128–162MB 的词典扩展后「扩展」菜单里照样
// **什么都不出现**。同时防"再给它画一个点了没用的启用开关"。
// 关键新约束（0038）：**空面板 ≠ 无状态**——只有 `stateless` 才沉底、才不给开关。
const pluginPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/PluginPanel.tsx"),
  "utf8",
);

check(
  "宿主发**插件目录**：每插件一行、面板内嵌，只按 stateless 归组（D36.9 + 0038）",
  /pub struct PluginCatalogEntry/.test(catalogSrc) &&
    /pub panels: Vec<PluginCatalogPanel>/.test(catalogSrc) &&
    /pub capabilities: Vec<String>/.test(catalogSrc) &&
    /pub stateless: bool/.test(catalogSrc) &&
    // 有启用语义的在前、无启用语义的纯数据扩展整组在最后。
    /stateful\.extend\(stateless_rows\)/.test(catalogSrc) &&
    // 判据是运行时形态，不是"名字像扩展包"，也不是"有没有面板"。
    /row\.runtime_kind == RuntimeKind::StaticData/.test(catalogSrc) &&
    // 反向守护：旧的 `panel === null`/`panels.is_empty()` 归组不能回来。
    !/if panels\.is_empty\(\)/.test(catalogSrc) &&
    !/panel: Option<PanelCatalogPanel>/.test(catalogSrc),
);
check(
  "「扩展」菜单按 stateless 归组：数据扩展**列最底下、不给开关**，其余全带开关",
  /const statefulRows = catalog\.filter\(\(i\) => !i\.stateless\)/.test(menuBarSrc) &&
    /const dataPackRows = catalog\.filter\(\(i\) => i\.stateless\)/.test(menuBarSrc) &&
    /dataPackRows\.map\(/.test(menuBarSrc) &&
    // 反向守护：不能再用「有没有面板」当归组判据。
    !/i\.panel === null/.test(menuBarSrc) &&
    // 数据扩展那一组的渲染里不得出现开关（否则就是一个点了没用的控件）。
    !/dataPackRows[\s\S]{0,600}?<SwitchToggle/.test(menuBarSrc),
);
check(
  "插件面板对数据包**不再画启用/禁用按钮**（那是空操作），只显示状态",
  /const stateless = p\.runtime_kind === "static-data"/.test(pluginPanelSrc) &&
    /plugin\.statelessState/.test(pluginPanelSrc),
);
check(
  "无面板的系统插件（python-core）落在**有启用语义组**且带开关（0038 回归）",
  // 上组用 statefulRows 渲染且组内就有 SwitchToggle；python-core 无面板但 stateful。
  /statefulRows\.map\(/.test(menuBarSrc) &&
    /statefulRows[\s\S]{0,1600}?<SwitchToggle/.test(menuBarSrc) &&
    // 面板是内嵌列表子行，而非"一行一个面板"的顶层循环。
    /item\.panels\.map\(/.test(menuBarSrc),
);

// ==================== 仓库面板：当前仓库显示**仓库名**（不是内部 repoId）====================
//
// 防的是"把自己的内部主键当显示值印出来"：`repoId` 是 `RepoId::generate()` 的 UUID，
// 对用户没有意义，而且与**同一个面板**里「切换仓库」子菜单显示的**名字**对不上——
// 同一件事在一个面板里两套写法。解析口径按**行为**断言（直接 import 纯函数），
// 源码侧只锚定"渲染的是名字"这一条正向事实。

const repoPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/RepoPanel.tsx"),
  "utf8",
);
const repoDisplaySrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/repoDisplay.ts"),
  "utf8",
);

const repoFixtures = [
  { id: "00c37ce8-8464-4808-8c51-c9af38e86516", name: "素材库" },
  { id: "a1b2c3d4-0000-0000-0000-000000000000", name: "照片归档" },
];
check(
  "当前仓库按 repoId 查到**仓库名**（判据是 id 相等，不是列表顺序）",
  repoDisplay.resolveRepoName(repoFixtures, repoFixtures[0].id) === "素材库" &&
    repoDisplay.resolveRepoName(repoFixtures, repoFixtures[1].id) === "照片归档" &&
    // 名称**可重名**：重名行里必须取 id 命中的那一条，而不是"第一条同名的"。
    repoDisplay.resolveRepoName(
      [
        { id: "x", name: "同名" },
        { id: "y", name: "同名" },
      ],
      "y",
    ) === "同名",
);
check(
  "名字不可得时**不回落 repoId**：未打开仓库 / 列表里查不到 → 占位符",
  repoDisplay.repoNameLabel(repoFixtures, null) === repoDisplay.REPO_NAME_PLACEHOLDER &&
    repoDisplay.repoNameLabel(repoFixtures, undefined) === repoDisplay.REPO_NAME_PLACEHOLDER &&
    repoDisplay.repoNameLabel(repoFixtures, "") === repoDisplay.REPO_NAME_PLACEHOLDER &&
    repoDisplay.repoNameLabel(repoFixtures, "不存在的-id") === repoDisplay.REPO_NAME_PLACEHOLDER &&
    // 空名 / 纯空白名同样算「不可得」（后端只拒空名，历史行仍可能有空白）。
    repoDisplay.repoNameLabel([{ id: "z", name: "   " }], "z") ===
      repoDisplay.REPO_NAME_PLACEHOLDER,
);
check(
  "占位符与全应用其它缺值处同款（`—`），不是空串（空串会让「没有名字」与「面板坏了」外观一致）",
  repoDisplay.REPO_NAME_PLACEHOLDER === "—",
);
check(
  "仓库面板的「当前仓库」渲染的是仓库名（经纯函数），**不再**印 repoId",
  /repoNameLabel\(repos, app\.repoId\)/.test(repoPanelSrc) &&
    // 反向：不得再把 repoId 当**显示值**渲染。`app.repoId === r.id` 这类**比较**是允许的，
    // 故只禁"把它渲染进节点"的形态；先剥注释——文件头会**引用** repoId 说明口径。
    !/\{app\.repoId \?\?/.test(stripComments(repoPanelSrc)) &&
    !/<span className="mono">/.test(stripComments(repoPanelSrc)),
);
check(
  "长仓库名在列内截断（名称是用户输入、长度不限；不截断会把 .kv 的 1fr 列顶宽）",
  /\.repo-current-name\s*\{[^}]*overflow:\s*hidden/.test(stylesSource) &&
    /\.repo-current-name\s*\{[^}]*text-overflow:\s*ellipsis/.test(stylesSource) &&
    /\.repo-current-name\s*\{[^}]*white-space:\s*nowrap/.test(stylesSource),
);
check(
  "显示名解析是**纯逻辑模块**（无 React / Tauri 依赖，门禁可直接 import）",
  !/from "react"/.test(repoDisplaySrc) && !/@tauri-apps/.test(repoDisplaySrc),
);

}
