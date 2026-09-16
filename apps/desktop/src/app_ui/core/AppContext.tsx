/**
 * app_ui 全局状态上下文 — 仓库 / 选中源 / 选中文件 / 刷新 / 状态栏 / 蓝图分发。
 */

import { createContext, useContext } from "react";
import type { DockviewApi } from "dockview-react";

import type { Language, Translate } from "../i18n";
import type { FileItem, StatusType } from "../shared/types";
import type { BlueprintDispatchInput } from "./blueprintEngine";

export interface AppContextValue {
  repoId: string | null;
  setRepoId: (id: string | null) => void;
  sourceId: string | null;
  setSourceId: (id: string | null) => void;
  albumId: string | null;
  setAlbumId: (id: string | null) => void;
  dirPath: string | null;
  setDirPath: (p: string | null) => void;
  selectedFile: FileItem | null;
  setSelectedFile: (f: FileItem | null) => void;
  /** 媒体预览多选集合（已选中的文件 id，跨视图/面板保持）。 */
  selectedIds: ReadonlySet<string>;
  setSelectedIds: (ids: Set<string>) => void;
  refreshKey: number;
  refresh: () => void;
  status: (message: string, type?: StatusType) => void;
  /** 聚焦/打开面板：已存在则激活（切换 tab），不存在则按 floating 创建。 */
  focusPanel: (id: string, floating?: boolean) => void;
  /** 当前 dockview 实例（只读用途，如从布局推导蓝图结构骨架）。 */
  getDockview: () => DockviewApi | null;
  /** 蓝图引擎事件分发（单击/双击/选中变化 → 显隐动作）。 */
  dispatch: (input: BlueprintDispatchInput) => void;
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
