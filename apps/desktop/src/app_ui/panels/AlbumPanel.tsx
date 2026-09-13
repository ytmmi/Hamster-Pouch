/**
 * 相册组件 — 添加相册（子菜单）+ 已添加的相册列表（右键操作 / 拖放加入）。
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import { ContextMenu } from "../menu/ContextMenu";
import type { AlbumItem } from "../shared/types";

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
      app.status(t("album.listFailed", { err: String(e) }), "error");
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
      app.status(t("album.createFailed", { err: String(e) }), "error");
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
      app.status(t("album.renameFailed", { err: String(e) }), "error");
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
      app.status(t("album.createChildFailed", { err: String(e) }), "error");
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
      app.status(t("album.deleteFailed", { err: String(e) }), "error");
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
      app.status(t("album.setMediaTypeFailed", { err: String(e) }), "error");
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
      app.status(t("album.addMemberFailed", { err: String(err) }), "error");
    }
  };

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

  /** 递归渲染相册树节点（呈现方式与图像源目录树一致）。 */
  const renderAlbumNode = (node: AlbumNode, depth: number): JSX.Element => {
    const expanded = !collapsed.has(node.id);
    const hasChildren = node.children.length > 0;
    const indent = depth * 14;
    return (
      <Fragment key={node.id}>
        <div
          className={`tree-node list-row${
            selectedAlbum === node.id ? " selected" : ""
          }${dropAlbumId === node.id ? " drop-target" : ""}`}
          style={{ paddingLeft: indent }}
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
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropAlbumId(node.id);
          }}
          onDragLeave={(e) => {
            // 仅当离开整行（含子元素）时才清除高亮，避免子元素间抖动
            const row = e.currentTarget;
            const related = e.relatedTarget;
            if (related instanceof Node && row.contains(related)) return;
            setDropAlbumId(null);
          }}
          onDrop={(e) => void dropFiles(node.id, e)}
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
            {kindLabel(node.kind)} · {mediaLabel(node.media_type)}
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
