/**
 * 媒体播放器面板 — libmpv 子进程播放控制。
 *
 * **交互约定（2026-09 用户裁决）**：面板不再放一排播放/暂停/定位/停止按钮，
 * 全部取消，改为
 *
 * 1. **单击视频画面 = 暂停 / 继续**；
 * 2. 画面下方一根**进度条**，可拖动定位，并**实时同步**播放进度。
 *
 * 两个实现难点：
 *
 * - **原生渲染子窗口的显隐**：mpv 渲染到一个 Win32 子窗口，它不受 DOM/CSS 约束。
 *   dockview 又把非激活标签的组件继续留在 DOM 里，因此"面板不可见"既不会卸载组件、
 *   也不会自动隐藏子窗口——不处理就会留下一块盖住 WebView 的不透明区域
 *   （"视频没了但点不动"）。这里订阅 `onDidActiveChange` / `onDidVisibilityChange`
 *   显式同步。
 * - **点击要能到达 WebView**：子窗口默认把鼠标事件**穿透**给下层（`WM_NCHITTEST`
 *   → `HTTRANSPARENT`），否则"单击画面暂停"根本收不到事件。几何用一层绝对定位的
 *   透明覆盖层来接收点击，画面本身仍在原生子窗口里。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import type { MediaPlaybackSnapshot } from "../shared/types";

export interface MediaPlayerPanelProps {
  /** dockview 面板 API；独立窗口宿主传替身（恒为激活）。 */
  api: PanelRenderCtx["api"];
}

/** 进度轮询间隔：足够跟手，又不至于把 IPC 打满。 */
const PROGRESS_POLL_MS = 500;

/** 拖动进度条期间暂停轮询，避免鼠标位置被回写覆盖。 */
export function MediaPlayerPanel({ api: panelApi }: MediaPlayerPanelProps): JSX.Element {
  const app = useApp();
  const [snapshot, setSnapshot] = useState<MediaPlaybackSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /** 面板是否可见（dockview 激活态）；供几何同步判断要不要顺带显示。 */
  const visibleRef = useRef(true);
  /** 拖动进度条中：此时以本地值为准，不被轮询结果覆盖。 */
  const scrubbingRef = useRef(false);
  const [scrubMs, setScrubMs] = useState<number | null>(null);

  const refreshPlayback = useCallback(async () => {
    try {
      const state = await api.mediaPlaybackState();
      if (!scrubbingRef.current) {
        setSnapshot(state);
      }
    } catch {
      /* 读取进度失败不打断界面；下一轮继续。 */
    }
  }, []);

  // 面板可见性 → 原生渲染子窗口显隐。隐藏用 `hide` 而非销毁：标签来回切换时
  // 不必重建窗口，也避免 mpv 的 `--wid` 目标失效。
  useEffect(() => {
    const sync = () => {
      const visible = Boolean(panelApi.isVisible && panelApi.isActive);
      visibleRef.current = visible;
      void api.mediaEmbedVisible(visible).catch(() => undefined);
    };
    sync();
    const disposables = [
      panelApi.onDidActiveChange(sync),
      panelApi.onDidVisibilityChange(sync),
    ];
    return () => {
      for (const d of disposables) {
        d.dispose();
      }
    };
  }, [panelApi]);

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
        .then((ready) => {
          setEmbedded(ready);
          // 几何同步**不**负责显示（后端不传 SWP_SHOWWINDOW）；首次创建后
          // 需要按当前可见性补一次，否则面板可见时画面不出现。
          if (ready && visibleRef.current) {
            void api.mediaEmbedVisible(true).catch(() => undefined);
          }
          // 点击要落到 WebView 才能"单击画面暂停"，因此显式声明穿透。
          void api.mediaEmbedClickThrough(true).catch(() => undefined);
        })
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
      // 面板真正卸载：销毁原生窗口并释放句柄（mpv 常驻进程保留）。
      void api.mediaEmbedRelease().catch(() => undefined);
      setEmbedded(false);
    };
  }, []);

  // 进度实时同步：**始终轮询**（间隔内无播放时开销极小）。
  //
  // 不能用"面板自己发起的播放"来开启轮询：蓝图双击是**宿主**直接调 `media_play`
  // 的（`AppUiApp.playFile`），面板并不知情；若只在面板按钮里记 sessionId，
  // 双击播放就永远拿不到进度（进度条恒为 `--:--`）。
  // 因此进度条的开关一律以 `media_playback_state` 的实际返回为准。
  useEffect(() => {
    void refreshPlayback();
    const timer = window.setInterval(() => {
      void refreshPlayback();
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPlayback, app.refreshKey]);

  /** 播放当前选中的文件（蓝图双击与"无会话时点击画面"都走这里）。 */
  const playSelected = useCallback(async () => {
    if (!app.repoId || !app.selectedFile) {
      app.status(app.t("player.selectFileFirst"), "error");
      return;
    }
    setBusy(true);
    try {
      await api.mediaPlay({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
      });
      app.status(app.t("player.playingInMpv"), "ok");
      void refreshPlayback();
    } catch (e) {
      app.status(app.t("player.playFailed", { err: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  }, [app, refreshPlayback]);

  /** 是否有正在播放/已加载的会话（以实际状态为准，不看本地是否发起过播放）。 */
  const hasSession = snapshot?.alive === true && !snapshot.ended;

  /** 单击画面：没有会话就开播，有会话则暂停/继续。 */
  const togglePause = useCallback(async () => {
    if (!hasSession) {
      await playSelected();
      return;
    }
    const paused = snapshot?.paused ?? false;
    try {
      await api.mediaPause({ paused: !paused });
      void refreshPlayback();
    } catch (e) {
      app.status(app.t("player.pauseToggleFailed", { err: String(e) }), "error");
    }
  }, [app, hasSession, snapshot, playSelected, refreshPlayback]);

  /** 进度条拖动中：只更新本地显示值。 */
  const onScrub = (value: number) => {
    scrubbingRef.current = true;
    setScrubMs(value);
  };

  /** 松手才真正定位（拖动期间发 seek 会把 mpv 打满且手感差）。 */
  const onScrubCommit = async (value: number) => {
    scrubbingRef.current = false;
    setScrubMs(null);
    if (!hasSession) {
      return;
    }
    try {
      await api.mediaSeek({ positionMs: Math.max(0, Math.floor(value)) });
      void refreshPlayback();
    } catch (e) {
      app.status(app.t("player.seekFailed", { err: String(e) }), "error");
    }
  };

  const durationMs = snapshot?.duration_ms ?? 0;
  const positionMs = scrubMs ?? snapshot?.position_ms ?? 0;
  const seekable = hasSession && durationMs > 0;
  const paused = snapshot?.paused ?? false;

  return (
    <div className="panel">
      <div className="viewer-info">
        <span>{app.selectedFile?.relative_path ?? app.t("common.noSelection")}</span>
        <span className="dim">{app.selectedFile?.media_type ?? "—"}</span>
      </div>

      {/*
        画面区：原生渲染子窗口盖在 `.player-surface` 之上；`.player-click-layer`
        是一层透明覆盖层，专门接收点击（子窗口已设为穿透，事件落到 WebView）。
      */}
      <div className="player-stage">
        <div className="player-surface" ref={surfaceRef} />
        <button
          type="button"
          className="player-click-layer"
          disabled={busy}
          onClick={() => void togglePause()}
          title={hasSession ? app.t(paused ? "player.clickToResume" : "player.clickToPause") : app.t("common.play")}
          aria-label={hasSession ? app.t(paused ? "player.clickToResume" : "player.clickToPause") : app.t("common.play")}
        >
          {!hasSession && <span className="player-overlay-hint">{app.t("common.play")}</span>}
          {hasSession && paused && (
            <span className="player-overlay-hint">{app.t("player.paused")}</span>
          )}
        </button>
      </div>

      {/* 进度条：画面下方，拖动定位，实时同步播放进度 */}
      <div className="player-progress">
        <span className="player-time mono">{formatMs(positionMs)}</span>
        <input
          className="player-progress-bar"
          type="range"
          min={0}
          max={durationMs > 0 ? durationMs : 1}
          step={100}
          value={Math.min(positionMs, durationMs > 0 ? durationMs : 1)}
          disabled={!seekable}
          onChange={(e) => onScrub(Number(e.target.value))}
          onMouseUp={(e) => void onScrubCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => void onScrubCommit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => void onScrubCommit(Number((e.target as HTMLInputElement).value))}
          aria-label={app.t("player.progress")}
        />
        <span className="player-time mono">{formatMs(durationMs)}</span>
      </div>

      {!embedded && (
        <div className="player-detached dim">{app.t("player.detachedWindow")}</div>
      )}
    </div>
  );
}

/** 毫秒 → `m:ss` / `h:mm:ss`；非正值显示 `--:--`。 */
function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return "--:--";
  }
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
