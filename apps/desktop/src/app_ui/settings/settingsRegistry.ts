/**
 * 「全部设置」的**分组与检索**纯逻辑（RFC 0010 决策 7 /
 * `docs/spec/settings-standard.md` 第 2、4、6 节）。
 *
 * 单独成文件的原因：界面（`SettingsApp.tsx`）只负责渲染，分组口径与搜索口径是
 * **可被门禁断言**的纯函数——`pnpm check:settings` 直接导入它验证"二级列表覆盖全部
 * 面板、分组与 `category` 一致、搜索只命中注册表内的项"。
 *
 * 本文件不 import React：纯数据 + 纯函数。
 */

import {
  PANEL_CATEGORIES,
  SETTING_CATEGORIES,
  allPanels,
  allSettingDecls,
  panelSettingDecls,
  pluginSettingDecls,
  pluginSettingsSections,
  type PanelCategory,
  type SettingCategory,
  type SettingDecl,
} from "@hamster-pouch/config";

/** 左侧二级列表的一项（面板 / 插件 / 或按分节）。 */
export interface SettingsSubItem {
  /** 稳定的滚动锚点 id。 */
  anchor: string;
  /** i18n 键（内置项）或插件提供的标题键。 */
  titleKey: string;
  /** 该二级项下的设置项数量。 */
  count: number;
}

/** 左侧一级分组（可按 `groupKey` 再分二级）。 */
export interface SettingsSubGroup {
  /** 分组标题的 i18n 键（面板大类按面板 `category` 分组时使用）。 */
  groupKey?: string;
  items: SettingsSubItem[];
}

/** 右侧分节。 */
export interface SettingsSection {
  anchor: string;
  /** 节标题 i18n 键。 */
  titleKey: string;
  /** 该分节为空时的空态文案键（`undefined` = 正常渲染）。 */
  emptyKey?: string;
  decls: readonly SettingDecl[];
}

/** 面板分类 → i18n 键（「全部设置 → 面板」二级列表的分组标题）。 */
export function panelCategoryTitleKey(category: PanelCategory): string {
  return `settings.panelCategory.${category}`;
}

/** 大类 → i18n 键。 */
export function settingCategoryTitleKey(category: SettingCategory): string {
  return `settings.category.${category}`;
}

/** 面板 id → 锚点 id（`panel.<id>`）。 */
export function panelAnchor(panelId: string): string {
  return `panel.${panelId}`;
}

/** 插件 id → 锚点 id（`plugin.<id>`）。 */
export function pluginAnchor(pluginId: string): string {
  return `plugin.${pluginId}`;
}

/**
 * 「面板」大类的二级列表：**全部已注册面板**，按 `category` 分组。
 *
 * 无 `settings` 的面板**仍然列出**（置灰空态）：`docs/spec/panel-standard.md` 第 8.5 节
 * 要求二级列表覆盖全部面板，设置标准第 4.1 节允许"置灰空态"这一口径——两处共用同一
 * 选择，本版本内一致。
 */
export function panelSubGroups(): SettingsSubGroup[] {
  const byCategory = new Map<PanelCategory, SettingsSubItem[]>();
  for (const category of PANEL_CATEGORIES) byCategory.set(category, []);
  for (const panel of allPanels()) {
    const count = (panel.settings ?? []).length;
    const items = byCategory.get(panel.category) ?? byCategory.get("other")!;
    items.push({ anchor: panelAnchor(panel.id), titleKey: panel.titleKey, count });
  }
  return PANEL_CATEGORIES.map((category) => ({
    groupKey: panelCategoryTitleKey(category),
    items: byCategory.get(category) ?? [],
  }));
}

/**
 * 「插件」大类的二级列表：按插件分类分组。
 *
 * 插件分类来自 manifest（缺省 `other`）；本版把"已登记设置分节的插件"与"已注册面板的
 * 插件"合并列出（后者用于展示启用状态与能力授权的入口）。
 */
export function pluginSubGroups(): SettingsSubGroup[] {
  const plugins = new Map<string, number>();
  for (const section of pluginSettingsSections()) {
    plugins.set(section.plugin_id, (plugins.get(section.plugin_id) ?? 0) + section.settings.length);
  }
  for (const panel of allPanels()) {
    if (panel.origin.kind === "plugin" && panel.origin.plugin_id) {
      if (!plugins.has(panel.origin.plugin_id)) plugins.set(panel.origin.plugin_id, 0);
    }
  }
  const items: SettingsSubItem[] = [...plugins.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pluginId, count]) => ({
      anchor: pluginAnchor(pluginId),
      // 插件自己的语言资源提供显示名；宿主 i18n 没有该键时 `t()` 原样返回键名。
      titleKey: `plugin.${pluginId}`,
      count,
    }));
  return [{ items }];
}

/** 某大类的二级分组（界面 / 蓝图 / 语言没有二级列表）。 */
export function subGroupsOf(category: SettingCategory): SettingsSubGroup[] {
  if (category === "panel") return panelSubGroups();
  if (category === "plugin") return pluginSubGroups();
  return [];
}

/**
 * 某大类右侧的分节。
 *
 * - `panel`：**每个面板一个分节**（节标题 = 面板标题），节内是该面板声明的 `settings[]`；
 * - `plugin`：**每个插件一个分节**（含启用状态与能力授权展示位）；
 * - 其余：按 `section_key` 分组（缺省用 `owner` 的分节）。
 */
export function sectionsOf(category: SettingCategory): SettingsSection[] {
  if (category === "panel") {
    return allPanels().map((panel) => ({
      anchor: panelAnchor(panel.id),
      titleKey: panel.titleKey,
      emptyKey: (panel.settings ?? []).length === 0 ? "settings.panel.empty" : undefined,
      decls: panelSettingDecls().filter(
        (d) => d.owner.kind === "panel" && d.owner.id === panel.id,
      ),
    }));
  }
  if (category === "plugin") {
    const sections: SettingsSection[] = pluginSettingsSections().map((section) => ({
      anchor: pluginAnchor(section.plugin_id),
      titleKey: section.title_key,
      decls: pluginSettingDecls().filter(
        (d) => d.owner.kind === "plugin" && d.owner.id === section.plugin_id,
      ),
    }));
    for (const item of pluginSubGroups()[0].items) {
      const pluginId = item.anchor.slice("plugin.".length);
      if (sections.some((s) => s.anchor === pluginAnchor(pluginId))) continue;
      sections.push({
        anchor: pluginAnchor(pluginId),
        titleKey: `plugin.${pluginId}`,
        emptyKey: "settings.plugin.empty",
        decls: [],
      });
    }
    if (sections.length === 0) {
      sections.push({
        anchor: "plugin.empty",
        titleKey: settingCategoryTitleKey("plugin"),
        emptyKey: "settings.plugin.empty",
        decls: [],
      });
    }
    return sections;
  }
  // 界面 / 蓝图 / 语言：按 `section_key` 分节（缺省用该大类的标题）。
  const decls = allSettingDecls().filter((d) => d.category === category);
  const bySection = new Map<string, SettingDecl[]>();
  for (const decl of decls) {
    const key = decl.section_key ?? settingCategoryTitleKey(category);
    const list = bySection.get(key) ?? [];
    list.push(decl);
    bySection.set(key, list);
  }
  return [...bySection.entries()].map(([titleKey, list]) => ({
    anchor: `${category}.${titleKey}`,
    titleKey,
    decls: list,
  }));
}

/** 命中结果（搜索用）。 */
export interface SettingSearchHit {
  category: SettingCategory;
  /** 命中项的落库键。 */
  storageKey: string;
  titleKey: string;
  /** 所属面板/插件的标题键（无则不出示）。 */
  ownerTitleKey?: string;
}

/**
 * 搜索设置项（第 6 节）：匹配 ①`title_key` 的**当前语言文案**；②`keywords`；
 * ③所属面板/插件的标题。
 *
 * **不搜索**设置项的当前值、仓库数据、插件内部数据；**不接受**正则与任意表达式
 * （因此这里只做大小写无关的子串匹配）。
 */
export function searchSettings(
  query: string,
  translate: (key: string) => string,
): SettingSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SettingSearchHit[] = [];
  for (const decl of allSettingDecls()) {
    const ownerTitleKey = ownerTitleKeyOf(decl);
    const haystack = [
      translate(decl.title_key),
      ...(decl.keywords ?? []),
      ownerTitleKey ? translate(ownerTitleKey) : "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) continue;
    hits.push({
      category: decl.category,
      storageKey: storageKeyOf(decl),
      titleKey: decl.title_key,
      ...(ownerTitleKey ? { ownerTitleKey } : {}),
    });
  }
  return hits;
}

/** 设置项的落库键（与 `@hamster-pouch/config` 的 `settingStorageKey` 同源）。 */
export function storageKeyOf(decl: SettingDecl): string {
  switch (decl.owner.kind) {
    case "panel":
      return `panel.${decl.owner.id}.${decl.id}`;
    case "plugin":
      return `plugin.${decl.owner.id}.${decl.id}`;
    default:
      return decl.id;
  }
}

/** 归属标题键（面板 / 插件的显示名；宿主项无归属名）。 */
export function ownerTitleKeyOf(decl: SettingDecl): string | undefined {
  const owner = decl.owner;
  if (owner.kind === "panel") {
    const panelId = owner.id;
    return allPanels().find((p) => p.id === panelId)?.titleKey;
  }
  if (owner.kind === "plugin") return `plugin.${owner.id}`;
  return undefined;
}

/** 全部大类（顺序固定：界面 / 蓝图 / 面板 / 插件 / 语言）。 */
export function allSettingCategories(): readonly SettingCategory[] {
  return SETTING_CATEGORIES;
}

/** 序列化设置值为 `app_settings` 的字符串（布尔用 `true`/`false`）。 */
export function encodeSettingValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** 由 `app_settings` 字符串按 `kind` 还原为设置值。 */
export function decodeSettingValue(decl: SettingDecl, raw: string): unknown {
  if (decl.kind === "switch" || decl.kind === "checkbox") return raw === "true";
  if (decl.kind === "numberInput" || decl.kind === "slider") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  return raw;
}
