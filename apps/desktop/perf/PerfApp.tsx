/**
 * 性能夹具的 **AppContext 替身**。
 *
 * `MediaPreviewPanel` 通过 `useApp()` 取仓库/选中/状态栏/蓝图分发等。夹具提供一个
 * 最小可用的实现：仓库与来源固定、选中集可变、`status` / `dispatch` 只记录不动作。
 * **生产代码不改**——面板拿到的就是一个正常的 context。
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { AppContext, type AppContextValue } from "../src/app_ui/core/AppContext";
import { makeTranslator } from "../src/app_ui/i18n";
import type { FileItem } from "../src/app_ui/shared/types";
import { PERF_REPO_ID } from "./stubs/tauri-core";

export interface PerfContextHandle {
  /** 面板上报过的状态文案（`status()` 调用）。 */
  statuses: string[];
  /** 蓝图分发次数（选中变化）。 */
  dispatches: number;
  /** 当前选中集大小。 */
  selectedCount: number;
}

/** 夹具里"打开的是哪个视图"——面板设置由 `settingOverrides` 控制。 */
export interface PerfAppProps {
  children: ReactNode;
  handle: PerfContextHandle;
}

export function PerfAppProvider({ children, handle }: PerfAppProps): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const t = useMemo(() => makeTranslator("zh-CN"), []);

  const value = useMemo<AppContextValue>(
    () => ({
      repoId: PERF_REPO_ID,
      setRepoId: () => undefined,
      sourceId: null,
      setSourceId: () => undefined,
      albumId: null,
      setAlbumId: () => undefined,
      dirPath: null,
      setDirPath: () => undefined,
      selectedFile,
      setSelectedFile,
      selectedIds,
      setSelectedIds: (ids) => {
        setSelectedIds(ids);
        handle.selectedCount = ids.size;
      },
      refreshKey,
      refresh: () => setRefreshKey((k) => k + 1),
      status: (message) => {
        handle.statuses.push(message);
      },
      askConfirm: async () => false,
      confirm: null,
      resolveConfirm: () => undefined,
      focusPanel: () => undefined,
      getDockview: () => null,
      dispatch: () => {
        handle.dispatches += 1;
      },
      language: "zh-CN",
      setLanguage: () => undefined,
      theme: "dark",
      t,
    }),
    [selectedFile, selectedIds, refreshKey, t, handle],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
