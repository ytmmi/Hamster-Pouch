/**
 * 媒体播放器面板 — 通过 libmpv 子进程播放选中的视频/音频文件。
 *
 * 调用 `media_play` / `media_pause` / `media_seek` / `media_stop` /
 * `media_process_status` 命令。所有错误经 `onStatus` 状态栏呈现，不抛出。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import type { FileItem, MediaStatus, StatusHandler } from "../types";

export interface MediaPlayerPanelProps {
  selectedFile: FileItem | null;
  repoId: string | null;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function MediaPlayerPanel({
  selectedFile,
  repoId,
  onStatus,
  refreshKey,
}: MediaPlayerPanelProps): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [seekMs, setSeekMs] = useState("");
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [busy, setBusy] = useState(false);

  /** 拉取一次子进程状态（失败仅上报，不置位） */
  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.mediaProcessStatus();
      setStatus(s);
    } catch (e) {
      onStatus(`状态查询失败: ${String(e)}`, "error");
    }
  }, [onStatus]);

  // 切换文件 / 刷新时重置本地态并查询一次状态
  useEffect(() => {
    setSessionId(null);
    setIsPaused(false);
    setSeekMs("");
    void refreshStatus();
  }, [selectedFile?.id, repoId, refreshStatus, refreshKey]);

  const handlePlay = useCallback(async () => {
    if (!repoId || !selectedFile) {
      onStatus("需要先打开仓库并选中文件", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await api.mediaPlay({
        repoId,
        fileId: selectedFile.id,
      });
      setSessionId(res.session_id);
      setIsPaused(false);
      onStatus(`开始播放: ${selectedFile.relative_path}`, "ok");
      await refreshStatus();
    } catch (e) {
      onStatus(`播放失败: ${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [repoId, selectedFile, onStatus, refreshStatus]);

  const handlePauseToggle = useCallback(async () => {
    if (!sessionId) {
      onStatus("无活动播放会话", "error");
      return;
    }
    const next = !isPaused;
    setBusy(true);
    try {
      await api.mediaPause({ sessionId, paused: next });
      setIsPaused(next);
      onStatus(next ? "已暂停" : "已继续", "ok");
    } catch (e) {
      onStatus(`暂停/继续失败: ${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [sessionId, isPaused, onStatus]);

  const handleSeek = useCallback(async () => {
    if (!sessionId) {
      onStatus("无活动播放会话", "error");
      return;
    }
    const parsed = Number.parseInt(seekMs, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      onStatus("定位位置需为非负整数（毫秒）", "error");
      return;
    }
    setBusy(true);
    try {
      await api.mediaSeek({ sessionId, positionMs: parsed });
      onStatus(`已定位到 ${parsed} ms`, "ok");
    } catch (e) {
      onStatus(`定位失败: ${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [sessionId, seekMs, onStatus]);

  const handleStop = useCallback(async () => {
    if (!sessionId) {
      onStatus("无活动播放会话", "error");
      return;
    }
    setBusy(true);
    try {
      await api.mediaStop({ sessionId });
      setSessionId(null);
      setIsPaused(false);
      setSeekMs("");
      onStatus("已停止播放", "ok");
      await refreshStatus();
    } catch (e) {
      onStatus(`停止失败: ${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [sessionId, onStatus, refreshStatus]);

  const fileReady = Boolean(repoId && selectedFile);
  const sessionActive = sessionId !== null;

  return (
    <div className="panel">
      <h2>媒体播放器</h2>

      {!fileReady && (
        <span className="placeholder">未选中文件</span>
      )}

      {fileReady && (
        <>
          <div className="panel-section">
            <div className="panel-row">
              <label>媒体类型</label>
              <span className="file-type-badge">
                {selectedFile?.media_type ?? "未知"}
              </span>
            </div>
            <div className="panel-row">
              <label>相对路径</label>
              <span>{selectedFile?.relative_path}</span>
            </div>
            <div className="panel-row">
              <label>会话ID</label>
              <span>{sessionId ?? "无"}</span>
            </div>
          </div>

          <div className="panel-section">
            <label>播放控制</label>
            <div className="media-controls">
              <button
                onClick={handlePlay}
                disabled={busy || sessionActive}
              >
                播放
              </button>
              <button
                onClick={handlePauseToggle}
                disabled={busy || !sessionActive}
              >
                {isPaused ? "继续" : "暂停"}
              </button>
              <button
                onClick={handleStop}
                disabled={busy || !sessionActive}
                className="danger"
              >
                停止
              </button>
            </div>
          </div>

          <div className="panel-section">
            <label>定位（毫秒）</label>
            <div className="media-controls">
              <input
                type="number"
                min={0}
                placeholder="0"
                value={seekMs}
                onChange={(e) => setSeekMs(e.target.value)}
                disabled={busy || !sessionActive}
              />
              <button
                onClick={handleSeek}
                disabled={busy || !sessionActive}
              >
                定位
              </button>
            </div>
          </div>

          <div className="panel-section">
            <label>子进程状态</label>
            <div className="media-controls">
              <button
                onClick={refreshStatus}
                disabled={busy}
              >
                状态刷新
              </button>
              <span className="media-status">
                {status
                  ? `alive=${status.alive ? "是" : "否"} | pipe=${status.pipe || "(空)"}`
                  : "未查询"}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
