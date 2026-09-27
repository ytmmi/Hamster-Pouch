/**
 * 正式 UI（app_ui）根组件 — 顶部功能条 + 可停靠工作区 + 状态栏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PANEL_MIN_SIZE, resolveOverlayPosition, SETTING_KEYS } from "@hamster-pouch/config";
import { normalizeLayoutJson } from "../shared/panelLayout";
import { collapseGroup, expandGroup } from "../shared/blueprintLayout";
import {
  activeBlueprintId,
  activeStateConflicts,
  loadActiveBlueprint,
  loadCurrentLayer,
  notifyBlueprintChangedLocally,
  reconcileActiveBlueprint,
  reconcileAfterLayoutApplied,
  setBlueprintFallbackNotifier,
  subscribeBlueprintHotReload,
  switchLayer,
} from "../shared/blueprintRuntime";
import {
  publishStructure,
  snapshotFromDockview,
} from "../panels/blueprintStructure";

import * as api from "../shared/api";
import { AppContext, type AppContextValue } from "./AppContext";
import { ConfirmDialog } from "./ConfirmDialog";
import { TaskOverlay } from "./TaskOverlay";
import { bindTaskActions, startTaskEvents } from "./taskStore";
import { useConfirm } from "./useConfirm";
import { blueprintEngine, type BlueprintCollapseAbsorb, type BlueprintDispatchInput } from "./blueprintEngine";
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  makeTranslator,
  type Language,
} from "../i18n";
import { MenuBar } from "../menu/MenuBar";
import { useAllPanelDefs, useDockComponents, panelTitle } from "./panelRegistry";
import { refreshPluginRegistrations, unregisterAll } from "./pluginRegistryHost";
import { SettingsApp } from "../settings/SettingsApp";
import type { FileItem, StatusType } from "../shared/types";

/** 在 dockview 里找"包含最多指定面板"的组（用于 `toward:<组>` 吸收目标解析）。 */
function findGroupForPanels(
  dv: DockviewApi,
  panelIds: string[],
): DockviewGroupPanel | null {
  let best: DockviewGroupPanel | null = null;
  let bestScore = 0;
  for (const g of dv.groups) {
    const ids = new Set(g.panels.map((p) => p.id));
    const score = panelIds.filter((id) => ids.has(id)).length;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

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

  // 面板注册表（内置 13 个 + 插件注册项）：插件注册/卸载时自动更新菜单与 dockview 组件表。
  const panelDefs = useAllPanelDefs();
  const dockComponents = useDockComponents();

  // 「全部设置」系统界面（RFC 0010 决策 7）：应用级、独立于仓库蓝图与 panel_layouts。
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 加载主题与语言设置（默认：白天模式 + 简体中文）
  useEffect(() => {
    void (async () => {
      try {
        const savedTheme = (await api.settingGet({ key: SETTING_KEYS.theme })).value;
        if (savedTheme === "dark" || savedTheme === "light") {
          setTheme(savedTheme);
        }
        const savedLang = (await api.settingGet({ key: SETTING_KEYS.language })).value;
        if (typeof savedLang === "string" && isLanguage(savedLang)) {
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

  // 插件注册表（RFC 0010 决策 3/4/5/7）：按当前仓库重建三张注册表的插件部分。
  // 未安装/未启用/API 不兼容的插件注册项**缺席** → 蓝图按「未接通」处理（允许保存）。
  const reloadPlugins = useCallback(
    async (targetRepoId: string) => {
      const result = await refreshPluginRegistrations(targetRepoId);
      if (result.panelCount + result.nodeTypeCount + result.settingsSectionCount > 0) {
        setRefreshKey((k) => k + 1);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!repoId) {
        unregisterAll();
        return;
      }
      await reloadPlugins(repoId);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, reloadPlugins]);

  // `plugin.changed`：启用/禁用/安装插件后立即重建注册表，蓝图里的引用随之恢复或灰显。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<{ repoId?: string }>("plugin.changed", (event) => {
          const target = event.payload?.repoId ?? repoId;
          if (target) void reloadPlugins(target);
        });
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
    return () => dispose?.();
  }, [repoId, reloadPlugins]);

  const status = useCallback(
    (text: string, type: StatusType = "info") => setStatusMsg({ text, type }),
    [],
  );

  /**
   * 等面板级渲染子窗口就绪后再播放（`docs/issues/0001`）。
   *
   * 蓝图双击会先 `show 播放器` 再立刻 `play`，但嵌入子窗口要等播放器面板挂载后的
   * `useEffect` 才创建；后端拿不到渲染目标时返回 `EMBED_NOT_READY`（不再静默开独立
   * 窗口）。这里轮询重试，让"第一次双击"也走面板内嵌。
   */
  const playWhenEmbedReady = useCallback(
    async (repoIdValue: string, fileId: string, attempts = 25): Promise<void> => {
      let lastError: unknown;
      for (let i = 0; i < attempts; i += 1) {
        try {
          await api.mediaPlay({ repoId: repoIdValue, fileId });
          return;
        } catch (e) {
          lastError = e;
          if (!String(e).includes("EMBED_NOT_READY")) {
            throw e;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 80));
        }
      }
      throw lastError;
    },
    [],
  );

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
      /**
       * 浮层内容面板：**必须浮动**（浮层是浮在布局之上的一层），并按蓝图定位/尺寸摆好。
       * - 不存在 → 按给定尺寸浮动创建；
       * - 已停靠 → 移入浮动组（`addFloatingGroup`）并置顶；
       * - 已是浮动 → 直接置顶并按尺寸调整。
       * 位置由蓝图的九宫格锚点 + 双模式偏移相对**工作区**换算（`resolveOverlayPosition`）。
       */
      showOverlayPanel: (
        panelId: string,
        box: {
          width: number;
          height: number;
          anchor: string;
          offsetX: number;
          offsetY: number;
        },
      ) => {
        const dv = apiRef.current;
        if (!dv) {
          void import("../shared/blueprintRuntime").then((m) =>
            m.traceBlueprint(`[overlay] ${panelId} 跳过：dockview 尚未就绪`),
          );
          return;
        }
        lastShownRef.current = panelId;
        const rect = workspaceRef.current?.getBoundingClientRect();
        const area = {
          width: Math.round(rect?.width ?? 1200),
          height: Math.round(rect?.height ?? 800),
        };
        const at = resolveOverlayPosition({
          anchor: box.anchor as never,
          offsetX: box.offsetX,
          offsetY: box.offsetY,
          area,
          size: { width: box.width, height: box.height },
        });
        const floating = { x: at.x, y: at.y, width: box.width, height: box.height };
        const existing = dv.getPanel(panelId);
        try {
          if (!existing) {
            dv.addPanel({
              ...PANEL_MIN_SIZE,
              id: panelId,
              component: panelId,
              title: panelTitle(panelId, t),
              floating,
            });
            void import("../shared/blueprintRuntime").then((m) =>
              m.traceBlueprint(
                `[overlay] ${panelId} 浮动创建 ${box.width}×${box.height} @(${at.x}, ${at.y}) 区域=${area.width}×${area.height}`,
              ),
            );
            return;
          }
          if (existing.api.location.type !== "floating") {
            dv.addFloatingGroup(existing, floating);
            void import("../shared/blueprintRuntime").then((m) =>
              m.traceBlueprint(
                `[overlay] ${panelId} 由停靠移入浮动组 ${box.width}×${box.height} @(${at.x}, ${at.y})`,
              ),
            );
          } else {
            existing.api.setSize({ width: box.width, height: box.height });
            void import("../shared/blueprintRuntime").then((m) =>
              m.traceBlueprint(`[overlay] ${panelId} 已是浮动，调整尺寸 ${box.width}×${box.height}`),
            );
          }
          existing.api.setActive();
        } catch (e) {
          // dockview 网格约束下失败时退化为"激活已存在面板"，并把原因写进诊断日志。
          void import("../shared/blueprintRuntime").then((m) =>
            m.traceBlueprint(`[overlay] ${panelId} 浮动失败，退化为激活：${String(e)}`),
          );
          existing?.api.setActive();
        }
      },
      hidePanel: (panelId: string) => {
        // 显式 hide 动作（用户蓝图规则）：与最近显示面板同 dockview 组时跳过
        // （标签激活已切换）；跨组则**收起至最小尺寸**（正文 6px、标签条保留，D25/D29）。
        // RFC 0007 决策 3：隐藏 = 收起，**不是关闭**，不销毁面板/标签。
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
        collapseGroup(panel.api.group);
      },
      togglePanel: (panelId: string, floating: boolean) => {
        // toggle 语义（RFC 0007）：**取反**。面板不存在 → 显示；已存在 → 关闭。
        // 与 hide（收起、不销毁）区分：toggle 需要一个"存在/不存在"的判据，
        // 引擎无面板状态记忆，因此此处以 dockview 的存在性作为当前态。
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
      collapsePanels: (panelIds: string[], absorb?: BlueprintCollapseAbsorb) => {
        const dv = apiRef.current;
        if (!dv) {
          return;
        }
        // toward 目标组：按成员面板 id 命中最多的 dockview 组（引擎已把 toward:<组> 解析为面板 id）。
        const towardGroup = absorb?.towardPanelIds
          ? findGroupForPanels(dv, absorb.towardPanelIds)
          : null;
        // 按 dockview 组去重：同一组成员只收起一次，避免重复吸收把邻居放大多次。
        const seen = new Set<string>();
        for (const id of panelIds) {
          const panel = dv.getPanel(id);
          if (!panel || seen.has(panel.api.group.id)) {
            continue;
          }
          seen.add(panel.api.group.id);
          // 组的隐藏 = 最小化至最小尺寸（正文 6px、标签条保留，D25）；
          // 与布局对账共用同一份"收起前尺寸"记忆，保证 expand 能恢复（RFC 0007 决策 3）；
          // hide_direction 指定把释放空间让给哪个邻居（D29）。
          collapseGroup(panel.api.group, dv, {
            direction: absorb?.direction,
            towardGroup,
          });
        }
      },
      expandPanels: (panelIds: string[]) => {
        const dv = apiRef.current;
        if (!dv) {
          return;
        }
        // 按组去重：展开重复触发会用兜底尺寸覆盖已恢复的原尺寸。
        const seen = new Set<string>();
        for (const id of panelIds) {
          const panel = dv.getPanel(id);
          if (!panel || seen.has(panel.api.group.id)) {
            continue;
          }
          seen.add(panel.api.group.id);
          expandGroup(panel.api.group);
        }
      },
      playFile: (fileId: string) => {
        if (!repoId) {
          return;
        }
        // 蓝图双击与「显示播放器」在同一帧发生，而面板级嵌入子窗口是在播放器面板
        // **挂载之后**才由 `media_embed_rect` 创建的。后端此时会回 EMBED_NOT_READY
        // （不再静默降级为独立窗口，见 `docs/issues/0001`），这里等面板就绪后重试。
        void playWhenEmbedReady(repoId, fileId)
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

  // 蓝图装载回退提示（RFC 0007 决策 3：无效文档回退内置默认时**必须提示用户**）。
  useEffect(() => {
    setBlueprintFallbackNotifier((reason) => {
      status(
        t(
          reason === "invalid-document"
            ? "blueprint.fallbackInvalid"
            : "blueprint.fallbackFailed",
        ),
        "error",
      );
    });
    return () => setBlueprintFallbackNotifier(null);
  }, [status, t]);

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
      // 状态冲突（同界面同对象同触发多状态，节点标准第 6 节）：库存里可能有历史遗留文档
      // （规则上线前保存的），装载后提示一次，避免"某次交互同时触发互斥状态"却毫无提示。
      const conflicts = activeStateConflicts();
      if (conflicts.length > 0) {
        status(t("blueprint.stateConflict", { count: conflicts.length }), "error");
      }
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

  // 长任务（扫描/卸载）事件：模块级 store，进度不进 context（否则每次进度都会重渲染所有面板）
  useEffect(() => {
    bindTaskActions({ status, refresh, t });
  }, [status, refresh, t]);
  useEffect(() => startTaskEvents(), []);

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
