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
