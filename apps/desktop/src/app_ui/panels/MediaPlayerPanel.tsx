/**
 * 媒体播放器面板 — DOM `<video>` 播放控制（与查看器同构，2026-09 决策更新）。
 *
 * **为什么放弃 libmpv 原生窗口（决策见 `docs/rfc/0005-media-capabilities.md`）**：
 * mpv 渲染到 Win32 原生子窗口，该窗口**永远盖在 WebView 之上**——打开「全部设置」
 * 等 DOM 浮层时视频会漂浮在浮层上方（"没内嵌进面板"）；且点击要么被原生窗口吞掉
 * （`HTTRANSPARENT` 只转发同线程窗口，WebView2 输入窗口不保证同线程）、要么依赖
 * 后端广播链路，真机反复不可靠（"单击无任何效果"）。DOM `<video>` 完全在 WebView
 * 内：内嵌于面板、被浮层自然覆盖、点击由浏览器原生派发——三者一并解决。
 *
 * **交互约定（2026-09 用户裁决）**：面板不放任何播放/暂停/定位/停止按钮：
 *
 * 1. **单击视频画面 = 暂停 / 继续**（读取 DOM 元素实时的 `.paused`，无状态过期）；
 * 2. 画面下方一根**进度条**，可拖动定位，实时同步；
 * 3. 面板内不显示「单击暂停/播放」等提示文字；
 * 4. 切标签默认自动暂停（可在「全部设置 → 面板 → 媒体播放器」关闭，默认开）；
 * 5. 播放完成回到首帧并暂停。
 *
 * 播放来源：蓝图双击视频（`payload.play`）→ `playerPlayStore.requestPlayerPlay(fileId)`
 * → 本面板解析路径、`convertFileSrc` 后加载并自动播放；单击画面且尚无源时播放
 * 当前选中的视频/音频文件。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import {
  getPlayerPlayRequest,
  subscribePlayerPlay,
} from "../core/playerPlayStore";
import type { PanelRenderCtx } from "../core/panelRegistry";

export interface MediaPlayerPanelProps {
  /** dockview 面板 API；独立窗口宿主传替身（恒为激活）。 */
  api: PanelRenderCtx["api"];
}

/**
 * 「切换标签时自动暂停」设置的应用设置键（面板设置，落库键
 * `panel.<panel_id>.<key>`，见 `docs/spec/panel-standard.md` 第 5.3 节）。
 */
const PLAYER_AUTO_PAUSE_SETTING_KEY = "panel.player.autoPauseOnTabSwitch";

export function MediaPlayerPanel({ api: panelApi }: MediaPlayerPanelProps): JSX.Element {
  const app = useApp();
  /** 当前加载的视频源（`convertFileSrc` 后的可播 URL）；`null` = 无源。 */
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** 播放请求序号：每次请求 +1，触发"加载后自动播放"（同文件重播也生效）。 */
  const [playToken, setPlayToken] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 拖动进度条中：此时以本地值为准，不被 timeupdate 覆盖。 */
  const scrubbingRef = useRef(false);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  /** 「切换标签时自动暂停」当前值（未设置 = 默认开）；用 ref 供可见性回调读取。 */
  const autoPauseRef = useRef(true);
  /** 设置是否已从存储读到（未读到前不自动暂停，避免用未经确认的默认值）。 */
  const autoPauseLoadedRef = useRef(false);
  /** 上次可见性（只对"可见→隐藏"的**转换**做自动暂停；挂载即隐藏不算切走）。 */
  const wasVisibleRef = useRef(Boolean(panelApi.isVisible && panelApi.isActive));
  /** 播放命令进行中：抑制重复触发。 */
  const busyRef = useRef(false);
  /** 最新 app 上下文（供只订阅一次的 effect 读取，避免闭包过期）。 */
  const appRef = useRef(app);
  appRef.current = app;

  /** 读取「切换标签时自动暂停」设置（未设置 = 默认开）。 */
  const reloadAutoPauseSetting = useCallback(async () => {
    try {
      const result = await api.settingGet({ key: PLAYER_AUTO_PAUSE_SETTING_KEY });
      const value = result.value;
      // 未设置（null）或显式 true 都视为开；只有显式 false 才关闭。
      autoPauseRef.current = !(value === false || value === "false");
    } catch {
      /* 读取失败（如非 Tauri 运行时）保持默认：开。 */
      autoPauseRef.current = true;
    } finally {
      autoPauseLoadedRef.current = true;
    }
  }, []);

  /** 加载并播放指定文件（蓝图双击请求与"无源时单击画面"共用）。 */
  const loadAndPlay = useCallback(async (fileId: string) => {
    const ctx = appRef.current;
    if (!ctx.repoId) {
      return;
    }
    busyRef.current = true;
    try {
      const path = await api.filePath({ repoId: ctx.repoId, fileId });
      setVideoUrl(convertFileSrc(path));
      setPositionMs(0);
      setScrubMs(null);
      setDurationMs(0);
      // 触发"src 就绪后自动播放"（双击视频 = 立即播放；被浏览器策略拦截则等用户单击）。
      setPlayToken((token) => token + 1);
      ctx.status(ctx.t("player.playing"), "ok");
    } catch (e) {
      ctx.status(ctx.t("player.playFailed", { err: String(e) }), "error");
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** 播放当前选中的视频/音频文件（无源时单击画面）。 */
  const playSelected = useCallback(async () => {
    const file = app.selectedFile;
    if (!app.repoId || !file) {
      app.status(app.t("player.selectFileFirst"), "error");
      return;
    }
    if (file.media_type !== "video" && file.media_type !== "audio") {
      app.status(app.t("player.selectFileFirst"), "error");
      return;
    }
    await loadAndPlay(file.id);
  }, [app, loadAndPlay]);

  /**
   * 单击画面 = 暂停 / 继续（有源时）；无源时播放当前选中文件。
   *
   * 状态读取的是 DOM 元素**实时的** `.paused`（浏览器保证当前值），不做任何本地
   * 快照——快速连点每次都是"读到最新态再取反"，暂停后单击必然继续，没有旧路径
   * "两次读到相同旧值 → 两次都暂停"的问题。
   */
  const handleStageClick = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    const video = videoRef.current;
    if (video) {
      if (video.paused) {
        // 用户手势内发起播放，自动播放策略不会拦截。
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
      return;
    }
    await playSelected();
  }, [playSelected]);

  // 播放请求（蓝图双击）：挂载即读一次（面板可能后挂载），再订阅后续请求。
  useEffect(() => {
    const initial = getPlayerPlayRequest();
    if (initial) {
      void loadAndPlay(initial.fileId);
    }
    return subscribePlayerPlay(() => {
      const request = getPlayerPlayRequest();
      if (request) {
        void loadAndPlay(request.fileId);
      }
    });
  }, [loadAndPlay]);

  // src 变化（或新的播放请求）→ 自动播放：重置到开头再播。
  // 同文件重复请求时 src 不变，靠 `playToken` 触发；`load()` 强制重新加载。
  useEffect(() => {
    if (!videoUrl || playToken === 0) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.pause();
    video.currentTime = 0;
    video.load();
    void video.play().catch(() => undefined);
  }, [videoUrl, playToken]);

  // 面板可见性 → 切标签自动暂停。隐藏用 DOM 元素的 `pause()`（视频在后台标签
  // 保持加载与进度，切回即暂停帧，单击继续）。
  useEffect(() => {
    void reloadAutoPauseSetting();
    const sync = () => {
      const visible = Boolean(panelApi.isVisible && panelApi.isActive);
      const prevVisible = wasVisibleRef.current;
      wasVisibleRef.current = visible;
      if (visible) {
        // 回到前台：刷新「切换标签时自动暂停」设置值，使设置修改无需重启即生效。
        void reloadAutoPauseSetting();
      } else if (
        // 只在"可见 → 隐藏"的**转换**时自动暂停：面板挂载即为隐藏态（如布局恢复时
        // 落在后台标签）不算切走，避免把刚播放的视频误暂停。
        prevVisible &&
        autoPauseLoadedRef.current &&
        autoPauseRef.current
      ) {
        videoRef.current?.pause();
      }
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
  }, [panelApi, reloadAutoPauseSetting]);

  /** 视频元数据就绪 → 进度条总时长。 */
  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) {
      setDurationMs(Math.round(video.duration * 1000));
    }
  };

  /** 播放位置推进 → 进度条（拖动中不被覆盖）。 */
  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (video && !scrubbingRef.current) {
      setPositionMs(Math.round(video.currentTime * 1000));
    }
  };

  /** 拖动定位完成 → 以新位置刷新进度条。 */
  const onSeeked = () => {
    const video = videoRef.current;
    if (video && !scrubbingRef.current) {
      setPositionMs(Math.round(video.currentTime * 1000));
    }
  };

  /** 播放完成 → 回到首帧并暂停（用户裁决）。 */
  const onEnded = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = 0;
    video.pause();
    setPositionMs(0);
  };

  /** 进度条拖动中：只更新本地显示值。 */
  const onScrub = (value: number) => {
    scrubbingRef.current = true;
    setScrubMs(value);
  };

  /** 松手才真正定位。 */
  const onScrubCommit = (value: number) => {
    scrubbingRef.current = false;
    setScrubMs(null);
    const video = videoRef.current;
    if (!video || !video.duration) {
      return;
    }
    video.currentTime = Math.max(0, Math.min(value / 1000, video.duration));
  };

  const displayPosition = scrubMs ?? positionMs;
  const seekable = Boolean(videoUrl) && durationMs > 0;

  return (
    <div className="panel">
      <div className="viewer-info">
        <span>{app.selectedFile?.relative_path ?? app.t("common.noSelection")}</span>
        <span className="dim">{app.selectedFile?.media_type ?? "—"}</span>
      </div>

      {/*
        画面区：DOM `<video>`（与查看器同构）——完全在 WebView 内，天然内嵌面板、
        被「全部设置」等浮层自然覆盖、点击由浏览器原生派发。
        按用户裁决：**不显示**「单击暂停/播放」等提示文字，也不设悬停提示。
      */}
      <div className="player-stage" onClick={() => void handleStageClick()}>
        {videoUrl ? (
          <video
            ref={videoRef}
            className="player-video"
            src={videoUrl}
            preload="metadata"
            playsInline
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
            onSeeked={onSeeked}
            onEnded={onEnded}
            aria-label={app.t("player.progress")}
          />
        ) : (
          <div className="player-surface" />
        )}
      </div>

      {/* 进度条：画面下方，拖动定位，实时同步播放进度 */}
      <div className="player-progress">
        <span className="player-time mono">{formatMs(displayPosition)}</span>
        <input
          className="player-progress-bar"
          type="range"
          min={0}
          max={durationMs > 0 ? durationMs : 1}
          step={100}
          value={Math.min(displayPosition, durationMs > 0 ? durationMs : 1)}
          disabled={!seekable}
          onChange={(e) => onScrub(Number(e.target.value))}
          onMouseUp={(e) => onScrubCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => onScrubCommit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => onScrubCommit(Number((e.target as HTMLInputElement).value))}
          aria-label={app.t("player.progress")}
        />
        <span className="player-time mono">{formatMs(durationMs)}</span>
      </div>
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
