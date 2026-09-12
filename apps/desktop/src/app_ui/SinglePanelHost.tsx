/**
 * 独立窗口宿主 — 当 URL 带 ?panel=<id> 时只渲染单个面板。
 *
 * 用于「窗口 → 独立」把面板脱离为系统窗口。仓库上下文可从 ?repoId= 读取。
 */

import { useCallback, useMemo, useState } from "react";

import { AppContext, type AppContextValue } from "./AppContext";
import { panelRender, panelTitle } from "./panelRegistry";
import type { FileItem, StatusType } from "./types";

export interface SinglePanelHostProps {
  panelId: string;
  repoId: string | null;
}

export function SinglePanelHost({ panelId, repoId }: SinglePanelHostProps): JSX.Element {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: StatusType } | null>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );

  const ctxValue: AppContextValue = useMemo(
    () => ({
      repoId,
      setRepoId: () => undefined,
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

  const content = panelRender(panelId);

  return (
    <AppContext.Provider value={ctxValue}>
      <div className="app-root single">
        <div className="single-header">{panelTitle(panelId)}</div>
        <div className="single-body">
          {content ?? <span className="placeholder">未知面板: {panelId}</span>}
        </div>
        <div className="app-status">
          <span className={`status-text ${statusMsg?.type ?? "info"}`}>
            {statusMsg?.text ?? "就绪"}
          </span>
          <span className="dim">仓库: {repoId ?? "—"}</span>
        </div>
      </div>
    </AppContext.Provider>
  );
}
