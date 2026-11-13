/**
 * 音乐播放器面板（2026-11-13 / D166）——**独立面板**，不寄生在媒体播放器面板里。
 *
 * 用户口径（m00958 之后确立）：音乐是**自己的面板**（`music`），媒体播放器面板
 * （`player`）只管视频。两者共享同一套队列口径（`queueView` / `useMusicQueue`）与
 * 同一套切曲手势（`←` / `→`、上一首 / 下一首），但各有各的面板设置
 * （`panel.music.style` / `volume` / `autoPauseOnTabSwitch`）。
 *
 * ## 两套样式（参考图定稿）
 *
 * - `haze`（样式 1）：深底浅字。左列是封面卡 + 曲名/艺人 + ★ + 进度 + 五枚无底
 *   传输 glyph + 音量条；右侧歌词是"原文大字 + 译文小字"成对，非当前行**高斯模糊**
 *   并逐行右移错位；背景是封面取色的缓慢流动晕染（`MusicStage` 的三层光斑）。
 * - `disc`（样式 2）：浅底深字。左列是曲名 — 艺人 + 歌词 + 进度 + 传输（大圆底
 *   播放键 + 红心）+ 音量条；右侧大唱片，播放中匀速转动，暂停停住。
 *
 * 样式在「全部设置 → 面板 → 音乐播放器 → 样式」切换（`panel.music.style`）。
 *
 * ## 取料（封面 / 歌词 / 色晕）来自后端
 *
 * 一条 `player.media` 命令带回三样东西（见 `docs/spec/commands-events.md` §3.3.3）：
 * 内嵌封面优先、其次同目录同名图片，`.lrc` 同目录同名（UTF-8/GBK 自动识别），
 * 以及从封面算出的 5 色主色板。**色晕只能由后端算**：asset 协议是跨源的，
 * canvas `getImageData` 会污染画布，前端取不到封面像素（D165 ④）。
 *
 * ## 播放来源
 *
 * 1. 蓝图双击音频（`payload.play`）→ `musicPlayStore` → 本面板解析路径并播放；
 * 2. 选中音频 → **只预载元数据**（时长/进度条/封面先出来），不出声（D142：首次
 *    播放必须由用户手势发起）；
 * 3. 用户点播放键 / 双击音频时才是真出声。
 *
 * ## 边界
 *
 * - 面板**只处理 `media_type === "audio"`**：选中视频时画面区是空舞台，不与媒体
 *   播放器面板抢活（两个面板可以同时开着，各放各的）。
 * - 收藏（★ / 红心）只显示图标，功能后续添加（用户 2026-11-13 口径）；用非交互的
 *   `span[role=img]`，不是"灰掉的按钮"。
 */

import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { usePanelSettingValue } from "../shared/settingValue";
import { publishSettingChanged } from "../core/settingChangeStore";
import { useApp } from "../core/AppContext";
import { getMusicPlayRequest, subscribeMusicPlay } from "../core/musicPlayStore";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { MusicStage } from "./music/MusicStage";
import { normalizeMusicStyle } from "./music/musicStyle";
import { parseLrc, type LrcDoc } from "./music/lrc";
import { trackArtistOf, trackTitleOf } from "./music/trackInfo";
import {
  canStepPlayable,
  cycleRepeatMode,
  DEFAULT_PLAYBACK_MODE,
  stepPlayable,
  toggleShuffleMode,
  type PlaybackMode,
  type StepOptions,
} from "./music/queueView";
import { useMusicQueue } from "./music/useMusicQueue";

export interface MusicPlayerPanelProps {
  /** dockview 面板 API；独立窗口宿主传替身（恒为激活）。 */
  api: PanelRenderCtx["api"];
}

/** 「切换标签时自动暂停」设置键（本面板自己的，与媒体播放器面板分开）。 */
const MUSIC_AUTO_PAUSE_SETTING_KEY = "panel.music.autoPauseOnTabSwitch";

/** 「音量」设置键（百分比 0–100）。 */
const MUSIC_VOLUME_SETTING_KEY = "panel.music.volume";

/** 音量缺省值（= 原声），与设置声明里的 `default` 保持一致。 */
const MUSIC_VOLUME_DEFAULT = 100;

/** 取料（封面 / 歌词 / 色晕）的空值：没有音频、取料失败都回落它。 */
const EMPTY_MEDIA: PanelMedia = {
  coverUrl: null,
  lyrics: null,
  hazeColors: [],
  tagTitle: null,
  tagArtist: null,
};

interface PanelMedia {
  /** 封面 URL（`convertFileSrc` 过的本地路径）；`null` = 没有封面。 */
  coverUrl: string | null;
  /** 解析后的歌词；`null` = 没有歌词文件。 */
  lyrics: LrcDoc | null;
  /** 封面色（空数组 = 用兜底色晕）。 */
  hazeColors: string[];
  /** 标签里的曲名；`null` = 没标签（回落到文件名切分）。 */
  tagTitle: string | null;
  /** 标签里的艺术家；`null` = 没标签。 */
  tagArtist: string | null;
}

/**
 * 音量夹紧到 0–100 的整数。
 *
 * 设置声明里**没有** min/max（见 `docs/spec/panel-standard.md` 第 5.3 节），范围由
 * 面板自己保证：落库值可能来自旧版本、手改的 `app_settings` 或宿主控件的边界。
 */
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return MUSIC_VOLUME_DEFAULT;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function MusicPlayerPanel({ api: panelApi }: MusicPlayerPanelProps): JSX.Element {
  const app = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  /** 当前加载的音频源（`convertFileSrc` 后的可播 URL）；`null` = 无源。 */
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  /** 播放请求序号：每次请求 +1，触发"加载后自动播放"（同文件重播也生效）。 */
  /** 当前源的 URL（异步回调里判断"源有没有换"）。 */
  const sourceUrlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLVideoElement>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  /** 元素是否在播（唱片转动、播放/暂停图标用；来源是 DOM 真实事件）。 */
  const [playing, setPlaying] = useState(false);
  /**
   * 随机 / 循环（用户 2026-11-13 批准"随机和循环可以做"）。
   *
   * 只存在**本次会话**里，不落库：它们是"这次怎么听"，跟"这个面板长什么样"不是
   * 一类东西（样式与音量才是设置）。缺省 = 顺序播放（不随机、不循环），且两者
   * **互斥**：点其一必取消另一个（用户 2026-11-13 裁决，见 `queueView.ts`）。
   */
  const [mode, setMode] = useState<PlaybackMode>(DEFAULT_PLAYBACK_MODE);
  const { shuffle, repeat } = mode;
  const stepOptions: StepOptions = { shuffle, repeat };
  /** 「切换标签时自动暂停」当前值（未设置 = 默认开）；用 ref 供可见性回调读取。 */
  const autoPauseRef = useRef(true);
  /** 设置是否已从存储读到（未读到前不自动暂停，避免用未经确认的默认值）。 */
  const autoPauseLoadedRef = useRef(false);
  /** 上次可见性（只对"可见→隐藏"的**转换**做自动暂停；挂载即隐藏不算切走）。 */
  const wasVisibleRef = useRef(Boolean(panelApi.isVisible && panelApi.isActive));
  /** 播放命令进行中：抑制重复触发。 */
  const busyRef = useRef(false);
  /**
   * 下一次 src 就绪是否**自动出声**：只有"用户点了播放 / 蓝图请求播放"才是 `true`；
   * 单纯切换选中只预载元数据（D142：首次播放必须由用户手势发起）。
   */
  const autoPlayRef = useRef(false);
  /** 当前 `<video>` 里装的是哪个文件（避免同文件重复换源丢掉进度）。 */
  const loadedFileIdRef = useRef<string | null>(null);
  /** 最新 app 上下文（供只订阅一次的 effect 读取，避免闭包过期）。 */
  const appRef = useRef(app);
  appRef.current = app;
  sourceUrlRef.current = sourceUrl;

  const selectedFile = app.selectedFile;
  const isAudio = selectedFile?.media_type === "audio";
  /** 样式（设置里切换；非法值回落缺省）。 */
  const style = normalizeMusicStyle(usePanelSettingValue("music", "style", panelApi));
  /** 可播放队列（"上一首 / 下一首"的范围）。 */
  const queue = useMusicQueue(app, panelApi);

  /**
   * 音量（百分比 0–100）。走面板设置的**标准读取路径**：`usePanelSettingValue`
   * 负责四条热更新触发源与声明里的 `default`，面板不再自己读一遍 `app_settings`。
   */
  const storedVolume = usePanelSettingValue("music", "volume", panelApi);
  /** 拖动音量条中：以本地值为准（松手才落库），与进度条同款时序。 */
  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  const volume =
    draftVolume ??
    (typeof storedVolume === "number" ? clampVolume(storedVolume) : MUSIC_VOLUME_DEFAULT);

  /** 取料（封面 / 歌词 / 色晕）。 */
  const [media, setMedia] = useState<PanelMedia>(EMPTY_MEDIA);
  /** 取料世代号：快速连点上一首/下一首时，旧请求的结果必须作废。 */
  const mediaGenerationRef = useRef(0);

  /** 读取「切换标签时自动暂停」设置（未设置 = 默认开）。 */
  const reloadAutoPauseSetting = useCallback(async () => {
    try {
      const result = await api.settingGet({ key: MUSIC_AUTO_PAUSE_SETTING_KEY });
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

  /**
   * 加载指定文件；`autoplay` 为假时**只换源、不出声**。
   *
   * 为什么要这个开关（用户 2026-11-13）：「控制图标是暂停时，切换下一首，禁止
   * 自动播放，图标是播放时才可以自动播放」。切歌是"用户的意图延续"——暂停态下
   * 点下一首，期望的是"翻到下一首停在开头"，不是"突然开始放"。
   */
  const loadAndPlay = useCallback(async (fileId: string, autoplay = true) => {
    const ctx = appRef.current;
    if (!ctx.repoId) {
      return;
    }
    busyRef.current = true;
    // 先认领这个文件，再等路径：否则"选中变化 → 只预载"那条 effect 会抢在前面
    // 把 `autoPlayRef` 打回 false（它看到 `loadedFileIdRef` 还是旧文件就自己去预载），
    // 于是切歌后有源、有进度、就是不出声。
    loadedFileIdRef.current = fileId;
    try {
      const path = await api.filePath({ repoId: ctx.repoId, fileId });
      autoPlayRef.current = autoplay;
      setPositionMs(0);
      setDurationMs(0);
      // 切歌先落"暂停"这一态：图标由元素事件驱动，但换源到真正出声之间有一段
      // 异步间隙，不先落下来的话旧曲目的"||"会一直挂着（用户真机反馈的现象）。
      setPlaying(false);
      const nextUrl = convertFileSrc(path);
      if (nextUrl === sourceUrlRef.current && audioRef.current) {
        // 同一首再播：源没换，直接回到开头（换源那次交给 `onLoadedMetadata`）。
        autoPlayRef.current = false;
        audioRef.current.currentTime = 0;
        if (autoplay) {
          void audioRef.current.play().catch(() => undefined);
          ctx.status(ctx.t("music.playing"), "ok");
        }
        return;
      }
      setSourceUrl(nextUrl);
      if (autoplay) {
        ctx.status(ctx.t("music.playing"), "ok");
      }
    } catch (e) {
      // 路径没拿到：把认领退回去，选中变化时那条预载 effect 还能再试一次。
      loadedFileIdRef.current = null;
      ctx.status(ctx.t("music.playFailed", { err: errorTextOf(ctx.t, e) }), "error");
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** 播放当前选中的音频（无源时点播放键）。 */
  const playSelected = useCallback(async () => {
    const file = app.selectedFile;
    if (!app.repoId || !file || file.media_type !== "audio") {
      app.status(app.t("music.selectFileFirst"), "error");
      return;
    }
    await loadAndPlay(file.id);
  }, [app, loadAndPlay]);

  /**
   * 暂停 / 继续。
   *
   * 状态读取的是 DOM 元素**实时的** `.paused`（浏览器保证当前值），不做任何本地
   * 快照——快速连点每次都是"读到最新态再取反"。无源时退化为"播放当前选中音频"。
   */
  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !sourceUrl || !isAudio) {
      void playSelected();
      return;
    }
    if (audio.paused) {
      // 用户手势内发起播放，自动播放策略不会拦截。
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, [isAudio, playSelected, sourceUrl]);

  /** 换一首（`±1`）：选中目标文件并立即播放；同类队列按循环/随机规则走。 */
  const stepTrack = useCallback(
    (delta: number) => {
      const ctx = appRef.current;
      const current = ctx.selectedFile;
      if (!current || current.media_type !== "audio") return;
      const nextIndex = stepPlayable(queue.files, queue.index, delta, "audio", stepOptions);
      const target = queue.files[nextIndex];
      if (!target) return;
      if (target.id !== current.id) {
        ctx.setSelectedIds(new Set([target.id]));
        ctx.setSelectedFile(target);
      }
      // 是否出声跟随**切换那一刻**的播放状态：暂停态切歌只换曲目、不自动播放。
      void loadAndPlay(target.id, playing);
    },
    [loadAndPlay, playing, queue.files, queue.index, shuffle, repeat],
  );

  /**
   * "上一首 / 下一首"是否可用：与步进**同一份规则**（`canStepPlayable`）——
   * 循环关闭且已在队尾时"下一首"就是不可用的，按钮不能还亮着让人点出一个"什么都没发生"。
   */
  const canPrev =
    isAudio && queue.index >= 0 && canStepPlayable(queue.files, queue.index, -1, "audio", stepOptions);
  const canNext =
    isAudio && queue.index >= 0 && canStepPlayable(queue.files, queue.index, 1, "audio", stepOptions);

  // 播放请求（蓝图双击音频）：挂载即读一次（面板可能后挂载），再订阅后续请求。
  useEffect(() => {
    const play = (fileId: string) => {
      void loadAndPlay(fileId);
    };
    const initial = getMusicPlayRequest();
    if (initial) {
      play(initial.fileId);
    }
    return subscribeMusicPlay(() => {
      const request = getMusicPlayRequest();
      if (request) {
        play(request.fileId);
      }
    });
  }, [loadAndPlay]);

  // 选中变化 → **只预载**（时长/进度条立刻可用、封面与色晕先出来），不自动出声。
  useEffect(() => {
    const file = app.selectedFile;
    const repoId = app.repoId;
    if (!repoId || !file) return;
    if (file.media_type !== "audio") return;
    if (loadedFileIdRef.current === file.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const path = await api.filePath({ repoId, fileId: file.id });
        if (cancelled) return;
        autoPlayRef.current = false;
        loadedFileIdRef.current = file.id;
        setSourceUrl(convertFileSrc(path));
        setPositionMs(0);
        setDurationMs(0);
      } catch {
        // 预载失败不弹错：等用户真的点播放时 `loadAndPlay` 会报出来。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app.repoId, app.selectedFile]);

  // 取料：选中音频就向后端要封面/歌词/色晕（非音频 → 清空）。
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
          tagTitle: result.title ?? null,
          tagArtist: result.artist ?? null,
        });
      } catch {
        // 取料失败不该挡住播放：没有封面/歌词，面板照常出声。
        if (mediaGenerationRef.current !== generation) return;
        setMedia(EMPTY_MEDIA);
      }
    })();
  }, [app.repoId, app.selectedFile, app.refreshKey]);

  // 面板可见性 → 切标签自动暂停。隐藏用 DOM 元素的 `pause()`（媒体在后台标签
  // 保持加载与进度，切回即暂停，点播放键继续）。
  useEffect(() => {
    void reloadAutoPauseSetting();
    const sync = () => {
      const visible = Boolean(panelApi.isVisible && panelApi.isActive);
      const prevVisible = wasVisibleRef.current;
      wasVisibleRef.current = visible;
      if (visible) {
        // 回到前台：刷新设置值，使设置修改无需重启即生效。
        void reloadAutoPauseSetting();
      } else if (prevVisible && autoPauseLoadedRef.current && autoPauseRef.current) {
        audioRef.current?.pause();
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

  // 音量落到元素上：元素是 `sourceUrl` 就绪后才挂载的，所以两个依赖都要看
  // （换源 = 新元素，必须重新应用；音量变化 = 当前元素即时生效）。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.volume = volume / 100;
    // 0 直接静音：比"音量 0 仍在解码出声"的边界更符合直觉，图标也才与听感一致。
    audio.muted = volume === 0;
  }, [volume, sourceUrl]);

  /** 音量写回（松手 / 键盘调整后）。落库失败不影响本次播放。 */
  const commitVolume = useCallback((value: number) => {
    const next = clampVolume(value);
    setDraftVolume(null);
    void api
      .settingSet({ key: MUSIC_VOLUME_SETTING_KEY, value: next })
      .then(() => publishSettingChanged(MUSIC_VOLUME_SETTING_KEY))
      .catch(() => {
        /* 写入失败不该让播放中断。 */
      });
  }, []);

  /** 音量条拖动中：只更新本地显示值（出声即时，落库等松手）。 */
  const onVolumeInput = (value: number) => {
    setDraftVolume(clampVolume(value));
  };

  /**
   * 元数据就绪 → 总时长；若这次请求"要出声"，在这里 `play()`。
   *
   * **不能**在设 `src` 的同一拍调 `play()`：`load()` 与 `play()` 抢同一个元素时，
   * Chromium 以 `AbortError: The play() request was interrupted by a call to load()`
   * 拒绝播放——真机表现就是"切了歌但不出声，图标还停在播放中"。
   */
  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (Number.isFinite(audio.duration)) {
      setDurationMs(Math.round(audio.duration * 1000));
    }
    if (autoPlayRef.current) {
      autoPlayRef.current = false;
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    }
  };

  /** 播放位置推进 → 进度条 / 歌词。 */
  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (audio) {
      setPositionMs(Math.round(audio.currentTime * 1000));
    }
  };

  /** 拖动定位完成 → 以新位置刷新进度条。 */
  const onSeeked = () => {
    const audio = audioRef.current;
    if (audio) {
      setPositionMs(Math.round(audio.currentTime * 1000));
    }
  };

  /**
   * 播放完成：**自动续播**（音乐播放器该有的行为）。
   *
   * - 单曲循环：不换文件，从头再放（避免重新取封面/歌词）；
   * - 列表循环 / 随机 / 还有下一首：续播；
   * - 循环关闭且到头：回到开头并暂停。
   */
  const onEnded = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (repeat === "one") {
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
      return;
    }
    if (canNext) {
      stepTrack(1);
      return;
    }
    audio.currentTime = 0;
    audio.pause();
    setPositionMs(0);
  };

  /**
   * 真正把播放位置移过去（进度条唯一入口）。
   *
   * 收成一处是刻意的：定位入口若各写一遍 `currentTime = ...`，夹紧范围就会各写
   * 一遍，迟早出现"进度条能拖到末帧、别处点不到"这类不一致。
   */
  const commitSeek = useCallback((ms: number) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) {
      return;
    }
    audio.currentTime = Math.max(0, Math.min(ms / 1000, audio.duration));
  }, []);

  /**
   * ← / → 切换上一首/下一首（与图像查看器同一套键盘语言）。
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

  // 曲名 / 艺术家：**标签优先，文件名兜底**（D167）。
  // 标签是文件自己声明的，没有"哪一侧是艺人"的歧义；文件名只在没标签时用。
  const title = media.tagTitle ?? trackTitleOf(selectedFile?.relative_path);
  const artist = media.tagArtist ?? trackArtistOf(selectedFile?.relative_path);

  return (
    <div
      ref={rootRef}
      className="panel"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        // 点击舞台即把键盘焦点交给面板（`<div>` 不会因子元素被点击而自动获得焦点）；
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
        舞台：DOM `<video>` 音频时是**看不见的播放器**（元素仍在，只是 1px 透明），
        画面整块交给 `MusicStage`。视频文件不归本面板管（选中视频时是空舞台）。
      */}
      <div className="player-stage" data-mode="music">
        {isAudio && sourceUrl ? (
          <video
            ref={audioRef}
            className="player-video is-audio"
            src={sourceUrl}
            preload="metadata"
            playsInline
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
            onSeeked={onSeeked}
            onEnded={onEnded}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            aria-label={app.t("music.progress")}
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
            durationMs={durationMs}
            playing={playing}
            volume={volume}
            shuffle={shuffle}
            repeat={repeat}
            canPrev={canPrev}
            canNext={canNext}
            onPrev={() => stepTrack(-1)}
            onNext={() => stepTrack(1)}
            onToggle={togglePlay}
            onSeek={(ms) => setPositionMs(ms)}
            onSeekCommit={commitSeek}
            onVolume={onVolumeInput}
            onVolumeCommit={commitVolume}
            onToggleShuffle={() => setMode((current) => toggleShuffleMode(current))}
            onToggleRepeat={() => setMode((current) => cycleRepeatMode(current))}
            t={app.t}
          />
        ) : (
          <div className="player-surface" />
        )}
      </div>
    </div>
  );
}
