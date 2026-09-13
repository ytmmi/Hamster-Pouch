/**
 * 媒体播放面板 — libmpv 子进程播放控制（播放 / 暂停 / 定位 / 停止 / 状态）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { MediaStatus } from "../shared/types";

export function MediaPlayerPanel(): JSX.Element {
  const app = useApp();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [positionMs, setPositionMs] = useState("0");
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.mediaProcessStatus());
    } catch (e) {
      app.status(`媒体状态查询失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, app.refreshKey]);

  // 面板级嵌入：把播放区域的位置/大小（物理像素）同步到原生渲染子窗口。
  // 失败（如无法创建子窗口）时 embedded=false，mpv 降级为独立窗口。
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) {
      return;
    }
    let raf = 0;
    const sync = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      void api
        .mediaEmbedRect({
          x: Math.round(rect.left * dpr),
          y: Math.round(rect.top * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
        })
        .then(setEmbedded)
        .catch(() => setEmbedded(false));
    };
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(sync);
      }
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (raf) {
        cancelAnimationFrame(raf);
      }
      void api.mediaEmbedRelease().catch(() => undefined);
      setEmbedded(false);
    };
  }, []);

  const play = async () => {
    if (!app.repoId || !app.selectedFile) {
      app.status("请先选中文件", "error");
      return;
    }
    setBusy(true);
    try {
      const r = await api.mediaPlay({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
      });
      setSessionId(r.session_id);
      setPaused(false);
      app.status("已在 mpv 中播放", "ok");
      void refreshStatus();
    } catch (e) {
      app.status(`播放失败: ${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    if (!sessionId) return;
    try {
      await api.mediaPause({ sessionId, paused: !paused });
      setPaused((p) => !p);
      app.status(paused ? "已继续" : "已暂停", "info");
    } catch (e) {
      app.status(`暂停切换失败: ${String(e)}`, "error");
    }
  };

  const seek = async () => {
    if (!sessionId) return;
    const ms = Number(positionMs);
    if (!Number.isFinite(ms) || ms < 0) {
      app.status("定位值无效", "error");
      return;
    }
    try {
      await api.mediaSeek({ sessionId, positionMs: Math.floor(ms) });
      app.status(`已定位到 ${Math.floor(ms)} ms`, "info");
    } catch (e) {
      app.status(`定位失败: ${String(e)}`, "error");
    }
  };

  const stop = async () => {
    if (!sessionId) return;
    try {
      await api.mediaStop({ sessionId });
      app.status("已停止", "info");
    } catch (e) {
      app.status(`停止失败: ${String(e)}`, "error");
    }
  };

  return (
    <div className="panel">
      <div className="viewer-info">
        <span>{app.selectedFile?.relative_path ?? "未选中文件"}</span>
        <span className="dim">{app.selectedFile?.media_type ?? "—"}</span>
      </div>

      {/* 原生渲染目标占位区：mpv 画面嵌入此区域之上 */}
      <div className="player-surface" ref={surfaceRef} />

      <div className="row">
        <button disabled={busy || !app.selectedFile} onClick={play}>
          播放
        </button>
        <button disabled={!sessionId} onClick={togglePause}>
          {paused ? "继续" : "暂停"}
        </button>
        <button className="danger" disabled={!sessionId} onClick={stop}>
          停止
        </button>
      </div>

      <div className="row">
        <input
          value={positionMs}
          onChange={(e) => setPositionMs(e.target.value)}
          placeholder="毫秒"
        />
        <button disabled={!sessionId} onClick={seek}>
          定位
        </button>
        <button onClick={() => void refreshStatus()}>刷新状态</button>
      </div>

      <div className="kv">
        <span>会话</span>
        <span className="mono">{sessionId ?? "—"}</span>
        <span>进程存活</span>
        <span>{status ? String(status.alive) : "—"}</span>
        <span>IPC 管道</span>
        <span className="mono">{status?.pipe || "（空）"}</span>
        <span>面板嵌入</span>
        <span>{embedded ? "已嵌入" : "独立窗口"}</span>
      </div>
    </div>
  );
}
