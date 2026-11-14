/**
 * 面板门禁分节 · 注册表 ↔ 声明参数取值域（原第 1–2 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList, stripComments } from "./harness.mjs";
import {
  ROOT, builtinIds, config, handCopiedPanelDefs, imageViewerSpec, optionValues,
  panelDefsDerived, rendererKeys, settingsAppSrc, stylesSource, viewerSettingsSrc,
} from "./shared.mjs";
export default async function run() {
// ============================== 1. 注册表 ↔ PANEL_IDS ↔ PANEL_DEFS / PANEL_TITLES ==============================

check(
  "注册表声明列表与 PANEL_IDS 一致（含顺序）",
  eqList(builtinIds, [...config.PANEL_IDS]),
  `registry=${builtinIds.join(",")} PANEL_IDS=${[...config.PANEL_IDS].join(",")}`,
);
// `PANEL_DEFS` 自 D184 起由 `BUILTIN_PANEL_SPECS.map(…)` 派生：id / titleKey 不再抄第二份，
// 因此"三方一致（含顺序）"退化成一条**结构性**断言——派生写法还在、且没有退回字面量；
// 标题键一致性由下面那条「注册表 ↔ PANEL_TITLES」承担。
check(
  "PANEL_DEFS 由注册表派生（不再手抄 id / titleKey 字面量）",
  panelDefsDerived && handCopiedPanelDefs.length === 0,
  handCopiedPanelDefs.length === 0
    ? "缺少 BUILTIN_PANEL_SPECS.map(…) 派生写法"
    : `手抄残留: ${handCopiedPanelDefs.length} 条`,
);
check(
  "渲染表 RENDERERS 的内置面板集合与注册表一致（无遗漏 / 无多余）",
  eqList([...rendererKeys].sort(), [...builtinIds].sort()),
  `renderers=${[...rendererKeys].sort().join(",")} registry=${[...builtinIds].sort().join(",")}`,
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
  "内置面板恰好 17 个",
  builtinIds.length === 17,
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
// `has_class` 由 `false` 改为 `true` 的两个面板是 **albums / sources**（D135）：它们确实有
// "条目分类"这一层（相册 = 相册列表的条目、源 = 目录树的条目）。此前写 `false` 的后果不是
// "少了个按钮"，而是类目一接上就被判 `panel-has-no-class`——前端灰显、Rust 对内置面板
// 报硬错误（拒绝保存），用户看到的是"连上了却读不回"。因此这条断言必须跟着**值**走。
check(
  "has_class：内置面板中 sources / albums / media / bookpreview 为 true（面板标准第 5.1 节）",
  eqList(hasClassTrue, ["sources", "albums", "media", "bookpreview"]),
  `has_class=true: ${hasClassTrue.join(",") || "（无）"}`,
);

// 面板事实的 Rust 侧自 D183 起是**生成物**（`crates/hp-core/src/panel_facts_generated.rs`，
// 由 `pnpm gen:panel-facts` 从 `panels.ts` 产出、`check:panel-facts` 逐字节比对）。这条是
// 反向断言：`blueprint_registry.rs` 里不得再出现手抄的面板事实元组——否则"生成物 + 逐字节
// 比对"只管住了生成物那一半，手抄那份照样能与 TS 分叉（D183 之前正是如此：注释声称由
// `check:panels` 断言，实际没有任何门禁读它）。
const blueprintRegistrySrc = stripComments(
  readFileSync(join(ROOT, "crates/hp-core/src/blueprint_registry.rs"), "utf8"),
);
const handCopiedFacts = [
  ...blueprintRegistrySrc.matchAll(
    /\(\s*"(repo|sources|albums|media|bookpreview|viewer|bookreader|imageviewer|metadata|tags|tagtable|color|player|music|tasks|plugins|blueprint)"\s*,\s*(?:true|false)/g,
  ),
].map((m) => m[1]);
check(
  "面板事实只在生成物里（blueprint_registry.rs 不再手抄 has_class / mount 事实）",
  handCopiedFacts.length === 0,
  `手抄残留: ${handCopiedFacts.join(", ") || "无"}`,
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
  carrierProblems.join(" | ") || "17 个面板全部指向 control，且 control 允许 panel_id",
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

}
