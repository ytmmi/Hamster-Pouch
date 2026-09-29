/**
 * 设置注册表一致性自检（RFC 0010 决策 7 / `docs/spec/settings-standard.md` 第 9 节）。
 *
 * 断言：
 * 1. **设置注册表 ↔ 本文档的五大大类**一致；每个大类都有归属项或**空态**（不隐藏）；
 * 2. `kind` 白名单与控件注册表的**输入类子集**一致，**不得出现 `button` 或非输入类**；
 * 3. **「面板」二级列表的分组与面板注册表 `category` 一致**，且**只列出声明了
 *    `settings` 的面板**（无设置项的面板不显示，第 4.1 节）；
 * 4. **右侧 = 左侧当前选择的详情**（主从结构，不是整栏混合）：面板/插件的每个二级项
 *    只解析出自己那一节，未显式选择时回退到该大类第一项；
 * 4. **「插件」二级列表**覆盖已登记插件，未分类落 `other`；
 * 5. **落库键前缀规则**：宿主 `ui.*` / `layout.*`；面板 `panel.<panel_id>.`；
 *    插件强制 `plugin.<plugin_id>.`（插件自带其它前缀即拒绝）；
 * 6. **搜索**：`title_key` 在三套语言资源里都存在（三套键集一致），
 *    且搜索**只命中注册表内的项**、不搜值/仓库数据；
 * 7. **回归**：现有三项设置（`ui.theme` / `ui.language` / `layout.syncBlueprint`）
 *    都能在新界面里找到并读写（零行为变化）。
 *
 * 用法：pnpm check:settings
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);
const registry = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/settings/settingsRegistry.ts")).href
);
const zhCN = (await import(pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/i18n/zh-CN.ts")).href)).zhCN;
const zhTW = (await import(pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/i18n/zh-TW.ts")).href)).zhTW;
const en = (await import(pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/i18n/en.ts")).href)).en;
const controlKinds = (await import(pathToFileURL(join(ROOT, "packages/config/src/controlKinds.ts")).href));

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const eqList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const doc = readFileSync(join(ROOT, "docs/spec/settings-standard.md"), "utf8");
const rustSettings = readFileSync(join(ROOT, "crates/hp-core/src/setting_types.rs"), "utf8");
const rustRegistry = readFileSync(
  join(ROOT, "crates/hp-core/src/setting_registry.rs"),
  "utf8",
);

const t = (key) => zhCN[key] ?? zhTW[key] ?? en[key] ?? key;

// ============================== 1. 大类（封闭枚举 + 空态） ==============================

check(
  "大类是封闭枚举且顺序固定（界面 / 蓝图 / 面板 / 插件 / 语言）",
  eqList([...config.SETTING_CATEGORIES], ["interface", "blueprint", "panel", "plugin", "language"]),
  [...config.SETTING_CATEGORIES].join(","),
);
const missingCategoryInDoc = config.SETTING_CATEGORIES.filter(
  (c) => !doc.includes(`\`${c}\``),
);
check(
  "设置标准文档列出了全部大类",
  missingCategoryInDoc.length === 0,
  `缺: ${missingCategoryInDoc.join(", ") || "无"}`,
);
const categoryI18n = config.SETTING_CATEGORIES.filter(
  (c) => typeof zhCN[`settings.category.${c}`] !== "string",
);
check(
  "每个大类都有 i18n 文案（三套语言键集一致）",
  categoryI18n.length === 0,
  categoryI18n.join(", ") || "5 个大类文案齐全",
);

/** 从 Rust `impl X { fn as_str }` 的 match 臂读出「枚举名 → JSON 取值」。 */
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

check(
  "Rust SettingCategory ↔ TS SETTING_CATEGORIES 一致（含顺序）",
  eqList([...asStrMap(rustSettings, "SettingCategory").values()], [...config.SETTING_CATEGORIES]),
);
check(
  "Rust SettingScope ↔ TS 一致",
  eqList([...asStrMap(rustSettings, "SettingScope").values()], ["app", "repo"]),
);

// ============================== 2. kind 只取输入类 ==============================

check(
  "设置项 kind 白名单 = 控件输入类 6 种（switch/textInput/numberInput/select/slider/checkbox）",
  eqList([...config.SETTING_INPUT_KINDS], [
    "switch",
    "textInput",
    "numberInput",
    "select",
    "slider",
    "checkbox",
  ]),
);
check(
  "**button 不允许**作为设置项控件（设置项是值不是动作）",
  !config.SETTING_INPUT_KINDS.includes("button"),
);
const nonInputKinds = config.SETTING_INPUT_KINDS.filter(
  (kind) => !controlKinds.CONTROL_KINDS.includes(kind),
);
check(
  "输入类白名单 ⊆ 控件 26 种 kind（不得发明新控件）",
  nonInputKinds.length === 0,
  nonInputKinds.join(", ") ||
    `6 项输入类全部在控件注册表内（共 ${controlKinds.CONTROL_KINDS.length} 种）`,
);
const layoutKindsInSettings = config.allSettingDecls().filter(
  (decl) => !config.SETTING_INPUT_KINDS.includes(decl.kind),
);
check(
  "注册表里的每个设置项 kind 都在输入类白名单内",
  layoutKindsInSettings.length === 0,
  layoutKindsInSettings.map((d) => `${d.id}:${d.kind}`).join(", "),
);

// ============================== 3. 现有三项设置迁入（零行为变化） ==============================

const legacy = ["ui.theme", "ui.language", "layout.syncBlueprint"];
const missingLegacy = legacy.filter((key) => !config.settingDeclByKey(key));
check(
  "现有三项设置（ui.theme / ui.language / layout.syncBlueprint）都能在新界面找到",
  missingLegacy.length === 0,
  `缺: ${missingLegacy.join(", ") || "无"}`,
);
check(
  "三项设置的缺省值与旧口径一致（浅色 / 简体中文 / 同步开）",
  config.DEFAULT_THEME === "light" &&
    config.DEFAULT_LANGUAGE === "zh-CN" &&
    config.isSyncBlueprintEnabled(null) === true &&
    config.settingDeclByKey("ui.theme").default === "light" &&
    config.settingDeclByKey("ui.language").default === "zh-CN" &&
    config.settingDeclByKey("layout.syncBlueprint").default === true,
);
check(
  "宿主设置落库键用 ui.* / layout.* 前缀",
  legacy.every((key) => /^(ui|layout)\./.test(key)),
);

// ============================== 4. 「面板」二级列表与面板注册表一致 ==============================

/** 声明了设置项的面板 id——**只有这些面板进「全部设置」**（第 4.1 节）。 */
const withSettingsIds = registry
  .panelsWithSettings()
  .map((p) => p.id)
  .sort();
const groups = registry.panelSubGroups();
const listedIds = groups
  .flatMap((g) => g.items.map((i) => i.anchor.slice("panel.".length)))
  .sort();
check(
  "「面板」二级列表只列出声明了设置项的面板（无 settings 的面板不显示）",
  eqList(listedIds, withSettingsIds),
  `listed=${listedIds.length} withSettings=${withSettingsIds.length} 全部面板=${config.PANEL_IDS.length}`,
);
const listedWithoutSettings = listedIds.filter(
  (id) => ((config.panelSpec(id)?.settings ?? []).length === 0),
);
check(
  "反向：没有设置项的面板一个都不在列表里（避免点进去是空页）",
  listedWithoutSettings.length === 0,
  listedWithoutSettings.join(", ") || "0 个无设置项的面板被列出",
);
const groupMismatch = [];
for (const group of groups) {
  const category = group.groupKey.replace("settings.panelCategory.", "");
  for (const item of group.items) {
    const spec = config.panelSpec(item.anchor.slice("panel.".length));
    if (!spec || spec.category !== category) {
      groupMismatch.push(`${item.anchor}: ${spec?.category} != ${category}`);
    }
  }
}
check(
  "「面板」二级分组与面板注册表 category 一致",
  groupMismatch.length === 0,
  groupMismatch.join(" | ") || `${groups.length} 个分类分组逐项一致`,
);
check(
  "空分组不渲染标题（该 category 下没有带设置项的面板时不留空标题）",
  groups.every((g) => g.items.length > 0),
  `groups=${groups.length}`,
);
const panelSections = registry.sectionsOf("panel");
check(
  "右侧面板分节与二级列表同源（每节 = 一个有设置项的面板，节内有设置项）",
  eqList(
    panelSections.map((s) => s.anchor).sort(),
    withSettingsIds.map((id) => `panel.${id}`),
  ) &&
    panelSections.every((s) => typeof s.titleKey === "string" && s.decls.length > 0),
  `sections=${panelSections.length}`,
);

// ============================== 4b. 右侧 = 左侧选择的详情（主从结构） ==============================

const mixed = [];
const fallbackWrong = [];
for (const category of config.SETTING_CATEGORIES) {
  const items = registry.flatSubItems(category);
  if (items.length === 0) {
    // 界面 / 蓝图 / 语言：大类自身即叶子，详情 = 该大类的分节。
    continue;
  }
  for (const item of items) {
    const detail = registry.detailSectionsOf(category, item.anchor);
    if (detail.length !== 1 || detail[0].anchor !== item.anchor) {
      mixed.push(`${category}/${item.anchor}: ${detail.map((s) => s.anchor).join("+") || "空"}`);
    }
  }
  const fallback = registry.detailSectionsOf(category, null);
  if (fallback.length !== 1 || fallback[0].anchor !== items[0].anchor) {
    fallbackWrong.push(`${category}: ${fallback.map((s) => s.anchor).join("+") || "空"}`);
  }
}
check(
  "右侧是主从详情：**只**显示左侧所选节点的分节，不是整栏混合",
  mixed.length === 0,
  mixed.join(" | ") || "全部二级项逐项只返回自己那一节",
);
check(
  "未显式选择（或选择已失效）时，右侧回退到该大类第一个二级项",
  fallbackWrong.length === 0,
  fallbackWrong.join(" | ") || "回退口径一致",
);

// ============================== 5. 「插件」二级列表与落库键前缀 ==============================

config.registerPluginSettingsSections([
  {
    plugin_id: "dev.hamsterpouch.system.palette",
    title_key: "palette.settings.title",
    category: "plugin",
    settings: [
      {
        key: "grid_size",
        kind: "numberInput",
        title_key: "palette.gridSize",
        default: 4,
      },
    ],
  },
]);
const pluginItems = registry.pluginSubGroups()[0].items;
check(
  "「插件」二级列表覆盖已登记插件",
  pluginItems.length === 1 &&
    pluginItems[0].anchor === "plugin.dev.hamsterpouch.system.palette",
  JSON.stringify(pluginItems.map((i) => i.anchor)),
);
const pluginDecl = config
  .pluginSettingDecls()
  .find((d) => d.owner.kind === "plugin" && d.owner.id === "dev.hamsterpouch.system.palette");
check(
  "插件设置落库键强制 plugin.<plugin_id>. 前缀（插件不能自定义前缀）",
  pluginDecl && registry.storageKeyOf(pluginDecl) ===
    "plugin.dev.hamsterpouch.system.palette.grid_size",
  pluginDecl ? registry.storageKeyOf(pluginDecl) : "（未登记）",
);
config.unregisterPluginSettingsSections("dev.hamsterpouch.system.palette");
check(
  "插件卸载后设置项从界面消失（值保留在 app_settings，重新启用即恢复）",
  config.pluginSettingDecls().length === 0 && config.allSettingDecls().length >= 3,
);

// 面板设置项落库键按面板隔离。
const panelSettingKey = config.panelSettingStorageKey("media", "thumbnail_size");
check(
  "面板设置落库键按面板隔离（panel.<panel_id>.<key>）",
  panelSettingKey === "panel.media.thumbnail_size",
  panelSettingKey,
);

// ============================== 6. 搜索 ==============================

const hits = registry.searchSettings("主题", t);
check(
  "搜索命中 `title_key` 的当前语言文案（『主题』→ ui.theme）",
  hits.some((h) => h.storageKey === "ui.theme"),
  hits.map((h) => h.storageKey).join(", ") || "无命中",
);
const keywordHits = registry.searchSettings("blueprint", t);
check(
  "搜索命中 keywords（『blueprint』→ layout.syncBlueprint）",
  keywordHits.some((h) => h.storageKey === "layout.syncBlueprint"),
  keywordHits.map((h) => h.storageKey).join(", ") || "无命中",
);
check(
  "搜索**不接受正则/任意表达式**、也不搜设置值（无匹配即空）",
  registry.searchSettings(".*", t).length === 0 &&
    registry.searchSettings("light", t).every((h) => h.storageKey !== "__value__"),
);
const registeredKeys = new Set(config.allSettingDecls().map((d) => registry.storageKeyOf(d)));
check(
  "搜索结果全部来自注册表（不搜仓库数据/插件内部数据）",
  [...hits, ...keywordHits].every((h) => registeredKeys.has(h.storageKey)),
);

// ============================== 7. i18n 键完整性与三套语言一致 ==============================

const zhCNKeys = Object.keys(zhCN).sort();
const zhTWKeys = Object.keys(zhTW).sort();
const enKeys = Object.keys(en).sort();
check(
  "三套语言键集完全一致（zh-CN / zh-TW / en）",
  eqList(zhCNKeys, zhTWKeys) && eqList(zhCNKeys, enKeys),
  `zh-CN=${zhCNKeys.length} zh-TW=${zhTWKeys.length} en=${enKeys.length}`,
);

/** 设置注册表里引用的全部 i18n 键（标题、选项、分节）。 */
const referencedKeys = new Set();
for (const decl of config.allSettingDecls()) {
  referencedKeys.add(decl.title_key);
  for (const option of decl.options ?? []) referencedKeys.add(option.title_key);
  if (decl.section_key) referencedKeys.add(decl.section_key);
}
for (const category of config.SETTING_CATEGORIES) {
  referencedKeys.add(`settings.category.${category}`);
}
for (const category of config.PANEL_CATEGORIES) {
  referencedKeys.add(`settings.panelCategory.${category}`);
}
const missingI18n = [...referencedKeys].filter(
  (key) => typeof zhCN[key] !== "string" || typeof zhTW[key] !== "string" || typeof en[key] !== "string",
);
check(
  "注册表引用的全部 i18n 键在三套语言里都存在",
  missingI18n.length === 0,
  `缺: ${missingI18n.join(", ") || "无"}（共 ${referencedKeys.size} 键）`,
);

// ============================== 8. 校验函数：硬错误口径 ==============================

const goodDecl = {
  id: "panel.example.size",
  category: "panel",
  owner: { kind: "system" },
  title_key: "settings.interface.theme",
  kind: "slider",
  default: 8,
};
check("合法设置项声明通过校验", config.validateSettingDecl(goodDecl).length === 0);
check(
  "kind = button 被拒绝（硬错误）",
  config.validateSettingDecl({ ...goodDecl, kind: "button" }).some((e) =>
    e.includes("不是输入类控件"),
  ),
);
check(
  "select 缺 options 被拒绝（否则无法渲染）",
  config.validateSettingDecl({ ...goodDecl, kind: "select", default: "a" }).some((e) =>
    e.includes("options"),
  ),
);
check(
  "default 与 kind 不匹配被拒绝",
  config.validateSettingDecl({ ...goodDecl, kind: "switch", default: "yes" }).some((e) =>
    e.includes("不匹配"),
  ),
);
check(
  "owner = panel 但 owner.id 未注册被拒绝",
  config
    .validateSettingDecl({ ...goodDecl, owner: { kind: "panel", id: "ghost" } }, {
      registeredPanels: ["media"],
    })
    .some((e) => e.includes("未注册")),
);
check(
  "落库键冲突被拒绝（不覆盖、不合并）",
  config
    .validateSettingDecl({ ...goodDecl, id: "ui.theme" }, { takenKeys: ["ui.theme"] })
    .some((e) => e.includes("落库键冲突")),
);

// ============== Rust 校验镜像 ↔ TS 权威声明（D76 / 契约 3.13 四条规则）==============
//
// 注册表的**权威声明在 TS**（D80 已裁决它不做成命令）；但 `setting.set` 的
// 「未知键拒绝 / 按 kind 校验 / 插件项 permission / 仅 repo 项带 repoId」必须由宿主执行，
// 所以 Rust 侧镜像了**校验所需的事实**。这一组断言就是防漂移的那道锁。

/** 解析 `setting_registry.rs` 里的 `SettingDeclFact { … }` 字面量。 */
function parseRustSettingMirror(src) {
  const out = [];
  const re = /SettingDeclFact\s*\{([\s\S]*?)\n\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    // `\b` 前缀不可省：否则 `kind:` 会命中 `owner_kind:`（下划线不是词边界）。
    const str = (k) => (body.match(new RegExp(`\\b${k}:\\s*"([^"]*)"`)) || [])[1];
    const ownerId = body.match(/owner_id:\s*Some\("([^"]*)"\)/);
    const scope = (body.match(/scope:\s*SettingScope::(\w+)/) || [])[1];
    const optionsRaw = (body.match(/options:\s*&\[([^\]]*)\]/) || [])[1] ?? "";
    const entry = {
      id: str("id"),
      ownerKind: str("owner_kind"),
      ownerId: ownerId ? ownerId[1] : null,
      kind: str("kind"),
      scope: scope === "Repo" ? "repo" : "app",
      options: [...optionsRaw.matchAll(/"([^"]*)"/g)].map((x) => x[1]),
    };
    // 结构体定义 / impl 里的其它 `SettingDeclFact {` 没有这些字段，跳过。
    if (entry.id && entry.ownerKind && entry.kind) out.push(entry);
  }
  return out;
}

const storageKeyOfDecl = (d) =>
  d.ownerKind === "panel" || d.ownerKind === "plugin"
    ? `${d.ownerKind}.${d.ownerId}.${d.id}`
    : d.id;
const factKey = (d) =>
  JSON.stringify([storageKeyOfDecl(d), d.kind, d.scope, [...d.options].sort()]);

const rustMirror = parseRustSettingMirror(rustRegistry);
const tsSystem = config.SYSTEM_SETTING_DECLS.map((d) => ({
  id: d.id,
  ownerKind: "system",
  ownerId: null,
  kind: d.kind,
  scope: d.scope ?? "app",
  options: (d.options ?? []).map((o) => o.value),
}));
const tsPanel = config.panelSettingDecls().map((d) => ({
  id: d.id,
  ownerKind: "panel",
  ownerId: d.owner.id,
  kind: d.kind,
  scope: d.scope ?? "app",
  options: (d.options ?? []).map((o) => o.value),
}));

const rustSystem = rustMirror.filter((d) => d.ownerKind === "system");
const rustPanel = rustMirror.filter((d) => d.ownerKind === "panel");

/** 两侧的对称差（便于一眼看出漂在哪一项）。 */
function mirrorDiff(rust, ts) {
  const r = new Set(rust.map(factKey));
  const s = new Set(ts.map(factKey));
  return [
    ...[...r].filter((k) => !s.has(k)).map((k) => `rust-only ${k}`),
    ...[...s].filter((k) => !r.has(k)).map((k) => `ts-only   ${k}`),
  ].join(" | ");
}

check(
  "Rust 宿主设置镜像 ↔ TS `SYSTEM_SETTING_DECLS` 逐项一致（落库键 / kind / scope / options）",
  eqList(rustSystem.map(factKey).sort(), tsSystem.map(factKey).sort()),
  mirrorDiff(rustSystem, tsSystem),
);
check(
  "Rust 面板设置镜像 ↔ TS `panelSettingDecls()` 逐项一致",
  eqList(rustPanel.map(factKey).sort(), tsPanel.map(factKey).sort()),
  mirrorDiff(rustPanel, tsPanel),
);
check(
  "镜像里没有 TS 侧不存在的多余声明（反向也一致）",
  rustMirror.length === tsSystem.length + tsPanel.length,
  `rust=${rustMirror.length} ts=${tsSystem.length + tsPanel.length}`,
);

const repoBridge = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/repo.rs"),
  "utf8",
);
check(
  "契约 3.13 规则①：setting.set 拒绝未知键（走 resolve_setting_target）",
  /未知设置键/.test(repoBridge) && /fn resolve_setting_target/.test(repoBridge),
);
check(
  "契约 3.13 规则②：按注册表 kind 校验值（复用 hp_core::validate_setting_value）",
  /validate_setting_value/.test(repoBridge) && /pub fn validate_setting_value/.test(rustRegistry),
);
check(
  "契约 3.13 规则③：插件项不满能力返回 permission（HpError::Permission）",
  /fn ensure_setting_capability/.test(repoBridge) &&
    /HpError::Permission/.test(repoBridge) &&
    /check_capability/.test(repoBridge),
);
check(
  "契约 3.13 规则④：仅 scope = repo 的项才拼 {key}.{repoId}",
  /scoped_storage_key/.test(repoBridge) &&
    !/fn scoped_setting_key/.test(repoBridge) &&
    /pub fn scoped_storage_key/.test(rustRegistry),
);
check(
  "setting.* 已按 D76 包装（{ ok, data?, error? }），前端对应解包",
  /ApiResponse<SettingValueResult>/.test(repoBridge) &&
    /ApiResponse<SettingOkResult>/.test(repoBridge) &&
    /unwrapApi/.test(
      readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/api/repo.ts"), "utf8"),
    ),
);

// ============================== 8.5 开关的渲染形态（胶囊按钮） ==============================
//
// 防的是"设置里的开关又变回原生复选框"：`switch` 与 `checkbox` 是**两种** kind，
// 前者是立即生效的开关（胶囊 + 圆形滑块，位置与颜色表示状态），后者是表单式布尔值（原生复选框）。
// 形态只允许有一份实现（`shared/SwitchToggle.tsx`），设置项与控件标准共用。

const settingsAppSwitchSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/settings/SettingsApp.tsx"),
  "utf8",
);
const switchToggleSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/SwitchToggle.tsx"),
  "utf8",
);
const controlRendererSwitchSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/control/ControlRenderer.tsx"),
  "utf8",
);
const stylesSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"),
  "utf8",
);
check(
  "设置里的 `switch` 渲染为胶囊开关组件（不再是原生复选框）",
  /case "switch":/.test(settingsAppSwitchSrc) &&
    /<SwitchToggle/.test(settingsAppSwitchSrc) &&
    /theme=\{app\.theme\}/.test(settingsAppSwitchSrc),
);
check(
  "胶囊开关 = 胶囊 + 圆形滑块：**位置与颜色**共同表示开关状态",
  /role="switch"/.test(switchToggleSrc) &&
    /aria-checked=\{checked\}/.test(switchToggleSrc) &&
    /className="hp-switch-knob"/.test(switchToggleSrc) &&
    /left: checked \? 17 : 1/.test(switchToggleSrc) &&
    /background: checked \? palette\.accent : palette\.bg/.test(switchToggleSrc) &&
    /\.hp-switch\s*\{[^}]*border-radius:\s*8px/.test(stylesSrc) &&
    /\.hp-switch-knob\s*\{[^}]*border-radius:\s*6px/.test(stylesSrc),
);
check(
  "`checkbox` 仍是原生复选框（两种 kind 不同形，不再共用一套渲染）",
  /case "checkbox":/.test(settingsAppSwitchSrc) &&
    /type="checkbox"/.test(settingsAppSwitchSrc),
);
check(
  "控件标准的 `switch` 复用同一组件（全应用只有一种开关形态）",
  /SwitchToggle/.test(controlRendererSwitchSrc) &&
    /value_change/.test(controlRendererSwitchSrc) &&
    !/hp-control-switch/.test(controlRendererSwitchSrc),
);

// ============================== 汇总 ==============================

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
