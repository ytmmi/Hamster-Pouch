/**
 * 面板注册表一致性自检（RFC 0010 决策 4 / `docs/spec/panel-standard.md` 第 8 节）。
 *
 * 断言：
 * 1. **注册表 ↔ 声明列表 ↔ 本文档**三方一致（id 清单、顺序、`category`、`has_class`、
 *    `blueprint_node`）；
 * 2. `PANEL_IDS` ↔ `PANEL_DEFS` ↔ `PANEL_TITLES` 三方一致（含顺序）；
 * 3. 每个 `blueprint_node` 都命中**已注册**的蓝图节点类型；可承载面板的节点类型必须
 *    允许 `panel_id` 字段（面板标准第 5.2 节）；
 * 4. Rust `PanelCategory` / 设置项输入类白名单 ↔ TS 注册表逐项对齐；
 * 5. 「全部设置」的大类/二级列表**只列出声明了 `settings` 的面板**，且分组与
 *    `category` 一致（无设置项的面板不显示，见 `docs/spec/settings-standard.md` 第 4.1 节）；
 * 6. **命名空间与插件缺失容错**：插件面板项必须是 `plugin.<plugin_id>.<local_id>`；
 *    未注册的 `panel_id` 既不报硬错误也不被丢弃（允许保存、原样保留）。
 *
 * 用法：pnpm check:panels
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);
// `.tsx` 不能直接被 Node 的 TS 剥离加载（JSX 不是可剥离语法），因此组件表用**源码解析**
// 断言（与 `tools/control-check.mjs` 对 `ControlRenderer.tsx` 的做法一致）。
const registrySource = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/panelRegistry.tsx"),
  "utf8",
);
const panelDefPairs = [
  ...registrySource.matchAll(/\{ id: "([^"]+)", titleKey: "([^"]+)", render:/g),
].map((m) => [m[1], m[2]]);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const eqList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const doc = readFileSync(join(ROOT, "docs/spec/panel-standard.md"), "utf8");
const rustPanels = readFileSync(join(ROOT, "crates/hp-core/src/panel_types.rs"), "utf8");

// ============================== 1. 注册表 ↔ PANEL_IDS ↔ PANEL_DEFS / PANEL_TITLES ==============================

const builtinIds = config.BUILTIN_PANEL_SPECS.map((s) => s.id);
check(
  "注册表声明列表与 PANEL_IDS 一致（含顺序）",
  eqList(builtinIds, [...config.PANEL_IDS]),
  `registry=${builtinIds.join(",")} PANEL_IDS=${[...config.PANEL_IDS].join(",")}`,
);
check(
  "注册表 ↔ PANEL_DEFS 的 id 与顺序一致",
  eqList(builtinIds, panelDefPairs.map((p) => p[0])),
  `defs=${panelDefPairs.map((p) => p[0]).join(",")}`,
);
const defTitleMismatch = panelDefPairs.filter(
  ([id, titleKey]) => config.PANEL_TITLES[id] !== titleKey,
);
check(
  "PANEL_DEFS ↔ PANEL_TITLES 的标题键一致",
  defTitleMismatch.length === 0,
  defTitleMismatch.map(([id, key]) => `${id}: ${key}`).join(" | "),
);
const titleMismatch = config.BUILTIN_PANEL_SPECS.filter(
  (spec) => config.PANEL_TITLES[spec.id] !== spec.titleKey,
);
check(
  "注册表 ↔ PANEL_TITLES 的标题键一致",
  titleMismatch.length === 0,
  titleMismatch.map((s) => `${s.id}: ${config.PANEL_TITLES[s.id]} != ${s.titleKey}`).join(" | "),
);
check(
  "内置面板恰好 13 个",
  builtinIds.length === 13,
  `实际 ${builtinIds.length}`,
);

// ============================== 2. 声明参数取值域 ==============================

const badCategory = config.BUILTIN_PANEL_SPECS.filter(
  (s) => !config.PANEL_CATEGORIES.includes(s.category),
);
check(
  "每个面板的 category 都在封闭枚举内（source/media/info/system/other）",
  badCategory.length === 0,
  badCategory.map((s) => `${s.id}:${s.category}`).join(", "),
);

const hasClassTrue = config.BUILTIN_PANEL_SPECS.filter((s) => s.hasClass).map((s) => s.id);
check(
  "has_class：内置面板中**只有** media 为 true（面板标准第 5.1 节）",
  eqList(hasClassTrue, ["media"]),
  `has_class=true: ${hasClassTrue.join(",") || "（无）"}`,
);

const badBlueprintNode = config.BUILTIN_PANEL_SPECS.filter(
  (s) => !config.hasNodeSpec(s.blueprintNode),
);
check(
  "每个 blueprint_node 都命中已注册的蓝图节点类型",
  badBlueprintNode.length === 0,
  badBlueprintNode.map((s) => `${s.id}→${s.blueprintNode}`).join(", "),
);

// 可承载面板的节点类型必须允许 `panel_id` 字段（面板标准第 5.2 节：双向一致）。
const carrierProblems = [];
for (const spec of config.BUILTIN_PANEL_SPECS) {
  const nodeSpec = config.nodeSpecOrNull(spec.blueprintNode);
  if (!nodeSpec) {
    carrierProblems.push(`${spec.id}→${spec.blueprintNode} 未注册`);
    continue;
  }
  const allowsPanelId = nodeSpec.fields.some((f) => f.name === "panel_id");
  if (spec.blueprintNode === "control" && !allowsPanelId) {
    carrierProblems.push(`节点类型 ${spec.blueprintNode} 未声明 panel_id 字段`);
  }
}
check(
  "control.panel_id ↔ 面板注册表 blueprint_node 双向一致",
  carrierProblems.length === 0,
  carrierProblems.join(" | ") || "13 个面板全部指向 control，且 control 允许 panel_id",
);

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
// 文档声明的「只有 media 有类目」必须与注册表一致（防文档与代码脱节）。
check(
  "文档与注册表在 has_class 上口径一致（media 是唯一有类目的内置面板）",
  doc.includes("`media`") && /`media`（媒体预览）\s*\|\s*\*\*`true`\*\*/.test(doc),
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
  // 组件表的**动态注册路径**：面板项清单由注册表派生（不是写死的 13 项），
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
  !afterUnregister.includes(pluginPanelId) && afterUnregister.length === 13,
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
const stylesSource = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
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

// ============================== 汇总 ==============================

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
