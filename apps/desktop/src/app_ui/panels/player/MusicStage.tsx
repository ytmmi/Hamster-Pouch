/**
 * 音乐播放器的**两种样式**（样式 1 色晕卡 / 样式 2 唱片），纯展示组件。
 *
 * 参考图定稿（用户 2026-11-13，第二版要求"几乎一致，除了画面比例"）：
 *
 * 样式 1（`haze`）——深底浅字，整块背景是**封面本身的高斯模糊**再叠三层主色光斑：
 * ```
 * ┌───────────────────────────────┬──────────────────────────────┐
 * │ ▣ 封面            （顶部一道短横）                            │
 * │   曲名  ★                     │   blurred  「上一句」          │
 * │   艺人                         │   blurred  上一句             │
 * │   ──────●──── 0:00     -3:24  │   原文（当前，清晰）           │
 * │   ⇄  ⏮   ⏸   ⏭   ↻          │   译文（当前，小字）           │
 * │   🔊 ────────●────            │   blurred  下一句             │
 * └───────────────────────────────┴──────────────────────────────┘
 * ```
 * 非当前行**有高斯模糊**，且逐行向右错开（参考图的歌词不是一列对齐的直线）。
 *
 * 样式 2（`disc`）——浅底深字，右上角一张**按封面上色**的大唱片（不是黑胶的黑），
 * 唱片外还有两道非标准的细环；唱片只在播放时转，暂停停在当前角度：
 * ```
 * ┌───────────────────────────────┬──────────────────────┐
 * │ 曲名 — 艺人                    │        ╭────╮        │
 * │ 上一句（淡）                   │      ╭─┤ 封面 ├─╮     │
 * │ 原文（当前，加粗）              │     ╱  ╰────╯  ╲      │
 * │ ────────●────────             │     ╲          ╱      │
 * │ ⇄  ⏮  (⏸)  ⏭  ↻  ♥          │      ╰────────╯       │
 * └───────────────────────────────┴──────────────────────┘
 * ```
 *
 * 两套样式的**传输控件位置与形状不同**（用户口径）：样式 1 是五枚无底 glyph 平铺在
 * 封面下面；样式 2 是"上一首 · 大圆底播放 · 下一首"，随机/循环缩成两端的小图标。
 *
 * 歌词来自 `.lrc`（`parseLrc` + `pairLrcLines`）；**没有歌词文件就整块不渲染**；
 * 没有时间轴的纯文本歌词照样显示、只是不做当前行高亮。当前行前后只渲染
 * `LRC_RADIUS` 行，DOM 数不随歌词长度增长。收藏**只有图标**（功能后续做），
 * 这里刻意渲染成非交互的 `<span>`：禁用按钮仍会进 Tab 序并被读屏读成"不可用"。
 */

import { useMemo } from "react";

import type { TranslationKey } from "../../i18n";
import { activeLrcIndex, lrcWindow, pairLrcLines, type LrcDoc, type LrcItem } from "./lrc";
import { stageVars } from "./haze";
import type { PlayerStyle } from "./playerStyle";
import type { RepeatMode } from "./queueView";
import { formatMs, formatRemaining } from "./time";
import { lyricIndent } from "./lyricView";

/** 当前行前后各渲染几行（3 行 ≈ 7 行可见，够看又不会占满整屏）。 */
const LRC_RADIUS = 3;

export interface MusicStageProps {
  /** 当前样式（在设置里切换）。 */
  style: PlayerStyle;
  /** 封面图 URL（`convertFileSrc` 过的本地资源）；`null` = 没有封面。 */
  coverUrl: string | null;
  /** 曲名（文件名推导，见 `trackInfo.ts`）。 */
  title: string;
  /** 艺人（文件名里没有 `" - "` 时为 `null`，不渲染那一半）。 */
  artist: string | null;
  /** 后端给的封面色（空数组 = 用兜底色晕）。 */
  hazeColors: readonly string[];
  /** 解析后的歌词；`null` = 没有歌词文件（整块不渲染）。 */
  lyrics: LrcDoc | null;
  /** 当前播放位置（歌词高亮 + 进度条）。 */
  positionMs: number;
  /** 总时长（未知时 `0`，进度条禁用）。 */
  durationMs: number;
  /** 是否正在播放（唱片转动 + 按钮图标）。 */
  playing: boolean;
  /** 音量 0–100。 */
  volume: number;
  /** 随机播放是否开启。 */
  shuffle: boolean;
  /** 循环模式。 */
  repeat: RepeatMode;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggle: () => void;
  onSeek: (ms: number) => void;
  onSeekCommit: (ms: number) => void;
  onVolume: (value: number) => void;
  onVolumeCommit: (value: number) => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

export function MusicStage(props: MusicStageProps) {
  const { style, lyrics, positionMs, playing, t } = props;
  const items = useMemo(() => (lyrics ? pairLrcLines(lyrics.lines) : null), [lyrics]);
  const activeIndex = useMemo(
    () => (lyrics?.synced && items ? activeLrcIndex(items, positionMs) : -1),
    [lyrics, items, positionMs],
  );
  const visible = useMemo(
    () => (items ? lrcWindow(items.length, activeIndex, LRC_RADIUS) : { start: 0, end: 0 }),
    [items, activeIndex],
  );

  return (
    <div className="player-music" data-style={style} style={stageVars(props.hazeColors)}>
      <div className="player-haze" aria-hidden="true">
        {props.coverUrl ? (
          <img className="player-haze-art" src={props.coverUrl} alt="" draggable={false} />
        ) : null}
        <span className="player-haze-blob player-haze-blob-a" />
        <span className="player-haze-blob player-haze-blob-b" />
        <span className="player-haze-blob player-haze-blob-c" />
      </div>

      {style === "haze" ? (
        <div className="player-layout" data-variant="haze">
          <span className="player-topline" aria-hidden="true" />
          <div className="player-card" data-empty={props.coverUrl ? "false" : "true"}>
            <div className="player-art" data-empty={props.coverUrl ? "false" : "true"}>
              {props.coverUrl ? (
                <img className="player-cover" src={props.coverUrl} alt="" draggable={false} />
              ) : null}
            </div>
            <div className="player-card-head">
              <TrackHeading title={props.title} artist={props.artist} />
              <FavoriteIcon shape="star" t={t} />
            </div>
            <SeekBar
              variant="haze"
              positionMs={positionMs}
              durationMs={props.durationMs}
              onSeek={props.onSeek}
              onSeekCommit={props.onSeekCommit}
              t={t}
            />
            <Transport {...props} />
            <VolumeBar
              volume={props.volume}
              onVolume={props.onVolume}
              onVolumeCommit={props.onVolumeCommit}
              t={t}
            />
          </div>
          <Lyrics items={items} start={visible.start} end={visible.end} active={activeIndex} variant="haze" t={t} />
        </div>
      ) : (
        <div className="player-layout" data-variant="disc">
          <div className="player-info">
            <div className="player-info-head">
              <span className="player-info-title">{props.title}</span>
              {props.artist ? (
                <>
                  <span className="player-info-dash" aria-hidden="true">
                    —
                  </span>
                  <span className="player-info-artist">{props.artist}</span>
                </>
              ) : null}
            </div>
            <Lyrics items={items} start={visible.start} end={visible.end} active={activeIndex} variant="disc" t={t} />
            <SeekBar
              variant="disc"
              positionMs={positionMs}
              durationMs={props.durationMs}
              onSeek={props.onSeek}
              onSeekCommit={props.onSeekCommit}
              t={t}
            />
            <Transport {...props} />
            <VolumeBar
              volume={props.volume}
              onVolume={props.onVolume}
              onVolumeCommit={props.onVolumeCommit}
              t={t}
            />
          </div>
          {props.coverUrl ? (
            <div className="player-vinyl">
              <span className="player-vinyl-ring player-vinyl-ring-outer" aria-hidden="true" />
              <span className="player-vinyl-ring player-vinyl-ring-inner" aria-hidden="true" />
              <div className="player-disc" data-playing={playing ? "true" : "false"}>
                <img className="player-disc-cover" src={props.coverUrl} alt="" draggable={false} />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 曲名 + 艺人（两种样式的排版不同，文字内容一致）。 */
function TrackHeading({ title, artist }: { title: string; artist: string | null }) {
  return (
    <div className="player-track">
      <div className="player-track-title">{title}</div>
      {artist ? <div className="player-track-artist">{artist}</div> : null}
    </div>
  );
}

/** 进度条（样式 1 两端带时间，样式 2 只有一条细线）。 */
function SeekBar({
  variant,
  positionMs,
  durationMs,
  onSeek,
  onSeekCommit,
  t,
}: {
  variant: PlayerStyle;
  positionMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
  onSeekCommit: (ms: number) => void;
  t: MusicStageProps["t"];
}) {
  const known = Number.isFinite(durationMs) && durationMs > 0;
  const max = known ? durationMs : 1;
  const value = Math.min(Math.max(0, positionMs), max);
  const percent = known ? (value / max) * 100 : 0;
  return (
    <div className="player-seek" data-variant={variant}>
      <input
        className="player-seek-bar"
        type="range"
        min={0}
        max={max}
        step={100}
        value={value}
        disabled={!known}
        style={{ ["--player-seek-pct" as string]: `${percent}%` }}
        onChange={(event) => onSeek(Number(event.target.value))}
        onMouseUp={(event) => onSeekCommit(Number((event.target as HTMLInputElement).value))}
        onTouchEnd={(event) => onSeekCommit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => onSeekCommit(Number((event.target as HTMLInputElement).value))}
        aria-label={t("player.progress")}
      />
      {variant === "haze" ? (
        <div className="player-seek-times mono">
          <span>{formatMs(positionMs)}</span>
          <span>{formatRemaining(positionMs, known ? durationMs : null)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** 传输控件：两种样式的位置与形状不同（见文件头）。 */
function Transport(props: MusicStageProps) {
  const { style, playing, t } = props;
  return (
    <div className="player-transport" data-variant={style}>
      <button
        type="button"
        className="player-transport-btn"
        data-role="shuffle"
        data-on={props.shuffle ? "true" : "false"}
        onClick={props.onToggleShuffle}
        aria-label={t("player.shuffle")}
        aria-pressed={props.shuffle}
      >
        <ShuffleIcon />
      </button>
      <button
        type="button"
        className="player-transport-btn"
        data-role="prev"
        onClick={props.onPrev}
        disabled={!props.canPrev}
        aria-label={t("player.prevTrack")}
      >
        <PrevIcon />
      </button>
      <button
        type="button"
        className="player-transport-btn player-transport-play"
        data-role="play"
        onClick={props.onToggle}
        aria-label={t(playing ? "player.pause" : "player.play")}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className="player-transport-btn"
        data-role="next"
        onClick={props.onNext}
        disabled={!props.canNext}
        aria-label={t("player.nextTrack")}
      >
        <NextIcon />
      </button>
      <button
        type="button"
        className="player-transport-btn"
        data-role="repeat"
        data-mode={props.repeat}
        onClick={props.onToggleRepeat}
        aria-label={t(repeatLabelKey(props.repeat))}
      >
        {props.repeat === "one" ? <RepeatOneIcon /> : <RepeatIcon />}
      </button>
      {style === "disc" ? <FavoriteIcon shape="heart" t={t} /> : null}
    </div>
  );
}

function repeatLabelKey(mode: RepeatMode): TranslationKey {
  if (mode === "one") return "player.repeatOne";
  if (mode === "all") return "player.repeatAll";
  return "player.repeatOff";
}

/** 音量（细条 + 图标；样式 2 里它淡到几乎只是提示，但不至于逼用户切样式调音量）。 */
function VolumeBar({
  volume,
  onVolume,
  onVolumeCommit,
  t,
}: {
  volume: number;
  onVolume: (value: number) => void;
  onVolumeCommit: (value: number) => void;
  t: MusicStageProps["t"];
}) {
  return (
    <div className="player-volume-row">
      <span className="player-volume-icon" aria-hidden="true">
        <SpeakerIcon volume={volume} />
      </span>
      <input
        className="player-volume-bar"
        type="range"
        min={0}
        max={100}
        step={1}
        value={volume}
        style={{ ["--player-seek-pct" as string]: `${volume}%` }}
        onChange={(event) => onVolume(Number(event.target.value))}
        onMouseUp={(event) => onVolumeCommit(Number((event.target as HTMLInputElement).value))}
        onTouchEnd={(event) => onVolumeCommit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => onVolumeCommit(Number((event.target as HTMLInputElement).value))}
        aria-label={t("player.volume")}
      />
    </div>
  );
}


/** 歌词窗口（无歌词 → 什么都不渲染；纯文本歌词 → 不高亮、不错位）。 */
function Lyrics({
  items,
  start,
  end,
  active,
  variant,
  t,
}: {
  items: readonly LrcItem[] | null;
  start: number;
  end: number;
  active: number;
  variant: PlayerStyle;
  t: MusicStageProps["t"];
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className="player-lyrics" data-variant={variant} aria-label={t("player.lyrics")}>
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset;
        const distance = active < 0 ? index + 1 : index - active;
        const isActive = index === active;
        const indent = variant === "haze" && !isActive ? lyricIndent(distance) : 0;
        return (
          <div
            key={`${item.timeMs}-${index}`}
            className={isActive ? "player-lyric is-active" : "player-lyric"}
            data-distance={Math.min(Math.max(distance, 0), 3)}
            style={indent > 0 ? { marginLeft: `${indent}cqw` } : undefined}
          >
            <div className="player-lyric-main">{item.main}</div>
            {item.sub ? <div className="player-lyric-sub">{item.sub}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** 收藏图标（**仅显示**，功能后续做；非交互元素，见文件头注释）。 */
function FavoriteIcon({ shape, t }: { shape: "star" | "heart"; t: MusicStageProps["t"] }) {
  return (
    <span
      className="player-fav"
      data-shape={shape}
      aria-label={t("player.favorite")}
      role="img"
    >
      {shape === "star" ? <StarIcon /> : <HeartIcon />}
    </span>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M19 5.5v13L8.5 12z" fill="currentColor" />
      <rect x="5" y="5.5" width="2.6" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M5 5.5v13L15.5 12z" fill="currentColor" />
      <rect x="16.4" y="5.5" width="2.6" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M4 7h3.2l8 10H20M4 17h3.2l3.1-3.9M15.4 7H20M20 7l-2.6-2.4M20 7l-2.6 2.4M20 17l-2.6-2.4M20 17l-2.6 2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M7 6h9a3.5 3.5 0 0 1 3.5 3.5V12M17 18H8a3.5 3.5 0 0 1-3.5-3.5V12M7 6L9.6 3.6M7 6l2.6 2.4M17 18l-2.6 2.4M17 18l-2.6-2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RepeatOneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M7 6h9a3.5 3.5 0 0 1 3.5 3.5V12M17 18H8a3.5 3.5 0 0 1-3.5-3.5V12M7 6L9.6 3.6M7 6l2.6 2.4M17 18l-2.6 2.4M17 18l-2.6-2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="12" y="15.4" textAnchor="middle" fontSize="8.5" fill="currentColor">
        1
      </text>
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M12 20.5s-7.6-4.7-7.6-9.7A4.3 4.3 0 0 1 12 7.9a4.3 4.3 0 0 1 7.6 2.9c0 5-7.6 9.7-7.6 9.7z"
        fill="currentColor"
      />
    </svg>
  );
}

function SpeakerIcon({ volume }: { volume: number }) {
  const muted = volume === 0;
  const loud = volume >= 50;
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M4 9.5v5h3.4l4.4 3.5V6L7.4 9.5H4z" fill="currentColor" />
      {!muted && (
        <path
          d="M15.4 9a4 4 0 0 1 0 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
      {!muted && loud && (
        <path
          d="M18 6.8a7.4 7.4 0 0 1 0 10.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
