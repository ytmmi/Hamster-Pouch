/**
 * 媒体播放器面板 — DOM `<video>` 播放控制 + **音乐模式**（两种样式）。
 *
 * **为什么放弃 libmpv 原生窗口（决策见 `docs/rfc/0005-media-capabilities.md`）**：
 * mpv 渲染到 Win32 原生子窗口，该窗口**永远盖在 WebView 之上**——打开「全部设置」
 * 等 DOM 浮层时视频会漂浮在浮层上方（"没内嵌进面板"）；且点击要么被原生窗口吞掉
 * （`HTTRANSPARENT` 只转发同线程窗口，WebView2 输入窗口不保证同线程）、要么依赖
 * 后端广播链路，真机反复不可靠（"单击无任何效果"）。DOM `<video>` 完全在 WebView
 * 内：内嵌于面板、被浮层自然覆盖、点击由浏览器原生派发——三者一并解决。
 *
 * ## 视频的交互约定（2026-09 用户裁决）
 *
 * 1. **单击视频画面 = 暂停 / 继续**（读取 DOM 元素实时的 `.paused`，无状态过期）；
 * 2. 画面下方一根**进度条**，可拖动定位，实时同步；
 * 3. 面板内不显示「单击暂停/播放」等提示文字；
 * 4. 切标签默认自动暂停（可在「全部设置 → 面板 → 媒体播放器」关闭，默认开）；
 * 5. 播放完成回到首帧并暂停。
 *
 * ## 音乐模式（2026-11-13 用户裁决，改写上面的第 1 条适用范围）
 *
 * 选中**音频**时画面区换成音乐播放器：封面、曲名/艺人、歌词、播放控件，两种样式
 * 在「全部设置 → 面板 → 媒体播放器 → 样式」里切换（`panels/player/*`）。这条
 * 明确**放宽**了"面板不放传输控制"的裁决——参考图里就是有播放/暂停与上一首/下一首
 * 的按钮，裁决原文已同步改写为"视频不放，音乐模式放"（RFC 0005）。
 *
 * - **队列** = 当前范围（相册 → 源/子目录 → 全仓库，与媒体预览同一口径）里的
 *   音频；上一首/下一首只在**同类**里走、端点循环（`usePlayerQueue`）；
 * - **视频也能切换**（用户同批要求"像图像查看器一样"）：按 ←/→ 走同类队列，
 *   视频仍不出现传输按钮（它的单击画面语义不变）；
 * - **封面**：后端 `player.media` 先取内嵌封面，再找同目录同名图片，都没有就
 *   **不显示图**（不画空框）；
 * - **歌词**：同目录同名 `.lrc`（UTF-8/GBK 由后端解码），没有文件就**不显示歌词**；
 * - **色晕**：封面主色来自后端（前端 canvas 读跨源资源会被 taint），没有封面时
 *   走 CSS 兜底色晕；
 * - **播放中唱片转动**（样式 2），暂停停在当前角度；
 * - **收藏只显示图标**（功能后续做）。
 *
 * ## 音量（2026-11-07 / D142）
 *
 * 进度条**右侧**一枚**音量图标**，点它展开一条**竖状**音量条（再点 / 点别处 / Esc
 * 收起）。图标本身就报告音量状态：静音时是喇叭加叉，音量过半才画出第二道声波。
 * 音量是**输出**控制，不在"不放传输控制"的禁令里。存成百分比面板设置
 * （`panel.player.volume`，0 = 静音、100 = 原声，默认 100）；声明层没有 min/max，
 * 越界值由 `clampVolume` 夹紧——与 `bookreader.pageWidth` / `brightness` 同款。
 *
 * 播放来源：蓝图双击视频（`payload.play`）→ `playerPlayStore.requestPlayerPlay(fileId)`
 * → 本面板解析路径、`convertFileSrc` 后加载并自动播放；单击画面且尚无源时播放
 * 当前选中的视频/音频文件。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { AudioWaveform } from "../shared/AudioWaveform";
import { usePanelSettingValue } from "../shared/settingValue";
import { publishSettingChanged } from "../core/settingChangeStore";
import { useApp } from "../core/AppContext";
import { getPlayerPlayRequest, subscribePlayerPlay } from "../core/playerPlayStore";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { MusicStage } from "./player/MusicStage";
import { normalizePlayerStyle } from "./player/playerStyle";
import { parseLrc, type LrcDoc } from "./player/lrc";
import { trackArtistOf, trackTitleOf } from "./player/trackInfo";
import { playableKindOf, stepPlayable } from "./player/queueView";
import { usePlayerQueue } from "./player/usePlayerQueue";

export interface MediaPlayerPanelProps {
  /** dockview 面板 API；独立窗口宿主传替身（恒为激活）。 */
  api: PanelRenderCtx["api"];
}

/**
 * 「切换标签时自动暂停」设置的应用设置键（面板设置，落库键
 * `panel.<panel_id>.<key>`，见 `docs/spec/panel-standard.md` 第 5.3 节）。
 */
const PLAYER_AUTO_PAUSE_SETTING_KEY = "panel.player.autoPauseOnTabSwitch";

/** 「音量」面板设置键（百分比 0–100）。 */
const PLAYER_VOLUME_SETTING_KEY = "panel.player.volume";

/** 音量缺省值（= 原声），与设置声明里的 `default` 保持一致。 */
const PLAYER_VOLUME_DEFAULT = 100;

/** 音乐取料（封面 / 歌词 / 色晕）的空值：没有音频、取料失败都回落它。 */
const EMPTY_MEDIA: PlayerMedia = { coverUrl: null, lyrics: null, hazeColors: [] };

interface PlayerMedia {
  /** 封面 URL（`convertFileSrc` 过的本地路径）；`null` = 没有封面。 */
  coverUrl: string | null;
  /** 解析后的歌词；`null` = 没有歌词文件。 */
  lyrics: LrcDoc | null;
  /** 封面色（空数组 = 用兜底色晕）。 */
  hazeColors: string[];
}

/**
 * 音量夹紧到 0–100 的整数。
 *
 * 设置声明里**没有** min/max（见 `docs/spec/panel-standard.md` 第 5.3 节），范围由
 * 面板自己保证：落库值可能来自旧版本、手改的 `app_settings` 或宿主控件的边界。
 */
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return PLAYER_VOLUME_DEFAULT;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function MediaPlayerPanel({ api: panelApi }: MediaPlayerPanelProps): JSX.Element {
  const app = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  /** 当前加载的媒体源（`convertFileSrc` 后的可播 URL）；`null` = 无源。 */
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** 播放请求序号：每次请求 +1，触发"加载后自动播放"（同文件重播也生效）。 */
  const [playToken, setPlayToken] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 拖动进度条中：此时以本地值为准，不被 timeupdate 覆盖。 */
  const scrubbingRef = useRef(false);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  /** 元素是否在播（唱片转动、播放/暂停图标用；来源是 DOM 真实事件）。 */
  const [playing, setPlaying] = useState(false);
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

  const selectedFile = app.selectedFile;
  const isAudio = selectedFile?.media_type === "audio";
  const kind = playableKindOf(selectedFile);
  /** 音乐模式的样式（设置里切换；非法值回落缺省）。 */
  const style = normalizePlayerStyle(usePanelSettingValue("player", "style", panelApi));
  /** 当前范围里的可播放队列（上一首/下一首 + 视频切换共用）。 */
  const queue = usePlayerQueue(app, panelApi);

  /**
   * 音量（百分比 0–100）。走面板设置的**标准读取路径**：`usePanelSettingValue`
   * 负责四条热更新触发源与声明里的 `default`，面板不再自己读一遍 `app_settings`。
   */
  const storedVolume = usePanelSettingValue("player", "volume", panelApi);
  /** 拖动音量条中：以本地值为准（松手才落库），与进度条同款时序。 */
  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  /** 竖状音量条是否展开。 */
  const [volumeOpen, setVolumeOpen] = useState(false);
  /** 音量控件的整块容器（按钮 + 浮层）：判断"点别处"用，见收起 effect。 */
  const volumeBoxRef = useRef<HTMLDivElement>(null);
  const volume =
    draftVolume ??
    (typeof storedVolume === "number" ? clampVolume(storedVolume) : PLAYER_VOLUME_DEFAULT);

  /** 音乐取料（封面 / 歌词 / 色晕）。 */
  const [media, setMedia] = useState<PlayerMedia>(EMPTY_MEDIA);
  /** 取料世代号：快速连点上一首/下一首时，旧请求的结果必须作废。 */
  const mediaGenerationRef = useRef(0);

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
      ctx.status(ctx.t("player.playFailed", { err: errorTextOf(ctx.t, e) }), "error");
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
   * 暂停 / 继续（画面单击与音乐控件共用）。
   *
   * 状态读取的是 DOM 元素**实时的** `.paused`（浏览器保证当前值），不做任何本地
   * 快照——快速连点每次都是"读到最新态再取反"。无源时退化为"播放当前选中文件"。
   */
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) {
      void playSelected();
      return;
    }
    if (video.paused) {
      // 用户手势内发起播放，自动播放策略不会拦截。
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [playSelected, videoUrl]);

  /** 换一首（`±1`）：选中目标文件并立即播放；同类队列端点循环。 */
  const stepTrack = useCallback(
    (delta: number) => {
      const ctx = appRef.current;
      const current = ctx.selectedFile;
      const currentKind = playableKindOf(current);
      if (!current || !currentKind) return;
      const nextIndex = stepPlayable(queue.files, queue.index, delta, currentKind);
      const target = queue.files[nextIndex];
      if (!target) return;
      if (target.id !== current.id) {
        ctx.setSelectedIds(new Set([target.id]));
        ctx.setSelectedFile(target);
      }
      void loadAndPlay(target.id);
    },
    [loadAndPlay, queue.files, queue.index],
  );

  /** 音乐控件的"上一首 / 下一首"是否可用（队列里至少有一个同类文件）。 */
  const canStep = useMemo(
    () => kind !== null && queue.index >= 0 && queue.files.some((f) => f.media_type === kind),
    [kind, queue.files, queue.index],
  );

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

  // 音乐取料：选中音频就向后端要封面/歌词/色晕（非音频 → 清空）。
  // 只依赖"选中了哪个文件"，不依赖队列：换队列不该重取封面。
  useEffect(() => {
    const generation = ++mediaGenerationRef.current;
    const file = app.selectedFile;
    const repoId = app.repoId;
    if (!repoId || !file || file.media_type !== "audio") {
      setMedia(EMPTY_MEDIA);
      return;
    }
    void (async () => {
      try {
        const result = await api.playerMedia({ repoId, fileId: file.id });
        if (mediaGenerationRef.current !== generation) return;
        setMedia({
          coverUrl: result.cover_path ? convertFileSrc(result.cover_path) : null,
          lyrics: result.lyrics_text ? parseLrc(result.lyrics_text) : null,
          hazeColors: result.haze_colors ?? [],
        });
      } catch {
        // 取料失败不该挡住播放：没有封面/歌词，面板照常出声。
        if (mediaGenerationRef.current !== generation) return;
        setMedia(EMPTY_MEDIA);
      }
    })();
  }, [app.repoId, app.selectedFile, app.refreshKey]);

  // 面板可见性 → 切标签自动暂停。隐藏用 DOM 元素的 `pause()`（媒体在后台标签
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

  // 音量落到元素上：`<video>` 是 `videoUrl` 就绪后才挂载的，所以两个依赖都要看
  // （换源 = 新元素，必须重新应用；音量变化 = 当前元素即时生效）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.volume = volume / 100;
    // 0 直接静音：比"音量 0 仍在解码出声"的边界更符合直觉，图标也才与听感一致。
    video.muted = volume === 0;
  }, [volume, videoUrl]);

  // 音量浮层收起：点别处、按 Esc。判据是**整块容器**（按钮 + 浮层）——只排除按钮会
  // 让"按住滑块拖动"的第一次 mousedown 就把浮层收掉（媒体预览下拉踩过的同款坑）。
  useEffect(() => {
    if (!volumeOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const box = volumeBoxRef.current;
      if (box && !box.contains(event.target as Node)) {
        setVolumeOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setVolumeOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [volumeOpen]);

  /**
   * 音量写回（松手 / 键盘调整后）。与书阅读器 `useReaderSettings` 同款：
   * 落库失败不影响本次播放（内存里的值仍然生效，下次读取会纠正）。
   */
  const commitVolume = useCallback((value: number) => {
    const next = clampVolume(value);
    setDraftVolume(null);
    void api
      .settingSet({ key: PLAYER_VOLUME_SETTING_KEY, value: next })
      .then(() => publishSettingChanged(PLAYER_VOLUME_SETTING_KEY))
      .catch(() => {
        /* 见上：写入失败不该让播放中断。 */
      });
  }, []);

  /** 音量条拖动中：只更新本地显示值（出声即时，落库等松手）。 */
  const onVolumeInput = (value: number) => {
    setDraftVolume(clampVolume(value));
  };

  /** 媒体元数据就绪 → 进度条总时长。 */
  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) {
      setDurationMs(Math.round(video.duration * 1000));
    }
  };

  /** 播放位置推进 → 进度条 / 歌词（拖动中不被覆盖）。 */
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

  /**
   * 播放完成：音乐且队列里还有下一首 → **自动续播**（音乐播放器该有的行为）；
   * 其余（视频、队列只有这一首）→ 回到首帧并暂停（用户裁决）。
   */
  const onEnded = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (isAudio && canStep) {
      stepTrack(1);
      return;
    }
    video.currentTime = 0;
    video.pause();
    setPositionMs(0);
  };

  /**
   * 真正把播放位置移过去。
   *
   * 收成一处是刻意的：进度条 / 波形 / 将来别的定位入口若各写一遍 `currentTime = ...`，
   * 夹紧范围就会各写一遍，迟早出现"进度条能拖到末帧、别处点不到"这类不一致。
   */
  const commitSeek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) {
      return;
    }
    video.currentTime = Math.max(0, Math.min(ms / 1000, video.duration));
  }, []);

  /** 进度条拖动中：只更新本地显示值。 */
  const onScrub = (value: number) => {
    scrubbingRef.current = true;
    setScrubMs(value);
  };

  /** 松手才真正定位。 */
  const onScrubCommit = (value: number) => {
    scrubbingRef.current = false;
    setScrubMs(null);
    commitSeek(value);
  };

  /**
   * ← / → 切换上一个/下一个（与图像查看器同一套键盘语言）。
   *
   * 只用无修饰的左右方向键；`Tab` / `Enter` 等一律放行（不 `preventDefault`），
   * 否则音量条等原生控件会失去键盘操作。
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    stepTrack(event.key === "ArrowLeft" ? -1 : 1);
  };

  const displayPosition = scrubMs ?? positionMs;
  const seekable = Boolean(videoUrl) && durationMs > 0;
  const title = trackTitleOf(selectedFile?.relative_path);
  const artist = trackArtistOf(selectedFile?.relative_path);

  return (
    <div
      ref={rootRef}
      className="panel"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        // 点击画面即把键盘焦点交给面板（`<div>` 不会因子元素被点击而自动获得焦点）；
        // 控件是 `<button>`，点它们时不抢焦点。`preventScroll` 防止聚焦引起跳动。
        if ((event.target as HTMLElement).closest("button")) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="viewer-info">
        <span>{selectedFile?.relative_path ?? app.t("common.noSelection")}</span>
        <span className="dim">{selectedFile?.media_type ?? "—"}</span>
      </div>

      {/*
        画面区：DOM `<video>`（与查看器同构）——完全在 WebView 内，天然内嵌面板、
        被「全部设置」等浮层自然覆盖、点击由浏览器原生派发。
        音频时它是**看不见的播放器**（媒体元素仍在，只是 1px 透明），画面交给音乐模式。
        按用户裁决：**不显示**「单击暂停/播放」等提示文字，也不设悬停提示。
      */}
      <div
        className="player-stage"
        onClick={isAudio ? undefined : () => togglePlay()}
        data-mode={isAudio ? "music" : "video"}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            className={isAudio ? "player-video is-audio" : "player-video"}
            src={videoUrl}
            preload="metadata"
            playsInline
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
            onSeeked={onSeeked}
            onEnded={onEnded}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            aria-label={app.t("player.progress")}
          />
        ) : null}
        {isAudio ? (
          <MusicStage
            style={style}
            coverUrl={media.coverUrl}
            title={title}
            artist={artist}
            hazeColors={media.hazeColors}
            lyrics={media.lyrics}
            positionMs={positionMs}
            playing={playing}
            canPrev={canStep}
            canNext={canStep}
            onPrev={() => stepTrack(-1)}
            onNext={() => stepTrack(1)}
            onToggle={togglePlay}
            t={app.t}
          />
        ) : videoUrl ? null : (
          <div className="player-surface" />
        )}
      </div>

      {/* 音频波形（D115）：整段起伏 + 随播放位置移动的游标，点 / 拖即定位。
          音乐模式下也保留——它是"哪儿有声"的唯一读法，与封面/歌词不冲突。 */}
      {isAudio && videoUrl && selectedFile && (
        <AudioWaveform
          repoId={app.repoId ?? ""}
          fileId={selectedFile.id}
          durationMs={durationMs > 0 ? durationMs : null}
          positionMs={displayPosition}
          onSeek={(seconds) => commitSeek(seconds * 1000)}
          className="player-wave"
          t={app.t}
        />
      )}

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

        {/*
          音量（D142）：进度条**右侧**一枚图标，点它展开一条**竖状**控制条。
          图标按用户裁决不写悬停提示（与画面区同一条规矩），语义只走 `aria-label`。
        */}
        <div className="player-volume" ref={volumeBoxRef}>
          <button
            type="button"
            className={`player-volume-btn${volumeOpen ? " is-open" : ""}`}
            onClick={() => setVolumeOpen((open) => !open)}
            aria-label={app.t("player.volume")}
            aria-expanded={volumeOpen}
          >
            <VolumeIcon volume={volume} />
          </button>
          {volumeOpen && (
            <div className="player-volume-pop">
              <input
                className="player-volume-slider"
                type="range"
                min={0}
                max={100}
                step={1}
                value={volume}
                onChange={(e) => onVolumeInput(Number(e.target.value))}
                onMouseUp={(e) => commitVolume(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => commitVolume(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => commitVolume(Number((e.target as HTMLInputElement).value))}
                aria-label={app.t("player.volume")}
              />
              <span className="player-volume-value mono">{volume}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 音量图标（内联 SVG，颜色随按钮的 `currentColor`）。
 *
 * 三态正是"图标本身就是状态显示"：静音（喇叭 + 叉）、有声（一道声波）、过半
 * （两道声波）。图标不给悬停提示——与画面区同一条规矩（面板内不出提示文字）。
 */
function VolumeIcon({ volume }: { volume: number }): JSX.Element {
  const muted = volume === 0;
  const loud = volume >= 50;
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
      {!muted && (
        <path
          d="M16 8.5a4.5 4.5 0 0 1 0 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
      {!muted && loud && (
        <path
          d="M18.5 6.5a7.5 7.5 0 0 1 0 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
      {muted && (
        <path
          d="M16 9.5l5 5M21 9.5l-5 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
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
