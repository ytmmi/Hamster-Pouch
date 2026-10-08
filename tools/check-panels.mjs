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
 *    未注册的 `panel_id` 既不报硬错误也不被丢弃（允许保存、原样保留）；
 * 7. **面板设置的闭环**：声明 ↔ 归一化 ↔ 面板消费 ↔ 热加载四条触发源（查看器顶部
 *    基础信息栏的 `infoBarEnabled` 是这套闭环的第一个布尔设置；色彩参考的
 *    `valueFormat` 另有"声明候选 ↔ 面板纯函数取值域"与"显示/复制同一份文本"两条断言），
 *    外加「点击图像即按需提取调色板」这条**装配层**行为（面板里没有提取按钮）。
 *
 * 用法：pnpm check:panels
 */

import { existsSync, readFileSync } from "node:fs";
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

/**
 * 剥掉 `//` 行注释与 `/* … *​/` 块注释，供"**不得出现**某写法"这类断言使用。
 *
 * 为什么需要：说明性注释里常常**引用**被禁的写法（例如"不用 `loading="lazy"`"），
 * 直接对全文匹配会把注释当代码——出现"注释一写就红"的假失败，或反过来让断言形同虚设。
 * 与 `tools/check-dormant-media.mjs` 的 `stripComments` 同一口径（各门禁自持一份，
 * 避免为一个小工具引入共享模块）。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, " "))
    .join("\n");
}

const doc = readFileSync(join(ROOT, "docs/spec/panel-standard.md"), "utf8");
const rustPanels = readFileSync(join(ROOT, "crates/hp-core/src/panel_types.rs"), "utf8");

// 被断言的前端源码：**提前读**，供多处断言共用。
// （写在断言之后会踩 `const` 的 TDZ 陷阱：脚本是顺序执行的，不是函数体。）
const viewerSettingsSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/useViewerSettings.ts"),
  "utf8",
);
const settingValueSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/settingValue.ts"),
  "utf8",
);
const viewerPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/ViewerPanel.tsx"),
  "utf8",
);
const metadataPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MetadataPanel.tsx"),
  "utf8",
);
const settingsAppSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/settings/SettingsApp.tsx"),
  "utf8",
);
const stylesSource = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
  "utf8",
);

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
  "内置面板恰好 14 个",
  builtinIds.length === 14,
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
  carrierProblems.join(" | ") || "14 个面板全部指向 control，且 control 允许 panel_id",
);

// 面板设置里 `select` 必须有候选（否则「全部设置」渲染不出、后端也拒写）。
const badSelects = [];
for (const spec of config.allPanels()) {
  for (const setting of spec.settings ?? []) {
    if (setting.kind !== "select") continue;
    const options = setting.options ?? [];
    if (options.length === 0) badSelects.push(`${spec.id}.${setting.key} 缺 options`);
    for (const option of options) {
      if (!option.title_key) badSelects.push(`${spec.id}.${setting.key} 的候选缺 title_key`);
      if (typeof option.value !== "string" || !option.value) {
        badSelects.push(`${spec.id}.${setting.key} 的候选 value 非法`);
      }
    }
  }
}
check(
  "面板设置里 kind = select 的项都给了非空 options（且候选带 i18n 键）",
  badSelects.length === 0,
  badSelects.join(" | ") || "全部 select 设置项候选完整",
);

// 面板设置的候选 ↔ 面板实现里的取值域（声明与实现漂移是最难发现的一类缺陷：
// 设置界面能选、面板代码认不出，表现为"改了设置没反应"）。
const placement = await import(
  pathToFileURL(
    join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPlacement.ts"),
  ).href
);
const imageViewerSpec = config.panelSpec("imageviewer");
const optionValues = (panelId, key) =>
  (config.panelSpec(panelId)?.settings?.find((s) => s.key === key)?.options ?? []).map(
    (o) => o.value,
  );
check(
  "imageviewer 的 select 候选 ↔ 面板实现取值域逐项一致（导航器四角 / 胶片栏四边 / 视图 / 缩放中心）",
  Boolean(imageViewerSpec) &&
    eqList(optionValues("imageviewer", "navigatorPosition"), [...placement.NAVIGATOR_CORNERS]) &&
    eqList(optionValues("imageviewer", "filmstripPosition"), [...placement.FILMSTRIP_EDGES]) &&
    eqList(optionValues("imageviewer", "filmstripView"), [...placement.FILMSTRIP_VIEWS]) &&
    eqList(optionValues("imageviewer", "zoomAnchor"), [...placement.ZOOM_ANCHORS]),
  `nav=${optionValues("imageviewer", "navigatorPosition").join(",")} ` +
    `film=${optionValues("imageviewer", "filmstripPosition").join(",")} ` +
    `view=${optionValues("imageviewer", "filmstripView").join(",")} ` +
    `anchor=${optionValues("imageviewer", "zoomAnchor").join(",")}`,
);
check(
  "滚轮缩放中心的**缺省**是「指针位置」（不是图像中心）",
  imageViewerSpec?.settings?.find((s) => s.key === "zoomAnchor")?.default === "pointer" &&
    placement.ZOOM_ANCHORS.includes("pointer"),
);
check(
  "imageviewer 的开关型设置缺省为真（导航器 / 胶片栏默认启用的声明）",
  imageViewerSpec?.settings?.find((s) => s.key === "navigatorEnabled")?.default === true &&
    imageViewerSpec?.settings?.find((s) => s.key === "filmstripEnabled")?.default === true,
);
check(
  "imageviewer 声明了 8 项面板设置（导航器启用/位置、胶片栏启用/位置/尺寸/视图、缩放中心、预加载半径）",
  (imageViewerSpec?.settings ?? []).length === 8,
  `实际 ${(imageViewerSpec?.settings ?? []).length}`,
);
check(
  "胶片栏视图缺省是「自适应」（不是平铺）",
  imageViewerSpec?.settings?.find((s) => s.key === "filmstripView")?.default === "adaptive" &&
    placement.FILMSTRIP_VIEWS.includes("adaptive") &&
    placement.FILMSTRIP_VIEWS.includes("tile"),
);
// 设置的分组分隔线：`divider_before` 只用来在「全部设置」里画横线，
// 必须是"分组起点"（第一项上写它无意义），且渲染层真的消费了它。
const dividerKeys = (imageViewerSpec?.settings ?? [])
  .filter((s) => s.divider_before)
  .map((s) => s.key);
check(
  "面板设置用 `divider_before` 分成四组（导航器 / 胶片栏 / 缩放 / 预加载），首项无分隔线",
  eqList(dividerKeys, ["filmstripEnabled", "zoomAnchor", "preloadRadius"]) &&
    imageViewerSpec?.settings?.[0]?.divider_before !== true,
  `divider_before: ${dividerKeys.join(",") || "（无）"}`,
);
check(
  "「全部设置」渲染层消费 `divider_before`（画横线且跳过首项）",
  /decl\.divider_before && index > 0/.test(settingsAppSrc) &&
    /settings-row-divider/.test(settingsAppSrc) &&
    /\.settings-row-divider\s*\{/.test(stylesSource),
);
// 胶片栏尺寸：**一个数值两用**（左右 = 宽、上下 = 高），数值范围由面板夹紧。
const filmstripSizeDecl = imageViewerSpec?.settings?.find((s) => s.key === "filmstripSize");
check(
  "胶片栏尺寸是单个数值设置（kind = numberInput，缺省落在面板夹紧范围内）",
  filmstripSizeDecl?.kind === "numberInput" &&
    typeof filmstripSizeDecl?.default === "number" &&
    filmstripSizeDecl.default >= placement.FILMSTRIP_SIZE_MIN &&
    filmstripSizeDecl.default <= placement.FILMSTRIP_SIZE_MAX,
  `kind=${filmstripSizeDecl?.kind} default=${filmstripSizeDecl?.default}`,
);
check(
  "胶片栏尺寸的夹紧函数与声明范围一致（0/负数/超大值都被夹进 [MIN, MAX]）",
  placement.clampFilmstripSize(0) === placement.FILMSTRIP_SIZE_FALLBACK &&
    placement.clampFilmstripSize(-10) === placement.FILMSTRIP_SIZE_FALLBACK &&
    placement.clampFilmstripSize(Number.NaN) === placement.FILMSTRIP_SIZE_FALLBACK &&
    placement.clampFilmstripSize(1) === placement.FILMSTRIP_SIZE_MIN &&
    placement.clampFilmstripSize(100000) === placement.FILMSTRIP_SIZE_MAX &&
    placement.clampFilmstripSize(120) === 120,
);
// 设置热加载：面板不能只依赖 `setting.changed` 事件（订阅时机/运行时环境都可能让它不达），
// 同窗口本地广播 + 窗口焦点 + 面板激活都必须订阅（缺一条就会出现"改了设置没反应"）。
check(
  "设置热加载走多条独立触发源（本地广播 + 后端事件 + 焦点 + 面板激活）",
  /subscribeSettingChanged\(/.test(viewerSettingsSrc) &&
    /listenHp\("setting\.changed"/.test(viewerSettingsSrc) &&
    /window\.addEventListener\("focus"/.test(viewerSettingsSrc) &&
    /onDidActiveChange/.test(viewerSettingsSrc) &&
    /onDidVisibilityChange/.test(viewerSettingsSrc),
);
check(
  "「全部设置」写入/恢复后广播本地变更（同窗口即时生效，不等 IPC 往返）",
  /publishSettingChanged\(key\)/.test(settingsAppSrc) &&
    (settingsAppSrc.match(/publishSettingChanged\(key\)/g) ?? []).length >= 2,
);

// ==================== 查看器（`panel.viewer`）的顶部基础信息栏设置 ====================
//
// 防的是"设置加了但没人用"。一段面板设置要成立，四段必须都在：
// **声明**（注册表）↔ **归一化**（非法取值回落缺省）↔ **面板消费**（真的条件渲染）↔
// **热加载**（四条独立触发源）。缺任何一段的表现都一样：改了设置没反应。

const viewerSpec = config.panelSpec("viewer");
const viewerInfoBarDecl = viewerSpec?.settings?.find((s) => s.key === "infoBarEnabled");
check(
  "查看器声明了「显示基础信息栏」设置（switch，缺省显示 = 零视觉变化）",
  (viewerSpec?.settings ?? []).length === 1 &&
    viewerInfoBarDecl?.kind === "switch" &&
    viewerInfoBarDecl?.title_key === "viewer.settings.infoBarEnabled" &&
    viewerInfoBarDecl?.default === true,
  `decls=${(viewerSpec?.settings ?? []).map((s) => s.key).join(",") || "（无）"} ` +
    `default=${viewerInfoBarDecl?.default}`,
);
check(
  "面板设置值按声明归一化：非法取值回落缺省（失败关闭）、缺省可解析、未注册面板为 undefined",
  config.normalizePanelSettingValue("viewer", "infoBarEnabled", false) === false &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", "false") === false &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", "yes") === true &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", 1) === true &&
    config.normalizePanelSettingValue("viewer", "infoBarEnabled", null) === true &&
    config.normalizePanelSettingValue("imageviewer", "filmstripSize", "bad") === 76 &&
    config.normalizePanelSettingValue("imageviewer", "zoomAnchor", "middle") === "pointer" &&
    config.normalizePanelSettingValue("imageviewer", "zoomAnchor", "center") === "center" &&
    config.normalizePanelSettingValue("ghost", "infoBarEnabled", true) === undefined,
);
check(
  "面板设置热加载走多条独立触发源（共享钩子：本地广播 + 后端事件 + 焦点 + 面板激活）",
  /subscribeSettingChanged\(/.test(settingValueSrc) &&
    /listenHp\("setting\.changed"/.test(settingValueSrc) &&
    /window\.addEventListener\("focus"/.test(settingValueSrc) &&
    /onDidActiveChange/.test(settingValueSrc) &&
    /onDidVisibilityChange/.test(settingValueSrc),
);
check(
  "查看器面板真的按该设置条件渲染顶部基础信息栏",
  /usePanelSwitch\(VIEWER_PANEL_ID, "infoBarEnabled"/.test(viewerPanelSrc) &&
    /showInfoBar &&/.test(viewerPanelSrc) &&
    /className="viewer-info"/.test(viewerPanelSrc),
);
check(
  "viewer 面板拿到 dockview 面板 API（第 4 条触发源「面板激活」才可达）",
  /\{ id: "viewer", titleKey: "panel\.viewer", render: \(ctx\) => <ViewerPanel api=\{ctx\.api\} \/> \}/.test(
    registrySource,
  ),
);

// ==================== 色彩参考（`panel.color`）的色值格式设置 + 按需提取 ====================
//
// 与查看器同一套闭环：**声明**（注册表）↔ **取值域**（声明候选 ↔ 面板纯函数逐项一致）↔
// **归一化**（非法取值回落缺省）↔ **面板消费**（真的按设置格式化 + 复制同一份文本）。
//
// **调色板提取的归属（用户口径 2026-09）**：面板**只读缓存**，提取不再是界面行为——
// 它是"**全面分析文件**"（源扫描 / 源全量重扫 / 右键「重新分析该文件」）的副产品，
// 落在 `hp_scanner::Scanner::write_palette`（两个 `MediaType::Image` 分支共用）。
// 因此这一段的断言从"点击即提取的装配层行为"改成"分析路径顺带提取 + 面板只读"。

const colorPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/ColorPanel.tsx"),
  "utf8",
);
const colorPaletteWatchPath = join(ROOT, "apps/desktop/src/app_ui/core/colorPaletteWatch.tsx");
const colorPalettePath = join(ROOT, "apps/desktop/src/app_ui/shared/colorPalette.ts");
const appUiAppSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/AppUiApp.tsx"),
  "utf8",
);
const scannerPaletteSrc = readFileSync(join(ROOT, "crates/hp-scanner/src/scanner.rs"), "utf8");
// 2026-10（缺陷 0018）：调色板的**计算**落在并行阶段的新模块里（`scan_compute.rs`），
// 而"要不要算"与"落库"仍在 `scanner.rs`。门禁读这两个文件。
const scannerComputeSrc = readFileSync(
  join(ROOT, "crates/hp-scanner/src/scan_compute.rs"),
  "utf8",
);
const colorCommandSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/color.rs"),
  "utf8",
);
const colorValue = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/colorValue.ts")).href
);

const colorSpec = config.panelSpec("color");
const colorFormatDecl = colorSpec?.settings?.find((s) => s.key === "valueFormat");
check(
  "色彩参考声明了「色值格式」设置（select，缺省十六进制 = 与存储口径同形）",
  (colorSpec?.settings ?? []).length === 1 &&
    colorFormatDecl?.kind === "select" &&
    colorFormatDecl?.title_key === "color.settings.valueFormat" &&
    colorFormatDecl?.default === "hex",
  `decls=${(colorSpec?.settings ?? []).map((s) => s.key).join(",") || "（无）"} default=${colorFormatDecl?.default}`,
);
check(
  "色值格式的 select 候选 ↔ 面板纯函数 `colorValue.ts` 的取值域逐项一致（缺省同源）",
  eqList(optionValues("color", "valueFormat"), [...colorValue.COLOR_VALUE_FORMATS]) &&
    colorValue.DEFAULT_COLOR_VALUE_FORMAT === colorFormatDecl?.default,
  `decl=${optionValues("color", "valueFormat").join(",")} ` +
    `panel=${[...colorValue.COLOR_VALUE_FORMATS].join(",")}`,
);
check(
  "色值格式按声明归一化：非法取值回落十六进制、未注册面板返回 undefined",
  config.normalizePanelSettingValue("color", "valueFormat", "decimal") === "decimal" &&
    config.normalizePanelSettingValue("color", "valueFormat", "rgb") === "hex" &&
    config.normalizePanelSettingValue("color", "valueFormat", null) === "hex" &&
    colorValue.resolveColorValueFormat("bogus") === "hex" &&
    config.normalizePanelSettingValue("ghost", "valueFormat", "hex") === undefined,
);
check(
  "色值格式化纯函数：十六进制 `#ffffff` ↔ 十进制 `255, 255, 255`（含 3 位缩写与非法输入原样返回）",
  colorValue.formatColorValue("#ffffff", "hex") === "#ffffff" &&
    colorValue.formatColorValue("#ff0000", "decimal") === "255, 0, 0" &&
    colorValue.formatColorValue("#ABC", "hex") === "#aabbcc" &&
    colorValue.formatColorValue("  #0a0B0c  ", "hex") === "#0a0b0c" &&
    colorValue.formatColorValue("nope", "hex") === "nope" &&
    colorValue.formatColorValue("nope", "decimal") === "nope",
);
check(
  "色彩参考面板消费该设置：同一份文本既显示又复制，且面板**只保留调色板**",
  /usePanelSettingValue\(COLOR_PANEL_ID, "valueFormat"/.test(colorPanelSrc) &&
    /formatColorValue\(selected, format\)/.test(colorPanelSrc) &&
    /navigator\.clipboard\.writeText\(text\)/.test(colorPanelSrc) &&
    /className="palette"/.test(colorPanelSrc) &&
    // 手动锁定/提取按钮与原生取色器都已移除（面板里只剩调色板 + 色值行）。
    !/lockManual|type="color"|colorSet\(/.test(colorPanelSrc),
);
check(
  "color 面板拿到 dockview 面板 API（第 4 条触发源「面板激活」才可达）",
  /\{ id: "color", titleKey: "panel\.color", render: \(ctx\) => <ColorPanel api=\{ctx\.api\} \/> \}/.test(
    registrySource,
  ),
);
check(
  "复制图标是项目内资产（`assets/copy.svg`）且用 mask 上色（图标随主题前景色）",
  existsSync(join(ROOT, "apps/desktop/src/app_ui/assets/copy.svg")) &&
    /from "\.\.\/assets\/copy\.svg"/.test(colorPanelSrc) &&
    /maskImage/.test(colorPanelSrc) &&
    /\.color-copy-icon\s*\{/.test(stylesSource) &&
    /\.color-copy-icon[\s\S]{0,200}mask-size: contain/.test(stylesSource),
);
check(
  "调色板**不再由界面触发提取**：点击即提取的装配层监视器与请求入口都已移除，面板只读缓存",
  // 三个"曾经的入口"都不该回来：监视器文件、请求模块、装配层挂载点。
  !existsSync(colorPaletteWatchPath) &&
    !existsSync(colorPalettePath) &&
    !/<ColorPaletteWatch/.test(appUiAppSrc) &&
    !/requestPaletteExtraction/.test(colorPanelSrc) &&
    // 面板只读：一次 `color.get` + 纯函数解析；**不是**提取命令。
    /parsePaletteJson\(await api\.colorGet\(\{ repoId, fileId \}\)\)/.test(colorPanelSrc) &&
    !/colorExtract/.test(colorPanelSrc) &&
    // 缺调色板时给"怎么拿到它"的提示（而不是让用户以为面板坏了）。
    /app\.t\("color\.empty"\)/.test(colorPanelSrc),
);
check(
  "提取绑定在**全面分析**上：扫描/重新分析都顺带写调色板，且**不覆盖手动锁定**的色值",
  // 2026-10（缺陷 0018）：扫描改为"串行准备 → 并行计算 → 串行写库"三段式，
  // 调色板的"要不要算"在**准备阶段**定（`want_palette`）、颜色值在**并行阶段**算出
  // （`scan_compute::analyze_image`）、落库在**写库阶段**（`write_one`）。
  // 断言内容不变，只改它读哪些文件——这正是 file-structure.md 第「门禁跟着代码走」条的办理方式。
  //
  // ① 并行阶段只解码**一次**，调色板与感知哈希共用同一张图（旧实现各解码一次）。
  /extract_palette_from_image\(&img, 0\)/.test(scannerComputeSrc) &&
    // ② 落库唯一入口：写库阶段的 `write_one` 走唯一 JSON 实现。
    /encode_palette_json\(colors\)/.test(scannerPaletteSrc) &&
    // ③ 手动锁定的色值在**准备阶段**就被排除（`want_palette` 为假 → 并行阶段不算它）。
    //    `locked:true` 是用户的判定权，重扫不得抹掉——旧实现是在写入前 return，
    //    现在提前到"决定要不要算"，语义相同且省下一次全尺寸重采样。
    /fn palette_is_locked\(&self, db: &RepoDb, existing: Option<&FileIndexRow>\) -> HpResult<bool>/.test(
      scannerPaletteSrc,
    ) &&
    /Some\(existing_color\) if palette_is_locked\(&existing_color\.color_json\)/.test(
      scannerPaletteSrc,
    ) &&
    // ④ 两条触发链路都设 `want_palette`：源扫描的准备阶段 + 单文件重新分析。
    (scannerPaletteSrc.match(/want_palette,?\s*$/gm) ?? []).length >= 2 &&
    // ⑤ 两条触发链路：`file.reanalyze` → `scanner.rescan_file`；源全量 → `options.full` 强制重算。
    // （`file.reanalyze` 自 2026-09 起是**后台任务**：带上任务的取消标志，见 `check:commands`
    //  的"单文件分析 = 与源扫描同款的后台任务"那组断言。）
    /\.scanner\s*\n?\s*\.rescan_file\(&mut db, &source, &file\.relative_path, &options, Some\(&cancel\)\)/.test(
      readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/file.rs"), "utf8"),
    ) &&
    // `options.full` 仍然强制重算（"源全量重扫"会把全部图片的调色板刷新一遍）。
    /options\.full \|\| row\.size != size \|\| row\.mtime != mtime/.test(scannerPaletteSrc) &&
    // ⑥ 按需命令保留（契约不变），但已无界面调用方：UI 只走分析路径。
    /db\.upsert_color_ref\(file_id, &encode_palette_json\(&palette\.colors\)\)\?;/.test(
      colorCommandSrc,
    ) &&
    !/colorExtract|color_extract\(/.test(appUiAppSrc) &&
    !/requestPaletteExtraction/.test(appUiAppSrc),
);

// 调色板本身：规模（8 色）、缓存格式版本（旧缓存自愈）与面板内的排布。
// （`colorCommandSrc` 在本节开头已经读过：上面的"提取绑定在全面分析上"用它断言写入路径。）
const paletteRsSrc = readFileSync(join(ROOT, "crates/hp-media/src/palette.rs"), "utf8");
const paletteJson = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/paletteJson.ts")).href
);
const rustPaletteSize = Number(
  (paletteRsSrc.match(/DEFAULT_PALETTE_SIZE:\s*usize\s*=\s*(\d+)/) || [])[1],
);
const rustPaletteVersion = Number(
  (paletteRsSrc.match(/PALETTE_FORMAT_VERSION:\s*u32\s*=\s*(\d+)/) || [])[1],
);
check(
  "调色板默认取 **8 色**（用户 2026-09-29 指定；此前 6）",
  rustPaletteSize === 8,
  `DEFAULT_PALETTE_SIZE=${rustPaletteSize}`,
);
check(
  "调色板缓存的格式版本 TS ↔ Rust 相等，且**唯一编解码处**真的把 `version` 写进 `color_json`",
  rustPaletteVersion > 0 &&
    rustPaletteVersion === paletteJson.PALETTE_FORMAT_VERSION &&
    // JSON 形态只有一处实现（`hp_media::encode_palette_json`）：两个写入方（分析路径与
    // 按需命令）都必须走它——谁自己拼串就可能漏写 `version`，前端会把缓存当"未提取"反复重算。
    /pub fn encode_palette_json\(colors: &\[String\]\) -> String \{[\s\S]{0,200}?"version": PALETTE_FORMAT_VERSION/.test(
      paletteRsSrc,
    ) &&
    /encode_palette_json/.test(scannerPaletteSrc) &&
    /encode_palette_json/.test(colorCommandSrc) &&
    // 反向：谁都不许再手写一份 `color_json`（旧的命令实现就是手拼的）。
    !/"version": PALETTE_FORMAT_VERSION,\s*\n\s*"colors"/.test(colorCommandSrc),
  `rust=${rustPaletteVersion} ts=${paletteJson.PALETTE_FORMAT_VERSION}`,
);
check(
  "旧版本/无版本的缓存按「未提取」处理（自动重算）；**手动锁定**的色值不受版本影响",
  paletteJson.parsePaletteJson('{"colors":["#112233"],"locked":false}').length === 0 &&
    paletteJson.parsePaletteJson(
      `{"version":${paletteJson.PALETTE_FORMAT_VERSION},"colors":["#112233"],"locked":false}`,
    ).length === 1 &&
    paletteJson.parsePaletteJson('{"colors":["#112233"],"locked":true}').length === 1 &&
    paletteJson.parsePaletteJson(null).length === 0 &&
    paletteJson.parsePaletteJson("not json").length === 0,
);
check(
  "色块随面板宽度伸展且**不是正方形**（flex 撑满一行、只给高度、不给固定宽度）",
  /\.swatch\s*\{[^}]*flex:\s*1 1 /.test(stylesSource) &&
    /\.swatch\s*\{[^}]*height:\s*18px/.test(stylesSource) &&
    !/\.swatch\s*\{[^}]*[\s;{]width:/.test(stylesSource),
);
check(
  "调色板不吃剩余高度（色值行紧跟其下方）、留出选中框空间且**不再裁掉蓝框**",
  /\.palette\s*\{[^}]*flex:\s*none/.test(stylesSource) &&
    /\.palette\s*\{[^}]*margin-top:/.test(stylesSource) &&
    /\.palette\s*\{[^}]*padding:/.test(stylesSource) &&
    !/\.palette\s*\{[^}]*overflow:/.test(stylesSource),
);

// ============ 媒体预览（`panel.media`）：缺省视图 / 排序 设置 + 面板消费 ============
//
// 与查看器 / 色彩参考同一套闭环：**声明**（注册表）↔ **取值域**（声明候选 ↔ 面板纯函数
// 逐项一致）↔ **归一化**（非法取值回落缺省）↔ **面板消费**（真的按设置排布与排序）↔
// **热加载**（共享钩子的四条触发源 + `viewer`/`color` 同款的 dockview 面板 API）。
//
// 另加两条本面板特有的口径：
// 1. 面板右上角的下拉是**本会话内**的临时覆盖（模块级变量），设置里的值才是缺省；
//    用户在「全部设置」里改动该项时必须**放弃**覆盖，否则就是"改了设置没反应"；
// 2. 排序下拉是「四个排序键 + 横线 + 正序/倒序」，横线由 `menu-sep` 画（不是两个下拉）。

const mediaPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx"),
  "utf8",
);
// 单元与下拉各自成文件（单文件 1200 行上限）：断言跟着代码走，不看它原来在哪。
const mediaCellSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewCell.tsx"),
  "utf8",
);
const mediaDropdownSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewDropdown.tsx"),
  "utf8",
);
// 媒体预览面板家族（2026-09 第四轮按 1200 行规则再拆）：主面板 / 取值域 / 会话状态 /
// 工具条 / 文件动作 / 右键菜单 / 选区 / 单元 / 下拉。**断言跟着代码走**：
// 凡「面板真的消费 / 真的渲染」这类断言读**整个家族**；反向断言同样读整个家族——
// 拆分不得成为逃离断言的后门（同上一条的既有口径）。
const MEDIA_FAMILY_FILES = [
  "apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewData.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewPaging.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewVirtual.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewVirtualRows.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewScroll.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewSession.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewToolbar.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewActions.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewMenu.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewSelection.ts",
  "apps/desktop/src/app_ui/panels/mediaPreviewCell.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewDropdown.tsx",
  "apps/desktop/src/app_ui/panels/mediaPreviewView.ts",
];
const mediaFamilySrc = MEDIA_FAMILY_FILES.map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");
const mediaToolbarSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewToolbar.tsx"),
  "utf8",
);
// 后台冻结的判据（共享钩子）：面板不可见时不该继续干活。
const panelForegroundSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/panelForeground.ts"),
  "utf8",
);
const mediaView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewView.ts")).href
);
const mediaPaging = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewPaging.ts")).href
);

// ---- 缺陷 0018 P1-A：**全库游标翻页**的纯逻辑（`mediaPreviewPaging.ts`）----
//
// 取数上限从"有界的一页"放开为"整个来源"之后，**循环安全**的来源变了：
// 旧实现靠 `MEDIA_PREVIEW_MAX_ITEMS` 兜底，现在那个上限正是要取消的东西，
// 于是只能靠"游标必须严格前进 + 页数上限"保证一个写坏的 `nextCursor` 不会变成死循环。
// 这些用例是**行为断言**（直接跑真函数），不是源码正则——正则守不住死循环。
const pageStub = (pages) => {
  const calls = [];
  let index = 0;
  const fetchPage = async (cursor) => {
    calls.push(cursor);
    const page = pages[index++];
    // 取数次数超出预期时抛错而不是挂住：死循环在测试里要**立刻失败**，不是等超时。
    if (!page) throw new Error(`取数次数超出预期（第 ${index} 次）`);
    return page;
  };
  return { fetchPage, calls };
};
const fileAt = (n) => ({ id: `f${n}` });

{
  const three = pageStub([
    { items: [fileAt(1), fileAt(2)], nextCursor: "c1" },
    { items: [fileAt(3)], nextCursor: "c2" },
    { items: [fileAt(4)], nextCursor: null },
  ]);
  const drained = await mediaPaging.drainPages(three.fetchPage);
  check(
    "翻页取完**整个来源**：首游标为 `null`，其后一律回传上一页的 `nextCursor`，`null` 即末页",
    three.calls.length === 3 &&
      JSON.stringify(three.calls) === JSON.stringify([null, "c1", "c2"]) &&
      drained.map((f) => f.id).join(",") === "f1,f2,f3,f4",
    `调用=${JSON.stringify(three.calls)} 条目=${drained.map((f) => f.id).join(",")}`,
  );
}

{
  const single = pageStub([{ items: [fileAt(1)], nextCursor: null }]);
  const drained = await mediaPaging.drainPages(single.fetchPage);
  check(
    "只有一页时不发第二次请求（`nextCursor === null` 即停）",
    single.calls.length === 1 && drained.length === 1,
    `调用=${single.calls.length}`,
  );
}

{
  // 后端若把游标写坏（永远回同一个非 null 值），旧式 `while (cursor)` 会永远翻下去。
  const looped = pageStub([
    { items: [fileAt(1)], nextCursor: "same" },
    { items: [fileAt(2)], nextCursor: "same" },
    { items: [fileAt(3)], nextCursor: "same" },
  ]);
  const result = await mediaPaging.drainPages(looped.fetchPage);
  check(
    "游标**不前进**（后端写坏）时立即停止，不退化成死循环",
    looped.calls.length === 2 && result.length === 2,
    `调用=${looped.calls.length} 条目=${result.length}`,
  );
}

{
  const dup = pageStub([
    { items: [fileAt(1), fileAt(2)], nextCursor: "c1" },
    { items: [fileAt(2), fileAt(3)], nextCursor: null },
  ]);
  const result = await mediaPaging.drainPages(dup.fetchPage);
  check(
    "跨页重复 id 去重且保持首次出现的顺序（库内容在翻页途中变动时不得出现重复单元）",
    result.map((f) => f.id).join(",") === "f1,f2,f3",
    `条目=${result.map((f) => f.id).join(",")}`,
  );
}

{
  const pages = pageStub([
    { items: [fileAt(1)], nextCursor: "c1" },
    { items: [fileAt(2)], nextCursor: null },
  ]);
  let stop = false;
  const result = await mediaPaging.drainPages(pages.fetchPage, {
    isCancelled: () => stop,
    onPage: () => {
      stop = true;
    },
  });
  check(
    "翻页途中取消：**不再多发请求**（全库翻页可能上百次往返，卸载/切换来源后必须立刻停）",
    pages.calls.length === 1 && result.length === 1,
    `取消后调用=${pages.calls.length}`,
  );
}

{
  const progressive = pageStub([
    { items: [fileAt(1), fileAt(2)], nextCursor: "c1" },
    { items: [fileAt(3)], nextCursor: "c2" },
    { items: [fileAt(4)], nextCursor: null },
  ]);
  const seen = [];
  await mediaPaging.drainPages(progressive.fetchPage, {
    onPage: (_added, accumulated) => seen.push(accumulated.length),
  });
  check(
    "首屏**第一页到手即回调**（不是等全部翻完才出图），且累计数单调增长",
    JSON.stringify(seen) === JSON.stringify([2, 3, 4]),
    `每页累计=${JSON.stringify(seen)}`,
  );
}

check(
  "取数上限已放开为**整个来源**：不再有 `MEDIA_PREVIEW_MAX_ITEMS` 截断，页大小仍是 500",
  !/MEDIA_PREVIEW_MAX_ITEMS/.test(mediaFamilySrc) &&
    mediaPaging.MEDIA_PREVIEW_PAGE_LIMIT === 500 &&
    /drainPages/.test(mediaFamilySrc),
);

check(
  "面板取数只依赖「看的是哪个来源」，**不依赖 `app` 整个对象**",
  // `app` 上下文对象在每次选中变化时都会换身份（`selectedIds` / `selectedFile` 是
  // `AppUiApp` 那个 `useMemo` 的依赖项）。若取数依赖它，用户每点一下缩略图都会重跑
  // 整个取数——在"翻完全库"的语义下就是每次点击重发上百次游标请求。
  /\[repoId, albumId, sourceId, dirPath, typeFilter, refreshKey\]/.test(mediaFamilySrc) &&
    !/\}, \[app, typeFilter\]\)/.test(mediaFamilySrc),
);

check(
  "后台翻页的**进度刷新只做首屏一次**（每次 `setFiles` 都会让前端全量排序重跑）",
  // 实测：5 万项名称排序约 281 ms（`localeCompare`）。若每页刷一次，5 万张（100 页）
  // 期间累计重排约 100 次、单线程阻塞十余秒；"每 10 页刷一次"仍有约 10 次递增的全量
  // 重排。中间过程对用户没有价值（首屏已出图、计数另有 `loading` 提示），
  // 因此只在第一页刷一次。
  /let firstPageRendered = false;/.test(mediaFamilySrc) &&
    /if \(firstPageRendered\) return;/.test(mediaFamilySrc) &&
    // 反向：不得再出现"每 N 页刷一次"那种按页数取模的节流。
    !/pageCount % \d+ !== 0/.test(mediaFamilySrc),
);

// ---- 缺陷 0018 P1-A：**虚拟化的行模型**（`mediaPreviewVirtual.ts`）----
//
// 容器虚拟化要先把条目切成"行"，行模型错了会直接表现为"丢项/重复/空白行"。
// 这些是**行为断言**（直接跑真函数）。
const virtual = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewVirtual.ts")).href
);

{
  const rows = virtual.chunkRows([1, 2, 3, 4, 5, 6, 7], 3);
  check(
    "按行切分：保序、不丢项、不重复，最后一行可以不满",
    JSON.stringify(rows) === JSON.stringify([[1, 2, 3], [4, 5, 6], [7]]),
    JSON.stringify(rows),
  );
}
check(
  "按行切分的边界：空列表得空数组，`perRow <= 0` 按 1 处理（否则切出无穷多空行）",
  virtual.chunkRows([], 3).length === 0 &&
    JSON.stringify(virtual.chunkRows([1, 2], 0)) === JSON.stringify([[1], [2]]) &&
    JSON.stringify(virtual.chunkRows([1, 2], -5)) === JSON.stringify([[1], [2]]),
);

// ---- 缺陷 0018 P1-A 回归：**滚动位置恢复 vs 后台翻页**（`mediaPreviewScroll.ts`）----
//
// P1-A 把取数从"一次取回有界一页"改成"后台翻页翻完全库"之后，恢复滚动的**时机**
// 与内容的**长度**不再同步：第一页到手时内容只有 500 行高，深位置会被浏览器夹住。
// 更隐蔽的是，这次"夹住"会触发 `scroll` 事件，监听器把夹住的中间值当成新目标记下来
// → 原始目标永久丢失，后面内容变长也恢复不回去。
//
// 这些是**行为断言**（直接跑真函数、按真实时序模拟"翻页→再翻页→用户滚动"），
// 不是源码正则：正则守不住"目标被中间值覆盖"这类时序缺陷。
const scroll = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewScroll.ts")).href
);

{
  // 模拟：5 万张、每行 100px 行高，用户在 3 万行处（target = 3000000）离开。
  // 第一页 500 项到手 → 内容 50000px、视口 800px → 最多滚到 49200，目标到不了。
  const slot = scroll.createScrollSlot();
  slot.target = 3_000_000;
  const firstApply = scroll.planScrollApply(slot, 50_000, 800, false);
  const pendingAfterFirst = slot.pending;

  // 浏览器把 scrollTop 夹到上限，并因此触发一次 scroll 事件。
  scroll.onScrollEvent(slot, 49_200, 50_000, 800);
  const targetAfterClamp = slot.target;

  // 后台翻完（内容 5,000,000px）后再恢复一次。
  const finalApply = scroll.planScrollApply(slot, 5_000_000, 800, true);

  check(
    "后台翻页下的滚动恢复：被夹住的中间值**不得**覆盖真实目标，翻完后再恢复到位",
    // 第一页时确实到不了（这正是回归的触发条件）。
    firstApply === 3_000_000 &&
      pendingAfterFirst === 3_000_000 &&
      // 关键：夹住所触发的那次 scroll 事件**没有**把目标改成 49200。
      targetAfterClamp === 3_000_000 &&
      // 内容变长后一次到位，且不再欠恢复。
      finalApply === 3_000_000 &&
      slot.pending === null,
    `首次=${firstApply} 夹住后target=${targetAfterClamp} 最终=${finalApply} pending=${slot.pending}`,
  );
}

check(
  "滚动恢复的退化输入：目标 0 / 非法值不欠恢复；**容器未布局**时必须挂住而不是抹掉目标",
  // 目标 0：没有要恢复的位置。
  scroll.needsScrollRestore(0, 50_000, 800) === false &&
    // NaN / 负数按 0 处理。
    scroll.needsScrollRestore(Number.NaN, 50_000, 800) === false &&
    scroll.needsScrollRestore(-5, 50_000, 800) === false &&
    // 正例：内容装得下就不欠恢复；装不下就欠。
    scroll.needsScrollRestore(1_000, 50_000, 800) === false &&
    scroll.needsScrollRestore(60_000, 50_000, 800) === true &&
    // **首帧**（scrollHeight = 0）是"还没量出来"，不是"内容只有 0 高"：
    // 必须挂住 pending，否则那次赋值触发的 scroll 事件会把目标抹成 0。
    scroll.needsScrollRestore(1_000, 0, 0) === true &&
    (() => {
      const slot = scroll.createScrollSlot();
      slot.target = 1_000;
      // 首帧：loading 还是 false（取数 effect 尚未把它置真），也不能收敛成 0。
      const applied = scroll.planScrollApply(slot, 0, 0, true);
      return applied === 1_000 && slot.pending === 1_000 && slot.target === 1_000;
    })(),
);

check(
  "翻页已结束而目标仍到不了时：就地收敛到可滚上限并**解除** pending",
  // 否则 pending 会永久挂着，用户之后的所有滚动都记不进 target（新的"恢复不了"）。
  (() => {
    const slot = scroll.createScrollSlot();
    slot.target = 3_000_000;
    const applied = scroll.planScrollApply(slot, 50_000, 800, true);
    // 条目被删到只剩 500 项：收敛到上限 49200，并解除 pending。
    return applied === 49_200 && slot.pending === null && slot.target === 49_200;
  })(),
);

check(
  "用户主动滚动（不欠恢复时）必须正常记录，否则浏览进度会丢",
  (() => {
    const slot = scroll.createScrollSlot();
    // 已到位、无 pending：用户滚到 1200 就该记住 1200。
    scroll.onScrollEvent(slot, 1_200, 50_000, 800);
    const normal = slot.target === 1_200 && slot.pending === null;

    // 还欠恢复、但内容已经装得下 → 这一跳就是恢复落地，按目标收口并解除。
    const slot2 = scroll.createScrollSlot();
    slot2.target = 3_000_000;
    slot2.pending = 3_000_000;
    scroll.onScrollEvent(slot2, 3_000_000, 5_000_000, 800);
    const landed = slot2.target === 3_000_000 && slot2.pending === null;

    return normal && landed;
  })(),
);

check(
  "面板真的接了这套恢复逻辑：存的是 slot 而不是裸数字，依赖数组含内容长度与 loading",
  // 缺陷 0018 回归的**接线**断言：纯函数对了但面板没接，等于没修。
  /const thumbScroll = createScrollSlot\(\);/.test(mediaPanelSrc) &&
    /const nameScroll = createScrollSlot\(\);/.test(mediaPanelSrc) &&
    // **两个**容器都必须走 planScrollApply——只要求"文件里出现过"会让"改了一个、
    // 漏了另一个"照样通过（实测：只回退平铺那个，断言仍全绿）。
    (mediaPanelSrc.match(/el\.scrollTop = planScrollApply\(/g) ?? []).length === 2 &&
    (mediaPanelSrc.match(/onScrollEvent\(/g) ?? []).length === 2 &&
    // 不得再退回"直接赋保存值"的写法（那正是被夹住的来源）。
    !/el\.scrollTop = thumbScroll\.target/.test(mediaPanelSrc) &&
    !/el\.scrollTop = nameScroll\.target/.test(mediaPanelSrc) &&
    // 依赖数组必须含内容长度与 loading：否则内容变长后不再重试，深位置恢复不回去。
    /\}, \[viewMode, view, foreground, app\.repoId, items\.length, loading\]\);/.test(mediaPanelSrc) &&
    /\}, \[viewMode, foreground, app\.repoId, items\.length, loading\]\);/.test(mediaPanelSrc),
);

{
  // 行高必须是**有限正数**：分数高度会让「行号 × 行高」与浏览器实际布局逐渐错位，
  // 滚到列表深处表现为"越滚越偏"。
  const tileName = virtual.tileRowHeight(160, true);
  const tileNoName = virtual.tileRowHeight(160, false);
  const list = virtual.listRowHeight();
  check(
    "行高由纯函数给出且为整数：平铺（缩略图方形 + 可选文件名）与列表",
    Number.isInteger(tileName) &&
      Number.isInteger(tileNoName) &&
      Number.isInteger(list) &&
      tileName > tileNoName &&
      tileName > 160 &&
      list > 0,
    `平铺(有名)=${tileName} 平铺(无名)=${tileNoName} 列表=${list}`,
  );
}
check(
  "行高与样式表的口径一致：平铺内边距 4px + 边框 1px（box-sizing: border-box）",
  /box-sizing:\s*border-box/.test(stylesSource) &&
    /\.mp-cell\s*\{[^}]*padding:\s*4px/.test(stylesSource) &&
    /\.mp-cell\s*\{[^}]*border:\s*1px solid transparent/.test(stylesSource) &&
    /\.mp-grid\.mp-view-tile \.mp-thumb\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/.test(stylesSource),
);

check(
  "平铺与列表**按行虚拟化**：只渲染窗口内的行，DOM 单元数与条目总数无关",
  // 缺陷 0018 的核心：容器不再 `items.map`，而是"占位层撑起总高度 + 只渲染窗口行"。
  /const tileVirtual = useFixedRowVirtualizer\(/.test(mediaPanelSrc) &&
    /const listVirtual = useMeasuredRowVirtualizer\(/.test(mediaPanelSrc) &&
    /tileVirtual\.rows\.map\(/.test(mediaPanelSrc) &&
    /listVirtual\.rows\.map\(/.test(mediaPanelSrc) &&
    /className="mp-virtual" style=\{\{ height: tileVirtual\.totalSize \}\}/.test(mediaPanelSrc) &&
    /className="mp-virtual" style=\{\{ height: listVirtual\.totalSize \}\}/.test(mediaPanelSrc) &&
    // 列表视图**不得**再直接铺全部条目：退回全量渲染必须当场变红。
    // （平铺/自适应走 `renderCell` 那条路，见下面那条断言；自适应见 `content-visibility` 的说明。）
    !/\{items\.map\(\(\{ file \}\) => \(/.test(mediaPanelSrc),
);

check(
  "列表视图的行高走**测量**而不是猜死（文字度量随语言/系统缩放变化）",
  /useMeasuredRowVirtualizer\(\s*listRef,/.test(mediaPanelSrc) &&
    /ref=\{listVirtual\.measureRef\}/.test(mediaPanelSrc) &&
    /listRowHeight\(\)/.test(mediaPanelSrc) &&
    // **`data-index` 是测量生效的前提**：库靠它把 DOM 节点反查回行号
    // （`indexFromElement` 读的就是这个属性）。少了它 → 返回 -1 →
    // `isIndexInRange(-1)` 为假 → 测量被**整条跳过**，行高永远停在首帧估计值，
    // 而且只在控制台打一句 warning。这是实测确认过的坑，必须钉住。
    /data-index=\{row\.index\}/.test(mediaPanelSrc) &&
    // 挂 `measureRef` 的元素与 `data-index` 必须在**同一个** DOM 节点上：
    // 库是"对回调传入的那个 node"读属性的，挂错层级同样读不到。
    // （窗口放宽到 900 字符：两者之间夹着上面那段说明注释。）
    /ref=\{listVirtual\.measureRef\}[\s\S]{0,900}?data-index=\{row\.index\}/.test(mediaPanelSrc),
);

check(
  "平铺虚拟化的**列数**与 CSS 同源：面板算好下发 `--mp-tile-columns`，切行用同一个值",
  // 不一致会表现为"行错位/留白"——CSS 排 4 列而 JS 按 3 列切行时尤其明显。
  /const tilePerRow = masonryColumnCount\(gridWidth, imageSize, MASONRY_GAP\);/.test(
    mediaPanelSrc,
  ) &&
    /chunkRows\(items, tilePerRow\)/.test(mediaPanelSrc) &&
    /"--mp-tile-columns": String\(Math\.max\(1, masonryColumns\)\)/.test(mediaPanelSrc) &&
    /repeat\(var\(--mp-tile-columns/.test(stylesSource),
);

check(
  "虚拟化容器的总高度由占位层给出（滚动条长度不随滚动变化，因此不会抖）",
  /\.mp-virtual\s*\{[^}]*position:\s*relative/.test(stylesSource) &&
    /\.mp-virtual-row\.mp-virtual-grid\s*\{[^}]*position:\s*absolute/.test(stylesSource) &&
    /\.mp-virtual-row\.mp-virtual-list\s*\{[^}]*position:\s*absolute/.test(stylesSource) &&
    // 行间距只在**一处**加：行盒高度里不含 gap（虚拟化下发 gap），CSS 若再加一次会翻倍。
    /MEDIA_TILE_ROW_GAP/.test(mediaFamilySrc) &&
    /MEDIA_LIST_ROW_GAP/.test(mediaFamilySrc) &&
    !/\.mp-virtual-row\.mp-virtual-grid\s*\{[^}]*row-gap/.test(stylesSource) &&
    !/\.mp-list\s*\{[^}]*gap:\s*2px/.test(stylesSource),
);

check(
  "跳过渲染（`content-visibility`）在自适应/瀑布流**打开**，占位高度按视图算得接近真实",
  // 原先这两个视图靠 `content-visibility: visible` 回避"占位高度写错导致的滚动抖动"。
  // 根因是占位值错（写死 140px），不是跳过渲染不可用——面板按视图下发接近真实的值。
  /content-visibility:\s*auto/.test(stylesSource) &&
    !/\.mp-view-adaptive \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    !/\.mp-masonry \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    // 单元真的把面板算出的值下发到块轴占位（内联覆盖样式表的简写块轴分量），
    // 且带 `auto` 关键字（渲染过就用记下的真实尺寸）。
    /containIntrinsicBlockSize:\s*`auto \$\{intrinsicHeight\}px`/.test(mediaCellSrc) &&
    /intrinsicHeight=\{cellIntrinsicHeight\(file\)\}/.test(mediaPanelSrc) &&
    // 自适应按图片尺寸估；瀑布流按**该文件**的宽高比算。
    /adaptiveCellIntrinsicHeight\(imageSize, showFileName\)/.test(mediaPanelSrc) &&
    /masonryCellHeight\(imageSize, ratio, showFileName\)/.test(mediaPanelSrc) &&
    /ratioCache\.get\(file\.id\) \?\? DEFAULT_CELL_RATIO/.test(mediaPanelSrc),
);

check(
  "瀑布流单元高度的**盒模型与样式表一致**（实测反推：28 + (列宽−12)/宽高比）",
  // 原先按"内边距 4+4、边框 1+1、缩略图 (列宽−10)/比例、文件名 16px"估算，
  // 实测**全错**：按列虚拟化（绝对定位）之后，高度猜错不再表现为错位、而是
  // **相邻单元重叠**——实测 minGap = −18px（应为 8px）。
  // 真实盒模型（列宽 160、border-box）：
  //   thumbW = 160 − 8(内边距) − 2(单元边框) = 150
  //   imgW   = 150 − 2(缩略图边框) = 148
  //   单元高 = 10 + (148/比例 + 2) + 4 + 12(文件名实际行高) = 28 + 148/比例
  // 该式对 5 个实测样本的误差 ≤ 0.05px。
  (() => {
    const at = (col, ratio) => virtual.masonryCellHeight(col, ratio, true);
    // 列宽 160、比例 1 → 28 + 148 = 176（实测 176.0）。
    if (at(160, 1) !== 176) return false;
    // 比例 1.78 → 28 + 83.1 = 111（实测 111.1）。
    if (Math.abs(at(160, 1.78) - 111) > 1) return false;
    // 比例 0.562 → 28 + 263.3 = 291（实测 291.4）。
    if (Math.abs(at(160, 0.562) - 291) > 1) return false;
    // 无文件名时只少 16px（4 gap + 12 行高）。
    if (virtual.masonryCellHeight(160, 1, false) !== 160) return false;
    return true;
  })(),
  `方=${virtual.masonryCellHeight(160, 1, true)} 宽=${virtual.masonryCellHeight(160, 1.78, true)} 竖=${virtual.masonryCellHeight(160, 0.562, true)} 无名=${virtual.masonryCellHeight(160, 1, false)}`,
);

check(
  "瀑布流**按列虚拟化**：只渲染窗口内的条目，列高由面板下发",
  // 与平铺/列表同一条不变量：DOM 单元数与条目总数脱钩。
  /masonryColumnLayout\(columns,/.test(mediaPanelSrc) &&
    /masonryVisibleRange\(/.test(mediaPanelSrc) &&
    /useScrollWindow\(gridRef, gridVersion\)/.test(mediaPanelSrc) &&
    // 列内必须**按窗口切片**渲染，不得 `column.map` 全量铺开。
    // （只断言"没有 column.map(({file,url})…"会被 `column.map((item, i)…` 绕过——
    //   实测：把 slice 退回全量 map，那条断言照样全绿。这里直接钉住切片本身。）
    /column\.slice\(start, range\.end\)\.map\(/.test(mediaPanelSrc) &&
    !/column\.map\(/.test(mediaPanelSrc) &&
    // 列高必须由面板给出：虚拟化后列内只有几十个单元，不给高度容器总高会塌掉。
    /style=\{\{ height: masonry\.columnHeights\[index\] \?\? 0 \}\}/.test(mediaPanelSrc) &&
    // 槽位用绝对定位 + 面板算出的偏移（不参与列内布局，避免累积误差）。
    /className="mp-masonry-slot"/.test(mediaPanelSrc) &&
    /transform: `translateY\(\$\{offsets\[at\] \?\? 0\}px\)`/.test(mediaPanelSrc),
);

check(
  "瀑布流的**宽高比异步到达**必须触发重算：ratioCache 有版本号 + 面板订阅",
  // 宽高比是 `<img>` 解码后才知道的，而行高由它推出。不重算的话列偏移停在
  // DEFAULT_CELL_RATIO 的估计上，与单元实际高度错位（这是本视图最容易踩的坑）。
  /export function getRatioCacheVersion\(\)/.test(mediaCellSrc) &&
    /export function subscribeRatioChange\(/.test(mediaCellSrc) &&
    /export function setRatioCache\(/.test(mediaCellSrc) &&
    // 写入口只有一处：`ratioCache.set` 不得再被直接调用（否则绕过版本号）。
    (mediaCellSrc.match(/ratioCache\.set\(/g) ?? []).length === 1 &&
    // 通知必须**合并**：一次滚动会解码几十张，5 万张的库会解码上万张，
    // 每次写入都通知就是上万次 O(条目数) 的布局重算。
    /queueMicrotask\(/.test(mediaCellSrc) &&
    /if \(ratioNotifyScheduled\) return;/.test(mediaCellSrc) &&
    /subscribeRatioChange\(\(\) => setRatioVersion\(getRatioCacheVersion\(\)\)\)/.test(
      mediaPanelSrc,
    ) &&
    // 版本号进布局依赖数组。
    /\[columns, imageSize, showFileName, view, viewMode, ratioVersion\]/.test(mediaPanelSrc),
);

check(
  "瀑布流列内间距**只在面板算的偏移里**加一次（列内不得再有 flex gap）",
  // 面板的 `masonryColumnLayout` 已经把 gap 加进偏移；列内再叠一层 flex gap
  // 会让偏移与实际位置差一个 gap（错位）。
  /\.mp-masonry-slot\s*\{[^}]*position:\s*absolute/.test(stylesSource) &&
    /\.mp-masonry-slot\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    !/\.mp-masonry-col\s*\{[^}]*gap:/.test(stylesSource),
);

check(
  "瀑布流单元高度按**宽高比**算（列宽 ÷ 宽高比），且退化输入有兜底",
  (() => {
    const square = virtual.masonryCellHeight(160, 1, false);
    const wide = virtual.masonryCellHeight(160, 2, false);
    const tall = virtual.masonryCellHeight(160, 0.5, false);
    return (
      Number.isInteger(square) &&
      // 宽图矮、竖图高（单调性：这是"瀑布流"与整齐网格的区别）。
      wide < square &&
      square < tall &&
      // 退化宽高比（0 / 负数 / NaN）按 1:1 兜底，不得算出 NaN 或负高度。
      virtual.masonryCellHeight(160, 0, false) === square &&
      virtual.masonryCellHeight(160, -2, false) === square &&
      virtual.masonryCellHeight(160, Number.NaN, false) === square
    );
  })(),
  `方=${virtual.masonryCellHeight(160, 1, false)} 宽=${virtual.masonryCellHeight(160, 2, false)} 竖=${virtual.masonryCellHeight(160, 0.5, false)}`,
);

check(
  "缩略图**挂载即预热**：不再有「等进入视口」的闸门（用户 2026-10-07：向上不预加载）",
  // 三种视图都已虚拟化，"被挂载" ⟺ "在虚拟化窗口内"（窗口以 scrollTop 为中心、上下同余量），
  // 因此窗口**就是**对称的预加载带。此前的两道闸门都会让取图时机偏离这条窗口：
  //   ① 共享 IntersectionObserver 等"真的进入视口"（虚拟化之前的做法）；
  //   ② `<img loading="lazy">` 交给浏览器启发式。
  // 另加**显式预热**：`.mp-cell` 的 `content-visibility: auto` 会让被跳过渲染的单元
  // 不触发 `<img>` 取图，而 overscan 带恰恰最容易被跳过。
  //
  // **断言前先剥注释**：本文件的说明文字里会**引用**这些被禁的写法（"不用
  // `loading="lazy"`"之类），直接对全文匹配会把注释当成代码，出现"注释一写就红"的假失败。
  (() => {
    const code = stripComments(mediaCellSrc);
    return (
      /const warmedThumbs = new Set<string>\(\);/.test(code) &&
      /new Image\(\)/.test(code) &&
      /warmedThumbs\.add\(file\.id\)/.test(code) &&
      // **正向锚点**：缩略图 effect 的守卫必须**只有** `needsThumb` 一个条件——
      // 后面紧跟 `resolveThumbUrl`，因此再挂任何"等可见"的条件（`!visible` /
      // `!audioVisible` / 别的状态）都会让这条不成立。
      // 只写"禁止某个旧拼法"是不够的：换成另一种可见性状态名就绕过去了
      // （实测：把守卫改成 `!needsThumb || !audioVisible` 时，旧断言仍然通过）。
      /if \(!needsThumb\) return;\s*let cancelled = false;\s*void resolveThumbUrl\(/.test(code) &&
      // 去掉浏览器懒加载：窗口已有界，取图要确定。
      !/loading="lazy"/.test(code) &&
      // 音频仍走共享观察器（`decodeAudioData` 是实打实的 CPU）。
      /observeUntilVisible\(el, \(\) => setAudioVisible\(true\)\)/.test(code)
    );
  })(),
);
check(
  "音频波形的可见性判定：**共享一个** `IntersectionObserver`（不逐格新建）",
  // 缺陷 0018：原实现每个单元各建一个观察器（5 万个单元 = 5 万个观察器）。
  // 观察器本就是"一个观察者观察多个目标"，收成模块级唯一一个即可。
  /const visibilityCallbacks = new WeakMap<Element, \(\) => void>\(\);/.test(mediaCellSrc) &&
    /let sharedObserver: IntersectionObserver \| null = null;/.test(mediaCellSrc) &&
    /function observeUntilVisible\(/.test(mediaCellSrc) &&
    // 关键不变量：整个单元模块里 `new IntersectionObserver` **恰好一次**
    // （逐格新建就会变成 N 次——这正是缺陷 0018 里 5 万个观察器的来源）。
    (mediaCellSrc.match(/new IntersectionObserver/g) ?? []).length === 1,
);
// 方向性差异的**根**在"窗口是否对称"：上下余量必须相等，否则预加载带本身就偏向一侧。
// 用纯函数按行为断言（不是读源码正则）——这是本次缺陷的第一性判据。
check(
  "虚拟化窗口**上下对称**（预加载带必须以 scrollTop 为中心，否则天然偏向一侧）",
  (() => {
    const offsets = Array.from({ length: 40 }, (_, i) => i * 200);
    const heights = Array.from({ length: 40 }, () => 200);
    const scrollTop = 4000;
    const viewportHeight = 800;
    const overscan = Math.max(200, viewportHeight / 2);
    const r = virtual.masonryVisibleRange(offsets, heights, scrollTop, viewportHeight, overscan);
    const above = Math.max(0, scrollTop - (offsets[r.start] ?? 0));
    const below = Math.max(
      0,
      (offsets[r.end - 1] ?? 0) + (heights[r.end - 1] ?? 0) - (scrollTop + viewportHeight),
    );
    return r.start < r.end && above === below && above > 0;
  })(),
);

const mediaSpec = config.panelSpec("media");
const mediaSettingKeys = (mediaSpec?.settings ?? []).map((s) => s.key);
check(
  "媒体预览声明了 5 项面板设置（view / imageSize / showFileName / sortKey / sortDir），都带 i18n 键",
  eqList(mediaSettingKeys, ["view", "imageSize", "showFileName", "sortKey", "sortDir"]) &&
    (mediaSpec?.settings ?? []).every(
      (s) => typeof s.title_key === "string" && s.title_key.length > 0,
    ),
  `decls=${mediaSettingKeys.join(",") || "（无）"}`,
);
check(
  "三项 select（视图 / 排序键 / 方向）+ numberInput（图片尺寸）+ switch（显示文件名）：`slider` 会把值夹在浏览器默认的 0–100，声明层没有 min/max",
  mediaSpec?.settings?.find((s) => s.key === "view")?.kind === "select" &&
    mediaSpec?.settings?.find((s) => s.key === "sortKey")?.kind === "select" &&
    mediaSpec?.settings?.find((s) => s.key === "sortDir")?.kind === "select" &&
    mediaSpec?.settings?.find((s) => s.key === "imageSize")?.kind === "numberInput" &&
    mediaSpec?.settings?.find((s) => s.key === "showFileName")?.kind === "switch" &&
    // 宿主 `slider` 渲染是裸 `<input type="range">`（无 min/max）→ 值域会被压在 0–100，
    // 图片尺寸 80–400 会被截断，故**不得**用 slider。
    !(mediaSpec?.settings ?? []).some((s) => s.kind === "slider"),
);
check(
  "媒体预览的 select 候选 ↔ 面板纯函数取值域逐项一致（视图 / 排序键 / 方向）",
  eqList(optionValues("media", "view"), [...mediaView.MEDIA_VIEW_MODES]) &&
    eqList(optionValues("media", "sortKey"), [...mediaView.MEDIA_SORT_KEYS]) &&
    eqList(optionValues("media", "sortDir"), [...mediaView.SORT_DIRECTIONS]),
  `view=${optionValues("media", "view").join(",")} ` +
    `sortKey=${optionValues("media", "sortKey").join(",")} ` +
    `sortDir=${optionValues("media", "sortDir").join(",")}`,
);
check(
  "缺省视图是「自适应」、缺省排序是「名称 · 正序」、缺省图片尺寸落在面板夹紧范围内",
  mediaView.MEDIA_VIEW_MODES.includes("adaptive") &&
    mediaSpec?.settings?.find((s) => s.key === "view")?.default === "adaptive" &&
    mediaSpec?.settings?.find((s) => s.key === "sortKey")?.default === "name" &&
    mediaSpec?.settings?.find((s) => s.key === "sortDir")?.default === "asc" &&
    typeof mediaSpec?.settings?.find((s) => s.key === "imageSize")?.default === "number" &&
    mediaSpec.settings.find((s) => s.key === "imageSize").default >=
      mediaView.MEDIA_IMAGE_SIZE_MIN &&
    mediaSpec.settings.find((s) => s.key === "imageSize").default <=
      mediaView.MEDIA_IMAGE_SIZE_MAX,
);
check(
  "图片尺寸夹紧：0 / 负数 / 非数值回落兜底值，超界夹到 [MIN, MAX]，正常值取整",
  mediaView.clampImageSize(0) === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize(-10) === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize(Number.NaN) === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize("bad") === mediaView.MEDIA_IMAGE_SIZE_FALLBACK &&
    mediaView.clampImageSize(1) === mediaView.MEDIA_IMAGE_SIZE_MIN &&
    mediaView.clampImageSize(100000) === mediaView.MEDIA_IMAGE_SIZE_MAX &&
    mediaView.clampImageSize(200.4) === 200 &&
    mediaView.MEDIA_IMAGE_SIZE_MIN === 80 &&
    mediaView.MEDIA_IMAGE_SIZE_MAX === 400,
  `[${mediaView.MEDIA_IMAGE_SIZE_MIN}, ${mediaView.MEDIA_IMAGE_SIZE_MAX}] 兜底 ${mediaView.MEDIA_IMAGE_SIZE_FALLBACK}`,
);
check(
  "媒体预览设置按声明归一化：非法取值回落缺省、未注册面板返回 undefined",
  config.normalizePanelSettingValue("media", "view", "masonry") === "masonry" &&
    config.normalizePanelSettingValue("media", "view", "grid") === "adaptive" &&
    config.normalizePanelSettingValue("media", "view", null) === "adaptive" &&
    config.normalizePanelSettingValue("media", "imageSize", 220) === 220 &&
    config.normalizePanelSettingValue("media", "imageSize", "240") === 240 &&
    config.normalizePanelSettingValue("media", "imageSize", "big") === 160 &&
    config.normalizePanelSettingValue("media", "imageSize", null) === 160 &&
    config.normalizePanelSettingValue("media", "showFileName", false) === false &&
    config.normalizePanelSettingValue("media", "showFileName", "false") === false &&
    // 开关的缺省是**显示**（与既有观感一致）；非法值回落缺省。
    config.normalizePanelSettingValue("media", "showFileName", "yes") === true &&
    config.normalizePanelSettingValue("media", "showFileName", null) === true &&
    config.normalizePanelSettingValue("media", "sortKey", "date") === "name" &&
    config.normalizePanelSettingValue("media", "sortDir", "up") === "asc" &&
    config.normalizePanelSettingValue("media", "sortDir", "desc") === "desc" &&
    config.normalizePanelSettingValue("ghost", "view", "tile") === undefined,
);
check(
  "「显示文件名」开关被面板真的消费（关掉只影响缩略图视图的标签，列表视图文件名照旧）",
  mediaSpec?.settings?.find((s) => s.key === "showFileName")?.default === true &&
    /usePanelSwitch\(MEDIA_PANEL_ID, "showFileName", \{ api: panelApi \}\)/.test(mediaFamilySrc) &&
    /showName=\{showFileName\}/.test(mediaFamilySrc) &&
    // 单元按开关条件渲染标签；列表视图的文件名是条目本体，不受开关影响。
    /\{showName && <span className="mp-name">/.test(mediaCellSrc) &&
    /<span className="mp-row-name">\{file\.relative_path\}<\/span>/.test(mediaFamilySrc),
);
check(
  "列表视图的体积走**宿主设置** `ui.sizeUnit`（与元数据面板同一份格式化），不另立同名面板设置",
  // 面板设置里不得出现 sizeUnit / dateFormat 这类宿主项的同名副本（两套口径必然漂移）。
  !(mediaSpec?.settings ?? []).some((s) => s.key === "sizeUnit") &&
    !(mediaSpec?.settings ?? []).some((s) => s.key === "dateFormat") &&
    /const sizeUnit = resolveSizeUnit\(useHostSettingValue\(SETTING_KEYS\.sizeUnit, panelApi\)\)/.test(
      mediaPanelSrc,
    ) &&
    /formatByteSize\(file\.size, sizeUnit\)/.test(mediaPanelSrc) &&
    // 不许退回裸字节数（用户反馈的就是这个）。
    !/<span className="mp-row-size">\{file\.size\}<\/span>/.test(mediaPanelSrc),
);
check(
  "媒体预览设置用 `divider_before` 分成两组（视图 / 排序），首项无分隔线",
  eqList(
    (mediaSpec?.settings ?? []).filter((s) => s.divider_before).map((s) => s.key),
    ["sortKey"],
  ) && mediaSpec?.settings?.[0]?.divider_before !== true,
);
const mkFile = (relative_path, size, mtime, media_type) => ({
  relative_path,
  size,
  mtime,
  media_type,
});
const mediaRows = [
  mkFile("b\\img10.jpg", 300, "1600000000000000000", "image"),
  mkFile("a\\img2.jpg", 100, "1700000000000000000", "image"),
  mkFile("c\\clip.mp4", 200, "1500000000000000000", "video"),
];
const nameOf = (list) => list.map((f) => f.relative_path).join(",");
const sortBy = (key, dir) => nameOf(mediaView.sortFiles(mediaRows, key, dir));
check(
  "排序纯函数：四个键 × 两个方向（名称**数字感知** `img2` < `img10`、时间按 epoch 纳秒、大小按字节）",
  sortBy("name", "asc") === "c\\clip.mp4,a\\img2.jpg,b\\img10.jpg" &&
    sortBy("name", "desc") === "b\\img10.jpg,a\\img2.jpg,c\\clip.mp4" &&
    sortBy("size", "asc") === "a\\img2.jpg,c\\clip.mp4,b\\img10.jpg" &&
    sortBy("time", "asc") === "c\\clip.mp4,b\\img10.jpg,a\\img2.jpg" &&
    // 「类型」同类型内再按名称，否则组内顺序由查询顺序决定（看起来在抖）。
    sortBy("type", "asc") === "a\\img2.jpg,b\\img10.jpg,c\\clip.mp4",
  `name=${sortBy("name", "asc")} | size=${sortBy("size", "asc")} | time=${sortBy("time", "asc")}`,
);
check(
  "排序是纯函数（不改动入参数组）且从**路径最后一段**取名（`\\` 与 `/` 都认）",
  mediaRows[0].relative_path === "b\\img10.jpg" &&
    mediaView.fileName("a\\b\\c.jpg") === "c.jpg" &&
    mediaView.fileName("a/b/c.jpg") === "c.jpg" &&
    mediaView.fileName("noext") === "noext",
);
const masonry = mediaView.distributeColumns([1, 2, 3, 4, 5, 6, 7], 3);
check(
  "瀑布流列分配：按序号从左到右（`i % columns`）、列数恒等于请求列数；宽度不可用时退 1 列",
  JSON.stringify(masonry) === JSON.stringify([[1, 4, 7], [2, 5], [3, 6]]) &&
    mediaView.distributeColumns([1, 2], 1.5).length === 1 &&
    mediaView.masonryColumnCount(0) === 1 &&
    mediaView.masonryColumnCount(-10) === 1 &&
    // 列数公式与 CSS `repeat(auto-fill, <单元格宽度>)` 一致（`n*w + (n-1)*gap <= 容器宽`）——
    // 平铺与瀑布流因此**永远同列数**（两者单元格同宽是用户口径）。
    mediaView.masonryColumnCount(400, 160, 8) === Math.floor((400 + 8) / (160 + 8)) &&
    mediaView.masonryColumnCount(1000, 160, 8) === Math.floor((1000 + 8) / (160 + 8)) &&
    // 808 = 400 + 8 + 400：刚好放得下两列（再多 1px 就只能放一列）。
    mediaView.masonryColumnCount(808, 400, 8) === 2 &&
    mediaView.masonryColumnCount(800, 400, 8) === 1,
  `400px→${mediaView.masonryColumnCount(400, 160, 8)} 1000px→${mediaView.masonryColumnCount(1000, 160, 8)}（单元格 160 / 间距 8）`,
);
check(
  "媒体预览面板真的消费四项设置（缺省读取 + 排序 + 三种视图 + 图片尺寸下发与列数）",
  /usePanelSettingValue\(MEDIA_PANEL_ID, "view", panelApi\)/.test(mediaFamilySrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "imageSize", panelApi\)/.test(mediaFamilySrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortKey", panelApi\)/.test(mediaFamilySrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortDir", panelApi\)/.test(mediaFamilySrc) &&
    /sortFiles\(files, sortKey, sortDir\)/.test(mediaFamilySrc) &&
    /mediaViewClass\(view\)/.test(mediaFamilySrc) &&
    /distributeColumns\(items, masonryColumns\)/.test(mediaFamilySrc) &&
    // 图片尺寸经 CSS 变量下发（一种设置、三种排布同一口径）。
    /"--mp-image-size": `\$\{imageSize\}px`/.test(mediaFamilySrc) &&
    /style=\{containerStyle\}/.test(mediaFamilySrc) &&
    /masonryColumnCount\(el\.clientWidth, imageSize, MASONRY_GAP\)/.test(mediaFamilySrc) &&
    /new ResizeObserver\(measure\)/.test(mediaFamilySrc),
);
check(
  "图片尺寸滑条在「视图」**左边**，取值域来自纯函数常量，列表模式下置灰",
  // 工具条顺序：滑条块在 `<ToolbarDropdown labelKey="media.settings.view"` 之前。
  // （2026-09 第四轮拆分：工具条整块渲染落在 `mediaPreviewToolbar.tsx`。）
  /className="mp-size"[\s\S]*?<ToolbarDropdown\s+labelKey="media\.settings\.view"/.test(mediaToolbarSrc) &&
    /min=\{MEDIA_IMAGE_SIZE_MIN\}/.test(mediaToolbarSrc) &&
    /max=\{MEDIA_IMAGE_SIZE_MAX\}/.test(mediaToolbarSrc) &&
    /value=\{imageSize\}/.test(mediaToolbarSrc) &&
    /onChange=\{\(e\) => onChooseImageSize\(Number\(e\.target\.value\)\)\}/.test(mediaToolbarSrc) &&
    // 与视图下拉同一处置：只在「预览图」模式下有效。
    /disabled=\{viewMode !== "thumb"\}/.test(mediaToolbarSrc) &&
    // 夹紧与「本会话记住」在会话状态模块（`chooseImageSize`），工具条只转发。
    /const clamped = clampImageSize\(next\);/.test(mediaFamilySrc),
);
check(
  "面板内的改动只做**本会话**覆盖，且「全部设置」显式改动时放弃覆盖（否则＝改了设置没反应）",
  /let sessionView: MediaViewMode \| null = null;/.test(mediaFamilySrc) &&
    /let sessionImageSize: number \| null = null;/.test(mediaFamilySrc) &&
    /sessionView = next;/.test(mediaFamilySrc) &&
    /sessionImageSize = clamped;/.test(mediaFamilySrc) &&
    /sessionSortKey = next;/.test(mediaFamilySrc) &&
    /sessionSortDir = next;/.test(mediaFamilySrc) &&
    /subscribeSettingChanged\(\(key\) => \{/.test(mediaFamilySrc) &&
    /key === VIEW_STORAGE_KEY/.test(mediaFamilySrc) &&
    /key === IMAGE_SIZE_STORAGE_KEY/.test(mediaFamilySrc) &&
    /key === SORT_KEY_STORAGE_KEY/.test(mediaFamilySrc) &&
    /key === SORT_DIR_STORAGE_KEY/.test(mediaFamilySrc) &&
    (mediaFamilySrc.match(/= null;\n\s+set\w+Override\(null\);/g) ?? []).length === 4,
);
check(
  "排序下拉 =「名称 / 时间 / 大小 / 类型」+ **一条横线** +「正序 / 倒序」（两组都由取值域派生）",
  // 取值域本身的顺序就是界面顺序（注册表候选与之逐项一致，见上面的 `eqList`）。
  eqList([...mediaView.MEDIA_SORT_KEYS], ["name", "time", "size", "type"]) &&
    eqList([...mediaView.SORT_DIRECTIONS], ["asc", "desc"]) &&
    /MEDIA_SORT_KEYS\.map\(/.test(mediaToolbarSrc) &&
    /SORT_DIRECTIONS\.map\(/.test(mediaToolbarSrc) &&
    // 横线挂在**方向组第一项**之前（`index === 0`），不会跑到最上面或错位。
    /ruleBefore: index === 0/.test(mediaToolbarSrc) &&
    /\{option\.ruleBefore && <div className="menu-sep" \/>\}/.test(mediaDropdownSrc),
  `sortKeys=${[...mediaView.MEDIA_SORT_KEYS].join(",")} directions=${[...mediaView.SORT_DIRECTIONS].join(",")}`,
);
check(
  "「视图」下拉只在「预览图」模式下有效（列表模式下置灰并给出原因）",
  /disabled=\{viewMode !== "thumb"\}/.test(mediaToolbarSrc) &&
    /disabledHint=\{t\("media\.viewOnlyInThumb"\)\}/.test(mediaToolbarSrc) &&
    // 下拉组件本身必须接住 `disabled`（否则"置灰"只是面板一厢情愿）。
    /disabled=\{disabled\}/.test(mediaDropdownSrc) &&
    // 工具条只接面板传下来的 `t`（同一份 i18n 函数，不是工具条自建一份文案）。
    /<MediaPreviewToolbar[\s\S]{0,900}?t=\{app\.t\}/.test(mediaPanelSrc) &&
    /import \{ ToolbarDropdown, type DropdownOption \} from "\.\/mediaPreviewDropdown";/.test(
      mediaToolbarSrc,
    ),
);
const contextMenuForDropdownSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/menu/ContextMenu.tsx"),
  "utf8",
);
check(
  "媒体预览在**后台标签时冻结**：三个条目容器都要求 `foreground`，滚动/列数测量在前台变化后重跑",
  /import \{ usePanelForeground \} from "\.\.\/shared\/panelForeground";/.test(mediaPanelSrc) &&
    /const foreground = usePanelForeground\(panelApi\);/.test(mediaPanelSrc) &&
    (mediaPanelSrc.match(/repoId && foreground && viewMode ===/g) ?? []).length === 3 &&
    // 冻结时容器不在 DOM 里：滚动恢复与瀑布流测量必须跟着前台变化重跑一次。
    // （滚动恢复的依赖数组另外还要含 `items.length` / `loading`——后台翻页下内容会
    //  一轮轮变长，只依赖"从无到有"的布尔会让深位置永远恢复不回去，见 `mediaPreviewScroll.ts`。）
    /\}, \[viewMode, view, foreground, app\.repoId, items\.length, loading\]\);/.test(
      mediaPanelSrc,
    ) &&
    /\}, \[viewMode, foreground, app\.repoId, items\.length, loading\]\);/.test(mediaPanelSrc) &&
    /\}, \[view, viewMode, foreground, imageSize, app\.repoId, items\.length > 0\]\);/.test(
      mediaPanelSrc,
    ),
);
check(
  "冻结判据只用 `isVisible`（不得掺 `isActive`：那会让「点别的面板就冻住」复发），且失败方向选「先渲染」",
  // `isActive` 表示"本组也是当前聚焦组"：用户点媒体源/相册时它会变 false，
  // 而本面板仍在显示——用 `isVisible && isActive` 当判据就会出现"点源不刷新、点一下才显示"。
  /const sync = \(\) => setForeground\(Boolean\(panelApi\.isVisible\)\);/.test(
    panelForegroundSrc,
  ) &&
    !/isVisible\s*&&\s*panelApi\.isActive/.test(panelForegroundSrc) &&
    !/onDidActiveChange/.test(panelForegroundSrc) &&
    /panelApi\.onDidVisibilityChange\(sync\)/.test(panelForegroundSrc) &&
    // 首帧乐观 + 无 API 不冻结：判断"不在显示"而误会让面板空白，宁可多渲染一次。
    /const \[foreground, setForeground\] = useState\(true\);/.test(panelForegroundSrc) &&
    /if \(!panelApi\) return;/.test(panelForegroundSrc),
);
// `renderCell` 的实现块：`ThumbCell` 的 props 必须全是稳定引用（列表视图的行走另一条路径，
// 那几行不是 memo 的受益者，不在此约束内）。
const renderCellSrc = (
  mediaPanelSrc.match(/const renderCell = useCallback\([\s\S]*?\n  \);/) || [""]
)[0];
check(
  "缩略图单元 `memo` 的前提被钉住：回调恒定引用 + 双击以文件为参数（不再逐格新建闭包）",
  /export const ThumbCell = memo\(function ThumbCell\(/.test(mediaCellSrc) &&
    /onDoubleClick: \(file: FileItem\) => void;/.test(mediaCellSrc) &&
    /onDoubleClick=\{\(\) => onDoubleClick\(file\)\}/.test(mediaCellSrc) &&
    /function useStableCallback<A extends unknown\[\], R>/.test(mediaPanelSrc) &&
    /const cellSelect = useStableCallback\(handleSelect\);/.test(mediaPanelSrc) &&
    /onSelect=\{cellSelect\}/.test(renderCellSrc) &&
    /onDoubleClick=\{cellDoubleClick\}/.test(renderCellSrc) &&
    // 反向：`ThumbCell` 的 props 里不许再出现逐格新建的箭头函数（那会让 memo 完全失效）。
    !/=\(\) =>/.test(renderCellSrc) &&
    !/onDoubleClick=\{\(\) =>/.test(renderCellSrc),
);
check(
  "两个下拉复用 portal 的 `ContextMenu`，且「点外部关闭」**同时排除按钮与弹出层**",  // 弹出层由 `ContextMenu` portal 到 `document.body`：它的 DOM **不在按钮里**，
  // 只排除按钮的话，按在选项上的 mousedown 会先关掉下拉、卸载弹出层，
  // 选项的 click 永远不会发生（"下拉能开、选什么都没反应"）。
  /<ContextMenu x=\{anchor\.x\} y=\{anchor\.y\}>/.test(mediaDropdownSrc) &&
    /btnRef\.current\?\.contains\(target\)/.test(mediaDropdownSrc) &&
    /target\.closest\("\.context-menu"\)/.test(mediaDropdownSrc) &&
    // 判定收在纯函数里（下面按行为断言），组件不得再手写一份 if。
    /shouldCloseDropdown\(inButton, inPopup\)/.test(mediaDropdownSrc) &&
    // 类名两侧必须对得上：弹出层的容器类由 `ContextMenu` 定义。
    /className="context-menu"/.test(contextMenuForDropdownSrc) &&
    // 顺序：先判"是不是外部"，再关；反过来等于没排除。
    /if \(!shouldCloseDropdown\(inButton, inPopup\)\) return;[\s\S]{0,80}?setAnchor\(null\);/.test(
      mediaDropdownSrc,
    ),
);
check(
  "「点外部关闭」的不变量：按在**弹出层内**不关闭（谁也不能化简回 `!inButton`）",
  mediaView.shouldCloseDropdown(false, false) === true &&
    mediaView.shouldCloseDropdown(true, false) === false &&
    mediaView.shouldCloseDropdown(false, true) === false &&
    mediaView.shouldCloseDropdown(true, true) === false,
  `(按钮内,弹出层内)=(${mediaView.shouldCloseDropdown(true, false)},${mediaView.shouldCloseDropdown(false, true)})`,
);
check(
  "media 面板拿到 dockview 面板 API（第 4 条触发源「面板激活」才可达）",
  /\{ id: "media", titleKey: "panel\.media", render: \(ctx\) => <MediaPreviewPanel api=\{ctx\.api\} \/> \}/.test(
    registrySource,
  ),
);
check(
  "三种视图的样式齐全且**共用一个图片尺寸变量**：平铺（固定列宽）/ 自适应（逐行两端对齐）/ 瀑布流（固定列宽）",
  // 平铺：固定列宽 = 图片尺寸。列数由**面板下发**（`--mp-tile-columns`）而不是
  // `auto-fill`——虚拟化必须知道 CSS 会排几列，否则"按几列切行"与 CSS 排布不一致，
  // 表现为行错位/留白。列数仍用与 `auto-fill` 相同的公式算（`masonryColumnCount`）。
  /\.mp-grid\.mp-view-tile\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--mp-tile-columns/.test(
    stylesSource,
  ) &&
    !/\.mp-grid\.mp-view-tile\s*\{[^}]*repeat\(auto-fill/.test(stylesSource) &&
    /"--mp-tile-columns":\s*String\(Math\.max\(1, masonryColumns\)\)/.test(mediaPanelSrc) &&
    /\.mp-view-tile \.mp-thumb img[\s\S]{0,120}?object-fit:\s*cover/.test(stylesSource) &&
    // 瀑布流：列宽 = 同一个变量（**不再 `flex: 1 1 0` 等分**，那会让列宽随面板漂移）。
    /\.mp-masonry\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    /\.mp-masonry-col\s*\{[^}]*flex:\s*0 0 var\(--mp-image-size/.test(stylesSource) &&
    !/\.mp-masonry-col\s*\{[^}]*flex:\s*1 1 0/.test(stylesSource) &&
    /\.mp-masonry \.mp-thumb img[\s\S]{0,160}?height:\s*auto/.test(stylesSource) &&
    // 行高不等的瀑布流**不得**再靠"关掉跳过渲染"回避滚动抖动：占位高度由面板按宽高比
    // 逐个文件下发（`contain-intrinsic-block-size`），跳过渲染因此可以打开。
    !/\.mp-masonry \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    /\.mp-size-range\s*\{/.test(stylesSource) &&
    /\.mp-dd\s*\{/.test(stylesSource),
);
check(
  "自适应 = **逐行两端对齐**：断行改由 JS（第 6 轮），行内仍按宽高比分配剩余空间（`flex-grow`/`flex-basis` 同为宽高比）",
  // 第 6 轮（缺陷 0018 §3.1 路线 2）：断行从 CSS `flex-wrap` 移到 JS（`adaptiveRowLayout`），
  // 否则虚拟化无从下手（JS 不测量就不知道 CSS 会断在哪）。**行内宽度分配仍是 CSS**，
  // 因此"两端对齐"的观感一字不改——这一点由 n=60 的 A/B 实测证明：
  // 旧实现 contentHeight = 1684，新实现同样 1684（逐行一致）。
  /\.mp-grid\.mp-view-adaptive\s*\{[^}]*--mp-row-max-factor:\s*2/.test(stylesSource) &&
    // 行容器是 flex 行，且**不得**再 `flex-wrap: wrap`：行边界由 JS 决定，
    // CSS 再换行就会与 JS 不一致（表现为行错位/留白）。
    /\.mp-virtual-row\.mp-virtual-adaptive\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    /\.mp-virtual-row\.mp-virtual-adaptive\s*\{[^}]*flex-wrap:\s*nowrap/.test(stylesSource) &&
    // 两端对齐的两行：grow 与 basis 都必须取宽高比，缺一就退化成"等高不齐边"。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*flex-grow:\s*var\(--mp-cell-ratio/.test(stylesSource) &&
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*flex-basis:\s*calc\(var\(--mp-cell-ratio/.test(
      stylesSource,
    ) &&
    // 内边距/边框必须在自适应下清零：它们会在宽度上加常数，破坏"高度 = 宽 ÷ 宽高比"，
    // 表现为同一行内各格高度参差（行底部不齐）。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*padding:\s*0/.test(stylesSource) &&
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*border:\s*none/.test(stylesSource) &&
    /\.mp-view-adaptive \.mp-cell\.selected\s*\{[^}]*outline-color/.test(stylesSource) &&
    // 缩略图高度由宽高比推出（行内等高、行间不等）。
    /\.mp-view-adaptive \.mp-thumb\s*\{[^}]*aspect-ratio:\s*var\(--mp-cell-ratio/.test(
      stylesSource,
    ) &&
    // 稀疏行不把单张图放大到上千像素：到行高上限即停手（JS 的 `adaptiveRowLayout` 用同一系数）。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*max-width:\s*calc\([\s\S]{0,160}?--mp-row-max-factor/.test(
      stylesSource,
    ) &&
    // 长文件名不得顶宽单元格（否则"按宽高比配平"失效）。
    /\.mp-view-adaptive \.mp-name\s*\{[^}]*contain:\s*inline-size/.test(stylesSource) &&
    // 行高由宽高比推出 → 跳过渲染的占位高度必须**接近真实**（不能靠关掉跳过渲染回避）。
    !/\.mp-view-adaptive \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource),
);
check(
  "自适应**断行与行高**由 JS 算（`adaptiveRowLayout`），且与 CSS 的配平同源",
  // 缺陷 0018 §3.1 路线 2：断行必须由 JS 算，虚拟化才可能；行内宽度仍交给 CSS。
  // 这里断言的是**纯函数行为**（门禁直接跑真函数），不是源码正则。
  (() => {
    const gap = 8;
    const target = 160;
    const factor = 2;
    // 10 张 1:1 的图、容器宽 808：每格基准宽 160 + 间距 8，
    // 5 格需要 5×160 + 4×8 = 832 > 808 → **每行只能放 4 格**（与 CSS flex-wrap 同判据）。
    const ratios = Array.from({ length: 10 }, () => 1);
    const layout = virtual.adaptiveRowLayout(ratios, 808, target, gap, factor);
    if (layout.rows.length !== 3) return false;
    if (layout.rows[0].length !== 4 || layout.rows[1].length !== 4) return false;
    if (layout.rows[2].length !== 2) return false;
    // 保序、不丢项、不重复。
    if (JSON.stringify(layout.rows.flat()) !== JSON.stringify([...Array(10).keys()])) return false;
    // 行内各格等高：(容器宽 − 行内间距) / Σ宽高比 = (808 − 24) / 4 = 196 → 行高 196。
    if (layout.rowHeights[0] !== 196 || layout.rowHeights[1] !== 196) return false;
    // 末行只有 2 格：撑满会是 (808−8)/2 = 400 > 160×2 = 320 → **封顶到 320**。
    if (layout.rowHeights[2] !== 320) return false;
    // 偏移单调、总高 = Σ行高 + 行间距。
    if (layout.offsets[0] !== 0 || layout.offsets[1] !== 196 + gap) return false;
    if (layout.total !== 196 + gap + 196 + gap + 320) return false;
    return true;
  })(),
  `行高=${virtual.adaptiveRowLayout(Array(10).fill(1), 808, 160, 8, 2).rowHeights.join(",")} 各行列数=${virtual
    .adaptiveRowLayout(Array(10).fill(1), 808, 160, 8, 2)
    .rows.map((r) => r.length)
    .join(",")}`,
);

check(
  "自适应行高**封顶**：稀疏行不被放大到荒唐高度（与 `--mp-row-max-factor` 同源）",
  (() => {
    // 一行只有 1 张 1:1 的图、容器宽 1578：撑满会是 1578px 高，必须封顶到 160×2 = 320。
    const layout = virtual.adaptiveRowLayout([1], 1578, 160, 8, 2);
    if (layout.rows.length !== 1) return false;
    if (layout.rowHeights[0] !== 320) return false;
    // 封顶后该格宽 = 1 × 160 × 2 = 320（`adaptiveCellWidth` 与之一致）。
    const width = virtual.adaptiveCellWidth(1, 1, 1, 1578, 160, 8, 2);
    return width === 320;
  })(),
);

check(
  "自适应断行的**退化输入**：空输入、非法宽高比、零宽容器都不崩",
  (() => {
    const empty = virtual.adaptiveRowLayout([], 800, 160, 8, 2);
    if (empty.rows.length !== 0 || empty.total !== 0) return false;
    // 0 / 负数 / NaN 一律按 1:1 处理（否则 flex 计算会得到 NaN，整行作废）。
    const bad = virtual.adaptiveRowLayout([0, -2, Number.NaN], 800, 160, 8, 2);
    if (bad.rows.flat().length !== 3) return false;
    if (!bad.rowHeights.every((h) => Number.isFinite(h) && h > 0)) return false;
    // 容器宽 0（首帧尚未测量）不得产出 NaN/负高度。
    const zero = virtual.adaptiveRowLayout([1, 1], 0, 160, 8, 2);
    if (!zero.rowHeights.every((h) => Number.isFinite(h) && h > 0)) return false;
    return true;
  })(),
);

check(
  "自适应**按行虚拟化**：只渲染窗口内的行（DOM 单元数与条目总数脱钩）",
  /adaptiveRowLayout\(/.test(mediaPanelSrc) &&
    /useVariableRowVirtualizer\(/.test(mediaPanelSrc) &&
    /adaptiveVirtual\.rows\.map\(/.test(mediaPanelSrc) &&
    // 必须**按窗口切片**渲染，不得退回 `items.map` 全量铺开。
    /\(adaptive\.rows\[row\.index\] \?\? \[\]\)\.map\(/.test(mediaPanelSrc) &&
    !/items\.map\(\(\{ file, url \}\) => renderCell/.test(mediaPanelSrc) &&
    // 内容总高度由虚拟化给出（行高逐行不同，但完全由纯函数算，不测量）。
    /className="mp-virtual" style=\{\{ height: adaptiveVirtual\.totalSize \}\}/.test(mediaPanelSrc) &&
    // 宽高比与容器宽度都必须进依赖：解码后断行会变，容器宽度变了要重新断行。
    /\[items, gridWidth, imageSize, showFileName, view, viewMode, ratioVersion\]/.test(
      mediaPanelSrc,
    ),
);

check(
  "自适应行高的**变量行高虚拟化**按行号取高度（不是常量）",
  // 行内等高、行间不等——用常量 estimateSize 会让内容总高与滚动条长度全错。
  // `.tsx` 不能被 Node 直接加载（JSX 不是可剥离语法），故读**家族源码**。
  /export function useVariableRowVirtualizer\(/.test(mediaFamilySrc) &&
    /estimateSize: \(index\) => heightsRef\.current\[index\] \?\? 0/.test(mediaFamilySrc),
);

check(
  "宽高比是自适应配平的输入：纯函数带兜底（0 / 负数 / NaN 不得进入 flex 计算）并**量后缓存**",
  mediaView.imageRatio(1600, 900) === 1600 / 900 &&
    mediaView.imageRatio(900, 1600) === 900 / 1600 &&
    mediaView.imageRatio(0, 100) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.imageRatio(100, 0) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.imageRatio(Number.NaN, 5) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.imageRatio(-3, 5) === mediaView.DEFAULT_CELL_RATIO &&
    mediaView.DEFAULT_CELL_RATIO === 1 &&
    mediaView.AUDIO_CARD_RATIO === 1.5 &&
    // 单元（`mediaPreviewCell.tsx`）：以 `--mp-cell-ratio` 下发 + 解码后量一次并写缓存
    // （重挂载不再重排一遍）；音频没有宽高比，用固定卡片比例，免得在自适应里成一张方块。
    /"--mp-cell-ratio": String\(ratio\)/.test(mediaCellSrc) &&
    /const next = imageRatio\(naturalWidth, naturalHeight, ratio\);/.test(mediaCellSrc) &&
    // 写入口是 `setRatioCache`（**不是**直接 `ratioCache.set`）：它同时推进版本号，
    // 让面板重算瀑布流/自适应的行高——见上面那条"宽高比异步到达"的断言。
    /setRatioCache\(file\.id, next\);/.test(mediaCellSrc) &&
    /export const ratioCache = new Map<string, number>\(\);/.test(mediaCellSrc) &&
    /file\.media_type === "audio"\s*\?\s*AUDIO_CARD_RATIO/.test(mediaCellSrc) &&
    // 面板必须真的用它渲染条目（不是留着两条渲染路径）。
    /import \{ ThumbCell, getRatioCacheVersion, ratioCache, subscribeRatioChange \} from "\.\/mediaPreviewCell";/.test(mediaPanelSrc) &&
    /<ThumbCell/.test(mediaPanelSrc),
);
check(
  "三种视图都**居中对齐**（图片宽度定死时余量左右均分，不许堆在右边留一条空白）；自适应被行高上限截住的行同理",
  /\.mp-grid\.mp-view-tile\s*\{[^}]*justify-content:\s*center/.test(stylesSource) &&
    // 自适应：断行改由 JS 后，居中落在**行容器**上（每一行各自居中；见第 6 轮的路线 2）。
    /\.mp-virtual-row\.mp-virtual-adaptive\s*\{[^}]*justify-content:\s*center/.test(stylesSource) &&
    /\.mp-masonry\s*\{[^}]*justify-content:\s*center/.test(stylesSource),
);

// ============ 元数据面板：宿主格式设置 ↔ 面板实现（体积 / 日期 / 类型自适应）============
//
// 体积单位与日期格式是**宿主项**（跨面板共用的通用口径，落在「界面 → 其他设置」），
// 因此"声明 ↔ Rust 镜像"的一致性由 `pnpm check:settings` 负责；这里断言三件这里才看得见的事：
// ① 归一化/收敛口径（越界与非法取值都回落缺省）；② 纯函数行为（格式化 + JSON 解析）；
// ③ 面板真的消费它们，并**按媒体类型**自适应渲染。

const format = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/format.ts")).href
);
const metadataInfo = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/metadataInfo.ts")).href
);

check(
  "「其他设置」三项宿主设置齐备（体积单位 / 日期格式 / 显示时间，类别与分节固定）",
  (() => {
    const sizeUnit = config.settingDeclByKey("ui.sizeUnit");
    const dateFormat = config.settingDeclByKey("ui.dateFormat");
    const dateShowTime = config.settingDeclByKey("ui.dateShowTime");
    return (
      sizeUnit?.kind === "select" &&
      sizeUnit.category === "interface" &&
      sizeUnit.section_key === "settings.section.other" &&
      sizeUnit.default === "binary" &&
      eqList(
        (sizeUnit.options ?? []).map((o) => o.value),
        ["binary", "decimal"],
      ) &&
      dateFormat?.default === "iso" &&
      eqList(
        (dateFormat.options ?? []).map((o) => o.value),
        ["iso", "us", "eu"],
      ) &&
      dateShowTime?.kind === "switch" &&
      dateShowTime.default === false
    );
  })(),
);

check(
  "宿主设置值归一化：越界/非法回落声明缺省、未注册键为 undefined、解析器收敛",
  config.normalizeHostSettingValue("ui.sizeUnit", "decimal") === "decimal" &&
    config.normalizeHostSettingValue("ui.sizeUnit", "kib") === "binary" &&
    config.normalizeHostSettingValue("ui.dateFormat", "us") === "us" &&
    config.normalizeHostSettingValue("ui.dateFormat", "29/09/2026") === "iso" &&
    config.normalizeHostSettingValue("ui.dateShowTime", "true") === true &&
    config.normalizeHostSettingValue("ui.dateShowTime", "yes") === false &&
    config.normalizeHostSettingValue("ui.theme", "blue") === "light" &&
    config.normalizeHostSettingValue("ui.notRegistered", true) === undefined &&
    config.resolveSizeUnit("kib") === "binary" &&
    config.resolveSizeUnit("decimal") === "decimal" &&
    config.resolveDateFormat("eu") === "eu" &&
    config.resolveDateFormat(undefined) === "iso" &&
    config.resolveDateShowTime("true") === false &&
    config.resolveDateShowTime(true) === true,
);

check(
  "体积格式化：二进制按 1024 换单位（KiB/MiB/GiB）、十进制按 1000（KB/MB/GB），都按体积自适应",
  format.formatByteSize(512, "binary") === "512 B" &&
    format.formatByteSize(1024, "binary") === "1.00 KiB" &&
    format.formatByteSize(1536, "binary") === "1.50 KiB" &&
    format.formatByteSize(1024 * 1024 * 3.5, "binary") === "3.50 MiB" &&
    format.formatByteSize(1024 ** 3, "binary") === "1.00 GiB" &&
    format.formatByteSize(1500, "decimal") === "1.50 KB" &&
    format.formatByteSize(1_000_000, "decimal") === "1.00 MB" &&
    format.formatByteSize(1_000_000_000, "decimal") === "1.00 GB" &&
    format.formatByteSize(-1, "binary") === "—" &&
    format.formatByteSize(null, "binary") === "—",
  `binary(1536)=${format.formatByteSize(1536, "binary")} decimal(1500)=${format.formatByteSize(1500, "decimal")}`,
);

// 时区无关：时间戳由**本地时间分量**构造，断言的是格式而不是某个时区下的偏移。
const localStamp = String(new Date(2026, 8, 29, 16, 2, 3).getTime() * 1e6);
check(
  "日期格式化：YYYY-MM-DD（缺省）/ MM-DD-YYYY / DD-MM-YYYY 三选，另可按开关补 HH:MM:SS",
  format.formatDateValue(localStamp, "iso", false) === "2026-09-29" &&
    format.formatDateValue(localStamp, "us", false) === "09/29/2026" &&
    format.formatDateValue(localStamp, "eu", false) === "29/09/2026" &&
    format.formatDateValue(localStamp, "iso", true) === "2026-09-29 16:02:03" &&
    format.formatDateValue("2026-09-29T16:02:03", "iso", true) === "2026-09-29 16:02:03" &&
    format.formatDateValue(null, "iso", false) === "—" &&
    format.formatDateValue("not a date", "iso", false) === "not a date",
  `iso=${format.formatDateValue(localStamp, "iso", false)} eu=${format.formatDateValue(localStamp, "eu", false)}`,
);

check(
  "时长/码率/帧率格式化：M:SS 与 H:MM:SS、十进制码率、两位小数帧率",
  format.formatDurationMs(0) === "0:00" &&
    format.formatDurationMs(307_000) === "5:07" &&
    format.formatDurationMs(3_723_000) === "1:02:03" &&
    format.formatDurationSeconds(1.5) === "0:01" &&
    format.formatDurationMs(null) === "—" &&
    format.formatBitRate(320_000) === "320 kbps" &&
    format.formatBitRate(1_450_000) === "1.45 Mbps" &&
    format.formatBitRate(0) === "—" &&
    format.formatFrameRate(30000 / 1001) === "29.97 fps" &&
    format.formatFrameRate(30) === "30 fps" &&
    format.formatFrameRate(null) === "—",
);

const ffprobeFixture = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      width: 1920,
      height: 1080,
      codec_name: "h264",
      avg_frame_rate: "30000/1001",
      bit_rate: "1450000",
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "12.345", bit_rate: "1500000", format_name: "mov,mp4" },
});
const ffprobeFacts = metadataInfo.parseMediaInfo(ffprobeFixture);
check(
  "ffprobe 原始 JSON → 尺寸/时长/编码/码率/帧率（键名与 `crates/hp-media/src/probe.rs` 一致）",
  ffprobeFacts?.width === 1920 &&
    ffprobeFacts?.height === 1080 &&
    ffprobeFacts?.durationMs === 12345 &&
    ffprobeFacts?.codec === "h264" &&
    ffprobeFacts?.bitRate === 1500000 &&
    Math.abs((ffprobeFacts?.frameRate ?? 0) - 30000 / 1001) < 1e-6,
  JSON.stringify(ffprobeFacts),
);
check(
  "ffprobe 缺项按「有就显示」降级：只有 format.duration 也能取时长，坏 JSON 返回 null",
  metadataInfo.parseMediaInfo('{"format":{"duration":"1.5"}}')?.durationMs === 1500 &&
    metadataInfo.parseMediaInfo('{"format":{"duration":"1.5"}}')?.width === null &&
    metadataInfo.parseMediaInfo('{"format":{"duration":"1.5"}}')?.frameRate === null &&
    metadataInfo.parseMediaInfo("not json") === null &&
    metadataInfo.parseMediaInfo(null) === null,
);
check(
  "EXIF 摘要 JSON → 像素尺寸（PNG 等全 null 不抛错；坏 JSON 返回 null）",
  metadataInfo.parseExifSummary('{"width":4000,"height":3000}')?.width === 4000 &&
    metadataInfo.parseExifSummary('{"width":4000,"height":3000}')?.height === 3000 &&
    metadataInfo.parseExifSummary('{"make":null,"width":null,"height":null}')?.width === null &&
    metadataInfo.parseExifSummary("") === null,
);

check(
  "元数据面板消费三项宿主设置（体积按单位制、日期按格式 + 时间开关）",
  /useHostSettingValue\(SETTING_KEYS\.sizeUnit/.test(metadataPanelSrc) &&
    /useHostSettingValue\(SETTING_KEYS\.dateFormat/.test(metadataPanelSrc) &&
    /useHostSettingValue\(SETTING_KEYS\.dateShowTime/.test(metadataPanelSrc) &&
    /formatByteSize\(meta\.size, sizeUnit\)/.test(metadataPanelSrc) &&
    /formatDateValue\(meta\.mtime, dateFormat, dateShowTime\)/.test(metadataPanelSrc),
);
check(
  "元数据面板按类型自适应：图像解码取像素、视频五项各占一行、音频读一次时长",
  /media_type === "image"/.test(metadataPanelSrc) &&
    /new Image\(\)/.test(metadataPanelSrc) &&
    /isImage\s*\?\s*formatPixelSize\(probed\.width \?\? exifFacts\?\.width/.test(metadataPanelSrc) &&
    /formatPixelSize\(mediaFacts\?\.width \?\? probed\.width/.test(metadataPanelSrc) &&
    /new Audio\(\)/.test(metadataPanelSrc) &&
    /preload = "metadata"/.test(metadataPanelSrc) &&
    /parseMediaInfo\(meta\?\.media_info_json\)/.test(metadataPanelSrc) &&
    /metadata\.dimensions/.test(metadataPanelSrc) &&
    /metadata\.duration/.test(metadataPanelSrc) &&
    /metadata\.codec/.test(metadataPanelSrc) &&
    /metadata\.bitrate/.test(metadataPanelSrc) &&
    /metadata\.frameRate/.test(metadataPanelSrc),
);
// 视频的 DOM 兜底：索引里的 `media_info_json` 只在扫描时 ffprobe 可用才写入，
// 早于该状态的索引行永远是空的（库内实测存在），只靠缓存会"什么都不显示"。
check(
  "视频有 DOM 兜底：索引无 ffprobe 缓存时用 `<video>` 探尺寸与时长，且缓存优先",
  /document\.createElement\("video"\)/.test(metadataPanelSrc) &&
    /video\.videoWidth/.test(metadataPanelSrc) &&
    /video\.videoHeight/.test(metadataPanelSrc) &&
    /mediaFacts\?\.width \?\? probed\.width/.test(metadataPanelSrc) &&
    /mediaFacts\?\.durationMs \?\? probed\.durationMs/.test(metadataPanelSrc),
);
// 取不到值的类型行**仍然渲染**（显示 `—`）：否则"索引里没数据"与"面板坏了"外观完全一样，
// 用户无法区分——这正是本轮实测踩到的那次。
check(
  "类型相关的行不因取不到值而消失（缺值显示 `—`，不是静默省略）",
  /mediaFacts\?\.codec \?\? "—"/.test(metadataPanelSrc) &&
    /formatBitRate\(mediaFacts\?\.bitRate\)/.test(metadataPanelSrc) &&
    /label: app\.t\("metadata\.duration"\)/.test(metadataPanelSrc) &&
    !/if \(dimensions !== "—"\)/.test(metadataPanelSrc) &&
    !/if \(duration !== "—"\)/.test(metadataPanelSrc),
);
// 图像查看器信息栏与元数据面板同口径：体积/日期走宿主设置，宽高比/百万像素/缩放仍归它自己。
// 防的是"信息栏又自带一套 1024 进制却标 KB 的旧口径"。
const viewerInfoBarSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ViewerInfoBar.tsx"),
  "utf8",
);
const viewerFormatSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerFormat.ts"),
  "utf8",
);
const imageViewerPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ImageViewerPanel.tsx"),
  "utf8",
);
check(
  "图像查看器信息栏的体积/日期改用宿主设置与共享格式化（不再自带旧口径）",
  format.formatByteSize(1024, "binary") === "1.00 KiB" &&
    /formatByteSize\(totalBytes, sizeUnit\)/.test(viewerInfoBarSrc) &&
    /formatByteSize\(file\.size, sizeUnit\)/.test(viewerInfoBarSrc) &&
    /formatDateValue\(file\.mtime, dateFormat, dateShowTime\)/.test(viewerInfoBarSrc) &&
    /formatPixelSize\(natural\?\.width/.test(viewerInfoBarSrc) &&
    /resolveSizeUnit\(useHostSettingValue\(SETTING_KEYS\.sizeUnit/.test(imageViewerPanelSrc) &&
    /sizeUnit=\{sizeUnit\}/.test(imageViewerPanelSrc) &&
    // 旧实现必须真的删掉：留着就还能被再次接上（`KB` 错标的来源）。
    !/formatBytes/.test(viewerFormatSrc) &&
    !/formatDateTime/.test(viewerFormatSrc) &&
    !/formatDimensions/.test(viewerFormatSrc),
);
check(
  "元数据面板拿到 dockview 面板 API（宿主设置热加载第 4 条触发源）",
  /\{ id: "metadata", titleKey: "panel\.metadata", render: \(ctx\) => <MetadataPanel api=\{ctx\.api\} \/> \}/.test(
    registrySource,
  ),
);
check(
  "元数据面板**不自带面板设置**（体积/日期是全仓库共用的宿主项，避免两套口径）",
  (config.panelSpec("metadata")?.settings ?? []).length === 0,
);

// ==================== 图像查看器：按键映射 + 键盘焦点获取 ====================
//
// 防的是"功能都在、就是按不动"这一类缺陷（与缺陷 0015「面板内点不动」同族）：
// ① 键位散落在组件里 → 改一处漏一处；② 键盘处理挂在面板根节点上，而**从其他面板
// 进来**时焦点还在原面板上，根节点根本收不到 `keydown`。两段都按**行为**断言
// （直接 import 纯函数），而不是只对源码写正则。

const keymap = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts")).href
);

check(
  "图像查看器按键映射：左方向键 = 上一张、右方向键 = 下一张（顺序即胶片栏序列）",
  keymap.viewerKeyAction("ArrowLeft") === "prev" &&
    keymap.viewerKeyAction("ArrowRight") === "next",
  `左=${keymap.viewerKeyAction("ArrowLeft")} 右=${keymap.viewerKeyAction("ArrowRight")}`,
);
check(
  "按键映射是**纯函数**：无关按键返回 null（调用方放行、不 preventDefault，宿主快捷键照常冒泡）",
  keymap.viewerKeyAction("a") === null &&
    keymap.viewerKeyAction("Enter") === null &&
    keymap.viewerKeyAction("Escape") === null &&
    keymap.viewerKeyAction("F5") === null,
);
check(
  "方向键上下与 PageUp/PageDown 的既有语义未被删除（回归对照：它们自面板引入起就是换图）",
  keymap.viewerKeyAction("ArrowUp") === "prev" &&
    keymap.viewerKeyAction("PageUp") === "prev" &&
    keymap.viewerKeyAction("ArrowDown") === "next" &&
    keymap.viewerKeyAction("PageDown") === "next" &&
    keymap.viewerKeyAction("Home") === "fit" &&
    keymap.viewerKeyAction("1") === "actual",
);
// 上一张 / 下一张必须落到**同一个**换图入口（`step` → `stepIndex` → `selectIndex`），
// 否则左右键会绕开胶片栏顺序（例如自己 +1 下标、忽略序列边界与空序列）。
check(
  "左右方向键落到同一换图入口（`stepIndex` + 选中序列项），不另立一套下标推进",
  /viewerKeyAction\(event\.key\)/.test(imageViewerPanelSrc) &&
    /action === "prev"[\s\S]{0,80}?step\(-1\)/.test(imageViewerPanelSrc) &&
    /action === "next"[\s\S]{0,80}?step\(1\)/.test(imageViewerPanelSrc) &&
    /stepIndex\(sequence\.index, sequence\.files\.length, delta\)/.test(imageViewerPanelSrc) &&
    // 组件里不得再有散落的 `case "ArrowLeft"` 分支（键位判定只在 viewerKeymap.ts 一处）。
    !/case "ArrowLeft"/.test(imageViewerPanelSrc),
);
// 「从其他面板进入图像查看器」这条路径：面板被程序激活时 DOM 焦点还在原面板上，
// 必须由面板自己把焦点拿到根节点——否则方向键永远不可达（用户看到的正是这个）。
// 三道细节都必须守住，缺一条都会"看起来实现了、实际按不动"：
//   ① 只在**进入**这个转换上取一次（独立单面板窗口的 `panelApi` 每次渲染都是新替身，
//      无条件取会反复抢焦点）；
//   ② 判据在激活的**当帧**读（`onDidActiveChange` 在 `pointerdown` 派发中同步触发，
//      此刻浏览器尚未执行"点击即聚焦"，读到的是点之前的焦点 → 放行；键盘在标签条
//      按 Enter 激活时读到标签元素 → 拦下，标签条左右键导航得以保留）；
//   ③ 取焦点**延后一帧**（鼠标点标签页时浏览器默认动作会把焦点给标签元素，同步
//      `focus()` 会被覆盖，表现为"进来了却按不动"）。
check(
  "从其他面板进入（程序激活）时面板把键盘焦点拿到根节点",
  /panelApi\.onDidActiveChange\(sync\)/.test(imageViewerPanelSrc) &&
    /panelApi\.onDidVisibilityChange\(sync\)/.test(imageViewerPanelSrc) &&
    /const active = Boolean\(panelApi\.isVisible && panelApi\.isActive\);/.test(imageViewerPanelSrc) &&
    /const entered = active && !enteredRef\.current;/.test(imageViewerPanelSrc) &&
    /enteredRef\.current = active;/.test(imageViewerPanelSrc) &&
    /if \(!entered\) return;/.test(imageViewerPanelSrc) &&
    /shouldTakeViewerFocus\(document\.activeElement\)/.test(imageViewerPanelSrc) &&
    // 取焦点延后一帧（否则被浏览器"点击即聚焦标签"的默认动作覆盖）；
    // 帧内重读激活态——这一帧里用户可能已经切走，此时不能再抢焦点。
    /requestAnimationFrame\(\(\) => \{[\s\S]{0,220}?if \(!panelApi\.isVisible \|\| !panelApi\.isActive\) return;[\s\S]{0,80}?rootRef\.current\?\.focus\(\{ preventScroll: true \}\);/.test(
      imageViewerPanelSrc,
    ) &&
    /cancelAnimationFrame\(focusFrameRef\.current\)/.test(imageViewerPanelSrc),
);
// 取焦点**不能无条件抢**：正在输入 / 模态浮层 / 标签条键盘导航都必须让路。
check(
  "取焦点有判据：输入框（input/textarea/select/contenteditable）不抢",
  keymap.shouldTakeViewerFocus({ tagName: "INPUT" }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "TEXTAREA" }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "SELECT" }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "DIV", isContentEditable: true }) === false &&
    keymap.shouldTakeViewerFocus({ tagName: "INPUT", closest: () => null }) === false,
);
check(
  "取焦点有判据：模态浮层（[role=dialog]）与标签条（[role=tablist]）内不抢",
  keymap.shouldTakeViewerFocus({ tagName: "DIV", closest: (s) => (s.includes("dialog") ? {} : null) }) ===
    false &&
    keymap.shouldTakeViewerFocus({
      tagName: "DIV",
      closest: (s) => (s.includes("tablist") ? {} : null),
    }) === false,
);
check(
  "取焦点有判据：无焦点 / body / 普通元素（即「从别的面板进来」的形态）要取",
  keymap.shouldTakeViewerFocus(null) === true &&
    keymap.shouldTakeViewerFocus(undefined) === true &&
    keymap.shouldTakeViewerFocus({ tagName: "BODY", closest: () => null }) === true &&
    keymap.shouldTakeViewerFocus({ tagName: "DIV", closest: () => null }) === true,
);
// 面板内点击取焦点这条入口保持不变（胶片栏的 `<button>` 仍不抢）。
check(
  "面板内点击仍把焦点交给根节点（胶片栏按钮不抢，避免键盘操作被面板吞掉）",
  /closest\("button"\)/.test(imageViewerPanelSrc) &&
    /tabIndex=\{0\}/.test(imageViewerPanelSrc) &&
    /onKeyDown=\{onKeyDown\}/.test(imageViewerPanelSrc),
);
check(
  "按键映射与焦点判据是**纯逻辑模块**（无 React / Tauri 依赖，门禁可直接 import）",
  !/from "react"/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts"),
      "utf8",
    ),
  ) && !/@tauri-apps/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts"),
      "utf8",
    ),
  ),
);

// ==================== 图像查看器：相邻图像预加载 ====================
//
// 防的是"预加载写了但没接上/接了却把内存吃光"：取哪些邻居由纯函数决定（按行为断言），
// 而"什么时候取、取到什么程度"由三条边界守住（前台才取 / 大图不解码 / 同张只预热一次）。

const preload = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPreload.ts")).href
);
const preloadHookSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/useViewerPreload.ts"),
  "utf8",
);
const imageUrlSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/imageUrl.ts"),
  "utf8",
);

check(
  "预加载取相邻项：以当前项为中心前后各 N 张，近的优先、同距离时向前优先",
  eqList(preload.preloadTargets(5, 20, 2), [6, 4, 7, 3]),
  `targets=${preload.preloadTargets(5, 20, 2).join(",")}`,
);
check(
  "预加载**越界不环绕**（与换图口径一致：到头就停，不绕回序列另一端）",
  eqList(preload.preloadTargets(0, 5, 2), [1, 2]) &&
    eqList(preload.preloadTargets(4, 5, 2), [3, 2]) &&
    eqList(preload.preloadTargets(1, 3, 3), [2, 0]),
);
check(
  "预加载半径 0 = **关闭**（不是「至少一张」）；当前项不在序列内时返回空",
  eqList(preload.preloadTargets(5, 20, 0), []) &&
    eqList(preload.preloadTargets(-1, 20, 2), []) &&
    eqList(preload.preloadTargets(0, 0, 2), []) &&
    eqList(preload.preloadTargets(20, 20, 2), []),
);
check(
  "预加载半径夹紧到 [0, 3]（上限的理由是内存：100 MP 解码后可达数百 MB）",
  preload.clampPreloadRadius(0) === 0 &&
    preload.clampPreloadRadius(-5) === 0 &&
    preload.clampPreloadRadius(99) === preload.PRELOAD_RADIUS_MAX &&
    preload.clampPreloadRadius(2.4) === 2 &&
    preload.clampPreloadRadius(Number.NaN) === preload.PRELOAD_RADIUS_FALLBACK &&
    preload.PRELOAD_RADIUS_MAX === 3,
);
check(
  "预加载半径的**声明缺省**落在面板夹紧范围内（与 filmstripSize 同一处置）",
  (() => {
    const decl = imageViewerSpec?.settings?.find((s) => s.key === "preloadRadius");
    return (
      decl?.kind === "numberInput" &&
      typeof decl?.default === "number" &&
      decl.default >= preload.PRELOAD_RADIUS_MIN &&
      decl.default <= preload.PRELOAD_RADIUS_MAX
    );
  })(),
  `kind=${imageViewerSpec?.settings?.find((s) => s.key === "preloadRadius")?.kind} ` +
    `default=${imageViewerSpec?.settings?.find((s) => s.key === "preloadRadius")?.default}`,
);
// 边界 1：面板不在前台就不预加载（dockview 会把后台标签留在 DOM 里）。
check(
  "预加载只在面板**前台**进行（判据只看 isVisible，见 shared/panelForeground.ts）",
  /usePanelForeground\(panelApi\)/.test(imageViewerPanelSrc) &&
    /enabled: foreground && Boolean\(repoId\)/.test(imageViewerPanelSrc) &&
    /if \(!enabled \|\| !repoId\)/.test(preloadHookSrc),
);
// 边界 2：大图只"解析 + 生成"，不"解码预热"（把解码位图留在内存里会吃光内存）。
check(
  "大图不参与**解码预热**（仍解析 URL 并触发后端生成，只是不用 new Image() 驻留位图）",
  /PRELOAD_DECODE_MAX_BYTES/.test(preloadHookSrc) &&
    /if \(file\.size > PRELOAD_DECODE_MAX_BYTES\) return;/.test(preloadHookSrc) &&
    /new Image\(\)/.test(preloadHookSrc) &&
    /image\.decoding = "async"/.test(preloadHookSrc),
);
// 边界 3：同一张只预热一次；换序列才重置。
check(
  "同一张只预热一次（换序列才重置记录），避免每次渲染重造 Image",
  /warmedRef\.current\.has\(file\.id\)/.test(preloadHookSrc) &&
    /warmedRef\.current\.add\(file\.id\)/.test(preloadHookSrc) &&
    /filesRef\.current !== files/.test(preloadHookSrc) &&
    /warmedRef\.current\.clear\(\)/.test(preloadHookSrc),
);
// 登记与预热必须**成对**：若"已登记"之后又因 effect 清理而放弃预热，那张图就永远
// 不会再试（登记表说它做过了）。这类缺陷没有任何外部症状，只能靠这条断言钉住。
check(
  "预热不因 effect 清理而丢弃（登记表说做过、就必须真的做，否则永不重试）",
  !/let cancelled = false;/.test(preloadHookSrc) &&
    !/if \(cancelled \|\| !url\) return;/.test(preloadHookSrc) &&
    /void resolveImageUrl\(repoId, file\.id, file\.relative_path\)\.then\(\(url\) => \{\s*if \(!url\) return;/.test(
      preloadHookSrc,
    ),
);
// 预加载必须走与当前图**同一份** URL 缓存，否则 HEIC 会被生成两次。
check(
  "预加载与当前图共用同一份 URL 缓存与去重（否则 HEIC 全分辨率生成两次）",
  /resolveImageUrl\(repoId, file\.id, file\.relative_path\)/.test(preloadHookSrc) &&
    /resolveImageUrlOutcome\(repoId, file\.id, file\.relative_path\)/.test(imageViewerPanelSrc) &&
    /imageUrlCache/.test(imageUrlSrc) &&
    /imagePromiseCache/.test(imageUrlSrc) &&
    // HEIC/HEIF 复用 previewUrl 的缓存（两个入口命中同一份）。
    /resolvePreviewUrl\(repoId, fileId\)/.test(imageUrlSrc) &&
    /needsPreview\(relativePath\)/.test(imageUrlSrc),
);
check(
  "取图策略收敛到一处：面板不再自己写 needsPreview ? previewGet : filePath 分支",
  !/api\.previewGet\(/.test(imageViewerPanelSrc) &&
    !/api\.filePath\(/.test(imageViewerPanelSrc) &&
    !/convertFileSrc/.test(imageViewerPanelSrc),
);
check(
  "预加载纯逻辑模块无 React / Tauri 依赖（门禁可直接 import）",
  !/from "react"/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPreload.ts"),
      "utf8",
    ),
  ) && !/@tauri-apps/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerPreload.ts"),
      "utf8",
    ),
  ),
);
// 面板消费该设置（声明 ↔ 消费闭环，与 filmstripSize 同款）。
check(
  "面板真的消费预加载半径设置（读设置 → 传进钩子）",
  /radius: settings\.preloadRadius/.test(imageViewerPanelSrc) &&
    /preloadRadius: clampPreloadRadius\(declaredDefault\("preloadRadius", 1\)\)/.test(viewerSettingsSrc) &&
    /preloadRadius:/.test(viewerSettingsSrc),
);

// ==================== 图像查看器：换图首帧的视图变换 ====================
//
// 防的是"切换瞬间的拉伸"（缺陷 0026）。机制（已确证，见该记录的证据行）：
// 新图解码完成（`<img onLoad>` → `setNatural`）与"重新适应窗口"（**被动** `useEffect`）
// 分属两个提交——`onLoad` 那一提交**先被浏览器绘制**，effect 才把变换改回来。因此若变换与
// "它属于哪张图"没有绑定，新图就会被先画成**上一张**的缩放与平移，下一帧才跳到「适应窗口」。
// 极值对照：从 6000×4000 切到 400×300 时先按 0.13 倍画、下一帧跳到 2.5 倍（反之亦然），
// 用户看到的就是切换瞬间的一次拉伸/跳变。
//
// 修复口径：**判据必须在渲染路径上**（`resolveViewTransform`），不能靠 effect 事后纠正
// ——换 `useLayoutEffect` 只是把窗口压小，仍依赖"onLoad → 绘制"的时序约定。

const viewerZoom = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts")).href
);
const zoomStage = { width: 800, height: 600 };
const zoomBig = { width: 6000, height: 4000 };
const zoomSmall = { width: 400, height: 300 };
/** 上一张的"极端"变换：放大过、也平移过（任何沿用都会一眼看出来）。 */
const zoomStale = { zoom: 3, offset: { x: 120, y: -80 } };

check(
  "换图首帧：变换记录**不属于**当前图像时取「适应窗口」（不沿用上一张的缩放/平移）",
  (() => {
    const t = viewerZoom.resolveViewTransform(
      "asset://old.jpg",
      "asset://new.jpg",
      zoomStale,
      zoomSmall,
      zoomStage,
    );
    return (
      t.zoom === viewerZoom.fitZoom(zoomSmall, zoomStage) && t.offset.x === 0 && t.offset.y === 0
    );
  })(),
  (() => {
    const t = viewerZoom.resolveViewTransform(
      "asset://old.jpg",
      "asset://new.jpg",
      zoomStale,
      zoomSmall,
      zoomStage,
    );
    return `zoom=${t.zoom} offset=${t.offset.x},${t.offset.y}`;
  })(),
);
check(
  "换图首帧的取值与上一张**完全无关**（同一张新图，无论上一张多离谱都得到同一个变换）",
  (() => {
    const crazy = { zoom: 32, offset: { x: 9999, y: -9999 } };
    const a = viewerZoom.resolveViewTransform("asset://old.jpg", "asset://new.jpg", zoomStale, zoomBig, zoomStage);
    const b = viewerZoom.resolveViewTransform("asset://old.jpg", "asset://new.jpg", crazy, zoomBig, zoomStage);
    const c = viewerZoom.resolveViewTransform("", "asset://new.jpg", zoomStale, zoomBig, zoomStage);
    return a.zoom === b.zoom && a.zoom === c.zoom && viewerZoom.fitZoom(zoomBig, zoomStage) === a.zoom;
  })(),
);
check(
  "同一张图内（记录属于当前图像）**保留**用户的缩放与平移（渲染路径不得把它当换图清掉）",
  (() => {
    const t = viewerZoom.resolveViewTransform(
      "asset://a.jpg",
      "asset://a.jpg",
      zoomStale,
      zoomBig,
      zoomStage,
    );
    return t.zoom === zoomStale.zoom && t.offset.x === 120 && t.offset.y === -80;
  })(),
);
check(
  "「适应窗口」= contain + 居中（平移清零）；尺寸不可用时退化为恒等（此时舞台无可见区域）",
  (() => {
    const fitted = viewerZoom.fitTransform(zoomBig, zoomStage);
    return (
      fitted.zoom === viewerZoom.fitZoom(zoomBig, zoomStage) &&
      fitted.offset.x === 0 &&
      fitted.offset.y === 0 &&
      viewerZoom.fitTransform(null, zoomStage) === viewerZoom.IDENTITY_TRANSFORM &&
      viewerZoom.fitTransform(zoomBig, { width: 0, height: 0 }) === viewerZoom.IDENTITY_TRANSFORM
    );
  })(),
);
// 正向锚点：面板必须把"这份变换属于哪张图"交给纯函数，并在**写入时**记下 token。
// 反向锚点：不得再出现"无主的" `useState<ViewTransform>` + 裸 `setTransform(` ——那正是
// 缺陷 0026 的形态（一个视图变换变量 + 事后 effect 纠正 → 换图首帧必然沿用上一张）。
check(
  "面板把「变换属于哪张图」交给纯函数（渲染路径判定 + 写入时记账），不再有无主的视图变换状态",
  /const transform = resolveViewTransform\(\s*owned\.token,\s*token,\s*owned\.transform,\s*natural,\s*viewport,?\s*\)/.test(
    imageViewerPanelSrc,
  ) &&
    /useState<OwnedTransform>\(\{ token: "", transform: IDENTITY_TRANSFORM \}\)/.test(
      imageViewerPanelSrc,
    ) &&
    /const token = url;/.test(imageViewerPanelSrc) &&
    /setOwned\(\{ token, transform: next \}\)/.test(imageViewerPanelSrc) &&
    // 舞台拿到的必须是**渲染路径算出的**变换，而不是某个状态变量直传。
    /transform=\{transform\}/.test(imageViewerPanelSrc) &&
    !/useState<ViewTransform>/.test(stripComments(imageViewerPanelSrc)) &&
    !/setTransform\(/.test(stripComments(imageViewerPanelSrc)),
);
// 换图后的"重新适应窗口"只由纯函数给值一次（渲染路径），effect 不得再兼任——否则
// 又回到"先画一帧旧的、再由 effect 纠正"。
check(
  "换图不靠 effect 事后纠正：适应窗口的取值只在纯函数里给，effect 只负责落账与改尺寸重适应",
  /commitTransform\(fitTransform\(natural, viewport\)\)/.test(imageViewerPanelSrc) &&
    /const transformRef = useRef\(transform\);/.test(imageViewerPanelSrc) &&
    !/fitZoom\(natural, viewport\)/.test(stripComments(imageViewerPanelSrc)),
);
check(
  "缩放几何纯逻辑模块无 React / Tauri 依赖（门禁可直接 import）",
  !/from "react"/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts"),
      "utf8",
    ),
  ) && !/@tauri-apps/.test(
    readFileSync(
      join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerZoom.ts"),
      "utf8",
    ),
  ),
);
// 相对更新（滚轮 / 导航器 / 1:1）必须走**函数式**写法，且基准先经纯函数归一化：
// ① 滚轮这类**连续事件**在 React 18 里会被批处理，若先读渲染当帧的 `transform` 再写入，
//    同一帧内的第二次事件会读到同一份旧值——中间那一步被丢掉（按步累加的 `prev` 形式不会）；
// ② 基准若不经归一化，换图后就会拿上一张的缩放当基准（与首帧毛病同源，只是发生在更新侧）。
check(
  "相对更新走函数式写法（连续事件不被批处理吞掉），且基准先归一化到当前图像",
  /setOwned\(\(prev\) => \(\{/.test(imageViewerPanelSrc) &&
    /resolveViewTransform\(prev\.token, token, prev\.transform, natural, baseViewport\)/.test(
      imageViewerPanelSrc,
    ) &&
    /updateTransform\(\(base\) => zoomAround\(base, base\.zoom \* factor, natural, size, anchor\), size\)/.test(
      imageViewerPanelSrc,
    ) &&
    /updateTransform\(\(base\) => zoomAround\(base, 1, natural, viewport, centerAnchor\(viewport\)\)\)/.test(
      imageViewerPanelSrc,
    ) &&
    /updateTransform\(\(base\) => centerOn\(base, natural, viewport, u, v\)\)/.test(
      imageViewerPanelSrc,
    ) &&
    // 反向锚点：不得把**渲染当帧**的 `transform` 当基准（批处理下会丢步、换图后会串图）。
    !/zoomAround\(transform,/.test(stripComments(imageViewerPanelSrc)) &&
    !/centerOn\(transform,/.test(stripComments(imageViewerPanelSrc)),
);

// 换图必须是**原子替换**：URL 与"这张图的尺寸"同批提交（缺陷 0028）。
//
// 用户报的现象（原文）："下一张图片大小为上一张的，然后复原为原比例，然后图像闪烁或抖动一次"。
// 这要求某一帧里同时成立"已经是新 URL"+"尺寸/几何还是上一张的"——即换图被拆成了两次提交。
// 修法：把"正在显示的图"收敛成**一个状态对象**（url + natural + fileId），并**先解码后替换**：
// 解码回来时尺寸已知，于是 url 与尺寸一次提交；换图只发生一帧，而那一帧里位图已就绪、几何已知。
const stageSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/ViewerStage.tsx"),
  "utf8",
);
const decodeSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerDecode.ts"),
  "utf8",
);
check(
  "换图是原子替换：url + 尺寸 + 文件 id 同一个状态对象，渲染两值都取自它",
  /useState<ShownImage \| null>\(null\)/.test(imageViewerPanelSrc) &&
    /setShown\(\{ url: nextUrl, natural: size, fileId \}\)/.test(imageViewerPanelSrc) &&
    /const url = shown\?\.url \?\? "";/.test(imageViewerPanelSrc) &&
    /const natural = shown\?\.natural \?\? null;/.test(imageViewerPanelSrc) &&
    // 反向锚点：不得再出现"先换 URL、尺寸另一次提交"的老写法（那正是"半新半旧"帧的来源）。
    !/setUrl\(/.test(stripComments(imageViewerPanelSrc)) &&
    !/setNatural\(/.test(stripComments(imageViewerPanelSrc)),
);
check(
  "换图**先解码后替换**：解码完成才把 url 与尺寸一起换（换图只发生一帧，且位图已就绪）",
  /await decodeImageSize\(nextUrl\)/.test(imageViewerPanelSrc) &&
    /if \(wantRef\.current !== fileId\) return;/.test(imageViewerPanelSrc) &&
    /await showImage\(outcome\.url, file\.id\)/.test(imageViewerPanelSrc) &&
    // 兜底（预览）也必须走同一条"解码后替换"的路，不得自己 setShown。
    /await showImage\(previewUrl, current\.id\)/.test(imageViewerPanelSrc),
);
check(
  "换图不再提前清空画面：解码期间上一张继续显示（没有「载入中」闪烁/空白帧）",
  // 选中项变化时**不**清空 `shown`（只有"没有可显示的图"和失败才清）。
  !/wantRef\.current = file\.id;\s*\n\s*setShown\(null\);/.test(imageViewerPanelSrc) &&
    /if \(!repoId \|\| !file \|\| file\.media_type !== "image"\) \{[\s\S]{0,120}?setShown\(null\);/.test(
      imageViewerPanelSrc,
    ),
);
check(
  "舞台：每张图一个新元素（`key={url}`）+ `decoding=\"sync\"`（复用元素会把旧图层的光栅拉成新尺寸）",
  /key=\{url\}/.test(stageSrc) &&
    /decoding="sync"/.test(stageSrc) &&
    /className=\{`iv-image\$\{natural \? "" : " iv-image-pending"\}`\}/.test(stageSrc),
);
check(
  "解码模块是 DOM 工具（不得变成组件/纯函数混装）：无 React 依赖，且只导出 `decodeImageSize`",
  !/from "react"/.test(decodeSrc) &&
    !/@tauri-apps/.test(decodeSrc) &&
    /export async function decodeImageSize\(/.test(decodeSrc),
);

// 「待解码」兜底几何必须与「适应窗口」同口径（缺陷 0027）。
//
// 断言的是**两处实现同一个公式**：`viewerZoom.fitZoom` 是 `min(舞台/图)`，而
// `.iv-image-pending` 用 `width/height: 100%` + `object-fit: contain`（CSS 的 contain
// **含放大**）。旧写法 `max-width/max-height: 100%` 只会缩小、**永不放大**，于是"宽高都小于
// 舞台的图"在解码完成那一帧先按原尺寸画、下一帧才被放大——实测 400×300 的图在 800×600 舞台里
// 先画 400×300、再跳到 800×600（**50% 偏差**，一帧即用户报的"一瞬间拉伸"）。
// 大图两帧恰好相同，所以这个缺陷**只在小图上可见**（这也是它此前没被当成"换图"缺陷的原因）。

/** 取某条 CSS 规则的声明块正文（选择器只出现一次时用它做断言）。 */
function cssRuleBody(source, selector) {
  const at = source.indexOf(`\n${selector} {`);
  if (at < 0) return null;
  const start = source.indexOf("{", at);
  const end = source.indexOf("}", start);
  return start < 0 || end < 0 ? null : source.slice(start + 1, end);
}

const pendingRule = cssRuleBody(stylesSource, ".iv-image-pending");
check(
  "「待解码」兜底用 CSS 的 contain（含放大）：宽度/高度吃满舞台 + `object-fit: contain`",
  Boolean(pendingRule) &&
    /width:\s*100%/.test(pendingRule) &&
    /height:\s*100%/.test(pendingRule) &&
    /object-fit:\s*contain/.test(pendingRule) &&
    // 居中由 object-position（默认 50% 50%）负责，不再靠 transform 偏移。
    /left:\s*0/.test(pendingRule) &&
    /top:\s*0/.test(pendingRule) &&
    /transform:\s*none/.test(pendingRule),
);
check(
  "**不得**再退回 `max-width/max-height: 100%`（那两条只缩小、不放大 → 小图会先按原尺寸画一帧）",
  Boolean(pendingRule) &&
    !/max-width/.test(pendingRule) &&
    !/max-height/.test(pendingRule),
);
check(
  "「待解码」兜底几何 ↔ `fitZoom` 同一公式（含**放大**与缩小、宽扁与高瘦四组夹具）",
  [
    [{ width: 400, height: 300 }, { width: 800, height: 600 }], // 小图：必须被放大
    [{ width: 6000, height: 4000 }, { width: 800, height: 600 }], // 大图：缩小
    [{ width: 1200, height: 400 }, { width: 800, height: 600 }], // 宽扁
    [{ width: 200, height: 2000 }, { width: 800, height: 600 }], // 高瘦
  ].every(([natural, vp]) => {
    // CSS `object-fit: contain` 的等比缩放因子
    const contain = Math.min(vp.width / natural.width, vp.height / natural.height);
    return Math.abs(viewerZoom.fitZoom(natural, vp) - contain) < 1e-9;
  }),
);

check(
  "宿主项与面板项共用同一份归一化内核与订阅内核（只在 config/settingValue.ts 与 shared/settingValue.ts 各一份）",
  /normalizeDeclaredValue/.test(
    readFileSync(join(ROOT, "packages/config/src/panels.ts"), "utf8"),
  ) &&
    /normalizeDeclaredValue/.test(
      readFileSync(join(ROOT, "packages/config/src/settings.ts"), "utf8"),
    ) &&
    /useStoredSetting/.test(settingValueSrc) &&
    /useHostSettingValue/.test(settingValueSrc) &&
    /usePanelSettingValue/.test(settingValueSrc),
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
  // 组件表的**动态注册路径**：面板项清单由注册表派生（不是写死的 14 项），
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
  !afterUnregister.includes(pluginPanelId) && afterUnregister.length === 14,
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

// ==================== 「扩展」菜单：装了但没启用必须可见（2026-09 缺陷修复的守护）====================
//
// 防的是：装完插件后「扩展」菜单里**什么都不出现**、界面也无任何提示，
// 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。
// 根因是 `plugin.panelCatalog` 这条"含未启用"的口径此前根本不存在——菜单是个占位。

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
  "「扩展」菜单不再是占位：渲染面板目录并带启用开关（胶囊）",
  /pluginPanelCatalog\(/.test(menuBarSrc) &&
    /panelCatalog\.map\(/.test(menuBarSrc) &&
    /togglePluginEnabled/.test(menuBarSrc) &&
    // 启用开关是宿主统一的胶囊按钮（`shared/SwitchToggle.tsx`），不再是原生复选框。
    /<SwitchToggle/.test(menuBarSrc) &&
    !/type="checkbox"/.test(menuBarSrc),
);
check(
  "未启用 → 灰显且不可点击（按钮 disabled），由右侧开关负责启用",
  /disabled=\{!item\.enabled\}/.test(menuBarSrc) && /\$\{item\.enabled \? "" : " dim"\}/.test(menuBarSrc),
);
check(
  "面板目录**含未启用**（host 侧不按 enabled 过滤，只如实报出该字段）",
  /fn panel_catalog/.test(catalogSrc) &&
    // 关键：panel_catalog 里**没有** `if !enabled { continue }` 这种过滤
    !/fn panel_catalog[\s\S]{0,2000}?if !enabled\s*\{/.test(catalogSrc) &&
    /pub enabled: bool/.test(catalogSrc),
);
check(
  "启用走既有授权口径（只传 repo.read，ui.panel 由宿主按 manifest 自动授予）",
  /pluginEnable\(repoId, item\.pluginId, \["repo\.read"\]\)/.test(menuBarSrc) &&
    /pluginDisable\(repoId, item\.pluginId\)/.test(menuBarSrc),
);
check(
  "面板目录是独立命令（不污染只含已启用的 plugin.contributions 注册表口径）",
  /export function pluginPanelCatalog/.test(apiPluginSrc) &&
    /"plugin_panel_catalog"/.test(apiPluginSrc) &&
    /pub\(crate\) fn plugin_panel_catalog/.test(catalogBridgeSrc),
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
// **什么都不出现**（与 `hello` / `control-demo` 是同一个缺陷）。同时防"再给它画一个
// 点了没用的启用开关"——词库装配只看安装目录、不读启用状态。
const pluginPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/PluginPanel.tsx"),
  "utf8",
);

check(
  "宿主把**无面板的插件也发一行**，并标出「无启用语义」（D36.9）",
  /panel: Option<PanelCatalogPanel>/.test(catalogSrc) &&
    /pub stateless: bool/.test(catalogSrc) &&
    // 带面板的在前、无面板的整组在最后（界面据此放到菜单最底下）。
    /with_panel\.extend\(without_panel\)/.test(catalogSrc) &&
    // 判据是运行时形态，不是"名字像扩展包"。
    /row\.runtime_kind == RuntimeKind::StaticData/.test(catalogSrc),
);
check(
  "「扩展」菜单把数据扩展**列在最底下**，且**不给启用按钮**",
  /const dataPackRows = panelCatalog\.filter\(\(i\) => i\.panel === null\)/.test(menuBarSrc) &&
    /dataPackRows\.map\(/.test(menuBarSrc) &&
    // 数据扩展那一组的渲染里不得出现开关（否则就是一个点了没用的控件）。
    !/dataPackRows[\s\S]{0,600}?<SwitchToggle/.test(menuBarSrc),
);
check(
  "插件面板对数据包**不再画启用/禁用按钮**（那是空操作），只显示状态",
  /const stateless = p\.runtime_kind === "static-data"/.test(pluginPanelSrc) &&
    /plugin\.statelessState/.test(pluginPanelSrc),
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
const repoDisplay = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/repoDisplay.ts")).href
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

// ============================== 汇总 ==============================

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
