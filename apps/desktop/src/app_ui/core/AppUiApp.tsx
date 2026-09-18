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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PANEL_MIN_SIZE, SETTING_KEYS } from "@hamster-pouch/config";
import { normalizeLayoutJson } from "../shared/panelLayout";
import {
  activeBlueprintId,
  loadActiveBlueprint,
  loadCurrentLayer,
  notifyBlueprintChangedLocally,
  reconcileActiveBlueprint,
  reconcileAfterLayoutApplied,
  subscribeBlueprintHotReload,
  switchLayer,
} from "../shared/blueprintRuntime";
import {
  publishStructure,
  snapshotFromDockview,
} from "../panels/blueprintStructure";

import * as api from "../shared/api";
import { AppContext, type AppContextValue } from "./AppContext";
import { blueprintEngine, type BlueprintDispatchInput } from "./blueprintEngine";
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  makeTranslator,
  type Language,
} from "../i18n";
import { MenuBar } from "../menu/MenuBar";
import { DOCK_COMPONENTS, PANEL_DEFS, panelTitle } from "./panelRegistry";
import type { FileItem, StatusType } from "../shared/types";

export function AppUiApp(): JSX.Element {
  const [repoId, setRepoId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [dirPath, setDirPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: StatusType } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);
  const apiRef = useRef<DockviewApi | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  /** 浮层容器期望可见态（D50）：按浮层节点 key 记录，供浮层宿主消费。 */
  const overlayStateRef = useRef<Map<string, boolean>>(new Map());

  const t = useMemo(() => makeTranslator(language), [language]);

  // 加载主题与语言设置（默认：白天模式 + 简体中文）
  useEffect(() => {
    void (async () => {
      try {
        const savedTheme = await api.settingGet({ key: SETTING_KEYS.theme });
        if (savedTheme === "dark" || savedTheme === "light") {
          setTheme(savedTheme);
        }
        const savedLang = await api.settingGet({ key: SETTING_KEYS.language });
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
    void api.settingSet({ key: SETTING_KEYS.theme, value: next }).catch(() => undefined);
  }, []);

  const changeLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void api.settingSet({ key: SETTING_KEYS.language, value: next }).catch(() => undefined);
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );

  // 语言切换时更新所有面板标签页标题（组件名随语言变化），并按蓝图重新对账布局
  // （默认可见/组收起状态与语言无关，但重渲染后需保持不漂移）。
  useEffect(() => {
    const dv = apiRef.current;
    if (!dv) {
      return;
    }
    for (const panel of dv.panels) {
      panel.setTitle(panelTitle(panel.id, t));
    }
    reconcileActiveBlueprint(dv);
  }, [t, language]);

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
        ...PANEL_MIN_SIZE,
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

  // 蓝图引擎执行器：把求值动作映射到 dockview 与媒体命令（RFC 0007 决策 3）。
  // 记录最近显示的面板，供 hide 判断是否同组（同组标签仅切换激活，不销毁/不收缩）。
  const lastShownRef = useRef<string | null>(null);
  const blueprintExecutor = useMemo(
    () => ({
      showPanel: (panelId: string, floating: boolean) => {
        lastShownRef.current = panelId;
        // 显示控件：面板已存在则激活其标签（同组即切换标签，其余标签保留），不存在则
        // 按 `floating` 创建（蓝图动作默认以标签方式加入；`payload.floating=true` 才浮动）。
        focusPanel(panelId, floating);
      },
      hidePanel: (panelId: string) => {
        // 显式 hide 动作（用户蓝图规则）：与最近显示面板同 dockview 组时跳过
        // （标签激活已切换）；跨组则收缩至最小尺寸（标签条保留，D25/D29）。
        const dv = apiRef.current;
        if (!dv) {
          return;
        }
        const panel = dv.getPanel(panelId);
        if (!panel) {
          return;
        }
        const shown = lastShownRef.current
          ? dv.getPanel(lastShownRef.current)
          : null;
        if (shown && panel.api.group.id === shown.api.group.id) {
          return;
        }
        try {
          panel.api.setSize({
            width: PANEL_MIN_SIZE.minimumWidth,
            height: PANEL_MIN_SIZE.minimumHeight,
          });
        } catch {
          panel.api.close();
        }
      },
      togglePanel: (panelId: string, floating: boolean) => {
        const dv = apiRef.current;
        if (!dv) {
          return;
        }
        if (dv.getPanel(panelId)) {
          dv.getPanel(panelId)!.api.close();
        } else {
          focusPanel(panelId, floating);
        }
      },
      collapsePanels: (panelIds: string[]) => {
        const dv = apiRef.current;
        if (!dv) {
          return;
        }
        for (const id of panelIds) {
          const panel = dv.getPanel(id);
          if (!panel) {
            continue;
          }
          try {
            // 组的隐藏 = 最小化至最小尺寸（正文 6px、标签条保留，D25）；
            // 隐藏方向/相邻组拉伸的 dockview 映射属实现期开放点（RFC 0007）。
            panel.api.setSize({
              width: PANEL_MIN_SIZE.minimumWidth,
              height: PANEL_MIN_SIZE.minimumHeight,
            });
          } catch {
            /* dockview 网格约束下忽略 */
          }
        }
      },
      expandPanels: (panelIds: string[]) => {
        const dv = apiRef.current;
        if (!dv) {
          return;
        }
        for (const id of panelIds) {
          const panel = dv.getPanel(id);
          if (!panel) {
            continue;
          }
          try {
            panel.api.setSize({ width: 480, height: 320 });
          } catch {
            /* 忽略 */
          }
        }
      },
      playFile: (fileId: string) => {
        if (!repoId) {
          return;
        }
        void api
          .mediaPlay({ repoId, fileId })
          .then(() => status(t("player.playingInMpv"), "ok"))
          .catch((e) => status(t("player.playFailed", { err: String(e) }), "error"));
      },
      // 界面跳转（D48/D54）：切到目标层 = 持久化当前层 + 套用该层布局 + 对账蓝图语义。
      navigateLayer: (layerKey: string) => {
        if (!repoId) {
          return;
        }
        void switchLayer(repoId, layerKey, apiRef.current).then((applied) => {
          status(
            applied ? t("layer.switched") : t("layer.switchedNoLayout"),
            "info",
          );
        });
      },
      // 浮层容器显隐（D50）：内容面板已由引擎按浮动方式显示/隐藏；这里只记录**浮层容器**
      // 的期望可见态，供后续的浮层宿主按外观档位（圆角/阴影/标签隐藏）渲染容器本身。
      setOverlayVisible: (overlayKey: string, visible: boolean) => {
        overlayStateRef.current.set(overlayKey, visible);
        void import("../shared/blueprintRuntime")
          .then((m) =>
            m.traceBlueprint(
              `[overlay] 浮层 ${overlayKey} → ${visible ? "显示" : "隐藏"}（容器外观渲染待控件标准落地）`,
            ),
          )
          .catch(() => undefined);
      },
    }),
    [focusPanel, repoId, status, t],
  );

  // 装配引擎：executor 变更时注入。
  useEffect(() => {
    blueprintEngine.setExecutor(blueprintExecutor);
  }, [blueprintExecutor]);

  // 仓库切换：装载生效蓝图（无默认 → 种子内置默认，保证零回归）；装载后把蓝图语义
  // 对账到当前布局（默认可见标签 + 组收起/展开）。
  // 注意：依赖里不含 `t`——蓝图文档与语言无关，刷新不重装，避免热更新被语言变化打断；
  // 语言变化只由下面的标题 effect 触发一次重新对账。
  useEffect(() => {
    if (!repoId) {
      blueprintEngine.setGraph(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // 重新装载"当前生效蓝图"（可能是布局绑定的蓝图，而非仓库默认）。
      await loadActiveBlueprint(repoId, activeBlueprintId());
      if (cancelled) {
        return;
      }
      // 当前层（D54）：按仓库持久化；记录缺失/失效时回退生效蓝图的第一个层。
      await loadCurrentLayer(repoId);
      if (cancelled) {
        return;
      }
      reconcileActiveBlueprint(apiRef.current);
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, refreshKey]);

  // 蓝图热更新：保存/设为默认/删除（本窗口或其它窗口）→ 重载生效蓝图并对账布局。
  useEffect(
    () =>
      subscribeBlueprintHotReload(
        () => repoId,
        () => apiRef.current,
      ),
    [repoId],
  );

  const dispatch = useCallback((input: BlueprintDispatchInput) => {
    blueprintEngine.dispatch(input);
  }, []);

  /** 供蓝图编辑器从当前布局推导结构骨架（只读用途）。 */
  const getDockview = useCallback(() => apiRef.current, []);
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
        status(t("layout.detachFailed", { err: String(e) }), "error");
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
        apiInstance.addPanel({ ...PANEL_MIN_SIZE, id, component: id, title: panelTitle(id, t) });
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
      focusPanel,
      dispatch,
      getDockview,
      language,
      setLanguage: changeLanguage,
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
      focusPanel,
      dispatch,
      getDockview,
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
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "repo",
        component: "repo",
        title: panelTitle("repo", t),
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "sources",
        component: "sources",
        title: panelTitle("sources", t),
        position: { referencePanel: "repo", direction: "below" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "albums",
        component: "albums",
        title: panelTitle("albums", t),
        position: { referencePanel: "sources", direction: "below" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "media",
        component: "media",
        title: panelTitle("media", t),
        // 保持 DOM（即使 tab 未激活），切回媒体预览时滚动位置不丢失
        renderer: "always",
        position: { referencePanel: "repo", direction: "right" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "viewer",
        component: "viewer",
        title: panelTitle("viewer", t),
        position: { referencePanel: "media", direction: "below" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "metadata",
        component: "metadata",
        title: panelTitle("metadata", t),
        position: { referencePanel: "media", direction: "right" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "tags",
        component: "tags",
        title: panelTitle("tags", t),
        position: { referencePanel: "metadata", direction: "below" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "color",
        component: "color",
        title: panelTitle("color", t),
        position: { referencePanel: "tags", direction: "within" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "tagtable",
        component: "tagtable",
        title: panelTitle("tagtable", t),
        position: { referencePanel: "tags", direction: "below" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "player",
        component: "player",
        title: panelTitle("player", t),
        position: { referencePanel: "tagtable", direction: "below" },
      });
      dv.addPanel({
        ...PANEL_MIN_SIZE,
        id: "tasks",
        component: "tasks",
        title: panelTitle("tasks", t),
        position: { referencePanel: "player", direction: "within" },
      });

      // 启动：若设置了默认仓库，自动打开并应用其默认布局（D25 相邻能力，失败忽略）。
      void (async () => {
        try {
          const defRepo = await api.repoGetDefault();
          if (!defRepo) {
            return;
          }
          const opened = await api.repoOpen({ repoId: defRepo });
          setRepoId(opened.id);
          // 分层（D53/D54）：先装载生效蓝图 → 读出该仓库的当前层 → 套用**当前层**那一份布局。
          await loadActiveBlueprint(opened.id, activeBlueprintId());
          const layer = await loadCurrentLayer(opened.id);
          const defLayout = await api.layoutGetDefault({ repoId: opened.id });
          if (!defLayout) {
            return;
          }
          const raw = await api.layoutGet({
            repoId: opened.id,
            name: defLayout,
            layerKey: layer ?? undefined,
          });
          const applied =
            raw ??
            // 该层没有专属行时按层无关行兼容（旧预设）。
            (await api.layoutGet({ repoId: opened.id, name: defLayout }));
          if (!applied) {
            return;
          }
          const layout = JSON.parse(applied);
          // 补齐最小尺寸约束并保持媒体预览 DOM（renderer=always）。
          dv.fromJSON(normalizeLayoutJson(layout));
          // 套用布局后按蓝图语义对账一次（D29：防止显隐/收起状态漂移）。
          reconcileAfterLayoutApplied(dv);
        } catch {
          /* 无默认仓库/布局或打开失败：保留默认布局 */
        }
      })();

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

      // 首屏布局就绪后再显示窗口，避免白屏（窗口初始 visible=false）
      requestAnimationFrame(() => {
        void getCurrentWindow().show().catch(() => undefined);
      });
    },
    [detachPanel, t],
  );

  /**
   * 把当前工作区布局结构发布到**跨窗口共享存储**：蓝图面板可能开在独立窗口，
   * 那里没有 dockview 实例，需要靠这份快照才能生成"布局块→标签组→控件"结构骨架。
   */
  useEffect(() => {
    const dv = apiRef.current;
    if (!dv) {
      return;
    }
    const publish = () => publishStructure(snapshotFromDockview(dv));
    publish();
    const disposable = dv.onDidLayoutChange(publish);
    return () => disposable.dispose();
  }, [repoId, refreshKey, theme]);

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
