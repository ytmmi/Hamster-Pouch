/**
 * 顶部功能条 — 设置 / 窗口 / 扩展（全局，非面板）。
 *
 * 窗口菜单：布局（保存/加载）、组件（显示/隐藏/独立）、重置布局。
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import * as api from "./api";
import { useApp } from "./AppContext";
import { LANGUAGES, type Language } from "./i18n";
import { PANEL_DEFS, panelTitle } from "./panelRegistry";

const LAYOUT_NAMES_KEY = "layout.names";
const layoutKey = (name: string) => `layout.${name}`;

/** 媒体预览面板必须保持 DOM（renderer=always），否则同组 tab 切换会丢失滚动位置。 */
const MEDIA_PANEL_ID = "media";
const panelExtra = (id: string): { renderer?: "always" } =>
  id === MEDIA_PANEL_ID ? { renderer: "always" } : {};

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
  const [open, setOpen] = useState<string | null>(null);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [layouts, setLayouts] = useState<string[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutName, setLayoutName] = useState("");
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

  // 读取已保存布局名（首行为最近保存）
  const loadLayoutNames = useCallback(async () => {
    try {
      const raw = await api.settingGet({ key: LAYOUT_NAMES_KEY });
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setLayouts(
        Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [],
      );
    } catch {
      setLayouts([]);
    }
  }, []);

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
        app.status(`${t("menubar.detach")}失败: ${String(e)}`, "error");
      });
      dv?.getPanel(id)?.api.close();
      app.status(`${panelTitle(id, t)} → ${t("menubar.detach")}`, "ok");
    } catch (e) {
      app.status(`${t("menubar.detach")}失败: ${String(e)}`, "error");
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
      const json = JSON.stringify(dv.toJSON());
      const next = [name, ...layouts.filter((n) => n !== name)];
      await api.settingSet({ key: layoutKey(name), value: json });
      await api.settingSet({ key: LAYOUT_NAMES_KEY, value: JSON.stringify(next) });
      setLayouts(next);
      app.status(`${t("menubar.layout.saved")}: ${name}`, "ok");
      closeMenus();
    } catch (e) {
      app.status(`保存布局失败: ${String(e)}`, "error");
    }
  };

  const applyLayout = async (name: string) => {
    const dv = apiRef.current;
    if (!dv) return;
    try {
      const raw = await api.settingGet({ key: layoutKey(name) });
      if (!raw) {
        app.status(`布局不存在: ${name}`, "error");
        return;
      }
      const layout = JSON.parse(raw);
      // 布局 JSON 不保存 renderer，加载后媒体预览会退回 onlyWhenVisible 导致滚动丢失
      if (layout?.panels?.[MEDIA_PANEL_ID]) {
        layout.panels[MEDIA_PANEL_ID].renderer = "always";
      }
      dv.fromJSON(layout);
      app.status(`已加载布局: ${name}`, "ok");
      closeMenus();
    } catch (e) {
      app.status(`加载布局失败: ${String(e)}`, "error");
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
            <div className="menu-item-row">
              <span className="menu-label">{t("menubar.theme")}</span>
              <button
                className={`menu-item small ${theme === "light" ? "on" : ""}`}
                onClick={() => onThemeChange("light")}
              >
                {t("menubar.theme.light")}
              </button>
              <button
                className={`menu-item small ${theme === "dark" ? "on" : ""}`}
                onClick={() => onThemeChange("dark")}
              >
                {t("menubar.theme.dark")}
              </button>
            </div>
            <div className="menu-sep" />
            <div className="menu-item-row">
              <span className="menu-label">{t("menubar.language")}</span>
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.id}
                  className={`menu-item small ${language === lang.id ? "on" : ""}`}
                  onClick={() => onLanguageChange(lang.id)}
                >
                  {t(lang.labelKey)}
                </button>
              ))}
            </div>
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
                {layouts.map((name, index) => (
                  <button
                    key={name}
                    className={`menu-item ${index === 0 ? "first" : ""}`}
                    onClick={() => void applyLayout(name)}
                  >
                    {name}
                  </button>
                ))}
                {layouts.length === 0 && (
                  <span className="menu-item dim">{t("menubar.layout.empty")}</span>
                )}
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

            <div className="menu-sep" />
            <button className="menu-item" onClick={resetLayout}>
              {t("menubar.resetLayout")}
            </button>
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
    </div>
  );
}
