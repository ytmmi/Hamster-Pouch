/**
 * app_ui 全局状态上下文 — 仓库 / 选中源 / 选中文件 / 刷新 / 状态栏。
 */

import { createContext, useContext } from "react";

import type { Language, Translate } from "./i18n";
import type { FileItem, StatusType } from "./types";

export interface AppContextValue {
  repoId: string | null;
  setRepoId: (id: string | null) => void;
  sourceId: string | null;
  setSourceId: (id: string | null) => void;
  selectedFile: FileItem | null;
  setSelectedFile: (f: FileItem | null) => void;
  refreshKey: number;
  refresh: () => void;
  status: (message: string, type?: StatusType) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translate;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp 必须在 AppContext.Provider 内使用");
  }
  return ctx;
}
