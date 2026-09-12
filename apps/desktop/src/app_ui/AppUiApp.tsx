/**
 * 正式 UI（app_ui）根组件 — 顶部功能条 + 可停靠工作区 + 状态栏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import * as api from "./api";
import { AppContext, type AppContextValue } from "./AppContext";
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  makeTranslator,
  type Language,
} from "./i18n";
import { MenuBar } from "./MenuBar";
import { DOCK_COMPONENTS, PANEL_DEFS, panelTitle } from "./panelRegistry";
import type { FileItem, StatusType } from "./types";

export function AppUiApp(): JSX.Element {
  const [repoId, setRepoId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: StatusType } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);
  const apiRef = useRef<DockviewApi | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const t = useMemo(() => makeTranslator(language), [language]);

  // 加载主题与语言设置（默认：白天模式 + 简体中文）
  useEffect(() => {
    void (async () => {
      try {
        const savedTheme = await api.settingGet({ key: "ui.theme" });
        if (savedTheme === "dark" || savedTheme === "light") {
          setTheme(savedTheme);
        }
        const savedLang = await api.settingGet({ key: "ui.language" });
        if (isLanguage(savedLang)) {
          setLanguageState(savedLang);
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

  const changeLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void api.settingSet({ key: "ui.language", value: next }).catch(() => undefined);
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );

  // 双击预览：已存在的目标面板 → 激活（切换 tab）；不存在 → 创建（可按需浮动）
  const focusPanel = useCallback(
    (id: string, floating = false) => {
      const dv = apiRef.current;
      if (!dv) {
        return;
      }
      const existing = dv.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }
      dv.addPanel({
        id,
        component: id,
        title: panelTitle(id, t),
        ...(floating
          ? { floating: { width: 880, height: 640, x: 140, y: 100 } }
          : {}),
      });
    },
    [t],
  );

  const detachPanel = useCallback(
    (id: string) => {
      const title = panelTitle(id, t);
      try {
        new WebviewWindow(`panel-${id}-${Date.now()}`, {
          url: `index.html?panel=${id}&lang=${language}`,
          title: `${t("app.name")} · ${title}`,
          width: 900,
          height: 620,
        });
        apiRef.current?.getPanel(id)?.api.close();
        status(`${title} → ${t("menubar.detach")}`, "ok");
      } catch (e) {
        status(`${t("menubar.detach")}失败: ${String(e)}`, "error");
      }
    },
    [status, t, language],
  );

  // 监听对话框窗口的仓库变更（创建/切换）
  useEffect(() => {
    const un = listen<{ repoId: string }>("repo.changed", (e) => {
      setRepoId(e.payload.repoId);
      refresh();
      status(`${t("repo.opened")}: ${e.payload.repoId.slice(0, 8)}`, "ok");
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [refresh, status, t]);

  // 监听独立窗口的「收回主窗口」请求
  useEffect(() => {
    const un = listen<{ id: string }>("panel.restore", (e) => {
      const id = e.payload.id;
      const apiInstance = apiRef.current;
      if (apiInstance && !apiInstance.getPanel(id)) {
        apiInstance.addPanel({ id, component: id, title: panelTitle(id, t) });
        status(`${panelTitle(id, t)} ← ${t("single.restore")}`, "ok");
      }
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [status, t]);

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
      focusPanel,
      language,
      setLanguage: changeLanguage,
      t,
    }),
    [
      repoId,
      sourceId,
      selectedFile,
      refreshKey,
      refresh,
      status,
      focusPanel,
      language,
      changeLanguage,
      t,
    ],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const dv = event.api;
      // 默认布局：左侧功能栏 + 中央媒体预览 + 右侧检查器
      dv.addPanel({ id: "repo", component: "repo", title: panelTitle("repo", t) });
      dv.addPanel({
        id: "sources",
        component: "sources",
        title: panelTitle("sources", t),
        position: { referencePanel: "repo", direction: "below" },
      });
      dv.addPanel({
        id: "albums",
        component: "albums",
        title: panelTitle("albums", t),
        position: { referencePanel: "sources", direction: "below" },
      });
      dv.addPanel({
        id: "media",
        component: "media",
        title: panelTitle("media", t),
        position: { referencePanel: "repo", direction: "right" },
      });
      dv.addPanel({
        id: "viewer",
        component: "viewer",
        title: panelTitle("viewer", t),
        position: { referencePanel: "media", direction: "below" },
      });
      dv.addPanel({
        id: "metadata",
        component: "metadata",
        title: panelTitle("metadata", t),
        position: { referencePanel: "media", direction: "right" },
      });
      dv.addPanel({
        id: "tags",
        component: "tags",
        title: panelTitle("tags", t),
        position: { referencePanel: "metadata", direction: "below" },
      });
      dv.addPanel({
        id: "color",
        component: "color",
        title: panelTitle("color", t),
        position: { referencePanel: "tags", direction: "within" },
      });
      dv.addPanel({
        id: "player",
        component: "player",
        title: panelTitle("player", t),
        position: { referencePanel: "tags", direction: "below" },
      });
      dv.addPanel({
        id: "tasks",
        component: "tasks",
        title: panelTitle("tasks", t),
        position: { referencePanel: "player", direction: "within" },
      });

      // 拖出工作区 → 独立窗口（左键按住标签页拖拽，指针离开工作区即脱离）
      dv.onWillDragPanel((dragEvent) => {
        const panelId = dragEvent.panel.id;
        const onUp = (ev: PointerEvent) => {
          document.removeEventListener("pointerup", onUp, true);
          const rect = workspaceRef.current?.getBoundingClientRect();
          if (!rect) {
            return;
          }
          const outside =
            ev.clientX < rect.left ||
            ev.clientX > rect.right ||
            ev.clientY < rect.top ||
            ev.clientY > rect.bottom;
          if (outside) {
            detachPanel(panelId);
          }
        };
        document.addEventListener("pointerup", onUp, true);
      });
    },
    [detachPanel, t],
  );

  return (
    <AppContext.Provider value={ctxValue}>
      <div className={`app-root ${theme === "dark" ? "theme-dark" : ""}`}>
        <MenuBar
          apiRef={apiRef}
          theme={theme}
          onThemeChange={changeTheme}
          language={language}
          onLanguageChange={changeLanguage}
        />
        <div className="app-workspace" ref={workspaceRef}>
          <DockviewReact
            components={DOCK_COMPONENTS}
            onReady={onReady}
            disableFloatingGroups={false}
            dndStrategy="pointer"
            theme={theme === "dark" ? themeDark : themeLight}
            popoutUrl="/popout.html"
            getTabContextMenuItems={(params) => [
              {
                label: t("tabmenu.close"),
                action: () => params.panel.api.close(),
              },
              {
                label: t("tabmenu.float"),
                action: () => params.api.addFloatingGroup(params.panel),
              },
              {
                label: t("tabmenu.detach"),
                action: () => detachPanel(params.panel.id),
              },
            ]}
          />
        </div>
        <div className="app-status">
          <span className={`status-text ${statusMsg?.type ?? "info"}`}>
            {statusMsg?.text ?? t("status.ready")}
          </span>
          <span className="dim">
            {t("status.repo")}: {repoId ?? "—"} | {t("status.source")}: {sourceId ?? "—"} |{" "}
            {t("status.file")}: {selectedFile?.relative_path ?? "—"} | {t("status.panels")}:{" "}
            {PANEL_DEFS.length}
          </span>
        </div>
      </div>
    </AppContext.Provider>
  );
}
