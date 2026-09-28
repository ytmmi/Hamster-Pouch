/**
 * 相册面板 — 创建、列表、成员管理、同步。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../api";
import type {
  AlbumItem,
  AlbumSyncConflictPayload,
  AlbumSyncFailedPayload,
  AlbumSyncProgressPayload,
  FileItem,
  StatusHandler,
} from "../types";

export interface AlbumPanelProps {
  repoId: string | null;
  selectedFile: FileItem | null;
  onRefresh: () => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function AlbumPanel({
  repoId,
  selectedFile,
  onRefresh,
  onStatus,
  refreshKey,
}: AlbumPanelProps): JSX.Element {
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [members, setMembers] = useState<FileItem[]>([]);

  // 创建表单
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<"fixed" | "follow_source">(
    "fixed",
  );
  const [createMediaType, setCreateMediaType] = useState("");
  const [createSourceId, setCreateSourceId] = useState("");

  const [syncInfo, setSyncInfo] = useState<{
    added: number;
    removed: number;
    pinned: number;
  } | null>(null);

  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 刷新相册列表
  const refreshAlbums = useCallback(async () => {
    if (!repoId) {
      setAlbums([]);
      return;
    }
    try {
      const list = await api.albumList({ repoId });
      setAlbums(list);
    } catch (e) {
      onStatus(`相册列表失败: ${String(e)}`, "error");
    }
  }, [repoId, onStatus]);

  useEffect(() => {
    void refreshAlbums();
  }, [refreshAlbums, refreshKey]);

  // 刷新成员列表
  useEffect(() => {
    if (!repoId || !selectedAlbumId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.albumMembers({
          repoId,
          albumId: selectedAlbumId,
        });
        if (!cancelled) setMembers(list);
      } catch (e) {
        if (!cancelled) onStatus(`成员列表失败: ${String(e)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedAlbumId, onStatus, refreshKey]);

  // 订阅同步事件
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    void (async () => {
      try {
        unlisteners.push(
          await listen<AlbumSyncProgressPayload>(
            "album.sync.progress",
            (e) => {
              setSyncInfo({
                added: e.payload.added,
                removed: e.payload.removed,
                pinned: e.payload.pinned,
              });
              onStatus(
                `同步完成: 新增 ${e.payload.added}, 移除 ${e.payload.removed}, 保留 ${e.payload.pinned}`,
                "ok",
              );
              onRefresh();
            },
          ),
        );
        unlisteners.push(
          await listen<AlbumSyncConflictPayload>(
            "album.sync.conflict",
            (e) => {
              // 逐文件冲突（缺陷 0004）：一个成员一条，fileId 是真实值，同步本身并未失败
              onStatus(`同步冲突（未移除）: fileId=${e.payload.fileId} 原因=${e.payload.reason}`, "info");
            },
          ),
        );
        unlisteners.push(
          await listen<AlbumSyncFailedPayload>(
            "album.sync.failed",
            (e) => {
              // 整体失败是独立事件（缺陷 0004）
              onStatus(`同步失败: ${e.payload.error}`, "error");
              setSyncInfo(null);
            },
          ),
        );
      } catch {
        // 非 Tauri 运行时
      }
    })();
    unlistenRefs.current = unlisteners;
    return () => {
      for (const fn of unlistenRefs.current) {
        try {
          fn();
        } catch {
          // 忽略
        }
      }
    };
  }, [onStatus, onRefresh]);

  const handleCreate = useCallback(async () => {
    if (!repoId || !createName.trim()) {
      onStatus("仓库名和相册名不能为空", "error");
      return;
    }
    try {
      const result = await api.albumCreate({
        repoId,
        name: createName.trim(),
        kind: createKind,
        mediaType: createMediaType.trim() || undefined,
        sourceId:
          createKind === "follow_source" && createSourceId.trim()
            ? createSourceId.trim()
            : undefined,
        fileIds:
          createKind === "fixed" && selectedFile
            ? [selectedFile.id]
            : undefined,
      });
      onStatus(`相册已创建: ${result.album_id.slice(0, 8)}`, "ok");
      setCreateName("");
      onRefresh();
    } catch (e) {
      onStatus(`创建相册失败: ${String(e)}`, "error");
    }
  }, [
    repoId,
    createName,
    createKind,
    createMediaType,
    createSourceId,
    selectedFile,
    onRefresh,
    onStatus,
  ]);

  const handleAddFile = useCallback(async () => {
    if (!repoId || !selectedAlbumId || !selectedFile) {
      onStatus("需要选中相册和文件", "error");
      return;
    }
    try {
      const result = await api.albumAddMember({
        repoId,
        albumId: selectedAlbumId,
        fileIds: [selectedFile.id],
      });
      onStatus(`已添加 ${result.added} 个成员`, "ok");
      onRefresh();
    } catch (e) {
      onStatus(`添加成员失败: ${String(e)}`, "error");
    }
  }, [repoId, selectedAlbumId, selectedFile, onRefresh, onStatus]);

  const handleRemoveFile = useCallback(async () => {
    if (!repoId || !selectedAlbumId || !selectedFile) {
      onStatus("需要选中相册和文件", "error");
      return;
    }
    try {
      const result = await api.albumRemoveMember({
        repoId,
        albumId: selectedAlbumId,
        fileIds: [selectedFile.id],
      });
      onStatus(`已移除 ${result.removed} 个成员`, "ok");
      onRefresh();
    } catch (e) {
      onStatus(`移除成员失败: ${String(e)}`, "error");
    }
  }, [repoId, selectedAlbumId, selectedFile, onRefresh, onStatus]);

  const handleSync = useCallback(async () => {
    if (!repoId || !selectedAlbumId) return;
    try {
      setSyncInfo(null);
      const taskId = await api.albumSync({
        repoId,
        albumId: selectedAlbumId,
      });
      onStatus(`同步已启动: taskId=${taskId.slice(0, 8)}`, "info");
    } catch (e) {
      onStatus(`启动同步失败: ${String(e)}`, "error");
    }
  }, [repoId, selectedAlbumId, onStatus]);

  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId);

  return (
    <div className="panel">
      <h2>虚拟相册</h2>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && (
        <>
          <div className="panel-section">
            <label>创建相册</label>
            <div className="panel-row">
              <input
                type="text"
                placeholder="相册名称"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
              <select
                value={createKind}
                onChange={(e) =>
                  setCreateKind(e.target.value as "fixed" | "follow_source")
                }
              >
                <option value="fixed">固定型 (fixed)</option>
                <option value="follow_source">跟随源 (follow_source)</option>
              </select>
              <select
                value={createMediaType}
                onChange={(e) => setCreateMediaType(e.target.value)}
              >
                <option value="">继承</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
                <option value="audio">音频</option>
              </select>
            </div>
            {createKind === "follow_source" && (
              <div className="panel-row">
                <input
                  type="text"
                  placeholder="媒体源 ID"
                  value={createSourceId}
                  onChange={(e) => setCreateSourceId(e.target.value)}
                />
              </div>
            )}
            {createKind === "fixed" && selectedFile && (
              <span className="placeholder">
                将自动包含选中文件: {selectedFile.id.slice(0, 8)}
              </span>
            )}
            <button onClick={handleCreate}>创建</button>
          </div>

          <div className="panel-section">
            <label>相册列表 ({albums.length})</label>
            <div className="item-list">
              {albums.length === 0 && (
                <span className="placeholder">无相册</span>
              )}
              {albums.map((a) => (
                <div
                  key={a.id}
                  className={`item-list-item ${
                    a.id === selectedAlbumId ? "selected" : ""
                  }`}
                  onClick={() => setSelectedAlbumId(a.id)}
                >
                  <span>
                    {a.name} — {a.kind}
                    {a.media_type ? ` (${a.media_type})` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {selectedAlbum && (
            <div className="panel-section">
              <label>
                成员 ({members.length}) — {selectedAlbum.name}
              </label>
              <div className="panel-row">
                <button
                  onClick={handleAddFile}
                  disabled={!selectedFile}
                >
                  添加选中文件
                </button>
                <button
                  onClick={handleRemoveFile}
                  disabled={!selectedFile}
                  className="danger"
                >
                  移除选中文件
                </button>
                {selectedAlbum.kind === "follow_source" && (
                  <button onClick={handleSync}>同步</button>
                )}
              </div>
              {syncInfo && (
                <span className="placeholder">
                  上次同步: +{syncInfo.added} -{syncInfo.removed} 保留
                  {syncInfo.pinned}
                </span>
              )}
              <div className="item-list">
                {members.map((m) => (
                  <div key={m.id} className="item-list-item">
                    <span title={m.relative_path}>{m.relative_path}</span>
                    <span>{m.media_type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
