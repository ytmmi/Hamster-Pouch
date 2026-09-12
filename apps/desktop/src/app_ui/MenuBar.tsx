/**
 * 顶部功能条 — 设置 / 窗口 / 扩展（全局，非面板）。
 *
 * 窗口菜单：显示/隐藏面板、重置布局、面板独立为系统窗口。
 */

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useApp } from "./AppContext";
import { PANEL_DEFS, panelTitle } from "./panelRegistry";

export interface MenuBarProps {
  apiRef: MutableRefObject<DockviewApi | null>;
}

export function MenuBar({ apiRef }: MenuBarProps): JSX.Element {
  const app = useApp();
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
      api.addPanel({ id, component: id, title: panelTitle(id) });
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
        api.addPanel({ id, component: id, title: panelTitle(id) });
      } else {
        api.addPanel({
          id,
          component: id,
          title: panelTitle(id),
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
        url: `index.html?panel=${id}${repo}`,
        title: `仓鼠颊 · ${panelTitle(id)}`,
        width: 900,
        height: 620,
      });
      void win.once("tauri://error", (e) => {
        app.status(`独立窗口创建失败: ${String(e)}`, "error");
      });
      api?.getPanel(id)?.api.close();
      app.status(`面板已独立为窗口: ${panelTitle(id)}`, "ok");
    } catch (e) {
      app.status(`独立窗口创建失败: ${String(e)}`, "error");
    }
    setOpen(null);
  };

  return (
    <div className="menubar" ref={rootRef}>
      <span className="menubar-brand">仓鼠颊</span>

      <div className="menu">
        <button className="menu-btn" onClick={() => setOpen(open === "settings" ? null : "settings")}>
          设置
        </button>
        {open === "settings" && (
          <div className="menu-pop">
            <span className="menu-item dim">设置项将在后续里程碑提供</span>
          </div>
        )}
      </div>

      <div className="menu">
        <button className="menu-btn" onClick={() => setOpen(open === "window" ? null : "window")}>
          窗口
        </button>
        {open === "window" && (
          <div className="menu-pop">
            <button className="menu-item" onClick={resetLayout}>
              重置布局
            </button>
            <div className="menu-sep" />
            {PANEL_DEFS.map((p) => {
              const exists = Boolean(apiRef.current?.getPanel(p.id));
              return (
                <div key={p.id} className="menu-item-row">
                  <button className="menu-item grow" onClick={() => togglePanel(p.id)}>
                    {exists ? "✓ " : "　"}
                    {p.title}
                  </button>
                  <button
                    className="menu-item small"
                    title="独立为系统窗口"
                    onClick={() => detachPanel(p.id)}
                  >
                    独立
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="menu">
        <button className="menu-btn" onClick={() => setOpen(open === "ext" ? null : "ext")}>
          扩展
        </button>
        {open === "ext" && (
          <div className="menu-pop">
            <span className="menu-item dim">插件与 AI 扩展将在 M5 提供</span>
          </div>
        )}
      </div>
    </div>
  );
}
