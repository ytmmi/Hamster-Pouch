/**
 * 媒体源组件 — 添加媒体源（选取文件夹）+ 已添加媒体源目录树（右键操作）。
 *
 * 添加流程：点「添加媒体源」→ 原生对话框选取文件夹 → 以**文件夹名为默认源名称**挂载；
 * 别名不在添加时填写，只能在添加后于条目上重命名。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import { getTask, setTask, useTask } from "../core/taskStore";
import { ContextMenu } from "../menu/ContextMenu";
import type { SourceTreeNode } from "../shared/types";

/** 取路径最后一段文件夹名。 */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 路径比较：同一文件夹只应挂载一次（Windows 路径忽略大小写，统一分隔符与末尾斜杠）。 */
function samePath(a: string, b: string): boolean {
  const isWindowsPath = (p: string) => p.includes("\\") || /^[A-Za-z]:/.test(p);
  const normalize = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const na = normalize(a);
  const nb = normalize(b);
  if (isWindowsPath(a) || isWindowsPath(b)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
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
  /** 右键目标相对路径：源根为 null，子文件夹为该节点 relative_path。 */
  relativePath: string | null;
  /** 右键目标显示名（用于「复制为相册」的相册名）。 */
  name: string;
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
  // 任务进度走独立 store：进度变化只重渲染本面板与浮窗，不再波及所有面板
  const task = useTask();
  const [nodes, setNodes] = useState<SourceTreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setNodes([]);
      return;
    }
    try {
      setNodes(await api.sourceTree({ repoId: app.repoId }));
    } catch (e) {
      app.status(app.t("source.treeFailed", { err: errorTextOf(app.t, e) }), "error");
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

  // 扫描事件订阅已上移到应用层（core/AppUiApp → core/ScanOverlay）：
  // 进度浮窗与"完成即刷新"不再依赖本面板是否挂载。

  /**
   * 添加媒体源：选取文件夹 → 以文件夹名为默认名称挂载。
   * 不在添加时填别名（别名只能添加后在条目上重命名）。
   */
  const addSource = async () => {
    if (!app.repoId) {
      app.status(t("common.pleaseOpenRepo"), "error");
      return;
    }
    let picked: string | null;
    try {
      picked = await api.pickFolder(t("source.pickFolderTitle"));
    } catch (e) {
      app.status(t("source.pickFailed", { err: errorTextOf(app.t, e) }), "error");
      return;
    }
    if (!picked) {
      return; // 用户取消
    }
    // 同一文件夹只挂载一次：已添加则直接选中，避免重复条目
    const existing = nodes.find(
      (n) => n.local_path !== null && samePath(n.local_path, picked),
    );
    if (existing?.source_id) {
      app.setSourceId(existing.source_id);
      app.setDirPath(null);
      app.setAlbumId(null);
      app.status(t("source.alreadyAdded", { name: existing.name }), "info");
      return;
    }
    const name = baseName(picked);
    try {
      const s = await api.sourceMount({ repoId: app.repoId, localPath: picked });
      // 立即入列，避免等待刷新
      setNodes((prev) =>
        prev.some((n) => n.source_id === s.id)
          ? prev
          : [
              ...prev,
              {
                key: `src:${s.id}`,
                name: s.alias ?? name,
                local_path: s.local_path,
                relative_path: null,
                source_id: s.id,
                file_count: 0,
                children: [],
              },
            ],
      );
      app.status(t("source.added", { name: s.alias ?? name }), "ok");
      app.refresh();
    } catch (e) {
      app.status(t("source.mountFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /** 开始重命名已添加媒体源的别名（添加时不可填）。 */
  const beginRename = (node: SourceTreeNode) => {
    setMenu(null);
    setRenameId(node.source_id);
    setRenameValue(node.name);
  };

  /** 提交别名重命名。 */
  const commitRename = async () => {
    if (!app.repoId || !renameId) return;
    const alias = renameValue.trim();
    if (!alias) {
      app.status(t("source.renameEmpty"), "error");
      return;
    }
    try {
      await api.sourceRename({ repoId: app.repoId, sourceId: renameId, alias });
      setNodes((prev) =>
        prev.map((n) => (n.source_id === renameId ? { ...n, name: alias } : n)),
      );
      app.status(t("source.renamed", { name: alias }), "ok");
      setRenameId(null);
      setRenameValue("");
      app.refresh();
    } catch (e) {
      app.status(t("source.renameFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  // 重命名输入框自动聚焦
  useEffect(() => {
    if (renameId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renameId]);

  /**
   * 卸载媒体源：先取影响预估 → 弹出警告（与进度浮窗同款）告知**不可恢复**的后果 →
   * 确认后在后台执行（带进度浮窗）。源在标记离线后立即从列表消失。
   */
  const unmount = async (sourceId: string) => {
    if (!app.repoId) return;
    const node = nodes.find((n) => n.source_id === sourceId);
    const name = node?.name ?? sourceId;

    let preview: Awaited<ReturnType<typeof api.sourceUnmountPreview>>;
    try {
      preview = await api.sourceUnmountPreview({ repoId: app.repoId, sourceId });
    } catch (e) {
      app.status(t("source.unmountFailed", { err: errorTextOf(app.t, e) }), "error");
      return;
    }

    const confirmed = await app.askConfirm({
      title: t("unmount.confirmTitle", { name }),
      message: t("unmount.confirmBody", {
        files: preview.file_count,
        tags: preview.tag_count,
        ratings: preview.rating_count,
        colors: preview.color_count,
        members: preview.member_count,
        albums: preview.albums.length,
      }),
      warning: t("unmount.confirmWarn"),
      details: preview.albums.map((a) => `${a.name}（${a.members}）`),
      detailsTitle:
        preview.albums.length > 0
          ? t("unmount.confirmDetails", { count: preview.albums.length })
          : undefined,
      confirmLabel: t("common.unmount"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (!confirmed) return;

    // 卸载的正是当前选中源时清掉选中，避免媒体预览停在一个已离线的源上
    if (app.sourceId === sourceId) {
      app.setSourceId(null);
      app.setDirPath(null);
    }
    // 立即挂上进度浮窗（后端第一帧进度到达前也要有反馈）
    setTask({
      titleKey: "unmount.title",
      sourceId,
      subtitle: name,
      messageKey: "unmount.preparing",
      messageParams: {},
      processed: 0,
      total: 0,
      current: null,
      // 卸载可取消：后端的清理循环在相册之间采样取消标志，不会把界面锁死
      cancellable: true,
      updatedAt: Date.now(),
    });

    try {
      await api.sourceUnmount({ repoId: app.repoId, sourceId });
      // 完成/失败由事件驱动（taskStore 会收尾并刷新）
    } catch (e) {
      setTask(null);
      app.status(t("source.unmountFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /**
   * 发起扫描。进度与完成事件由应用层集中订阅并渲染居中浮窗
   * （见 `core/TaskOverlay.tsx`），面板只负责发起与提示。
   */
  const scan = async (sourceId: string, full: boolean) => {
    if (!app.repoId) return;
    if (getTask()) {
      app.status(t("task.busy"), "info");
      return;
    }
    const name = nodes.find((n) => n.source_id === sourceId)?.name ?? null;
    try {
      await api.sourceScan({ repoId: app.repoId, sourceId, full });
      // 立刻置为"遍历中、总数未知"：后端第一帧进度可能还要等一会儿才到
      setTask({
        titleKey: "scan.title",
        sourceId,
        subtitle: name,
        messageKey: "scan.walking",
        messageParams: { count: 0 },
        processed: 0,
        total: 0,
        current: null,
        cancellable: true,
        updatedAt: Date.now(),
      });
      app.status(t("source.scanStarted"), "info");
    } catch (e) {
      app.status(t("source.scanStartFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  // 复制为相册：基于源（或子文件夹）创建跟随源相册并立即同步
  const copyAsAlbum = async (
    sourceId: string,
    relativePath: string | null,
    name: string,
  ) => {
    if (!app.repoId) return;
    try {
      const r = await api.albumCreate({
        repoId: app.repoId,
        name,
        kind: "follow_source",
        sourceId,
        syncMode: "mirror",
        includeSubsources: false,
        filterJson: relativePath
          ? JSON.stringify({ dirPrefix: relativePath })
          : undefined,
      });
      await api.albumSync({ repoId: app.repoId, albumId: r.album_id });
      app.status(t("source.copiedAsAlbum", { name }), "ok");
      app.setAlbumId(r.album_id);
      app.setSourceId(null);
      app.refresh();
    } catch (e) {
      app.status(t("source.copyAsAlbumFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

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
    // 重命名只针对源根节点（改名即改媒体源别名）。
    const renaming = isSource && renameId === node.source_id;
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
              renaming
                ? undefined
                : isSource
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
            onContextMenu={(e) => {
              e.preventDefault();
              if (isSource) {
                // 源根节点：右键同步选中，不切换预览
                app.setSourceId(node.source_id!);
                app.setDirPath(null);
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  sourceId: node.source_id!,
                  relativePath: null,
                  name: node.name,
                });
              } else {
                // 子文件夹节点：右键也打开同一菜单，sourceId 取所属源
                app.setSourceId(ownerSourceId);
                app.setDirPath(node.relative_path);
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  sourceId: ownerSourceId,
                  relativePath: node.relative_path,
                  name: node.name,
                });
              }
            }}
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
            {renaming ? (
              // 重命名只改「已添加媒体源」的别名，源路径不变
              <span className="rename-row" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={renameRef}
                  className="menu-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void commitRename();
                    } else if (e.key === "Escape") {
                      setRenameId(null);
                    }
                  }}
                />
                <button className="menu-item small" onClick={() => void commitRename()}>
                  {"\u2713"}
                </button>
                <button
                  className="menu-item small"
                  onClick={() => setRenameId(null)}
                  title={t("common.cancel")}
                >
                  {"\u2715"}
                </button>
              </span>
            ) : (
              <span className="source-name">{node.name}</span>
            )}
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
          {/* 添加媒体源：选取文件夹，源名称默认取文件夹名 */}
          <button className="menu-item" onClick={() => void addSource()}>
            {t("source.add")}
          </button>

          {/* 扫描进度改由应用层居中浮窗显示（core/ScanOverlay.tsx），面板不再内嵌进度条 */}

          {/* 已添加的媒体源目录树（右键操作） */}
          <div className="section-title">
            {t("source.list")}（{nodes.length}）
          </div>
          <div className="list source-list">
            {nodes.map((n) => renderNode(n, 0, n.source_id!))}
            {nodes.length === 0 && (
              <span className="placeholder">{t("source.noSource")}</span>
            )}
          </div>

          {/* 右键上下文菜单 */}
          {menu && (
            <ContextMenu x={menu.x} y={menu.y}>
              <button
                className="menu-item"
                disabled={task !== null}
                onClick={() => {
                  void scan(menu.sourceId, false);
                  setMenu(null);
                }}
              >
                {t("common.scan")}
              </button>
              <button
                className="menu-item"
                disabled={task !== null}
                onClick={() => {
                  void scan(menu.sourceId, true);
                  setMenu(null);
                }}
              >
                {t("common.fullScan")}
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  void copyAsAlbum(menu.sourceId, menu.relativePath, menu.name);
                  setMenu(null);
                }}
              >
                {t("source.copyAsAlbum")}
              </button>
              {menu.relativePath === null && (
                <>
                  <div className="menu-sep" />
                  {/* 别名只能在添加之后修改 */}
                  <button
                    className="menu-item"
                    onClick={() => {
                      const node = nodes.find((n) => n.source_id === menu.sourceId);
                      if (node) {
                        beginRename(node);
                      } else {
                        setMenu(null);
                      }
                    }}
                  >
                    {t("common.rename")}
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
                </>
              )}
            </ContextMenu>
          )}
        </>
      )}
    </div>
  );
}
