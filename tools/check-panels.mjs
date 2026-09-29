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
  "imageviewer 声明了 7 项面板设置（导航器启用/位置、胶片栏启用/位置/尺寸/视图、缩放中心）",
  (imageViewerSpec?.settings ?? []).length === 7,
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
  "面板设置用 `divider_before` 分成三组（导航器 / 胶片栏 / 缩放），首项无分隔线",
  eqList(dividerKeys, ["filmstripEnabled", "zoomAnchor"]) &&
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
    /listen\("setting\.changed"/.test(viewerSettingsSrc) &&
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
    /listen\("setting\.changed"/.test(settingValueSrc) &&
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
// 另外断言「点击图像即按需提取调色板」这条**应用级**行为确实挂在装配层（而不是面板里——
// 面板是后台标签时并未挂载，挂在那里就不会"点击即提取"），以及同一文件的并发去重。

const colorPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/ColorPanel.tsx"),
  "utf8",
);
const colorPaletteWatchSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/colorPaletteWatch.tsx"),
  "utf8",
);
const colorPaletteSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/colorPalette.ts"),
  "utf8",
);
const appUiAppSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/AppUiApp.tsx"),
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
  "点击图像即按需提取调色板：监视器挂在装配层，缺失才请求提取且**只保留最新一次**（短延迟 + 单飞）",
  /<ColorPaletteWatch \/>/.test(appUiAppSrc) &&
    /requestPaletteExtraction\(/.test(colorPaletteWatchSrc) &&
    /media_type === "image"/.test(colorPaletteWatchSrc) &&
    /colorExtract\(/.test(colorPaletteSrc) &&
    // 节流 + 去重都在共享入口里（否则快速连续选中会把全应用唯一的仓库锁排满）。
    /PALETTE_REQUEST_DELAY_MS/.test(colorPaletteSrc) &&
    /pending = \{ repoId, fileId \};/.test(colorPaletteSrc) &&
    /if \(draining\) return;/.test(colorPaletteSrc) &&
    // 面板装载时再自检一次（覆盖上次提取失败/刚重启），与监视器共用同一个入口。
    /requestPaletteExtraction\(repoId, fileId\)/.test(colorPanelSrc),
);

// 调色板本身：规模（8 色）、缓存格式版本（旧缓存自愈）与面板内的排布。
const paletteRsSrc = readFileSync(join(ROOT, "crates/hp-media/src/palette.rs"), "utf8");
const colorCommandSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/color.rs"),
  "utf8",
);
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
  "调色板缓存的格式版本 TS ↔ Rust 相等，且提取命令真的把 `version` 写进 `color_json`",
  rustPaletteVersion > 0 &&
    rustPaletteVersion === paletteJson.PALETTE_FORMAT_VERSION &&
    /PALETTE_FORMAT_VERSION/.test(colorCommandSrc) &&
    /"version"/.test(colorCommandSrc),
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
const mediaView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/mediaPreviewView.ts")).href
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
    /usePanelSwitch\(MEDIA_PANEL_ID, "showFileName", \{ api: panelApi \}\)/.test(mediaPanelSrc) &&
    /showName=\{showFileName\}/.test(mediaPanelSrc) &&
    // 单元按开关条件渲染标签；列表视图的文件名是条目本体，不受开关影响。
    /\{showName && <span className="mp-name">/.test(mediaCellSrc) &&
    /<span className="mp-row-name">\{file\.relative_path\}<\/span>/.test(mediaPanelSrc),
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
  /usePanelSettingValue\(MEDIA_PANEL_ID, "view", panelApi\)/.test(mediaPanelSrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "imageSize", panelApi\)/.test(mediaPanelSrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortKey", panelApi\)/.test(mediaPanelSrc) &&
    /usePanelSettingValue\(MEDIA_PANEL_ID, "sortDir", panelApi\)/.test(mediaPanelSrc) &&
    /sortFiles\(files, sortKey, sortDir\)/.test(mediaPanelSrc) &&
    /mediaViewClass\(view\)/.test(mediaPanelSrc) &&
    /distributeColumns\(items, masonryColumns\)/.test(mediaPanelSrc) &&
    // 图片尺寸经 CSS 变量下发（一种设置、三种排布同一口径）。
    /"--mp-image-size": `\$\{imageSize\}px`/.test(mediaPanelSrc) &&
    /style=\{containerStyle\}/.test(mediaPanelSrc) &&
    /masonryColumnCount\(el\.clientWidth, imageSize, MASONRY_GAP\)/.test(mediaPanelSrc) &&
    /new ResizeObserver\(measure\)/.test(mediaPanelSrc),
);
check(
  "图片尺寸滑条在「视图」**左边**，取值域来自纯函数常量，列表模式下置灰",
  // 工具条顺序：滑条块在 `<ToolbarDropdown labelKey="media.settings.view"` 之前。
  /className="mp-size"[\s\S]*?<ToolbarDropdown\s+labelKey="media\.settings\.view"/.test(mediaPanelSrc) &&
    /min=\{MEDIA_IMAGE_SIZE_MIN\}/.test(mediaPanelSrc) &&
    /max=\{MEDIA_IMAGE_SIZE_MAX\}/.test(mediaPanelSrc) &&
    /value=\{imageSize\}/.test(mediaPanelSrc) &&
    /onChange=\{\(e\) => chooseImageSize\(Number\(e\.target\.value\)\)\}/.test(mediaPanelSrc) &&
    // 与视图下拉同一处置：只在「预览图」模式下有效。
    /disabled=\{viewMode !== "thumb"\}/.test(mediaPanelSrc) &&
    /const clamped = clampImageSize\(next\);/.test(mediaPanelSrc),
);
check(
  "面板内的改动只做**本会话**覆盖，且「全部设置」显式改动时放弃覆盖（否则＝改了设置没反应）",
  /let sessionView: MediaViewMode \| null = null;/.test(mediaPanelSrc) &&
    /let sessionImageSize: number \| null = null;/.test(mediaPanelSrc) &&
    /sessionView = next;/.test(mediaPanelSrc) &&
    /sessionImageSize = clamped;/.test(mediaPanelSrc) &&
    /sessionSortKey = next;/.test(mediaPanelSrc) &&
    /sessionSortDir = next;/.test(mediaPanelSrc) &&
    /subscribeSettingChanged\(\(key\) => \{/.test(mediaPanelSrc) &&
    /key === VIEW_STORAGE_KEY/.test(mediaPanelSrc) &&
    /key === IMAGE_SIZE_STORAGE_KEY/.test(mediaPanelSrc) &&
    /key === SORT_KEY_STORAGE_KEY/.test(mediaPanelSrc) &&
    /key === SORT_DIR_STORAGE_KEY/.test(mediaPanelSrc) &&
    (mediaPanelSrc.match(/= null;\n\s+set\w+Override\(null\);/g) ?? []).length === 4,
);
check(
  "排序下拉 =「名称 / 时间 / 大小 / 类型」+ **一条横线** +「正序 / 倒序」（两组都由取值域派生）",
  // 取值域本身的顺序就是界面顺序（注册表候选与之逐项一致，见上面的 `eqList`）。
  eqList([...mediaView.MEDIA_SORT_KEYS], ["name", "time", "size", "type"]) &&
    eqList([...mediaView.SORT_DIRECTIONS], ["asc", "desc"]) &&
    /MEDIA_SORT_KEYS\.map\(/.test(mediaPanelSrc) &&
    /SORT_DIRECTIONS\.map\(/.test(mediaPanelSrc) &&
    // 横线挂在**方向组第一项**之前（`index === 0`），不会跑到最上面或错位。
    /ruleBefore: index === 0/.test(mediaPanelSrc) &&
    /\{option\.ruleBefore && <div className="menu-sep" \/>\}/.test(mediaDropdownSrc),
  `sortKeys=${[...mediaView.MEDIA_SORT_KEYS].join(",")} directions=${[...mediaView.SORT_DIRECTIONS].join(",")}`,
);
check(
  "「视图」下拉只在「预览图」模式下有效（列表模式下置灰并给出原因）",
  /disabled=\{viewMode !== "thumb"\}/.test(mediaPanelSrc) &&
    /disabledHint=\{app\.t\("media\.viewOnlyInThumb"\)\}/.test(mediaPanelSrc) &&
    // 下拉组件本身必须接住 `disabled`（否则"置灰"只是面板一厢情愿）。
    /disabled=\{disabled\}/.test(mediaDropdownSrc) &&
    /import \{ ToolbarDropdown, type DropdownOption \} from "\.\/mediaPreviewDropdown";/.test(
      mediaPanelSrc,
    ),
);
const contextMenuForDropdownSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/menu/ContextMenu.tsx"),
  "utf8",
);
check(
  "两个下拉复用 portal 的 `ContextMenu`，且「点外部关闭」**同时排除按钮与弹出层**",
  // 弹出层由 `ContextMenu` portal 到 `document.body`：它的 DOM **不在按钮里**，
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
  // 平铺：固定列宽 = 图片尺寸；自适应：见下面那条专测（行内按宽高比配平）。
  /\.mp-grid\.mp-view-tile\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, var\(--mp-image-size/.test(
    stylesSource,
  ) &&
    /\.mp-view-tile \.mp-thumb img[\s\S]{0,120}?object-fit:\s*cover/.test(stylesSource) &&
    // 瀑布流：列宽 = 同一个变量（**不再 `flex: 1 1 0` 等分**，那会让列宽随面板漂移）。
    /\.mp-masonry\s*\{[^}]*display:\s*flex/.test(stylesSource) &&
    /\.mp-masonry-col\s*\{[^}]*flex:\s*0 0 var\(--mp-image-size/.test(stylesSource) &&
    !/\.mp-masonry-col\s*\{[^}]*flex:\s*1 1 0/.test(stylesSource) &&
    /\.mp-masonry \.mp-thumb img[\s\S]{0,160}?height:\s*auto/.test(stylesSource) &&
    // 行高不等的瀑布流必须关掉跳过渲染，否则滚动高度随滚动变化。
    /\.mp-masonry \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource) &&
    /\.mp-size-range\s*\{/.test(stylesSource) &&
    /\.mp-dd\s*\{/.test(stylesSource),
);
check(
  "自适应 = **逐行两端对齐**：断行用基准宽度、行内按宽高比分配剩余空间（`flex-grow`/`flex-basis` 同为宽高比）",
  /\.mp-grid\.mp-view-adaptive\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/.test(stylesSource) &&
    /\.mp-grid\.mp-view-adaptive\s*\{[^}]*--mp-row-max-factor:\s*2/.test(stylesSource) &&
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
    // 稀疏行不把单张图放大到上千像素：到行高上限即停手。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*max-width:\s*calc\([\s\S]{0,160}?--mp-row-max-factor/.test(
      stylesSource,
    ) &&
    // 长文件名不得顶宽单元格（否则"按宽高比配平"失效）。
    /\.mp-view-adaptive \.mp-name\s*\{[^}]*contain:\s*inline-size/.test(stylesSource) &&
    // 行高由宽高比推出 → 跳过渲染的 140px 提示与真实高度无关，必须关掉。
    /\.mp-view-adaptive \.mp-cell\s*\{[^}]*content-visibility:\s*visible/.test(stylesSource),
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
    /ratioCache\.set\(file\.id, next\);/.test(mediaCellSrc) &&
    /export const ratioCache = new Map<string, number>\(\);/.test(mediaCellSrc) &&
    /file\.media_type === "audio"\s*\?\s*AUDIO_CARD_RATIO/.test(mediaCellSrc) &&
    // 面板必须真的用它渲染条目（不是留着两条渲染路径）。
    /import \{ ThumbCell \} from "\.\/mediaPreviewCell";/.test(mediaPanelSrc) &&
    /<ThumbCell/.test(mediaPanelSrc),
);
check(
  "三种视图都**居中对齐**（图片宽度定死时余量左右均分，不许堆在右边留一条空白）；自适应被行高上限截住的行同理",
  /\.mp-grid\.mp-view-tile\s*\{[^}]*justify-content:\s*center/.test(stylesSource) &&
    /\.mp-grid\.mp-view-adaptive\s*\{[^}]*justify-content:\s*center/.test(stylesSource) &&
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
    /pub\(crate\) fn plugin_panel_catalog/.test(
      readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/plugin.rs"), "utf8"),
    ),
);

// ============================== 汇总 ==============================

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
