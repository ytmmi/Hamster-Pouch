/**
 * 图像源组件 — 添加图像源（子菜单）+ 已添加的图像源列表（右键操作）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../api";
import { useApp } from "../AppContext";
import type {
  ScanCompletedPayload,
  ScanErrorPayload,
  ScanProgressPayload,
  SourceItem,
} from "../types";

/** 取路径最后一段文件夹名。 */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 路径文本：过长省略尾部；悬停时滚轮可水平滚动查看完整路径。 */
function PathText({ path }: { path: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <span ref={ref} className="source-path" title={path}>
      {path}
    </span>
  );
}

interface ContextMenuState {
  x: number;
  y: number;
  sourceId: string;
}

export function SourcePanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [openAdd, setOpenAdd] = useState(false);
  const [localPath, setLocalPath] = useState("");
  const [alias, setAlias] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [progress, setProgress] = useState<{ p: number; t: number } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setSources([]);
      return;
    }
    try {
      setSources(await api.sourceList({ repoId: app.repoId }));
    } catch (e) {
      app.status(`图像源列表失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  // 点击任意处关闭右键菜单
  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  // 扫描事件订阅
  useEffect(() => {
    void (async () => {
      try {
        unlistenRef.current.push(
          await listen<ScanProgressPayload>("scan.progress", (e) =>
            setProgress({ p: e.payload.processed, t: e.payload.total }),
          ),
          await listen<ScanCompletedPayload>("scan.completed", (e) => {
            app.status(
              `扫描完成: 索引 ${e.payload.indexed} / 变更 ${e.payload.changed} / 缺失 ${e.payload.missing}`,
              "ok",
            );
            setProgress(null);
            app.refresh();
          }),
          await listen<ScanErrorPayload>("scan.error", (e) => {
            app.status(`扫描错误: ${e.payload.error}`, "error");
            setProgress(null);
          }),
        );
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
    return () => {
      for (const fn of unlistenRef.current) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  }, [app]);

  const mount = async () => {
    if (!app.repoId || !localPath.trim()) {
      app.status(t("source.pathPlaceholder"), "error");
      return;
    }
    try {
      const s = await api.sourceMount({
        repoId: app.repoId,
        localPath: localPath.trim(),
        alias: alias.trim() || undefined,
      });
      // 立即入列，避免等待刷新
      setSources((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]));
      app.status(`${t("source.add")}: ${s.alias ?? baseName(s.local_path)}`, "ok");
      setLocalPath("");
      setAlias("");
      setOpenAdd(false);
      app.refresh();
    } catch (e) {
      app.status(`挂载失败: ${String(e)}`, "error");
    }
  };

  const unmount = async (sourceId: string) => {
    if (!app.repoId) return;
    try {
      await api.sourceUnmount({ repoId: app.repoId, sourceId });
      setSources((prev) => prev.filter((x) => x.id !== sourceId));
      app.status(`${t("common.unmount")} ✓`, "ok");
      app.refresh();
    } catch (e) {
      app.status(`卸载失败: ${String(e)}`, "error");
    }
  };

  const scan = async (sourceId: string, full: boolean) => {
    if (!app.repoId) return;
    try {
      setProgress({ p: 0, t: 0 });
      await api.sourceScan({ repoId: app.repoId, sourceId, full });
      app.status("扫描已启动", "info");
    } catch (e) {
      app.status(`启动扫描失败: ${String(e)}`, "error");
      setProgress(null);
    }
  };

  const pct = progress && progress.t > 0 ? Math.round((progress.p / progress.t) * 100) : 0;

  return (
    <div className="panel">
      {!app.repoId && <span className="placeholder">{t("common.pleaseOpenRepo")}</span>}
      {app.repoId && (
        <>
          {/* 添加图像源（点击 → 子菜单） */}
          <button className="menu-item has-sub" onClick={() => setOpenAdd((v) => !v)}>
            {t("source.add")}{" "}
            <span className="sub-arrow">{openAdd ? "▾" : "▸"}</span>
          </button>
          {openAdd && (
            <div className="menu-sub">
              <div className="menu-item-row">
                <input
                  className="menu-input"
                  value={localPath}
                  autoFocus
                  placeholder={t("source.pathPlaceholder")}
                  onChange={(e) => setLocalPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void mount();
                    }
                  }}
                />
              </div>
              <div className="menu-item-row">
                <input
                  className="menu-input"
                  value={alias}
                  placeholder={t("source.aliasPlaceholder")}
                  onChange={(e) => setAlias(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void mount();
                    }
                  }}
                />
                <button className="menu-item small" onClick={() => void mount()}>
                  ✓
                </button>
              </div>
            </div>
          )}

          {progress && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <button className="danger" onClick={() => void api.taskCancel()}>
                {t("common.cancel")}
              </button>
            </div>
          )}

          {/* 已添加的图像源（右键操作） */}
          <div className="section-title">
            {t("source.list")}（{sources.length}）
          </div>
          <div className="list source-list">
            {sources.map((s) => (
              <div
                key={s.id}
                className={`list-row source-row ${
                  app.sourceId === s.id ? "selected" : ""
                }`}
                onClick={() => app.setSourceId(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  app.setSourceId(s.id);
                  setMenu({ x: e.clientX, y: e.clientY, sourceId: s.id });
                }}
              >
                <span className="source-name">{s.alias ?? baseName(s.local_path)}</span>
                <PathText path={s.local_path} />
              </div>
            ))}
            {sources.length === 0 && <span className="placeholder">{t("common.noFile")}</span>}
          </div>

          {/* 右键上下文菜单 */}
          {menu && (
            <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
              <button
                className="menu-item"
                onClick={() => {
                  void scan(menu.sourceId, false);
                  setMenu(null);
                }}
              >
                {t("common.scan")}
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void scan(menu.sourceId, true);
                  setMenu(null);
                }}
              >
                {t("common.fullScan")}
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => {
                  void unmount(menu.sourceId);
                  setMenu(null);
                }}
              >
                {t("common.unmount")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
