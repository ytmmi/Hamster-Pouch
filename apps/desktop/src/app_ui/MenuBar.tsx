/**
 * 顶部功能条 — 设置 / 窗口 / 扩展（全局，非面板）。
 *
 * 窗口菜单：显示/隐藏面板、重置布局、面板独立为系统窗口。
 */

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useApp } from "./AppContext";
import { LANGUAGES, type Language } from "./i18n";
import { PANEL_DEFS, panelTitle } from "./panelRegistry";

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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const togglePanel = (id: string) => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.close();
    } else {
      api.addPanel({ id, component: id, title: panelTitle(id, t) });
    }
    setOpen(null);
  };

  const resetLayout = () => {
    const api = apiRef.current;
    if (!api) return;
    api.clear();
    const order = PANEL_DEFS.map((p) => p.id);
    order.forEach((id, index) => {
      if (index === 0) {
        api.addPanel({ id, component: id, title: panelTitle(id, t) });
      } else {
        api.addPanel({
          id,
          component: id,
          title: panelTitle(id, t),
          position: { referencePanel: order[0], direction: "within" },
        });
      }
    });
    setOpen(null);
  };

  const detachPanel = (id: string) => {
    const api = apiRef.current;
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
      api?.getPanel(id)?.api.close();
      app.status(`${panelTitle(id, t)} → ${t("menubar.detach")}`, "ok");
    } catch (e) {
      app.status(`${t("menubar.detach")}失败: ${String(e)}`, "error");
    }
    setOpen(null);
  };

  return (
    <div className="menubar" ref={rootRef}>
      <span className="menubar-brand">{t("app.name")}</span>

      <div className="menu">
        <button
          className="menu-btn"
          onClick={() => setOpen(open === "settings" ? null : "settings")}
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

      <div className="menu">
        <button
          className="menu-btn"
          onClick={() => setOpen(open === "window" ? null : "window")}
        >
          {t("menubar.window")}
        </button>
        {open === "window" && (
          <div className="menu-pop">
            <button className="menu-item" onClick={resetLayout}>
              {t("menubar.resetLayout")}
            </button>
            <div className="menu-sep" />
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

      <div className="menu">
        <button className="menu-btn" onClick={() => setOpen(open === "ext" ? null : "ext")}>
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
