/**
 * 顶部功能条 — 设置 / 窗口 / 扩展（全局，非面板）。
 *
 * 窗口菜单：布局（保存/加载）、组件（显示/隐藏/独立）、重置布局。
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import { BlueprintEngine, blueprintEngine } from "../core/blueprintEngine";
import { syncBlueprintFromLayout } from "../shared/blueprintSync";
import { LANGUAGES, type Language } from "../i18n";
import { PANEL_DEFS, panelTitle } from "../core/panelRegistry";
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
}

export function MenuBar({
  apiRef,
  theme,
  onThemeChange,
  language,
  onLanguageChange,
}: MenuBarProps): JSX.Element {
  const app = useApp();
  const { t } = app;
  // 布局按仓库隔离（D1）：未打开仓库时用空串表示全局默认。
  const repoId = app.repoId ?? "";
  const [open, setOpen] = useState<string | null>(null);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [layouts, setLayouts] = useState<string[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutName, setLayoutName] = useState("");
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number; name: string } | null>(
    null,
  );
  const [renamingLayout, setRenamingLayout] = useState<string | null>(null);
  const [renameLayoutValue, setRenameLayoutValue] = useState("");
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

  // 读取当前仓库的已保存布局名（首行为最近保存）
  const loadLayoutNames = useCallback(async () => {
    try {
      const items = await api.layoutList({ repoId });
      setLayouts(items.map((item) => item.name));
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
    const order = PANEL_DEFS.map((p) => p.id);
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
        app.status(t("layout.detachFailed", { err: String(e) }), "error");
      });
      dv?.getPanel(id)?.api.close();
      app.status(`${panelTitle(id, t)} → ${t("menubar.detach")}`, "ok");
    } catch (e) {
      app.status(t("layout.detachFailed", { err: String(e) }), "error");
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
        repoId,
        name,
        layoutJson: json,
        blueprintIds: boundId ? [boundId] : undefined,
      });
      await loadLayoutNames();
      app.status(`${t("menubar.layout.saved")}: ${name}`, "ok");
      app.refresh();
      closeMenus();
    } catch (e) {
      app.status(t("layout.saveFailed", { err: String(e) }), "error");
    }
  };

  const applyLayout = async (name: string) => {
    const dv = apiRef.current;
    if (!dv) return;
    try {
      const raw = await api.layoutGet({ repoId, name });
      if (!raw) {
        app.status(t("layout.notFound", { name }), "error");
        return;
      }
      const layout = JSON.parse(raw);
      // 补齐最小尺寸约束（旧布局未记录会回退到 dockview 默认 100×100）；
      // 媒体预览强制 renderer=always，避免 tab 切换丢滚动位置。
      dv.fromJSON(normalizeLayoutJson(layout));
      // 布局绑定蓝图：应用布局时激活其绑定的第一个蓝图（1 个布局可绑定多个蓝图）。
      if (repoId) {
        const bound = await api
          .layoutBlueprints({ repoId, name })
          .catch(() => [] as string[]);
        if (bound[0]) {
          const doc = await api.blueprintGet({
            repoId,
            blueprintId: bound[0],
          });
          if (doc) {
            blueprintEngine.setGraph(BlueprintEngine.parse(doc));
          }
        }
      }
      app.status(t("layout.loaded", { name }), "ok");
      closeMenus();
    } catch (e) {
      app.status(t("layout.loadFailed", { err: String(e) }), "error");
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
      await api.layoutRename({ repoId, name, newName: trimmed });
      await loadLayoutNames();
      app.status(t("layout.renamed", { name: trimmed }), "ok");
    } catch (e) {
      app.status(t("layout.renameFailed", { err: String(e) }), "error");
    }
  };

  const deleteLayout = async (name: string) => {
    setLayoutMenu(null);
    if (!window.confirm(t("menubar.layout.deleteConfirm"))) {
      return;
    }
    try {
      await api.layoutDelete({ repoId, name });
      await loadLayoutNames();
      app.status(t("layout.deleted", { name }), "ok");
    } catch (e) {
      app.status(t("layout.deleteFailed", { err: String(e) }), "error");
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
        repoId,
        name,
        layoutJson: json,
        blueprintIds: boundId ? [boundId] : undefined,
      });
      await loadLayoutNames();
      app.status(t("layout.updated", { name }), "ok");
      app.refresh();
    } catch (e) {
      app.status(t("layout.updateFailed", { err: String(e) }), "error");
    }
  };

  const setDefaultLayout = async (name: string) => {
    setLayoutMenu(null);
    try {
      await api.layoutSetDefault({ repoId, name });
      app.status(t("layout.defaultSet", { name }), "ok");
    } catch (e) {
      app.status(t("layout.defaultFailed", { err: String(e) }), "error");
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
                    </button>
                  ),
                )}
                {layouts.length === 0 && (
                  <span className="menu-item dim">{t("menubar.layout.empty")}</span>
                )}
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
                {PANEL_DEFS.map((p) => {
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
            <span className="menu-item dim">{t("menubar.extensionsHint")}</span>
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
        </ContextMenu>
      )}
    </div>
  );
}
