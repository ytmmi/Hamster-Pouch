/**
 * tag表 — 仓库 tag 层级树（D22）。
 *
 * - 层级树：展开/折叠、缩进、tag 图标、右侧文件计数；
 * - 交叉关联：多父级 tag 在每个上级下各出现一次，名称以浅蓝色标示；
 * - 右键菜单：新增同级标签 / 新增子标签 / 重命名；
 * - 新增：先插入空白临时标签行并聚焦输入，回车确认；不命名则丢弃临时行；
 * - 拖拽 = 移动（拖到 tag 上成为其子级，拖到空白移到根）；
 * - **媒体拖放打标（D117）**：从媒体预览拖来单选/多选的文件（载荷
 *   `application/x-hp-files`）悬停在某个 tag 上时该行出现**蓝色框**，放下即把这些
 *   文件加进该 tag（按 tag 名调 `tag.add`，同名幂等 → 命中同一 tag 实体），随后
 *   `app.refresh()` 让「标签 评分」面板（依赖 `refreshKey`）同步刷新。
 *   媒体载荷与 tag 移动载荷靠 `dataTransfer.types` 区分：拖拽过程中只有 `types`
 *   可读（`getData` 受保护模式限制），因此判据必须写在 `onDragOver` 里。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import { ContextMenu } from "../menu/ContextMenu";
import type { TagTreeNode } from "../shared/types";

/**
 * 媒体预览拖拽载荷的 MIME（`panels/mediaPreviewSelection.ts` 写入，相册面板同款）。
 *
 * 拖拽过程中**只有 `types` 可读**：`getData` 在 `dragover` 阶段受 HTML5 保护模式限制，
 * 因此"这是媒体拖拽还是 tag 移动"的判据必须用 `types.includes(...)` 写在 `onDragOver`。
 */
const FILES_MIME = "application/x-hp-files";

/** 从拖拽载荷解析文件 id 列表（非法载荷返回空数组，绝不抛错打断拖放）。 */
function readFileIds(dt: DataTransfer): string[] {
  const raw = dt.getData(FILES_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

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

interface DraftState {
  mode: "root" | "sibling" | "child";
  refId?: string;
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
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  /** 媒体拖拽悬停的 tag 行（蓝色框）；与 tag 移动的 `dropTargetId` 分开，两种高亮不混。 */
  const [fileDropId, setFileDropId] = useState<string | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setRoots([]);
      return;
    }
    try {
      setRoots(await api.tagTree(app.repoId));
    } catch (e) {
      app.status(app.t("tagtable.loadFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.repoId, app.refreshKey]);

  useEffect(() => {
    if (draft) {
      draftRef.current?.focus();
    }
  }, [draft]);

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

  /** 插入空白临时标签行（尚未落库）。 */
  const startDraft = (mode: DraftState["mode"], node?: TagTreeNode) => {
    committedRef.current = false;
    setDraft({ mode, refId: node?.id });
    setDraftValue("");
    setMenu(null);
  };

  /** 确认临时标签：有名字则创建；为空则丢弃（等价于删除临时标签）。 */
  const commitDraft = async () => {
    if (committedRef.current || !draft) {
      return;
    }
    committedRef.current = true;
    const name = draftValue.trim();
    if (!name || !app.repoId) {
      setDraft(null);
      setDraftValue("");
      return;
    }
    try {
      if (draft.mode === "root") {
        await api.tagCreateRoot(app.repoId, name);
      } else if (draft.mode === "child" && draft.refId) {
        await api.tagCreateChild(app.repoId, draft.refId, name);
      } else if (draft.mode === "sibling" && draft.refId) {
        await api.tagCreateSibling(app.repoId, draft.refId, name);
      }
      setDraft(null);
      setDraftValue("");
      app.refresh();
    } catch (e) {
      app.status(app.t("tagtable.createFailed", { err: errorTextOf(app.t, e) }), "error");
      setDraft(null);
      setDraftValue("");
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
      app.status(app.t("tagtable.renameFailed", { err: errorTextOf(app.t, e) }), "error");
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
      app.status(app.t("tagtable.moveFailed", { err: errorTextOf(app.t, e) }), "error");
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
      app.status(app.t("tagtable.moveFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  /**
   * 媒体拖到某 tag 上：把这些文件加进该 tag（D117）。
   *
   * 走既有 `tag.add`（按名幂等：`create_tag` 同仓库同名返回**已有实体**，`tags` 表有
   * `UNIQUE(repo_id, name)`），因此**不需要新增命令**，命中的正是这一行的 tag 实体。
   * 成功后 `app.refresh()` 递增 `refreshKey`：本面板重拉树（计数变化）、「标签 评分」
   * 面板（effect 依赖 `refreshKey`）重拉所选文件的 tag —— 这就是"同步更新"的落点。
   */
  const dropFilesOnNode = async (target: TagTreeNode, e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setFileDropId(null);
    const fileIds = readFileIds(e.dataTransfer);
    if (!app.repoId || fileIds.length === 0) return;
    try {
      await api.tagAdd({ repoId: app.repoId, fileIds, tagName: target.name });
      app.status(
        app.t("tagtable.dropAdded", { count: fileIds.length, name: target.name }),
        "ok",
      );
      app.refresh();
    } catch (err) {
      app.status(app.t("tagtable.dropFailed", { err: errorTextOf(app.t, err) }), "error");
    }
  };

  const draftRow = (depth: number) => (
    <div className="tag-tree-row draft" style={{ paddingLeft: 6 + depth * 14 }}>
      <span className="tag-tree-arrow" />
      <TagIcon />
      <input
        ref={draftRef}
        className="tag-tree-rename"
        value={draftValue}
        placeholder={app.t("tagtable.createHint")}
        onChange={(e) => setDraftValue(e.target.value)}
        onBlur={() => void commitDraft()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitDraft();
          else if (e.key === "Escape") {
            committedRef.current = true;
            setDraft(null);
          }
        }}
      />
    </div>
  );

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
      const isSiblingDraft = draft?.mode === "sibling" && draft.refId === node.id;
      const isChildDraft = draft?.mode === "child" && draft.refId === node.id;
      return (
        <div key={key}>
          <div
            className="tag-tree-row"
            data-drop={dropTargetId === node.id ? "1" : undefined}
            data-drop-files={fileDropId === node.id ? "1" : undefined}
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
              setFileDropId(null);
            }}
            onDragOver={(e) => {
              // 媒体载荷优先：拖拽中只能读 `types`（见文件头说明）。
              if (e.dataTransfer.types.includes(FILES_MIME)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                setFileDropId(node.id);
                setDropTargetId(null);
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              if (dragId && dragId !== node.id) setDropTargetId(node.id);
            }}
            onDragLeave={(e) => {
              // 仅当真正离开整行（含子元素）时才清除，避免子元素间抖动。
              const row = e.currentTarget;
              const related = e.relatedTarget;
              if (related instanceof Node && row.contains(related)) return;
              setDropTargetId((cur) => (cur === node.id ? null : cur));
              setFileDropId((cur) => (cur === node.id ? null : cur));
            }}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes(FILES_MIME)) {
                void dropFilesOnNode(node, e);
                return;
              }
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
          {/* 同级临时标签：紧跟该节点之后、同缩进 */}
          {isSiblingDraft && draftRow(depth)}
          {/* 子级临时标签：作为该节点的第一个子项 */}
          {!isCollapsed && isChildDraft && draftRow(depth + 1)}
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
                onClick={() => startDraft("root")}
              >
                ＋
              </button>
            </span>
          </div>

          <div
            className="tag-tree-body"
            onDragOver={(e) => {
              e.preventDefault();
              // 悬停在空白处：行高亮必须清掉（否则会留在上一个经过的行上）。
              setFileDropId(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setFileDropId(null);
              // 媒体落在空白处 = 不指定 tag，什么都不做（不能当成"移到根"）。
              if (e.dataTransfer.types.includes(FILES_MIME)) return;
              void dropOnRoot();
            }}
          >
            {draft?.mode === "root" && draftRow(0)}
            {renderNodes(shown, 0, "")}
            {shown.length === 0 && draft?.mode !== "root" && (
              <span className="placeholder">{app.t("tagtable.empty")}</span>
            )}
          </div>

          {menu && (
            <ContextMenu x={menu.x} y={menu.y}>
              <button
                className="menu-item"
                onClick={() => startDraft("sibling", menu.node)}
              >
                {app.t("tagtable.newSibling")}
              </button>
              <button
                className="menu-item"
                onClick={() => startDraft("child", menu.node)}
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
