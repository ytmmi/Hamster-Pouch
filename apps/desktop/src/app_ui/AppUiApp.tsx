/**
 * 正式 UI（app_ui）根组件 — 顶部功能条 + 可停靠工作区 + 状态栏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import * as api from "./api";
import { AppContext, type AppContextValue } from "./AppContext";
import { MenuBar } from "./MenuBar";
import { DOCK_COMPONENTS, PANEL_DEFS } from "./panelRegistry";
import type { FileItem, StatusType } from "./types";

export function AppUiApp(): JSX.Element {
  const [repoId, setRepoId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: StatusType } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const apiRef = useRef<DockviewApi | null>(null);

  // 加载主题设置（默认白天模式 / 浅色）
  useEffect(() => {
    void (async () => {
      try {
        const saved = await api.settingGet({ key: "ui.theme" });
        if (saved === "dark" || saved === "light") {
          setTheme(saved);
        }
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
  }, []);

  const changeTheme = useCallback((next: "light" | "dark") => {
    setTheme(next);
    void api.settingSet({ key: "ui.theme", value: next }).catch(() => undefined);
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );

  const ctxValue: AppContextValue = useMemo(
    () => ({
      repoId,
      setRepoId,
      sourceId,
      setSourceId,
      selectedFile,
      setSelectedFile,
      refreshKey,
      refresh,
      status,
    }),
    [repoId, sourceId, selectedFile, refreshKey, refresh, status],
  );

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    const api = event.api;
    // 默认布局：左侧功能栏 + 中央媒体预览 + 右侧检查器
    api.addPanel({ id: "repo", component: "repo", title: "仓库" });
    api.addPanel({
      id: "sources",
      component: "sources",
      title: "图像源",
      position: { referencePanel: "repo", direction: "below" },
    });
    api.addPanel({
      id: "albums",
      component: "albums",
      title: "相册",
      position: { referencePanel: "sources", direction: "below" },
    });
    api.addPanel({
      id: "media",
      component: "media",
      title: "媒体预览",
      position: { referencePanel: "repo", direction: "right" },
    });
    api.addPanel({
      id: "viewer",
      component: "viewer",
      title: "查看器",
      position: { referencePanel: "media", direction: "below" },
    });
    api.addPanel({
      id: "metadata",
      component: "metadata",
      title: "元数据",
      position: { referencePanel: "media", direction: "right" },
    });
    api.addPanel({
      id: "tags",
      component: "tags",
      title: "标签/评分",
      position: { referencePanel: "metadata", direction: "below" },
    });
    api.addPanel({
      id: "color",
      component: "color",
      title: "色彩参考",
      position: { referencePanel: "tags", direction: "within" },
    });
    api.addPanel({
      id: "player",
      component: "player",
      title: "媒体播放",
      position: { referencePanel: "tags", direction: "below" },
    });
    api.addPanel({
      id: "tasks",
      component: "tasks",
      title: "任务",
      position: { referencePanel: "player", direction: "within" },
    });
  }, []);

  return (
    <AppContext.Provider value={ctxValue}>
      <div className={`app-root ${theme === "dark" ? "theme-dark" : ""}`}>
        <MenuBar apiRef={apiRef} theme={theme} onThemeChange={changeTheme} />
        <div className="app-workspace">
          <DockviewReact
            components={DOCK_COMPONENTS}
            onReady={onReady}
            disableFloatingGroups={false}
          />
        </div>
        <div className="app-status">
          <span className={`status-text ${statusMsg?.type ?? "info"}`}>
            {statusMsg?.text ?? "就绪"}
          </span>
          <span className="dim">
            仓库: {repoId ?? "—"} | 源: {sourceId ?? "—"} | 文件:{" "}
            {selectedFile?.relative_path ?? "—"} | 面板: {PANEL_DEFS.length}
          </span>
        </div>
      </div>
    </AppContext.Provider>
  );
}
