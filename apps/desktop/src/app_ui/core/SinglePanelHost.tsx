/**
 * 独立窗口宿主 — 当 URL 带 ?panel=<id> 时只渲染单个面板。
 *
 * 用于「窗口 → 独立」把面板脱离为系统窗口。仓库与语言上下文从 URL 读取。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { emitHp } from "../shared/events";

import { SETTING_KEYS } from "@hamster-pouch/config";

import { AppContext, type AppContextValue } from "./AppContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { TaskOverlay } from "./TaskOverlay";
import { bindTaskActions, startTaskEvents } from "./taskStore";
import { useConfirm } from "./useConfirm";
import { blueprintEngine } from "./blueprintEngine";
import { DEFAULT_LANGUAGE, isLanguage, makeTranslator, type Language } from "../i18n";
import * as api from "../shared/api";
import { panelRender, panelTitle, type PanelRenderCtx } from "./panelRegistry";
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
  // 主题与应用级设置同源（`ui.theme`）：独立窗口也必须与主窗口一致，
  // 否则受控渲染器（控件）会取到与宿主不同的 token 档位。
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    void (async () => {
      try {
        const savedTheme = (await api.settingGet({ key: SETTING_KEYS.theme })).value;
        if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
  }, []);

  const language: Language = isLanguage(lang) ? lang : DEFAULT_LANGUAGE;
  const t = useMemo(() => makeTranslator(language), [language]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );
  // 独立窗口同样需要任务状态与确认弹窗：从脱离出来的媒体源面板发起扫描/卸载时，
  // 浮窗与警告框就在本窗口显示（进度走模块级 store，不入 context）
  useEffect(() => {
    bindTaskActions({ status, refresh, t });
  }, [status, refresh, t]);
  useEffect(() => startTaskEvents(), []);
  const { confirm, askConfirm, resolveConfirm } = useConfirm();

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
      askConfirm,
      confirm,
      resolveConfirm,
      focusPanel: () => undefined,
      dispatch: (input) => blueprintEngine.dispatch(input),
      // 独立单面板窗口没有工作区 dockview：结构骨架不可用（返回 null，面板会退化为空图）。
      getDockview: () => null,
      language,
      setLanguage: () => undefined,
      theme,
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
      askConfirm,
      confirm,
      resolveConfirm,
      language,
      theme,
      t,
    ],
  );

  // 独立单面板窗口**没有** dockview 面板 API：用最小替身让面板正常渲染，
  // 且视为"始终激活"（该窗口只显示这一个面板，没有标签可切换）。
  const content = panelRender(panelId, {
    api: {
      isActive: true,
      isVisible: true,
      onDidActiveChange: () => ({ dispose: () => undefined }),
      onDidVisibilityChange: () => ({ dispose: () => undefined }),
    } as unknown as PanelRenderCtx["api"],
  });

  return (
    <AppContext.Provider value={ctxValue}>
      <div className={`app-root single ${theme === "dark" ? "theme-dark" : ""}`}>
        <div className="single-header">
          <span>{panelTitle(panelId, t)}</span>
          <button
            className="single-restore"
            onClick={() => {
              void emitHp("panel.restore", { id: panelId });
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
        <TaskOverlay />
        <ConfirmDialog />
      </div>
    </AppContext.Provider>
  );
}
