/**
 * tag表 — 仓库 tag 层级树（D22）。
 *
 * - 层级树：展开/折叠、缩进、tag 图标、右侧文件计数；
 * - 交叉关联：多父级 tag 在每个上级下各出现一次，名称以浅蓝色标示；
 * - 右键菜单：新增同级标签 / 新增子标签 / 重命名。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import { ContextMenu } from "../menu/ContextMenu";
import type { TagTreeNode } from "../shared/types";

/** 树过滤：保留自身或后代满足条件的节点。 */
function filterTree(
  nodes: TagTreeNode[],
  pred: (n: TagTreeNode) => boolean,
): TagTreeNode[] {
  const out: TagTreeNode[] = [];
  for (const n of nodes) {
    const kids = filterTree(n.children, pred);
    if (pred(n) || kids.length > 0) {
      out.push({ ...n, children: kids });
    }
  }
  return out;
}

/** tag 图标（内联 SVG，避免外部资源）。 */
function TagIcon(): JSX.Element {
  return (
    <svg className="tag-tree-icon" viewBox="0 0 16 16" width="12" height="12">
      <path
        d="M2 2.8C2 2.36 2.36 2 2.8 2h5.1c.21 0 .42.08.57.24l5.3 5.3c.31.31.31.82 0 1.13l-5.1 5.1a.8.8 0 0 1-1.13 0l-5.3-5.3A.8.8 0 0 1 2 7.9V2.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="5.4" cy="5.4" r="1" fill="currentColor" />
    </svg>
  );
}

interface CreateState {
  mode: "root" | "sibling" | "child";
  refId?: string;
  refName?: string;
}

interface MenuState {
  x: number;
  y: number;
  node: TagTreeNode;
}

export function TagTablePanel(): JSX.Element {
  const app = useApp();
  const [roots, setRoots] = useState<TagTreeNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");
  const [crossOnly, setCrossOnly] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [creating, setCreating] = useState<CreateState | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const createRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setRoots([]);
      return;
    }
    try {
      setRoots(await api.tagTree(app.repoId));
    } catch (e) {
      app.status(`tag表加载失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.repoId, app.refreshKey]);

  useEffect(() => {
    if (creating) {
      createRef.current?.focus();
    }
  }, [creating]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openMenu = (e: ReactMouseEvent, node: TagTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const startCreate = (mode: CreateState["mode"], node?: TagTreeNode) => {
    setCreating({ mode, refId: node?.id, refName: node?.name });
    setCreateValue("");
    setMenu(null);
  };

  const commitCreate = async () => {
    const name = createValue.trim();
    if (!name || !app.repoId || !creating) {
      setCreating(null);
      return;
    }
    try {
      if (creating.mode === "root") {
        await api.tagCreateRoot(app.repoId, name);
      } else if (creating.mode === "child" && creating.refId) {
        await api.tagCreateChild(app.repoId, creating.refId, name);
      } else if (creating.mode === "sibling" && creating.refId) {
        await api.tagCreateSibling(app.repoId, creating.refId, name);
      }
      setCreating(null);
      setCreateValue("");
      app.refresh();
    } catch (e) {
      app.status(`新建标签失败: ${String(e)}`, "error");
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    try {
      await api.tagRename(renaming.id, name);
      setRenaming(null);
      app.refresh();
    } catch (e) {
      app.status(`重命名失败: ${String(e)}`, "error");
    }
  };

  /** 拖到某 tag 上：移动为该 tag 的子级（替换原上级）。 */
  const dropOnNode = async (target: TagTreeNode) => {
    if (!app.repoId || !dragId || dragId === target.id) return;
    try {
      await api.tagMove(dragId, target.id);
      setDragId(null);
      setDropTargetId(null);
      app.refresh();
    } catch (e) {
      app.status(`移动失败: ${String(e)}`, "error");
    }
  };

  /** 拖到空白区域：移到根（解除全部上级）。 */
  const dropOnRoot = async () => {
    if (!app.repoId || !dragId) return;
    try {
      await api.tagMove(dragId, null);
      setDragId(null);
      setDropTargetId(null);
      app.refresh();
    } catch (e) {
      app.status(`移动失败: ${String(e)}`, "error");
    }
  };

  const kw = keyword.trim().toLowerCase();
  let shown = roots;
  if (kw) {
    shown = filterTree(shown, (n) => n.name.toLowerCase().includes(kw));
  }
  if (crossOnly) {
    shown = filterTree(shown, (n) => n.is_cross);
  }

  const renderNodes = (nodes: TagTreeNode[], depth: number, parentKey: string) =>
    nodes.map((node) => {
      const key = `${parentKey}/${node.id}`;
      const hasKids = node.children.length > 0;
      const isCollapsed = collapsed.has(key);
      const isRenaming = renaming?.id === node.id;
      return (
        <div key={key}>
          <div
            className="tag-tree-row"
            data-drop={dropTargetId === node.id ? "1" : undefined}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable
            onContextMenu={(e) => openMenu(e, node)}
            onDragStart={(e) => {
              setDragId(node.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropTargetId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragId && dragId !== node.id) setDropTargetId(node.id);
            }}
            onDragLeave={() =>
              setDropTargetId((cur) => (cur === node.id ? null : cur))
            }
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void dropOnNode(node);
            }}
          >
            <span
              className="tag-tree-arrow"
              onClick={() => hasKids && toggleCollapse(key)}
            >
              {hasKids ? (isCollapsed ? "▶" : "▼") : ""}
            </span>
            <TagIcon />
            {isRenaming ? (
              <input
                className="tag-tree-rename"
                value={renaming.value}
                autoFocus
                onChange={(e) => setRenaming({ id: node.id, value: e.target.value })}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename();
                  else if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span
                className={node.is_cross ? "tag-tree-name cross" : "tag-tree-name"}
                onDoubleClick={() => setRenaming({ id: node.id, value: node.name })}
              >
                {node.name}
              </span>
            )}
            <span className="tag-tree-count">{node.count}</span>
          </div>
          {!isCollapsed && hasKids && renderNodes(node.children, depth + 1, key)}
        </div>
      );
    });

  return (
    <div className="panel tag-table" onClick={() => setMenu(null)}>
      {!app.repoId && (
        <span className="placeholder">{app.t("common.selectRepo")}</span>
      )}
      {app.repoId && (
        <>
          <div className="tag-tree-toolbar">
            <span className="tag-tree-title">
              {app.t("panel.tagtable")} <span className="dim">▼</span>
            </span>
            <span className="tag-tree-actions">
              <button
                className={crossOnly ? "icon-btn on" : "icon-btn"}
                title={app.t("tagtable.crossOnly")}
                onClick={() => setCrossOnly((v) => !v)}
              >
                🔖
              </button>
              <input
                className="tag-tree-search"
                value={keyword}
                placeholder={app.t("tagtable.search")}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <button
                className="icon-btn"
                title={app.t("tagtable.newRoot")}
                onClick={() => startCreate("root")}
              >
                ＋
              </button>
            </span>
          </div>

          {creating && (
            <div className="tag-tree-create">
              <span className="dim">
                {creating.mode === "root"
                  ? app.t("tagtable.newRoot")
                  : creating.mode === "child"
                    ? `${app.t("tagtable.newChild")} → ${creating.refName}`
                    : `${app.t("tagtable.newSibling")} → ${creating.refName}`}
              </span>
              <input
                ref={createRef}
                value={createValue}
                placeholder={app.t("tagtable.createHint")}
                onChange={(e) => setCreateValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitCreate();
                  else if (e.key === "Escape") setCreating(null);
                }}
              />
            </div>
          )}

          <div
            className="tag-tree-body"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void dropOnRoot();
            }}
          >
            {renderNodes(shown, 0, "")}
            {shown.length === 0 && (
              <span className="placeholder">{app.t("tagtable.empty")}</span>
            )}
          </div>

          {menu && (
            <ContextMenu x={menu.x} y={menu.y}>
              <button
                className="menu-item"
                onClick={() => startCreate("sibling", menu.node)}
              >
                {app.t("tagtable.newSibling")}
              </button>
              <button
                className="menu-item"
                onClick={() => startCreate("child", menu.node)}
              >
                {app.t("tagtable.newChild")}
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setRenaming({ id: menu.node.id, value: menu.node.name });
                  setMenu(null);
                }}
              >
                {app.t("tagtable.rename")}
              </button>
            </ContextMenu>
          )}
        </>
      )}
    </div>
  );
}
