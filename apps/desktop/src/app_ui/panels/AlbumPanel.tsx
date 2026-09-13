/**
 * 相册组件 — 添加相册（子菜单）+ 已添加的相册列表（右键操作）+ 成员。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import { useApp } from "../AppContext";
import type { AlbumItem, FileItem } from "../types";

interface ContextMenuState {
  x: number;
  y: number;
  albumId: string;
}

export function AlbumPanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [openAdd, setOpenAdd] = useState(false);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [members, setMembers] = useState<FileItem[]>([]);
  const selectedAlbum = app.albumId;
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("fixed");
  const [mediaType, setMediaType] = useState("multimedia");

  const loadAlbums = useCallback(async () => {
    if (!app.repoId) {
      setAlbums([]);
      return;
    }
    try {
      setAlbums(await api.albumList({ repoId: app.repoId }));
    } catch (e) {
      app.status(`相册列表失败: ${String(e)}`, "error");
    }
  }, [app]);

  const loadMembers = useCallback(
    async (albumId: string) => {
      if (!app.repoId) return;
      try {
        setMembers(await api.albumMembers({ repoId: app.repoId, albumId }));
      } catch (e) {
        app.status(`相册成员失败: ${String(e)}`, "error");
      }
    },
    [app],
  );

  useEffect(() => {
    void loadAlbums();
  }, [loadAlbums, app.refreshKey]);

  useEffect(() => {
    if (selectedAlbum) {
      void loadMembers(selectedAlbum);
    } else {
      setMembers([]);
    }
  }, [selectedAlbum, loadMembers, app.refreshKey]);

  // 点击任意处关闭右键菜单
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
      const r = await api.albumCreate({
        repoId: app.repoId,
        name: name.trim(),
        kind,
        mediaType,
        sourceId: kind === "follow_source" ? app.sourceId ?? undefined : undefined,
        syncMode: kind === "follow_source" ? "mirror" : undefined,
      });
      app.status(`${t("album.add")}: ${name.trim()}`, "ok");
      setName("");
      setOpenAdd(false);
      app.setAlbumId(r.album_id);
      app.setSourceId(null);
      app.refresh();
    } catch (e) {
      app.status(`创建相册失败: ${String(e)}`, "error");
    }
  };

  const addSelected = async (albumId: string) => {
    if (!app.repoId || !app.selectedFile) {
      app.status(t("common.noSelection"), "error");
      return;
    }
    try {
      const r = await api.albumAddMember({
        repoId: app.repoId,
        albumId,
        fileIds: [app.selectedFile.id],
      });
      app.status(`${t("album.addSelected")}: +${r.added}`, "ok");
      app.refresh();
    } catch (e) {
      app.status(`加入成员失败: ${String(e)}`, "error");
    }
  };

  const removeSelected = async (albumId: string) => {
    if (!app.repoId || !app.selectedFile) {
      app.status(t("common.noSelection"), "error");
      return;
    }
    try {
      const r = await api.albumRemoveMember({
        repoId: app.repoId,
        albumId,
        fileIds: [app.selectedFile.id],
      });
      app.status(`${t("album.removeSelected")}: -${r.removed}`, "ok");
      app.refresh();
    } catch (e) {
      app.status(`移除成员失败: ${String(e)}`, "error");
    }
  };

  const sync = async (albumId: string) => {
    if (!app.repoId) return;
    try {
      await api.albumSync({ repoId: app.repoId, albumId });
      app.status(`${t("album.sync")}…`, "info");
    } catch (e) {
      app.status(`同步失败: ${String(e)}`, "error");
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
              </div>
              <div className="menu-item-row">
                <span className="menu-label">{t("album.kind")}</span>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="fixed">{t("album.kind.fixed")}</option>
                  <option value="follow_source">{t("album.kind.follow")}</option>
                </select>
              </div>
              <div className="menu-item-row">
                <span className="menu-label">{t("album.mediaType")}</span>
                <select value={mediaType} onChange={(e) => setMediaType(e.target.value)}>
                  <option value="multimedia">{t("album.media.all")}</option>
                  <option value="image">{t("album.media.image")}</option>
                  <option value="video">{t("album.media.video")}</option>
                  <option value="audio">{t("album.media.audio")}</option>
                </select>
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
            {albums.map((a) => (
              <div
                key={a.id}
                className={`list-row source-row ${
                  selectedAlbum === a.id ? "selected" : ""
                }`}
                onClick={() => {
                  app.setAlbumId(a.id);
                  app.setSourceId(null);
                  app.setDirPath(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  app.setAlbumId(a.id);
                  app.setSourceId(null);
                  app.setDirPath(null);
                  setMenu({ x: e.clientX, y: e.clientY, albumId: a.id });
                }}
              >
                <span className="source-name">{a.name}</span>
                <span className="source-path">
                  {kindLabel(a.kind)} · {mediaLabel(a.media_type)}
                </span>
              </div>
            ))}
            {albums.length === 0 && <span className="placeholder">{t("common.noFile")}</span>}
          </div>

          {/* 选中相册的成员 */}
          {selectedAlbum && (
            <>
              <div className="section-title">
                {t("album.members")}（{members.length}）
              </div>
              <div className="list compact album-members">
                {members.map((m) => (
                  <span key={m.id} className="source-path" title={m.relative_path}>
                    {m.relative_path}
                  </span>
                ))}
                {members.length === 0 && (
                  <span className="placeholder">{t("common.noFile")}</span>
                )}
              </div>
            </>
          )}

          {/* 右键上下文菜单 */}
          {menu && (
            <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
              <button
                className="menu-item"
                onClick={() => {
                  void sync(menu.albumId);
                  setMenu(null);
                }}
              >
                {t("album.sync")}
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void addSelected(menu.albumId);
                  setMenu(null);
                }}
              >
                {t("album.addSelected")}
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void removeSelected(menu.albumId);
                  setMenu(null);
                }}
              >
                {t("album.removeSelected")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
