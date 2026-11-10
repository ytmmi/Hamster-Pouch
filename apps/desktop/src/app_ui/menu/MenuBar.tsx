/**
 * 顶部功能条 — 设置 / 窗口 / 扩展（全局，非面板）。
 *
 * 窗口菜单：布局（保存/加载）、组件（显示/隐藏/独立）、重置布局。
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type JSX } from "react";
import type { DockviewApi } from "dockview-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { SwitchToggle } from "../shared/SwitchToggle";
import { useApp } from "../core/AppContext";
import { syncBlueprintFromLayout } from "../shared/blueprintSync";
import {
  currentLayerKey,
  loadActiveBlueprint,
  reconcileAfterLayoutApplied,
  setActiveBlueprintId,
} from "../shared/blueprintRuntime";
import { LANGUAGES, type Language } from "../i18n";
import { useAllPanelDefs, panelTitle } from "../core/panelRegistry";
import { ContextMenu } from "./ContextMenu";
import { normalizeLayoutJson } from "../shared/panelLayout";
import { PANEL_MIN_SIZE } from "@hamster-pouch/config";

/** 媒体预览面板必须保持 DOM（renderer=always），否则同组 tab 切换会丢失滚动位置。 */
const MEDIA_PANEL_ID = "media";
const panelExtra = (id: string): { renderer?: "always"; minimumWidth: number; minimumHeight: number } => ({
  ...PANEL_MIN_SIZE,
  ...(id === MEDIA_PANEL_ID ? { renderer: "always" as const } : {}),
});

export interface MenuBarProps {
  apiRef: MutableRefObject<DockviewApi | null>;
  theme: "light" | "dark";
  onThemeChange: (next: "light" | "dark") => void;
  language: Language;
  onLanguageChange: (next: Language) => void;
  /** 打开「全部设置」系统界面（RFC 0010 决策 7）。 */
  onOpenSettings: () => void;
}

export function MenuBar({
  apiRef,
  theme,
  onThemeChange,
  language,
  onLanguageChange,
  onOpenSettings,
}: MenuBarProps): JSX.Element {
  const app = useApp();
  const { t } = app;
  // 面板注册表（内置 14 个 + 插件注册项）：重置布局与组件菜单都用这一份清单。
  const panelDefs = useAllPanelDefs();
  // RFC 0011：布局预设是应用级的；仓库只在有绑定时覆盖（`repoId` 可空）。
  const repoId = app.repoId;
  const [open, setOpen] = useState<string | null>(null);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [layouts, setLayouts] = useState<string[]>([]);
  /** 「扩展」菜单的**已安装插件目录**（含未启用的，每个插件一行）。 */
  const [catalog, setCatalog] = useState<api.PluginCatalogItem[]>([]);
  const [extBusy, setExtBusy] = useState(false);

  /** 拉取插件目录。打开菜单时按需拉取 → 启用/禁用后天然不会陈旧。
   *  即使未打开仓库也照常拉取（后端按空仓库处理，enabled 全为 false），
   *  保证「所有安装的插件」始终可见；只是没仓库时开关不可点。 */
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api.pluginCatalog(repoId ?? ""));
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
      setCatalog([]);
    }
  }, [repoId, app]);

  useEffect(() => {
    if (open === "ext") void loadCatalog();
  }, [open, loadCatalog]);

  /**
   * 就地启用/禁用某个插件（「扩展」菜单右侧的开关）。
   *
   * 授权按插件**声明的能力**发起（host.rs:81 要求请求 ⊆ 声明能力）：
   * 早期实现硬编码 `repo.read`，会让只声明 `native.code` 的随包系统插件
   * （python-core）报「插件未声明能力: repo.read」。
   * 启用后宿主广播 `plugin.changed`，面板注册表随之重建，该插件的面板即可打开。
   */
  const togglePluginEnabled = useCallback(
    async (item: api.PluginCatalogItem) => {
      if (!repoId) {
        app.status(app.t("common.selectRepo"), "error");
        return;
      }
      setExtBusy(true);
      try {
        if (item.enabled) {
          await api.pluginDisable(repoId, item.pluginId);
        } else {
          await api.pluginEnable(repoId, item.pluginId, item.capabilities);
        }
        await loadCatalog();
      } catch (e) {
        app.status(errorTextOf(app.t, e), "error");
      } finally {
        setExtBusy(false);
      }
    },
    [repoId, app, loadCatalog],
  );

  /**
   * 「扩展」菜单按**有无启用语义**分组：只看 `stateless`，与「有没有面板」无关。
   *
   * - `statefulRows`：有启用语义 → 每个插件一行 + 右侧开关；其面板另作可打开的
   *   子行。随包系统插件 `python-core`（`panels` 为空但 `stateless=false`）也在这组，
   *   不再被当成词库。
   * - `dataPackRows`：`stateless` 的纯数据扩展（tagdict-* / tagrel-*，装完即生效），
   *   **只列出来、不给开关**——给它开关等于骗用户。后端已把它们整组排在最后。
   */
  const statefulRows = catalog.filter((i) => !i.stateless);
  const dataPackRows = catalog.filter((i) => i.stateless);
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutName, setLayoutName] = useState("");
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number; name: string } | null>(
    null,
  );
  const [renamingLayout, setRenamingLayout] = useState<string | null>(null);
  const [renameLayoutValue, setRenameLayoutValue] = useState("");
  /** 应用级默认预设名（菜单里打「默认」标记）。 */
  const [defaultLayout, setDefaultLayoutName] = useState<string | null>(null);
  /** 当前仓库的覆盖预设名（无覆盖为 null）。 */
  const [repoBinding, setRepoBinding] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(null);
        setSubmenu(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // 读取应用级预设名（最新在前）+ 默认指针 + 当前仓库覆盖（RFC 0011）。
  const loadLayoutNames = useCallback(async () => {
    try {
      const [items, def, bound] = await Promise.all([
        api.layoutList(),
        api.layoutGetDefault().catch(() => null),
        repoId ? api.layoutGetDefault({ repoId }).catch(() => null) : Promise.resolve(null),
      ]);
      setLayouts(items.map((item) => item.name));
      setDefaultLayoutName(def);
      setRepoBinding(bound);
    } catch {
      setLayouts([]);
    }
  }, [repoId]);

  useEffect(() => {
    void loadLayoutNames();
  }, [loadLayoutNames]);

  const closeMenus = () => {
    setOpen(null);
    setSubmenu(null);
    setSavingLayout(false);
    setLayoutName("");
  };

  const togglePanel = (id: string) => {
    const dv = apiRef.current;
    if (!dv) return;
    const existing = dv.getPanel(id);
    if (existing) {
      existing.api.close();
    } else {
      dv.addPanel({ id, component: id, title: panelTitle(id, t), ...panelExtra(id) });
    }
  };

  const resetLayout = () => {
    const dv = apiRef.current;
    if (!dv) return;
    dv.clear();
    const order = panelDefs.map((p) => p.id);
    order.forEach((id, index) => {
      if (index === 0) {
        dv.addPanel({ id, component: id, title: panelTitle(id, t), ...panelExtra(id) });
      } else {
        dv.addPanel({
          id,
          component: id,
          title: panelTitle(id, t),
          ...panelExtra(id),
          position: { referencePanel: order[0], direction: "within" },
        });
      }
    });
    closeMenus();
  };

  const detachPanel = (id: string) => {
    const dv = apiRef.current;
    const repo = app.repoId ? `&repoId=${encodeURIComponent(app.repoId)}` : "";
    try {
      const win = new WebviewWindow(`panel-${id}-${Date.now()}`, {
        url: `index.html?panel=${id}&lang=${language}${repo}`,
        title: `${t("app.name")} · ${panelTitle(id, t)}`,
        width: 900,
        height: 620,
      });
      void win.once("tauri://error", (e) => {
        app.status(t("layout.detachFailed", { err: errorTextOf(app.t, e) }), "error");
      });
      dv?.getPanel(id)?.api.close();
      app.status(`${panelTitle(id, t)} → ${t("menubar.detach")}`, "ok");
    } catch (e) {
      app.status(t("layout.detachFailed", { err: errorTextOf(app.t, e) }), "error");
    }
    closeMenus();
  };

  const saveLayout = async () => {
    const dv = apiRef.current;
    const name = layoutName.trim();
    if (!dv || !name) {
      return;
    }
    try {
      // 布局内调整组后：把当前 dockview 组结构自动同步进默认蓝图（自动生成对应节点），
      // 并把默认蓝图绑定到该布局（1 个布局可绑定多个蓝图）。
      const boundId = repoId ? await syncBlueprintFromLayout(repoId, dv) : null;
      const json = JSON.stringify(dv.toJSON());
      await api.layoutSave({
        name,
        layoutJson: json,
        // D53：写**当前层**那一份布局；当前层按仓库持久化（D54）。
        layerKey: currentLayerKey() ?? undefined,
        blueprintIds: boundId ? [boundId] : undefined,
      });
      await loadLayoutNames();
      app.status(`${t("menubar.layout.saved")}: ${name}`, "ok");
      app.refresh();
      closeMenus();
    } catch (e) {
      app.status(t("layout.saveFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const applyLayout = async (name: string) => {
    const dv = apiRef.current;
    if (!dv) return;
    try {
      // D53：套用**当前层**那一份布局；该层没有专属行时按 `""` 兜底（同一预设内）。
      const layerKey = currentLayerKey() ?? undefined;
      const raw =
        (await api.layoutGet({ name, layerKey })) ??
        (await api.layoutGet({ name }));
      if (!raw) {
        app.status(t("layout.notFound", { name }), "error");
        return;
      }
      const layout = JSON.parse(raw);
      // 补齐最小尺寸约束（旧布局未记录会回退到 dockview 默认 100×100）；
      // 媒体预览强制 renderer=always，避免 tab 切换丢滚动位置。
      dv.fromJSON(normalizeLayoutJson(layout));
      // 布局绑定蓝图：应用布局时激活其绑定的第一个蓝图（1 个布局可绑定多个蓝图），
      // 随后立即把蓝图语义对账到新布局（默认可见标签 + 组收起/展开）。
      let boundId: string | null = null;
      const bound = await api.layoutBlueprints({ name }).catch(() => [] as string[]);
      if (repoId && bound[0]) {
        const loaded = await loadActiveBlueprint(repoId, bound[0]);
        boundId = loaded.loaded ? bound[0] : null;
      }
      if (!boundId) {
        setActiveBlueprintId(null);
      }
      reconcileAfterLayoutApplied(dv);
      app.status(t("layout.loaded", { name }), "ok");
      closeMenus();
    } catch (e) {
      app.status(t("layout.loadFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const renameLayout = async (name: string, newName: string) => {
    const trimmed = newName.trim();
    setRenamingLayout(null);
    setLayoutMenu(null);
    if (!trimmed || trimmed === name) {
      return;
    }
    try {
      await api.layoutRename({ name, newName: trimmed });
      await loadLayoutNames();
      app.status(t("layout.renamed", { name: trimmed }), "ok");
    } catch (e) {
      app.status(t("layout.renameFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const deleteLayout = async (name: string) => {
    setLayoutMenu(null);
    if (!window.confirm(t("menubar.layout.deleteConfirm"))) {
      return;
    }
    try {
      await api.layoutDelete({ name });
      await loadLayoutNames();
      app.status(t("layout.deleted", { name }), "ok");
    } catch (e) {
      app.status(t("layout.deleteFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 用当前布局覆盖该预设（同步蓝图并保持/更新绑定）。 */
  const updateLayout = async (name: string) => {
    setLayoutMenu(null);
    const dv = apiRef.current;
    if (!dv) {
      return;
    }
    try {
      // 与保存一致：调整组后自动同步进默认蓝图并绑定。
      const boundId = repoId ? await syncBlueprintFromLayout(repoId, dv) : null;
      const json = JSON.stringify(dv.toJSON());
      await api.layoutSave({
        name,
        layoutJson: json,
        // D53：覆盖的是**当前层**那一份布局。
        layerKey: currentLayerKey() ?? undefined,
        blueprintIds: boundId ? [boundId] : undefined,
      });
      await loadLayoutNames();
      app.status(t("layout.updated", { name }), "ok");
      app.refresh();
    } catch (e) {
      app.status(t("layout.updateFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const setDefaultLayout = async (name: string) => {
    setLayoutMenu(null);
    try {
      await api.layoutSetDefault({ name });
      app.status(t("layout.defaultSet", { name }), "ok");
    } catch (e) {
      app.status(t("layout.defaultFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 把预设设为**当前仓库**的覆盖（RFC 0011：只写绑定，不动应用级默认）。 */
  const bindRepoLayout = async (name: string) => {
    setLayoutMenu(null);
    if (!repoId) {
      app.status(t("layout.bindingNeedsRepo"), "info");
      return;
    }
    try {
      await api.layoutBindRepo({ repoId, name });
      await loadLayoutNames();
      app.status(t("layout.bound", { name }), "ok");
    } catch (e) {
      app.status(t("layout.bindFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 清除当前仓库覆盖，回到应用级默认。 */
  const clearRepoBinding = async () => {
    setLayoutMenu(null);
    if (!repoId) {
      return;
    }
    try {
      await api.layoutBindRepo({ repoId });
      await loadLayoutNames();
      app.status(t("layout.unbound"), "ok");
    } catch (e) {
      app.status(t("layout.bindFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 导出预设为 `.json`（系统保存对话框取路径，Rust 侧落盘）。 */
  const exportLayout = async (name: string) => {
    setLayoutMenu(null);
    try {
      const safe = name.replace(/[\\/:*?"<>|]/g, "_");
      const path = await saveDialog({
        defaultPath: `${safe}.json`,
        filters: [{ name: "Hamster Pouch Layout", extensions: ["json"] }],
      });
      if (!path) {
        return;
      }
      await api.layoutExport({ name, path });
      app.status(t("layout.exported", { name }), "ok");
    } catch (e) {
      app.status(t("layout.exportFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 导入预设（重名自动加后缀，不覆盖、不改绑定）。 */
  const importLayout = async () => {
    closeMenus();
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Hamster Pouch Layout", extensions: ["json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) {
        return;
      }
      const item = await api.layoutImport({ path });
      await loadLayoutNames();
      app.status(t("layout.imported", { name: item.name }), "ok");
    } catch (e) {
      app.status(t("layout.importFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  return (
    <div className="menubar" ref={rootRef}>
      <span className="menubar-brand">{t("app.name")}</span>

      {/* 设置 */}
      <div className="menu">
        <button
          className="menu-btn"
          onClick={() => {
            setOpen(open === "settings" ? null : "settings");
            setSubmenu(null);
          }}
        >
          {t("menubar.settings")}
        </button>
        {open === "settings" && (
          <div className="menu-pop">
            {/* 主题子菜单（与窗口菜单同款） */}
            <button
              className="menu-item has-sub"
              onClick={() => setSubmenu(submenu === "theme" ? null : "theme")}
            >
              {t("menubar.theme")} <span className="sub-arrow">▸</span>
            </button>
            {submenu === "theme" && (
              <div className="menu-sub">
                {(
                  [
                    { id: "light" as const, labelKey: "menubar.theme.light" as const },
                    { id: "dark" as const, labelKey: "menubar.theme.dark" as const },
                  ]
                ).map((item) => (
                  <button
                    key={item.id}
                    className={`menu-item ${theme === item.id ? "first" : ""}`}
                    onClick={() => onThemeChange(item.id)}
                  >
                    {theme === item.id ? "● " : "　"}
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            )}

            {/* 语言子菜单（与窗口菜单同款） */}
            <button
              className="menu-item has-sub"
              onClick={() => setSubmenu(submenu === "language" ? null : "language")}
            >
              {t("menubar.language")} <span className="sub-arrow">▸</span>
            </button>
            {submenu === "language" && (
              <div className="menu-sub">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.id}
                    className={`menu-item ${language === lang.id ? "first" : ""}`}
                    onClick={() => onLanguageChange(lang.id)}
                  >
                    {language === lang.id ? "● " : "　"}
                    {t(lang.labelKey)}
                  </button>
                ))}
              </div>
            )}

            {/* D59 的「保存布局时同步蓝图」已移入「全部设置 → 蓝图」
                （设置注册表 `layout.syncBlueprint`），菜单里不再重复。 */}

            {/* RFC 0010 决策 7：跳转到「全部设置」系统界面（应用级，独立于仓库蓝图）。
                先收起本下拉，否则「全部设置」窗口弹出后这层菜单仍留在原处。 */}
            <button
              className="menu-item"
              onClick={() => {
                closeMenus();
                onOpenSettings();
              }}
            >
              {t("settings.more")} <span className="sub-arrow">▸</span>
            </button>
          </div>
        )}
      </div>

      {/* 窗口 */}
      <div className="menu">
        <button
          className="menu-btn"
          onClick={() => {
            setOpen(open === "window" ? null : "window");
            setSubmenu(null);
          }}
        >
          {t("menubar.window")}
        </button>
        {open === "window" && (
          <div className="menu-pop">
            {/* 布局子菜单 */}
            <button
              className="menu-item has-sub"
              onClick={() => setSubmenu(submenu === "layout" ? null : "layout")}
            >
              {t("menubar.layout")} <span className="sub-arrow">▸</span>
            </button>
            {submenu === "layout" && (
              <div className="menu-sub">
                {savingLayout ? (
                  <div className="menu-item-row">
                    <input
                      className="menu-input"
                      value={layoutName}
                      autoFocus
                      placeholder={t("menubar.layout.namePrompt")}
                      onChange={(e) => setLayoutName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void saveLayout();
                        }
                      }}
                    />
                    <button className="menu-item small" onClick={() => void saveLayout()}>
                      ✓
                    </button>
                  </div>
                ) : (
                  <button className="menu-item" onClick={() => setSavingLayout(true)}>
                    {t("menubar.layout.save")}
                  </button>
                )}
                <div className="menu-sep" />
                {layouts.map((name, index) =>
                  renamingLayout === name ? (
                    <div key={name} className="menu-item-row">
                      <input
                        className="menu-input"
                        value={renameLayoutValue}
                        autoFocus
                        onChange={(e) => setRenameLayoutValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void renameLayout(name, renameLayoutValue);
                          } else if (e.key === "Escape") {
                            setRenamingLayout(null);
                          }
                        }}
                      />
                      <button
                        className="menu-item small"
                        onClick={() => void renameLayout(name, renameLayoutValue)}
                      >
                        ✓
                      </button>
                    </div>
                  ) : (
                    <button
                      key={name}
                      className={`menu-item ${index === 0 ? "first" : ""}`}
                      onClick={() => void applyLayout(name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setLayoutMenu({ x: e.clientX, y: e.clientY, name });
                      }}
                    >
                      {name}
                      {defaultLayout === name && (
                        <span className="dim"> · {t("menubar.layout.defaultTag")}</span>
                      )}
                      {repoBinding === name && (
                        <span className="dim"> · {t("menubar.layout.bindingTag")}</span>
                      )}
                    </button>
                  ),
                )}
                {layouts.length === 0 && (
                  <span className="menu-item dim">{t("menubar.layout.empty")}</span>
                )}
                {/* 导出 / 导入（RFC 0011 决策 6）：导出走预设右键菜单 */}
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => void importLayout()}>
                  {t("menubar.layout.import")}
                </button>
                {/* 重置布局：置于布局子菜单最底部 */}
                <div className="menu-sep" />
                <button className="menu-item" onClick={resetLayout}>
                  {t("menubar.resetLayout")}
                </button>
              </div>
            )}

            {/* 组件子菜单 */}
            <button
              className="menu-item has-sub"
              onClick={() => setSubmenu(submenu === "components" ? null : "components")}
            >
              {t("menubar.components")} <span className="sub-arrow">▸</span>
            </button>
            {submenu === "components" && (
              <div className="menu-sub">
                {panelDefs.map((p) => {
                  const exists = Boolean(apiRef.current?.getPanel(p.id));
                  return (
                    <div key={p.id} className="menu-item-row">
                      <button className="menu-item grow" onClick={() => togglePanel(p.id)}>
                        {exists ? "✓ " : "　"}
                        {t(p.titleKey)}
                      </button>
                      <button
                        className="menu-item small"
                        title={t("menubar.detach")}
                        onClick={() => detachPanel(p.id)}
                      >
                        {t("menubar.detach")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 扩展 */}
      <div className="menu">
        <button
          className="menu-btn"
          onClick={() => {
            setOpen(open === "ext" ? null : "ext");
            setSubmenu(null);
          }}
        >
          {t("menubar.extensions")}
        </button>
        {open === "ext" && (
          <div className="menu-pop">
            {catalog.length === 0 && (
              <span className="menu-item dim">{t("menubar.extensionsHint")}</span>
            )}
            {/* 有启用语义的插件：**一个插件一行**，右侧就地开关；其面板另作可打开的
                子行。无面板的系统插件（python-core）也在这里、照样带开关——它不再被
                误当成纯数据扩展。开关按 `capabilities` 启用（禁止硬编码 repo.read）。 */}
            {statefulRows.map((item) => (
              <div key={item.pluginId}>
                <div className="menu-item-row">
                  <span
                    className={`menu-item grow static${item.enabled ? "" : " dim"}`}
                    title={item.pluginId}
                  >
                    {item.pluginName}
                    <span className="dim"> · {item.runtimeKind}</span>
                  </span>
                  {/* 容器用 `<span>` 而不是 `<label>`：`<label>` 不得包住其它可交互元素，
                      胶囊开关本身就是按钮（无障碍名由 `label` 属性给）。 */}
                  <span
                    className="ext-toggle"
                    title={
                      item.enabled
                        ? t("plugin.disable")
                        : `${t("menubar.extensionsNeedsEnable")} — ${t("menubar.extensionsEnableHint")}`
                    }
                  >
                    <span>{t("plugin.enable")}</span>
                    <SwitchToggle
                      checked={item.enabled}
                      theme={theme}
                      label={`${t("plugin.enable")} ${item.pluginName}`}
                      disabled={extBusy || !repoId}
                      onChange={() => void togglePluginEnabled(item)}
                    />
                  </span>
                </div>
                {item.panels.map((panel) => {
                  const inLayout = Boolean(apiRef.current?.getPanel(panel.id));
                  return (
                    <div key={panel.id} className="menu-item-row">
                      <button
                        className={`menu-item grow${item.enabled ? "" : " dim"}`}
                        // 未启用 → 打不开（面板还没登记进注册表），按钮置灰、由上方开关负责启用。
                        disabled={!item.enabled}
                        title={item.enabled ? panel.id : t("menubar.extensionsNeedsEnable")}
                        onClick={() => togglePanel(panel.id)}
                      >
                        {inLayout ? "✓ " : "　"}
                        {item.pluginName}
                        {/* 插件语言资源通道未落地 → 这里直接显示标题键，不做 i18n 查询 */}
                        <span className="dim"> · {panel.titleKey}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            {/* 纯数据扩展（tagdict-* / tagrel-*）：**列在最后、无启用按钮**
                ——词库数据装完即生效，没有可"启用"的状态（RFC 0008 D36.9）。 */}
            {dataPackRows.length > 0 && <div className="menu-sep" />}
            {dataPackRows.map((item) => (
              <div key={item.pluginId} className="menu-item-row">
                <span className="menu-item grow static" title={item.pluginId}>
                  　{item.pluginName}
                  <span className="dim"> · {t("plugin.statelessHint")}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 布局预设右键菜单 */}
      {layoutMenu && (
        <ContextMenu x={layoutMenu.x} y={layoutMenu.y}>
          <button
            className="menu-item"
            onClick={() => {
              setRenamingLayout(layoutMenu.name);
              setRenameLayoutValue(layoutMenu.name);
              setLayoutMenu(null);
            }}
          >
            {t("menubar.layout.rename")}
          </button>
          <button
            className="menu-item"
            onClick={() => void deleteLayout(layoutMenu.name)}
          >
            {t("menubar.layout.delete")}
          </button>
          <button
            className="menu-item"
            onClick={() => void updateLayout(layoutMenu.name)}
          >
            {t("menubar.layout.update")}
          </button>
          <button
            className="menu-item"
            onClick={() => void setDefaultLayout(layoutMenu.name)}
          >
            {t("menubar.layout.setDefault")}
          </button>
          <button
            className="menu-item"
            onClick={() => void bindRepoLayout(layoutMenu.name)}
          >
            {t("menubar.layout.bindRepo")}
          </button>
          <button
            className="menu-item"
            onClick={() => void clearRepoBinding()}
          >
            {t("menubar.layout.clearBinding")}
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => void exportLayout(layoutMenu.name)}
          >
            {t("menubar.layout.export")}
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
