/**
 * 应用设置：取值域、设置注册表（RFC 0010 决策 7 / `docs/spec/settings-standard.md`）。
 *
 * 「全部设置」是**应用级系统界面**：不进 `blueprints` 表、不受蓝图引擎管辖、不参与
 * `panel_layouts`；设置值只写全局库 `app_settings`（键值对，**不新增库表**）。
 *
 * 本文件是设置注册表的**单一事实来源**（宿主项 + 面板项 + 插件项），供界面、
 * 搜索与门禁 `pnpm check:settings` 共用。与 Rust `crates/hp-core/src/setting_types.rs`
 * 的取值域逐项对齐。
 */

import { allPanels, panelSettingStorageKey } from "./panels";
import { isBareId, isValidPluginId } from "./namespace";

/** 界面主题。 */
export type Theme = "light" | "dark";

/** 界面语言。 */
export type Language = "zh-CN" | "zh-TW" | "en";

/** 应用设置键（宿主设置；也是 `app_settings.key`）。 */
export const SETTING_KEYS = {
  theme: "ui.theme",
  language: "ui.language",
  /** 保存布局时是否把 dockview 结构自动同步进默认蓝图（D59，默认开）。 */
  syncBlueprint: "layout.syncBlueprint",
} as const;

/** 默认主题：白天浅色。 */
export const DEFAULT_THEME: Theme = "light";

/** 默认语言：简体中文。 */
export const DEFAULT_LANGUAGE: Language = "zh-CN";

export function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark";
}

export function isLanguage(value: string | null | undefined): value is Language {
  return value === "zh-CN" || value === "zh-TW" || value === "en";
}

/** D59：布局→蓝图自动同步开关是否开启（未设置 = 开）。 */
export function isSyncBlueprintEnabled(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === "true";
}

// ============================== 设置注册表 ==============================

/** 设置**大类**（封闭枚举，顺序即界面的固定顺序）。 */
export const SETTING_CATEGORIES = [
  "interface",
  "blueprint",
  "panel",
  "plugin",
  "language",
] as const;
export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

/**
 * 设置项的取值控件类型：**只取控件的输入类 6 种**。
 *
 * 设置项是**值**不是动作，因此 `button` 不允许；布局/展示/集合/反馈类的 `kind`
 * 用作设置项即硬错误（与面板设置同一份白名单）。
 */
export const SETTING_INPUT_KINDS = [
  "switch",
  "textInput",
  "numberInput",
  "select",
  "slider",
  "checkbox",
] as const;
export type SettingInputKind = (typeof SETTING_INPUT_KINDS)[number];

/** 设置值：一律是标量（不接受嵌套对象或任意表达式，同 D32 口径）。 */
export type SettingValue = string | number | boolean;

/** 设置项作用域（缺省 `app`）。 */
export type SettingScope = "app" | "repo";

/** 归属：宿主 / 某面板 / 某插件。 */
export type SettingOwner =
  | { kind: "system" }
  | { kind: "panel"; id: string }
  | { kind: "plugin"; id: string };

/**
 * `select` 的可选项。
 *
 * **规范缺口（如实记录）**：`docs/spec/settings-standard.md` 第 5 节的声明参数列表
 * 没有列 `options`，但 `select` 没有选项就无法渲染。本实现补上该字段并按硬错误校验
 * （见 `validateSettingDecl`），已作为规范缺口上报，未自行改规范。
 */
export interface SettingOption {
  value: string;
  title_key: string;
}

/** 一条设置项声明（纯数据；宿主项 / 面板项 / 插件项**同形**，只有 `owner` 不同）。 */
export interface SettingDecl {
  /** 稳定 id（也是落库键的组成部分）。 */
  id: string;
  category: SettingCategory;
  owner: SettingOwner;
  /** i18n 键（D27）；不得内联文字。 */
  title_key: string;
  kind: SettingInputKind;
  /** 缺省值；不写即「未设置」。 */
  default?: SettingValue;
  /** `select` 的可选项。 */
  options?: readonly SettingOption[];
  scope?: SettingScope;
  requires_capability?: string;
  /** 搜索补充关键词（第 6 节）。 */
  keywords?: readonly string[];
  /** 右侧分节标题的 i18n 键；缺省用 `owner` 的分节。 */
  section_key?: string;
}

/** 落库键（`app_settings.key`）。规则与 Rust `SettingDecl::storage_key` 一致。 */
export function settingStorageKey(decl: SettingDecl): string {
  switch (decl.owner.kind) {
    case "panel":
      return panelSettingStorageKey(decl.owner.id, decl.id);
    case "plugin":
      return `plugin.${decl.owner.id}.${decl.id}`;
    default:
      return decl.id;
  }
}

/**
 * 宿主设置声明（现有三项设置迁入；**零行为变化**）。
 *
 * 与旧口径逐项对齐：`ui.theme` 默认浅色、`ui.language` 默认简体中文、
 * `layout.syncBlueprint` 未设置 = 开。
 */
export const SYSTEM_SETTING_DECLS: readonly SettingDecl[] = [
  {
    id: SETTING_KEYS.theme,
    category: "interface",
    owner: { kind: "system" },
    title_key: "settings.interface.theme",
    kind: "select",
    default: DEFAULT_THEME,
    options: [
      { value: "light", title_key: "settings.interface.theme.light" },
      { value: "dark", title_key: "settings.interface.theme.dark" },
    ],
    keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
    section_key: "settings.section.appearance",
  },
  {
    id: SETTING_KEYS.language,
    category: "language",
    owner: { kind: "system" },
    title_key: "settings.language.interface",
    kind: "select",
    default: DEFAULT_LANGUAGE,
    options: [
      { value: "zh-CN", title_key: "menubar.language.zhCN" },
      { value: "zh-TW", title_key: "menubar.language.zhTW" },
      { value: "en", title_key: "menubar.language.en" },
    ],
    keywords: ["language", "locale", "语言", "語言"],
    section_key: "settings.section.language",
  },
  {
    id: SETTING_KEYS.syncBlueprint,
    category: "blueprint",
    owner: { kind: "system" },
    title_key: "settings.blueprint.syncOnSave",
    kind: "switch",
    default: true,
    keywords: ["blueprint", "layout", "sync", "蓝图", "布局", "同步"],
    section_key: "settings.section.blueprintSync",
  },
];

/**
 * 面板设置声明（由**面板注册表**派生，第 5.3 节）。
 *
 * 面板设置值按面板隔离：落库键 `panel.<panel_id>.<key>`。
 */
export function panelSettingDecls(): readonly SettingDecl[] {
  const out: SettingDecl[] = [];
  for (const panel of allPanels()) {
    for (const setting of panel.settings ?? []) {
      out.push({
        id: setting.key,
        category: "panel",
        owner: { kind: "panel", id: panel.id },
        title_key: setting.title_key,
        kind: setting.kind,
        default: setting.default,
        scope: setting.scope,
        requires_capability: setting.requires_capability,
      });
    }
  }
  return out;
}

// ============================== 插件设置（`settingsSection` 贡献点） ==============================

/** 插件经 `settingsSection` 声明的一组设置项。 */
export interface PluginSettingsSection {
  /** 插件 id（manifest `id`）。 */
  plugin_id: string;
  /** 该分节的 i18n 键。 */
  title_key: string;
  /** 归入哪个大类（**不得新增大类**）。 */
  category: SettingCategory;
  settings: readonly {
    key: string;
    kind: SettingInputKind;
    title_key: string;
    default?: SettingValue;
    options?: readonly SettingOption[];
    scope?: SettingScope;
    requires_capability?: string;
    keywords?: readonly string[];
  }[];
}

let pluginSections: PluginSettingsSection[] = [];

/** 登记插件的设置分节（宿主在插件加载/启用后调用）。 */
export function registerPluginSettingsSections(
  sections: readonly PluginSettingsSection[],
): void {
  if (sections.length === 0) return;
  const next = [...pluginSections];
  for (const section of sections) {
    if (!isValidPluginId(section.plugin_id)) continue;
    if (!SETTING_CATEGORIES.includes(section.category)) continue;
    const at = next.findIndex((s) => s.plugin_id === section.plugin_id);
    if (at >= 0) next[at] = section;
    else next.push(section);
  }
  pluginSections = next;
}

/** 注销某插件的设置分节（卸载/禁用）；**值保留**在 `app_settings` 里（第 7 节）。 */
export function unregisterPluginSettingsSections(pluginId?: string): void {
  pluginSections = pluginId ? pluginSections.filter((s) => s.plugin_id !== pluginId) : [];
}

/** 当前已登记的插件设置分节。 */
export function pluginSettingsSections(): readonly PluginSettingsSection[] {
  return pluginSections;
}

/** 插件设置声明（由已登记的分节展平）。 */
export function pluginSettingDecls(): readonly SettingDecl[] {
  const out: SettingDecl[] = [];
  for (const section of pluginSections) {
    for (const setting of section.settings) {
      out.push({
        id: setting.key,
        category: section.category,
        owner: { kind: "plugin", id: section.plugin_id },
        title_key: setting.title_key,
        kind: setting.kind,
        default: setting.default,
        options: setting.options,
        scope: setting.scope,
        requires_capability: setting.requires_capability,
        keywords: setting.keywords,
        section_key: section.title_key,
      });
    }
  }
  return out;
}

/** 全部设置项（宿主 + 面板 + 插件）。 */
export function allSettingDecls(): readonly SettingDecl[] {
  return [...SYSTEM_SETTING_DECLS, ...panelSettingDecls(), ...pluginSettingDecls()];
}

/** 按落库键取设置声明（未注册返回 `undefined`）。 */
export function settingDeclByKey(key: string): SettingDecl | undefined {
  return allSettingDecls().find((d) => settingStorageKey(d) === key);
}

/** 某大类下的设置项。 */
export function settingDeclsOfCategory(category: SettingCategory): readonly SettingDecl[] {
  return allSettingDecls().filter((d) => d.category === category);
}

// ============================== 校验 ==============================

/** 设置项 id 规则（`^[a-z][a-z0-9._-]{0,63}$`），与 Rust 同口径。 */
export function isValidSettingId(id: string): boolean {
  return isBareId(id);
}

/**
 * 校验一条设置项声明；返回全部**硬错误**（空 = 可注册/可渲染）。
 *
 * 逐条对应 `docs/spec/settings-standard.md` 第 8 节 + 面板标准第 7.1 节。
 */
export function validateSettingDecl(
  decl: SettingDecl,
  ctx: { takenKeys?: readonly string[]; registeredPanels?: readonly string[] } = {},
): string[] {
  const errors: string[] = [];
  const key = settingStorageKey(decl);

  if (!isValidSettingId(decl.id)) {
    errors.push(`设置项 id 不合命名规则（^[a-z][a-z0-9._-]{0,63}$）: ${decl.id}`);
  }
  if (!SETTING_CATEGORIES.includes(decl.category)) {
    errors.push(`设置项 ${decl.id} 的 category 不在五大大类内: ${decl.category}`);
  }
  if (decl.owner.kind !== "system" && !decl.owner.id.trim()) {
    errors.push(`设置项 ${decl.id} 的 owner.id 缺失（${decl.owner.kind} 归属必需）`);
  }
  if (
    decl.owner.kind === "panel" &&
    ctx.registeredPanels &&
    !ctx.registeredPanels.includes(decl.owner.id)
  ) {
    errors.push(`设置项 ${decl.id} 的 owner.id 未注册: ${decl.owner.id}`);
  }
  if (!decl.title_key.trim()) {
    errors.push(`设置项 ${decl.id} 缺少 title_key（D27：不得内联文字）`);
  }
  if (!SETTING_INPUT_KINDS.includes(decl.kind)) {
    errors.push(
      `设置项 ${decl.id} 的 kind 不是输入类控件: ${decl.kind}（允许 ${SETTING_INPUT_KINDS.join("/")}）`,
    );
  }
  if (decl.kind === "select" && (decl.options?.length ?? 0) === 0) {
    errors.push(`设置项 ${decl.id} 是 select 但没有 options（无法渲染）`);
  }
  if (decl.default !== undefined) {
    const matchesKind =
      (decl.kind === "switch" || decl.kind === "checkbox")
        ? typeof decl.default === "boolean"
        : decl.kind === "numberInput" || decl.kind === "slider"
          ? typeof decl.default === "number"
          : typeof decl.default === "string";
    if (!matchesKind) {
      errors.push(`设置项 ${decl.id} 的 default 与 kind（${decl.kind}）不匹配`);
    }
  }
  if (decl.scope !== undefined && decl.scope !== "app" && decl.scope !== "repo") {
    errors.push(`设置项 ${decl.id} 的 scope 非法: ${decl.scope}`);
  }
  if (ctx.takenKeys?.includes(key)) {
    errors.push(`设置项落库键冲突（不覆盖、不合并）: ${key}`);
  }
  return errors;
}
