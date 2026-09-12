/**
 * 相册面板 — 创建（固定 / 跟随源）、成员维护、同步。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import { useApp } from "../AppContext";
import type { AlbumItem, FileItem } from "../types";

export function AlbumPanel(): JSX.Element {
  const app = useApp();
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [members, setMembers] = useState<FileItem[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
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
        setMembers(
          await api.albumMembers({ repoId: app.repoId, albumId }),
        );
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

  const create = async () => {
    if (!app.repoId || !name.trim()) {
      app.status("相册名不能为空", "error");
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
      app.status("相册已创建", "ok");
      setName("");
      setSelectedAlbum(r.album_id);
      app.refresh();
    } catch (e) {
      app.status(`创建相册失败: ${String(e)}`, "error");
    }
  };

  const addSelected = async () => {
    if (!app.repoId || !selectedAlbum || !app.selectedFile) {
      app.status("请先选中相册与文件", "error");
      return;
    }
    try {
      const r = await api.albumAddMember({
        repoId: app.repoId,
        albumId: selectedAlbum,
        fileIds: [app.selectedFile.id],
      });
      app.status(`已加入 ${r.added} 个成员`, "ok");
      app.refresh();
    } catch (e) {
      app.status(`加入成员失败: ${String(e)}`, "error");
    }
  };

  const sync = async () => {
    if (!app.repoId || !selectedAlbum) return;
    try {
      await api.albumSync({ repoId: app.repoId, albumId: selectedAlbum });
      app.status("同步已启动", "info");
    } catch (e) {
      app.status(`同步失败: ${String(e)}`, "error");
    }
  };

  return (
    <div className="panel">
      {!app.repoId && <span className="placeholder">请先打开仓库</span>}
      {app.repoId && (
        <>
          <div className="row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="相册名"
            />
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="fixed">固定型</option>
              <option value="follow_source">跟随源</option>
            </select>
            <select
              value={mediaType}
              onChange={(e) => setMediaType(e.target.value)}
            >
              <option value="multimedia">全部</option>
              <option value="image">图像</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
            <button onClick={create}>创建</button>
          </div>

          <div className="list">
            {albums.map((a) => (
              <button
                key={a.id}
                className={`list-row ${
                  selectedAlbum === a.id ? "selected" : ""
                }`}
                onClick={() => setSelectedAlbum(a.id)}
              >
                <span>{a.name}</span>
                <span className="dim">
                  {a.kind} · {a.media_type ?? "继承"}
                </span>
              </button>
            ))}
            {albums.length === 0 && <span className="placeholder">无相册</span>}
          </div>

          {selectedAlbum && (
            <>
              <div className="row">
                <button onClick={addSelected}>加入选中文件</button>
                <button onClick={sync}>同步</button>
                <span className="dim">成员 {members.length}</span>
              </div>
              <div className="list compact">
                {members.map((m) => (
                  <span key={m.id} className="dim">
                    {m.relative_path}
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
