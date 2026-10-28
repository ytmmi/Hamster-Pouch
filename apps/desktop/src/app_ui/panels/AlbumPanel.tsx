/**
 * 相册组件 — 添加相册（子菜单）+ 已添加的相册列表（右键操作 / 拖放加入 / 拖拽改父子）。
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type JSX,
} from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import { ContextMenu } from "../menu/ContextMenu";
import type { AlbumItem } from "../shared/types";

/** 相册拖拽载荷的 MIME 类型（与文件的 `application/x-hp-files` 区分，D117/D128）。 */
const ALBUM_DRAG_MIME = "application/x-hp-album";

/** 拖拽命中目标相册时的三种提示：属性完全匹配 / 目标包含拖拽 / 冲突（D128）。 */
type DropKind = "match" | "contain" | "conflict";

interface ContextMenuState {
  x: number;
  y: number;
  albumId: string;
}

/** 相册树节点：AlbumItem + 子相册。 */
interface AlbumNode extends AlbumItem {
  children: AlbumNode[];
}

/** 将扁平相册列表按 parent_album_id 组装为树（无父或父缺失的作为根）。 */
function buildAlbumTree(albums: AlbumItem[]): AlbumNode[] {
  const map = new Map<string, AlbumNode>();
  for (const a of albums) {
    map.set(a.id, { ...a, children: [] });
  }
  const roots: AlbumNode[] = [];
  for (const a of albums) {
    const node = map.get(a.id);
    if (!node) continue;
    const parent = a.parent_album_id ? map.get(a.parent_album_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * 解析相册的**有效**媒体属性：显式值优先，否则沿父链继承，顶层无值 = `multimedia`。
 *
 * 与后端 `hp-album::media::resolve_media_type` 同口径（D10），用于拖拽时的三色预判。
 */
function effectiveMediaType(albumId: string, byId: Map<string, AlbumItem>): string {
  let cur = byId.get(albumId);
  for (let guard = 0; cur && guard < 64; guard += 1) {
    if (cur.media_type) return cur.media_type;
    cur = cur.parent_album_id ? byId.get(cur.parent_album_id) : undefined;
  }
  return "multimedia";
}

/** 媒体属性是否"完全等价"（`null`/`""` 已由 {@link effectiveMediaType} 归一）。 */
function sameMediaType(a: string, b: string): boolean {
  return a === b;
}

/**
 * 媒体属性包含关系：`multimedia` 是所有具体类型的超集（对齐 `AlbumMediaType::contains`）。
 *
 * `containsMedia(outer, inner)` 为真表示 `outer` 覆盖 `inner`。
 */
function containsMedia(outer: string, inner: string): boolean {
  return outer === inner || outer === "multimedia";
}

/** `candidateId` 是否为 `albumId` 的后代（沿 parent 链上溯；用于禁止互相包含）。 */
function isDescendantOf(
  candidateId: string,
  albumId: string,
  byId: Map<string, AlbumItem>,
): boolean {
  let cur = byId.get(candidateId);
  for (let guard = 0; cur && guard < 64; guard += 1) {
    if (cur.id === albumId) return true;
    cur = cur.parent_album_id ? byId.get(cur.parent_album_id) : undefined;
  }
  return false;
}

/** 折叠箭头（内联 SVG，currentColor；展开时旋转 90°）。 */
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

/** 相册图标（内联 SVG，currentColor）。 */
function AlbumIcon(): JSX.Element {
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

export function AlbumPanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [openAdd, setOpenAdd] = useState(false);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const selectedAlbum = app.albumId;
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [name, setName] = useState("");

  // 拖放高亮：当前被悬停的相册 id
  const [dropAlbumId, setDropAlbumId] = useState<string | null>(null);
  // 相册拖相册的命中提示（`null` = 只是文件拖放，不画三色框）
  const [dropKind, setDropKind] = useState<DropKind | null>(null);
  // 正在被拖拽的相册 id（用于三色预判与禁环）
  const [dragAlbumId, setDragAlbumId] = useState<string | null>(null);
  // 右键菜单内「重命名相册」行内输入状态
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  // 右键菜单内「设置媒体属性」子菜单开关
  const [openMediaTypeSub, setOpenMediaTypeSub] = useState(false);
  // 右键菜单内「创建子相册」行内输入状态
  const [creatingChild, setCreatingChild] = useState(false);
  const [childName, setChildName] = useState("");
  // 折叠的相册（key = 相册 id）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const albumTree = useMemo(() => buildAlbumTree(albums), [albums]);
  /** 右键菜单当前指向的相册（用于决定是否显示「取消同步」）。 */
  const menuAlbum = useMemo(
    () => albums.find((a) => a.id === menu?.albumId),
    [albums, menu],
  );

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const loadAlbums = useCallback(async () => {
    if (!app.repoId) {
      setAlbums([]);
      return;
    }
    try {
      setAlbums(await api.albumList({ repoId: app.repoId }));
    } catch (e) {
      app.status(t("album.listFailed", { err: errorTextOf(t, e) }), "error");
    }
  }, [app]);

  useEffect(() => {
    void loadAlbums();
  }, [loadAlbums, app.refreshKey]);

  // 点击菜单外任意处关闭右键菜单（菜单内部点击由 stopPropagation 阻止冒泡）
  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  const create = async () => {
    if (!app.repoId || !name.trim()) {
      app.status(t("album.name"), "error");
      return;
    }
    try {
      // 简化：只创建固定型相册（不指定 mediaType → 继承）
      const r = await api.albumCreate({
        repoId: app.repoId,
        name: name.trim(),
        kind: "fixed",
      });
      app.status(`${t("album.add")}: ${name.trim()}`, "ok");
      setName("");
      setOpenAdd(false);
      app.setAlbumId(r.album_id);
      app.setSourceId(null);
      app.refresh();
    } catch (e) {
      app.status(t("album.createFailed", { err: errorTextOf(t, e) }), "error");
    }
  };

  // 重命名相册
  const renameAlbum = async (albumId: string, newName: string) => {
    if (!app.repoId || !newName.trim()) {
      app.status(t("album.name"), "error");
      return;
    }
    try {
      await api.albumRename({ repoId: app.repoId, albumId, name: newName.trim() });
      app.status(`${t("album.rename")}: ${newName.trim()}`, "ok");
      app.refresh();
    } catch (e) {
      app.status(t("album.renameFailed", { err: errorTextOf(t, e) }), "error");
    }
  };

  // 创建子相册（右键菜单内联输入；固定型 + 全部媒体属性）
  const createChild = async (parentId: string, childNameValue: string) => {
    if (!app.repoId || !childNameValue.trim()) {
      app.status(t("album.name"), "error");
      return;
    }
    try {
      const r = await api.albumCreate({
        repoId: app.repoId,
        name: childNameValue.trim(),
        kind: "fixed",
        mediaType: "multimedia",
        parentAlbumId: parentId,
      });
      app.status(`${t("album.createChild")}: ${childNameValue.trim()}`, "ok");
      app.setAlbumId(r.album_id);
      app.refresh();
    } catch (e) {
      app.status(t("album.createChildFailed", { err: errorTextOf(t, e) }), "error");
    }
  };

  // 删除相册（若删除的是当前选中相册，则清空选中）
  const deleteAlbum = async (albumId: string) => {
    if (!app.repoId) return;
    const album = albums.find((a) => a.id === albumId);
    if (!window.confirm(`${t("album.delete")}: ${album?.name ?? ""}`)) return;
    try {
      await api.albumDelete({ repoId: app.repoId, albumId });
      app.status(`${t("album.delete")}: ${album?.name ?? albumId}`, "ok");
      if (app.albumId === albumId) {
        app.setAlbumId(null);
      }
      app.refresh();
    } catch (e) {
      app.status(t("album.deleteFailed", { err: errorTextOf(t, e) }), "error");
    }
  };

  // 设置相册媒体属性（multimedia / image / video / audio）
  const setAlbumMediaType = async (albumId: string, mt: string) => {
    if (!app.repoId) return;
    try {
      await api.albumSetMediaType({ repoId: app.repoId, albumId, mediaType: mt });
      app.status(`${t("album.mediaType.set")}: ${mediaLabel(mt)}`, "ok");
      app.refresh();
    } catch (e) {
      app.status(t("album.setMediaTypeFailed", { err: errorTextOf(t, e) }), "error");
    }
  };

  // 拖放加入成员：解析 application/x-hp-files 载荷（JSON.stringify(string[])）
  const dropFiles = async (albumId: string, e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropAlbumId(null);
    if (!app.repoId) return;
    const raw = e.dataTransfer.getData("application/x-hp-files");
    if (!raw) return;
    let fileIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        fileIds = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      return; // 忽略无效载荷
    }
    if (fileIds.length === 0) return;
    try {
      const r = await api.albumAddMember({ repoId: app.repoId, albumId, fileIds });
      app.status(`${t("album.dropHint")}: +${r.added}`, "ok");
      app.refresh();
    } catch (err) {
      app.status(t("album.addMemberFailed", { err: errorTextOf(t, err) }), "error");
    }
  };

  /**
   * 判定"把 `sourceAlbumId` 拖到 `targetAlbumId` 上"的提示色（D128）：
   *
   * - `conflict`：目标就是自己、或目标在自己子树内（会形成互相包含）；
   * - `match`：两边有效媒体属性完全相同；
   * - `contain`：目标属性覆盖拖拽方（例如目标 `multimedia`、拖拽方 `image`）。
   *
   * 目标属性**窄于**拖拽方（目标 `image`、拖拽方 `multimedia`）也算 `conflict`——
   * 放进去之后子相册的成员永远不可能满足父相册的属性，属于无意义嵌套。
   */
  const computeDropKind = useCallback(
    (sourceAlbumId: string, targetAlbumId: string): DropKind | null => {
      if (sourceAlbumId === targetAlbumId) return "conflict";
      const byId = new Map(albums.map((a) => [a.id, a]));
      if (!byId.has(sourceAlbumId) || !byId.has(targetAlbumId)) return null;
      // 目标在拖拽方子树内 → 互相包含，必须禁止
      if (isDescendantOf(targetAlbumId, sourceAlbumId, byId)) return "conflict";
      const source = effectiveMediaType(sourceAlbumId, byId);
      const target = effectiveMediaType(targetAlbumId, byId);
      if (sameMediaType(source, target)) return "match";
      if (containsMedia(target, source)) return "contain";
      return "conflict";
    },
    [albums],
  );

  // 拖拽相册到目标相册：改变 parent_album_id（后端再做一次禁环校验）
  const moveAlbum = async (albumId: string, parentAlbumId: string | null) => {
    if (!app.repoId) return;
    const album = albums.find((a) => a.id === albumId);
    if (!album) return;
    if (album.parent_album_id === parentAlbumId) {
      app.status(t("album.moved", { name: album.name }), "info");
      return;
    }
    try {
      const r = await api.albumMove({
        repoId: app.repoId,
        albumId,
        parentAlbumId,
      });
      app.status(t("album.moved", { name: album.name }), "ok");
      app.refresh();
      return r;
    } catch (e) {
      app.status(t("album.moveFailed", { err: errorTextOf(t, e) }), "error");
      return undefined;
    }
  };

  // 取消同步：同步相册退化为一般（固定型）相册，成员全部保留
  const unsyncAlbum = async (albumId: string) => {
    if (!app.repoId) return;
    const album = albums.find((a) => a.id === albumId);
    try {
      await api.albumUnsync({ repoId: app.repoId, albumId });
      app.status(t("album.unsynced", { name: album?.name ?? albumId }), "ok");
      app.refresh();
    } catch (e) {
      app.status(t("album.unsyncFailed", { err: errorTextOf(t, e) }), "error");
    }
  };

  /** 该相册是否为同步根相册（只有同步根才可取消同步）。 */
  const isSyncRoot = (a: AlbumItem): boolean =>
    a.sync_root_album_id !== null && a.sync_root_album_id === a.id;

  const kindLabel = (k: string) =>
    k === "follow_source" ? t("album.kind.follow") : t("album.kind.fixed");

  const mediaLabel = (m: string | null): string => {
    switch (m) {
      case null:
      case "":
        return t("album.inherit");
      case "image":
        return t("album.media.image");
      case "video":
        return t("album.media.video");
      case "audio":
        return t("album.media.audio");
      default:
        return t("album.media.all");
    }
  };

  /** 递归渲染相册树节点（呈现方式与媒体源目录树一致）。 */
  const renderAlbumNode = (node: AlbumNode, depth: number): JSX.Element => {
    const expanded = !collapsed.has(node.id);
    const hasChildren = node.children.length > 0;
    const indent = depth * 14;
    // 相册拖相册时的三色命中提示；文件拖放仍走旧的 drop-target 高亮
    const albumHover = dragAlbumId !== null && dropAlbumId === node.id;
    const dragClass = albumHover && dropKind ? ` drop-target-${dropKind}` : "";
    // 颜色只说"能不能放"，文字说"为什么"——色觉差异不该成为唯一判据。
    const dragHint = albumHover && dropKind ? t(`album.drop.${dropKind}`) : undefined;
    const fileHover = dragAlbumId === null && dropAlbumId === node.id;
    return (
      <Fragment key={node.id}>
        <div
          className={`tree-node list-row${
            selectedAlbum === node.id ? " selected" : ""
          }${fileHover ? " drop-target" : ""}${dragClass}`}
          style={{ paddingLeft: indent }}
          draggable
          onClick={() => {
            app.setAlbumId(node.id);
            app.setSourceId(null);
            app.setDirPath(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            // 右键仅打开菜单，不切换媒体预览（左键负责切换预览）
            setRenameValue(node.name);
            setRenaming(false);
            setCreatingChild(false);
            setChildName("");
            setOpenMediaTypeSub(false);
            setMenu({ x: e.clientX, y: e.clientY, albumId: node.id });
          }}
          onDragStart={(e) => {
            // 只带相册 id：文件的 application/x-hp-files 载荷走另一条分支
            e.dataTransfer.setData(ALBUM_DRAG_MIME, node.id);
            e.dataTransfer.effectAllowed = "move";
            setDragAlbumId(node.id);
          }}
          onDragEnd={() => {
            setDragAlbumId(null);
            setDropAlbumId(null);
            setDropKind(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            const movingId = dragAlbumId ?? "";
            if (movingId) {
              const kind = computeDropKind(movingId, node.id);
              e.dataTransfer.dropEffect = kind === "conflict" ? "none" : "move";
              setDropAlbumId(node.id);
              setDropKind(kind);
            } else {
              e.dataTransfer.dropEffect = "copy";
              setDropAlbumId(node.id);
              setDropKind(null);
            }
          }}
          onDragLeave={(e) => {
            // 仅当离开整行（含子元素）时才清除高亮，避免子元素间抖动
            const row = e.currentTarget;
            const related = e.relatedTarget;
            if (related instanceof Node && row.contains(related)) return;
            setDropAlbumId(null);
            setDropKind(null);
          }}
          onDrop={(e) => {
            const albumId = e.dataTransfer.getData(ALBUM_DRAG_MIME);
            if (albumId) {
              // 相册拖相册：改变父子关系（红框 / 自包含 / 互相包含一律拒绝）
              e.preventDefault();
              setDropAlbumId(null);
              setDropKind(null);
              if (albumId === node.id) return;
              const kind = computeDropKind(albumId, node.id);
              if (kind === "conflict") {
                app.status(t("album.moveCycle"), "error");
                return;
              }
              void moveAlbum(albumId, node.id);
              return;
            }
            void dropFiles(node.id, e);
          }}
        >
          <span
            className={`tree-arrow${hasChildren ? "" : " is-empty"}${
              expanded ? " on" : ""
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) {
                toggleCollapse(node.id);
              }
            }}
          >
            {hasChildren ? <ChevronIcon /> : null}
          </span>
          <span className="tree-folder">
            <AlbumIcon />
          </span>
          <span className="source-name">{node.name}</span>
          <span className="source-path">
            {dragHint ?? (
              <>
                {kindLabel(node.kind)} · {mediaLabel(node.media_type)}
              </>
            )}
          </span>
          <span className="tree-count">{node.member_count}</span>
        </div>
        {expanded &&
          hasChildren &&
          node.children.map((c) => renderAlbumNode(c, depth + 1))}
      </Fragment>
    );
  };

  return (
    <div className="panel">
      {!app.repoId && <span className="placeholder">{t("common.pleaseOpenRepo")}</span>}
      {app.repoId && (
        <>
          {/* 添加相册（点击 → 子菜单） */}
          <button className="menu-item has-sub" onClick={() => setOpenAdd((v) => !v)}>
            {t("album.add")} <span className="sub-arrow">{openAdd ? "▾" : "▸"}</span>
          </button>
          {openAdd && (
            <div className="menu-sub">
              <div className="menu-item-row">
                <input
                  className="menu-input"
                  value={name}
                  autoFocus
                  placeholder={t("album.name")}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void create();
                    }
                  }}
                />
                <button className="menu-item small" onClick={() => void create()}>
                  ✓
                </button>
              </div>
            </div>
          )}

          {/* 已添加的相册 */}
          <div className="section-title">
            {t("album.list")}（{albums.length}）
          </div>
          <div className="list album-list">
            {albumTree.map((n) => renderAlbumNode(n, 0))}
            {albums.length === 0 && <span className="placeholder">{t("common.noFile")}</span>}
          </div>

          {/* 右键上下文菜单 */}
          {menu && (
            <ContextMenu x={menu.x} y={menu.y}>
              {/* 重命名相册：行内输入（Enter 或 ✓ 确认） */}
              {renaming ? (
                <div className="menu-item-row">
                  <input
                    className="menu-input"
                    value={renameValue}
                    autoFocus
                    placeholder={t("album.name")}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void renameAlbum(menu.albumId, renameValue);
                        setMenu(null);
                      }
                    }}
                  />
                  <button
                    className="menu-item small"
                    onClick={() => {
                      void renameAlbum(menu.albumId, renameValue);
                      setMenu(null);
                    }}
                  >
                    ✓
                  </button>
                </div>
              ) : (
                <button
                  className="menu-item"
                  onClick={() => setRenaming(true)}
                >
                  {t("album.rename")}
                </button>
              )}

              {/* 创建子相册：行内输入 */}
              {creatingChild ? (
                <div className="menu-item-row">
                  <input
                    className="menu-input"
                    value={childName}
                    autoFocus
                    placeholder={t("album.name")}
                    onChange={(e) => setChildName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void createChild(menu.albumId, childName);
                        setMenu(null);
                      }
                    }}
                  />
                  <button
                    className="menu-item small"
                    onClick={() => {
                      void createChild(menu.albumId, childName);
                      setMenu(null);
                    }}
                  >
                    ✓
                  </button>
                </div>
              ) : (
                <button
                  className="menu-item"
                  onClick={() => {
                    setCreatingChild(true);
                    setChildName("");
                  }}
                >
                  {t("album.createChild")}
                </button>
              )}

              {/* 删除相册（confirm 后执行） */}
              <button
                className="menu-item danger"
                onClick={() => {
                  void deleteAlbum(menu.albumId);
                  setMenu(null);
                }}
              >
                {t("album.delete")}
              </button>

              {/* 取消同步：仅同步相册（同步根）出现；取消后退化为一般相册，成员保留 */}
              {menuAlbum !== undefined && isSyncRoot(menuAlbum) && (
                <button
                  className="menu-item"
                  onClick={() => {
                    void unsyncAlbum(menu.albumId);
                    setMenu(null);
                  }}
                >
                  {t("album.unsync")}
                </button>
              )}

              {/* 设置媒体属性：子菜单（全部 / 图像 / 视频 / 音频） */}
              <button
                className="menu-item has-sub"
                onClick={() => setOpenMediaTypeSub((v) => !v)}
              >
                {t("album.mediaType.set")}{" "}
                <span className="sub-arrow">{openMediaTypeSub ? "▾" : "▸"}</span>
              </button>
              {openMediaTypeSub && (
                <div className="menu-sub">
                  <button
                    className="menu-item"
                    onClick={() => {
                      void setAlbumMediaType(menu.albumId, "multimedia");
                      setMenu(null);
                    }}
                  >
                    {t("album.media.all")}
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      void setAlbumMediaType(menu.albumId, "image");
                      setMenu(null);
                    }}
                  >
                    {t("album.media.image")}
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      void setAlbumMediaType(menu.albumId, "video");
                      setMenu(null);
                    }}
                  >
                    {t("album.media.video")}
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      void setAlbumMediaType(menu.albumId, "audio");
                      setMenu(null);
                    }}
                  >
                    {t("album.media.audio")}
                  </button>
                </div>
              )}
            </ContextMenu>
          )}
        </>
      )}
    </div>
  );
}
