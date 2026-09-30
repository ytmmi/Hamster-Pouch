/**
 * 界面偏好设置（主题 / 语言）的装载与写回 —— 「全部设置 → 界面」的宿主项。
 *
 * 只有两个取值加两个写回入口，是菜单条与「全部设置」界面**共用**的同一份状态：
 * 两处各自持有一份会让主题切换在另一处不同步。
 */

import { useCallback, useEffect, useState } from "react";
import { SETTING_KEYS } from "@hamster-pouch/config";

import { DEFAULT_LANGUAGE, isLanguage, type Language } from "../i18n";
import * as api from "../shared/api";

/** 宿主界面偏好：主题 + 语言，以及它们的写回入口。 */
export interface ShellSettings {
  theme: "light" | "dark";
  language: Language;
  changeTheme: (next: "light" | "dark") => void;
  changeLanguage: (next: Language) => void;
}

/** 装载界面偏好设置，并提供持久化写回。 */
export function useShellSettings(): ShellSettings {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);

  // 加载主题与语言设置（默认：白天模式 + 简体中文）
  useEffect(() => {
    void (async () => {
      try {
        const savedTheme = (await api.settingGet({ key: SETTING_KEYS.theme })).value;
        if (savedTheme === "dark" || savedTheme === "light") {
          setTheme(savedTheme);
        }
        const savedLang = (await api.settingGet({ key: SETTING_KEYS.language })).value;
        if (typeof savedLang === "string" && isLanguage(savedLang)) {
          setLanguageState(savedLang);
        }
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
  }, []);

  const changeTheme = useCallback((next: "light" | "dark") => {
    setTheme(next);
    void api.settingSet({ key: SETTING_KEYS.theme, value: next }).catch(() => undefined);
  }, []);

  const changeLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void api.settingSet({ key: SETTING_KEYS.language, value: next }).catch(() => undefined);
  }, []);

  return { theme, language, changeTheme, changeLanguage };
}
