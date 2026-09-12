/**
 * i18n 入口 — 语言类型、字典表、翻译函数。
 *
 * 默认语言：简体中文（zh-CN）。当前支持 zh-CN / zh-TW / en。
 */

import { en } from "./en";
import { zhCN, type DictZhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

export type Language = "zh-CN" | "zh-TW" | "en";

export type TranslationKey = keyof DictZhCN;

export type Translate = (key: TranslationKey) => string;

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
};

/** 可选语言列表（label 用 key，便于随语言切换显示）。 */
export const LANGUAGES: { id: Language; labelKey: TranslationKey }[] = [
  { id: "zh-CN", labelKey: "menubar.language.zhCN" },
  { id: "zh-TW", labelKey: "menubar.language.zhTW" },
  { id: "en", labelKey: "menubar.language.en" },
];

export const DEFAULT_LANGUAGE: Language = "zh-CN";

/** 判断字符串是否为受支持语言。 */
export function isLanguage(value: string | null | undefined): value is Language {
  return value === "zh-CN" || value === "zh-TW" || value === "en";
}

/** 翻译：找不到时回退到简体中文，再回退到 key 本身。 */
export function translate(language: Language, key: TranslationKey): string {
  const dict = DICTIONARIES[language] ?? DICTIONARIES[DEFAULT_LANGUAGE];
  return dict[key] ?? DICTIONARIES[DEFAULT_LANGUAGE][key] ?? key;
}

/** 生成指定语言的翻译函数。 */
export function makeTranslator(language: Language): Translate {
  return (key) => translate(language, key);
}
