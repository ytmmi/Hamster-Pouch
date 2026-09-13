/**
 * 图像源组件 — 添加图像源（子菜单）+ 已添加图像源目录树（右键操作）。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../api";
import { useApp } from "../AppContext";
import type {
  ScanCompletedPayload,
  ScanErrorPayload,
  ScanProgressPayload,
  SourceTreeNode,
} from "../types";

/** 取路径最后一段文件夹名。 */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 文件夹图标（内联 SVG，currentColor）。 */
function FolderIcon(): JSX.Element {
  return (
    <svg
      className="tree-folder-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
    </svg>
  );
}

/** 展开箭头（内联 SVG，currentColor；展开时旋转 90°）。 */
function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="tree-chevron-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
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

/** 递归移除指定 source_id 的节点（卸载后本地即时更新）。 */
function removeBySourceId(
  nodes: SourceTreeNode[],
  sourceId: string,
): SourceTreeNode[] {
  return nodes
    .filter((n) => n.source_id !== sourceId)
    .map((n) => ({ ...n, children: removeBySourceId(n.children, sourceId) }));
}

export function SourcePanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [openAdd, setOpenAdd] = useState(false);
  const [localPath, setLocalPath] = useState("");
  const [alias, setAlias] = useState("");
  const [nodes, setNodes] = useState<SourceTreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ p: number; t: number } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setNodes([]);
      return;
    }
    try {
      setNodes(await api.sourceTree({ repoId: app.repoId }));
    } catch (e) {
      app.status(`图像源目录树加载失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

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
      setNodes((prev) =>
        prev.some((n) => n.source_id === s.id)
          ? prev
          : [
              ...prev,
              {
                key: `src:${s.id}`,
                name: s.alias ?? baseName(s.local_path),
                local_path: s.local_path,
                relative_path: null,
                source_id: s.id,
                file_count: 0,
                children: [],
              },
            ],
      );
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
      setNodes((prev) => removeBySourceId(prev, sourceId));
      app.status(`${t("common.unmount")} \u2713`, "ok");
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

  const pct =
    progress && progress.t > 0 ? Math.round((progress.p / progress.t) * 100) : 0;

  /** 递归渲染目录树节点。 */
  const renderNode = (
    node: SourceTreeNode,
    depth: number,
    ownerSourceId: string,
  ): JSX.Element => {
    const isSource = node.source_id !== null;
    const expanded = !collapsed.has(node.key);
    const hasChildren = node.children.length > 0;
    const indent = depth * 14;
    const selected = isSource
      ? app.sourceId === node.source_id && app.dirPath === null
      : app.sourceId === ownerSourceId && app.dirPath === node.relative_path;

    return (
      <Fragment key={node.key}>
        <div className="tree-node-wrap">
          <div
            className={`tree-node list-row${selected ? " selected" : ""}`}
            style={{ paddingLeft: indent }}
            onClick={
              isSource
                ? () => {
                    app.setSourceId(node.source_id!);
                    app.setDirPath(null);
                    app.setAlbumId(null);
                  }
                : () => {
                    app.setSourceId(ownerSourceId);
                    app.setDirPath(node.relative_path);
                    app.setAlbumId(null);
                  }
            }
            onContextMenu={
              isSource
                ? (e) => {
                    e.preventDefault();
                    app.setSourceId(node.source_id!);
                    app.setDirPath(null);
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      sourceId: node.source_id!,
                    });
                  }
                : undefined
            }
          >
            <span
              className={`tree-arrow${hasChildren ? "" : " is-empty"}${
                expanded ? " on" : ""
              }`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) {
                  toggle(node.key);
                }
              }}
            >
              {hasChildren ? <ChevronIcon /> : null}
            </span>
            <span className="tree-folder">
              <FolderIcon />
            </span>
            <span className="source-name">{node.name}</span>
            <span className="tree-count">{node.file_count}</span>
          </div>

          {isSource && node.local_path && (
            <div className="tree-path" style={{ paddingLeft: indent + 28 }}>
              <PathText path={node.local_path} />
            </div>
          )}
        </div>

        {expanded &&
          hasChildren &&
          node.children.map((child) =>
            renderNode(child, depth + 1, ownerSourceId),
          )}
      </Fragment>
    );
  };

  return (
    <div className="panel">
      {!app.repoId && (
        <span className="placeholder">{t("common.pleaseOpenRepo")}</span>
      )}
      {app.repoId && (
        <>
          {/* 添加图像源（点击 → 子菜单） */}
          <button className="menu-item has-sub" onClick={() => setOpenAdd((v) => !v)}>
            {t("source.add")}{" "}
            <span className="sub-arrow">{openAdd ? "\u25BE" : "\u25B8"}</span>
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
                  {"\u2713"}
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

          {/* 已添加的图像源目录树（右键操作） */}
          <div className="section-title">
            {t("source.list")}（{nodes.length}）
          </div>
          <div className="list source-list">
            {nodes.map((n) => renderNode(n, 0, n.source_id!))}
            {nodes.length === 0 && (
              <span className="placeholder">{t("common.noFile")}</span>
            )}
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
