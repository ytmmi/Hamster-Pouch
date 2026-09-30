/**
 * 正式 UI（app_ui）根组件 — 应用外壳（`docs/spec/panel-standard.md` 第 7.2 节 /
 * RFC 0010 决策 3、4、7）：装配 dockview、接入蓝图运行时与插件注册表、渲染顶部功能条、
 * 工作区、状态栏、进度浮窗与「全部设置」覆盖层。
 *
 * 本文件只做**装配与渲染**；其余职责各自成文件（同在 `core/` 下）：
 * - `blueprintExecutor.ts`：蓝图动作 → dockview 面板操作；
 * - `overlayHost.ts`：浮层容器渲染（登记与撤销）；
 * - `defaultWorkspaceLayout.ts` / `workspaceBootstrap.ts`：首屏布局与默认仓库装载；
 * - `panelDetach.ts`：面板脱离为独立窗口；
 * - `useShellSettings.ts` / `usePluginRegistrations.ts` / `useBlueprintRuntimeWiring.ts` /
 *   `useTaskWiring.ts`：设置、插件注册表、蓝图运行时、长任务的生命周期接线。
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
import { PANEL_MIN_SIZE } from "@hamster-pouch/config";
import { reconcileActiveBlueprint } from "../shared/blueprintRuntime";
import {
  publishStructure,
  snapshotFromDockview,
} from "../panels/blueprintStructure";

import { AppContext, type AppContextValue } from "./AppContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { TaskOverlay } from "./TaskOverlay";
import { blueprintEngine, type BlueprintDispatchInput } from "./blueprintEngine";
import { useBlueprintExecutor } from "./blueprintExecutor";
import { addDefaultPanels } from "./defaultWorkspaceLayout";
import { makeTranslator } from "../i18n";
import { MenuBar } from "../menu/MenuBar";
import { useAllPanelDefs, useDockComponents, panelTitle } from "./panelRegistry";
import { bindPanelDragOut, detachPanelToWindow } from "./panelDetach";
import { SettingsApp } from "../settings/SettingsApp";
import type { FileItem, StatusType } from "../shared/types";
import { useBlueprintRuntimeWiring } from "./useBlueprintRuntimeWiring";
import { useConfirm } from "./useConfirm";
import { useOverlayHost } from "./overlayHost";
import { usePluginRegistrations } from "./usePluginRegistrations";
import { useShellSettings } from "./useShellSettings";
import { useTaskWiring } from "./useTaskWiring";
import { bootstrapDefaultRepo } from "./workspaceBootstrap";

export function AppUiApp(): JSX.Element {
  // 界面偏好（主题 / 语言）：菜单条与「全部设置」共用同一份状态与写回入口。
  const { theme, language, changeTheme, changeLanguage } = useShellSettings();

  const [repoId, setRepoId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [dirPath, setDirPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: StatusType } | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const t = useMemo(() => makeTranslator(language), [language]);

  // 面板注册表（内置 14 个 + 插件注册项）：插件注册/卸载时自动更新菜单与 dockview 组件表。
  const panelDefs = useAllPanelDefs();
  const dockComponents = useDockComponents();

  // 「全部设置」系统界面（RFC 0010 决策 7）：应用级、独立于仓库蓝图与 panel_layouts。
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** 当前 dockview 实例（只读用途：执行器、蓝图对账、结构快照、上下文）。 */
  const getDockview = useCallback(() => apiRef.current, []);
  /** 工作区元素（浮层定位换算与"拖出工作区"判定）。 */
  const getWorkspace = useCallback(() => workspaceRef.current, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );

  // 插件注册表（RFC 0010 决策 3/4/5/7）：按当前仓库重建三张注册表的插件部分。
  // 注册项数量变化时刷新 key，让依赖注册表的蓝图与结构快照重新收敛。
  usePluginRegistrations(repoId, refresh);

  // 面板标题**始终**由「面板注册表 + 当前语言」派生，不采信布局里持久化的 `title`。
  //
  // 为什么需要这一步：dockview 的 `fromJSON` 会把持久化布局里存的 `title` 原样恢复，
  // 而标题是派生显示值、不是布局数据。少了它，面板改名（或切换语言）后旧布局会一直
  // 显示旧名——包括**未激活的标签页**（其组件尚未挂载，没法自行纠正）。
  // 因此这里既订阅 `onDidAddPanel`（覆盖 `fromJSON` 重建出来的每一个面板），
  // 也对已存在的面板立即补一遍。
  useEffect(() => {
    const dv = apiRef.current;
    if (!dv) {
      return;
    }
    for (const panel of dv.panels) {
      panel.setTitle(panelTitle(panel.id, t));
    }
    const disposable = dv.onDidAddPanel((panel) => {
      panel.setTitle(panelTitle(panel.id, t));
    });
    // 语言切换后按蓝图重新对账布局（默认可见/组收起状态与语言无关，
    // 但重渲染后需保持不漂移）。
    reconcileActiveBlueprint(dv);
    return () => disposable.dispose();
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

  // 蓝图引擎执行器（把求值动作映射到 dockview 与媒体命令）与其容器宿主。
  const overlayHost = useOverlayHost({ getDockview, theme });
  const blueprintExecutor = useBlueprintExecutor({
    getDockview,
    getWorkspace,
    focusPanel,
    repoId,
    status,
    t,
    overlayHost,
  });

  // 引擎装配、生效蓝图装载、热更新订阅与回退提示（RFC 0007）。
  useBlueprintRuntimeWiring({
    executor: blueprintExecutor,
    repoId,
    refreshKey,
    getDockview,
    status,
    t,
  });

  const dispatch = useCallback((input: BlueprintDispatchInput) => {
    blueprintEngine.dispatch(input);
  }, []);

  const detachPanel = useCallback(
    (id: string) => {
      detachPanelToWindow({ panelId: id, getDockview, language, status, t });
    },
    [getDockview, language, status, t],
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

  // 长任务（扫描/卸载）事件：模块级 store + 订阅只在启动时注册一次。
  useTaskWiring({ status, refresh, t });

  // 危险操作确认弹窗
  const { confirm, askConfirm, resolveConfirm } = useConfirm();

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
      askConfirm,
      confirm,
      resolveConfirm,
      focusPanel,
      dispatch,
      getDockview,
      language,
      setLanguage: changeLanguage,
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
      focusPanel,
      dispatch,
      getDockview,
      language,
      changeLanguage,
      theme,
      t,
    ],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const dv = event.api;
      // 默认布局：左侧功能栏 + 中央媒体预览 + 右侧检查器
      addDefaultPanels(dv, t);

      // 启动：若设置了默认仓库，自动打开并应用其默认布局（D25 相邻能力，失败忽略）。
      void bootstrapDefaultRepo(dv, setRepoId);

      // 拖出工作区 → 独立窗口（左键按住标签页拖拽，指针离开工作区即脱离）
      bindPanelDragOut({ dv, getWorkspace, detach: detachPanel });

      // 首屏布局就绪后再显示窗口，避免白屏（窗口初始 visible=false）
      requestAnimationFrame(() => {
        void getCurrentWindow().show().catch(() => undefined);
      });
    },
    [detachPanel, getWorkspace, t],
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
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="app-workspace" ref={workspaceRef}>
          <DockviewReact
            components={dockComponents}
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
            {panelDefs.length}
          </span>
        </div>
        {/* 调色板**不再**由「选中图像」触发提取（用户口径 2026-09）：它是**全面分析文件**
            的副产品——源扫描 / 源全量重扫 / 「重新分析该文件」在 `hp_scanner` 里顺带写入
            （`Scanner::write_palette`）。因此这里没有选中监视器，色彩参考面板只读缓存。 */}
        {/* 长任务进度浮窗 + 危险操作确认弹窗：界面居中，盖在布局/面板之上 */}
        <TaskOverlay />
        <ConfirmDialog />
        {/* 「全部设置」系统界面（RFC 0010 决策 7）：不进蓝图、不参与 panel_layouts */}
        {settingsOpen && (
          <SettingsApp
            onClose={() => setSettingsOpen(false)}
            onThemeChange={changeTheme}
            onLanguageChange={changeLanguage}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}
