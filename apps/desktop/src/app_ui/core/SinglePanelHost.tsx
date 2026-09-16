/**
 * 独立窗口宿主 — 当 URL 带 ?panel=<id> 时只渲染单个面板。
 *
 * 用于「窗口 → 独立」把面板脱离为系统窗口。仓库与语言上下文从 URL 读取。
 */

import { useCallback, useMemo, useState } from "react";
import { emit } from "@tauri-apps/api/event";

import { AppContext, type AppContextValue } from "./AppContext";
import { blueprintEngine } from "./blueprintEngine";
import { DEFAULT_LANGUAGE, isLanguage, makeTranslator, type Language } from "../i18n";
import { panelRender, panelTitle } from "./panelRegistry";
import type { FileItem, StatusType } from "../shared/types";

export interface SinglePanelHostProps {
  panelId: string;
  repoId: string | null;
  lang?: string | null;
}

export function SinglePanelHost({ panelId, repoId, lang }: SinglePanelHostProps): JSX.Element {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [dirPath, setDirPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: StatusType } | null>(null);

  const language: Language = isLanguage(lang) ? lang : DEFAULT_LANGUAGE;
  const t = useMemo(() => makeTranslator(language), [language]);

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
      albumId,
      setAlbumId,
      dirPath,
      setDirPath,
      selectedFile,
      setSelectedFile,
      selectedIds,
      setSelectedIds,
      refreshKey,
      refresh,
      status,
      focusPanel: () => undefined,
      dispatch: (input) => blueprintEngine.dispatch(input),
      // 独立单面板窗口没有工作区 dockview：结构骨架不可用（返回 null，面板会退化为空图）。
      getDockview: () => null,
      language,
      setLanguage: () => undefined,
      t,
    }),
    [
      repoId,
      sourceId,
      albumId,
      dirPath,
      selectedFile,
      selectedIds,
      refreshKey,
      refresh,
      status,
      language,
      t,
    ],
  );

  const content = panelRender(panelId);

  return (
    <AppContext.Provider value={ctxValue}>
      <div className="app-root single">
        <div className="single-header">
          <span>{panelTitle(panelId, t)}</span>
          <button
            className="single-restore"
            onClick={() => {
              void emit("panel.restore", { id: panelId });
            }}
          >
            {t("single.restore")}
          </button>
        </div>
        <div className="single-body">
          {content ?? (
            <span className="placeholder">
              {t("single.unknownPanel")}: {panelId}
            </span>
          )}
        </div>
        <div className="app-status">
          <span className={`status-text ${statusMsg?.type ?? "info"}`}>
            {statusMsg?.text ?? t("status.ready")}
          </span>
          <span className="dim">
            {t("status.repo")}: {repoId ?? "—"}
          </span>
        </div>
      </div>
    </AppContext.Provider>
  );
}
