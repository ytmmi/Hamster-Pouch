/**
 * 应用设置键与默认值（与后端全局库 `app_settings` 表 key 对齐）。
 */

/** 界面主题。 */
export type Theme = "light" | "dark";

/** 界面语言。 */
export type Language = "zh-CN" | "zh-TW" | "en";

/** 应用设置键。 */
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
