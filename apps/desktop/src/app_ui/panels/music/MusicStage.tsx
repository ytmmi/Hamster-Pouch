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

import { useId, useMemo } from "react";

import type { TranslationKey } from "../../i18n";
import { activeLrcIndex, lrcWindow, pairLrcLines, type LrcDoc, type LrcItem } from "./lrc";
import { stageVars } from "./haze";
import type { MusicStyle } from "./musicStyle";
import type { RepeatMode } from "./queueView";
import { formatClock, formatMs, formatRemaining } from "./time";
import {
  LYRIC_LEAD_MS,
  lineProgress,
  lyricChars,
  lyricIndent,
  sungCharCount,
} from "./lyricView";

/** 当前行前后各渲染几行（2 行 ≈ 5 行可见：与参考图的歌词窗口一致，也够看）。 */
const LRC_RADIUS = 2;

export interface MusicStageProps {
  /** 当前样式（在设置里切换）。 */
  style: MusicStyle;
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
  /** 噪波滤镜的 id（每个实例一份，避免两个音乐面板互相抢同一个 `url(#…)`）。 */
  const noiseId = `player-haze-noise-${useId().replace(/[^\w-]/g, "")}`;
  const items = useMemo(() => (lyrics ? pairLrcLines(lyrics.lines) : null), [lyrics]);
  // 判定用 `positionMs + LYRIC_LEAD_MS`：行的淡入/放大过渡约 0.5s，提前一个过渡
  // 时长触发，动画收尾那一刻正好切到正在唱的那句（用户 2026-11-13 D171）。
  const activeIndex = useMemo(
    () => (lyrics?.synced && items ? activeLrcIndex(items, positionMs + LYRIC_LEAD_MS) : -1),
    [lyrics, items, positionMs],
  );
  const visible = useMemo(
    () => (items ? lrcWindow(items.length, activeIndex, LRC_RADIUS) : { start: 0, end: 0 }),
    [items, activeIndex],
  );
  return (
    <div
      className="player-music"
      data-style={style}
      style={{
        ...stageVars(props.hazeColors),
        ["--player-haze-noise" as string]: `url(#${noiseId})`,
      }}
    >
      {/*
        背景：**只用封面色板里的一两个主色**做光斑（用户 2026-11-13 口径：
        "在封面的颜色板上选 1-2 个颜色进行颜色晕的渲染，样式 1 不是直接进行封面的
        高斯模糊"）。因此这里既没有封面糊图、也没有第三种颜色。
      */}
      {/*
        色团要"像放大的、随时间变换的噪波"（用户 2026-11-13 D168）——靠两层叠加：
        ① `feTurbulence` + `feDisplacementMap` 把圆形色团的边缘撕成不规则流体，
           `baseFrequency` 用 SMIL 缓慢漂移，形状才会自己长出来又化掉；
        ② CSS 关键帧同时改 `border-radius` 与位移/缩放，周期互质（47s / 61s），
           两者叠加后不会出现"整块一起呼吸"的机械感。
        `useId` 保证同一页面里两个实例的滤镜 id 不撞。
      */}
      <svg className="player-haze-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id={noiseId} x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.004 0.008"
              numOctaves={4}
              seed={7}
              result="noise"
            >
              <animate
                attributeName="baseFrequency"
                dur="37s"
                values="0.003 0.007;0.010 0.004;0.006 0.011;0.003 0.007"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale={140}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
      <div className="player-haze" aria-hidden="true">
        <span className="player-haze-blob player-haze-blob-a" />
        <span className="player-haze-blob player-haze-blob-b" />
        <span className="player-haze-blob player-haze-blob-c" />
      </div>

      {style === "haze" ? (
        <div className="player-layout" data-variant="haze">
          <span className="player-topline" aria-hidden="true" />
          <div className="player-card">
            {/* 缺封面时**不缩排、不省略**：同一块画布，内容换成曲名（D167）。 */}
            <div className="player-art">
              <CoverVisual coverUrl={props.coverUrl} title={props.title} className="player-cover" />
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
          <Lyrics
            items={items}
            start={visible.start}
            end={visible.end}
            active={activeIndex}
            positionMs={positionMs}
            variant="haze"
            t={t}
          />
        </div>
      ) : (
        <div className="player-layout" data-variant="disc">
          <div className="player-info" data-has-lyrics={items && items.length > 0 ? "true" : "false"}>
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
            <Lyrics
            items={items}
            start={visible.start}
            end={visible.end}
            active={activeIndex}
            positionMs={positionMs}
            variant="disc"
            t={t}
          />
          </div>
          {/*
            控制区固定在**面板底部**、宽度只占左侧列（用户 2026-11-13 D168 裁决：
            "默认在面板底部，和样式 1 类似，不是和唱片平齐"）。歌词因此不会再被
            进度条挤到画面中部——它是信息区，控制区是另一块。
          */}
          <div className="player-bar" data-variant="disc">
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
          {/* 唱片始终在场（构图不因缺封面变化），中心圆里换成曲名（D167）。 */}
          <div className="player-vinyl">
            <span className="player-vinyl-ring player-vinyl-ring-outer" aria-hidden="true" />
            <span className="player-vinyl-ring player-vinyl-ring-inner" aria-hidden="true" />
            <div className="player-disc" data-playing={playing ? "true" : "false"}>
              <CoverVisual
                coverUrl={props.coverUrl}
                title={props.title}
                className="player-disc-cover"
                label={false}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 封面画面的两种形态：有封面就是那张图，没有封面就在**同一块画布**上画占位（D167）。
 *
 * 占位不换排版：同样的宽高、同样的圆角 / 圆形，缺封面不会让任何一块挪位。用户口径：
 * 「如果缺失封面，不是省略封面，而是用音乐名渲染封面进行占位，禁止因为缺失封面而
 * 改变样式的布局」。
 *
 * **两种占位内容不同**（用户 2026-11-13 追加）：
 * - 样式 1 的封面卡是独立的方块 → 占位写曲名（它是全场唯一"本该有张图"的位置）。
 * - 样式 2 的封面嵌在唱片圆心 → 占位**不写文字**，圆心直接变成唱片自己的一部分
 *   （盘心），因为那圈东西的本义是"唱片的中轴"，不是"墙上的画框"。
 */
function CoverVisual({
  coverUrl,
  title,
  className,
  label = true,
}: {
  coverUrl: string | null;
  title: string;
  className: string;
  /** 占位上是否写字。样式 2 传 `false`：圆心不写曲名。 */
  label?: boolean;
}) {
  if (coverUrl) {
    return <img className={className} src={coverUrl} alt="" draggable={false} />;
  }
  return (
    <span className={`${className} is-placeholder`} aria-hidden="true">
      {label ? <span className="player-cover-name">{title}</span> : null}
    </span>
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
  variant: MusicStyle;
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
        aria-label={t("music.progress")}
      />
      {variant === "haze" ? (
        <div className="player-seek-times mono">
          <span>{known ? formatClock(positionMs) : formatMs(positionMs)}</span>
          <span>{formatRemaining(positionMs, known ? durationMs : null)}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 传输控件：两种样式的**位置与形状不同**（见文件头）。
 *
 * - 样式 1（haze）：五枚无底 glyph 平铺在封面下面，等距铺满左列。
 * - 样式 2（disc）：分成三段——左右两端各贴住进度条的两端（随机/循环在左，收藏在右），
 *   上一首/播放/下一首居中。用户 2026-11-13：「随机播放、上一首、下一首、收藏等图标
 *   要和进度条两端对齐」——所以两端是 `1fr`、中间是 `auto`，图标才会被推到列的两边，
 *   而不是跟着整排居中。
 */
function Transport(props: MusicStageProps) {
  const { style, playing, t } = props;

  const shuffle = (
    <button
      type="button"
      className="player-transport-btn"
      data-role="shuffle"
      data-on={props.shuffle ? "true" : "false"}
      onClick={props.onToggleShuffle}
      aria-label={t("music.shuffle")}
      aria-pressed={props.shuffle}
    >
      <ShuffleIcon />
    </button>
  );
  const repeat = (
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
  );
  const prev = (
    <button
      type="button"
      className="player-transport-btn"
      data-role="prev"
      onClick={props.onPrev}
      disabled={!props.canPrev}
      aria-label={t("music.prevTrack")}
    >
      <PrevIcon />
    </button>
  );
  const play = (
    <button
      type="button"
      className="player-transport-btn player-transport-play"
      data-role="play"
      onClick={props.onToggle}
      aria-label={t(playing ? "music.pause" : "music.play")}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
  const next = (
    <button
      type="button"
      className="player-transport-btn"
      data-role="next"
      onClick={props.onNext}
      disabled={!props.canNext}
      aria-label={t("music.nextTrack")}
    >
      <NextIcon />
    </button>
  );

  if (style === "disc") {
    return (
      <div className="player-transport" data-variant="disc">
        <div className="player-transport-side">
          {shuffle}
          {repeat}
        </div>
        <div className="player-transport-main">
          {prev}
          {play}
          {next}
        </div>
        <div className="player-transport-side player-transport-side-end">
          <FavoriteIcon shape="heart" t={t} />
        </div>
      </div>
    );
  }

  return (
    <div className="player-transport" data-variant={style}>
      {shuffle}
      {prev}
      {play}
      {next}
      {repeat}
    </div>
  );
}

function repeatLabelKey(mode: RepeatMode): TranslationKey {
  if (mode === "one") return "music.repeatOne";
  if (mode === "all") return "music.repeatAll";
  return "music.repeatOff";
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
        aria-label={t("music.volume")}
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
  positionMs,
  variant,
  t,
}: {
  items: readonly LrcItem[] | null;
  start: number;
  end: number;
  active: number;
  positionMs: number;
  variant: MusicStyle;
  t: MusicStageProps["t"];
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className="player-lyrics" data-variant={variant} aria-label={t("music.lyrics")}>
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset;
        const distance = active < 0 ? index + 1 : index - active;
        const isActive = index === active;
        const indent = variant === "haze" && !isActive ? lyricIndent(distance) : 0;
        // 当前句逐字从左到右填充（用户 2026-11-13 D171，参考图 2 的口径）：已唱到的
        // 字换高亮色、未唱部分保持淡色，边界随播放推进——不是整句一起亮。
        const next = items[index + 1];
        const progress = isActive
          ? lineProgress(item.timeMs, next ? next.timeMs : null, positionMs)
          : 0;
        const chars = isActive ? lyricChars(item.main) : null;
        const sung = chars ? sungCharCount(chars.length, progress) : 0;
        return (
          <div
            key={`${item.timeMs}-${index}`}
            className={isActive ? "player-lyric is-active" : "player-lyric"}
            data-distance={Math.min(Math.max(distance, 0), 3)}
            style={indent > 0 ? { marginLeft: `${indent}cqw` } : undefined}
          >
            <div className="player-lyric-main">
              {chars
                ? chars.map((char, charIndex) => (
                    <span
                      // 同一句里可能重复字，位置参与 key 才稳定。
                      key={`${charIndex}-${char}`}
                      className="player-lyric-char"
                      data-sung={charIndex < sung ? "true" : "false"}
                    >
                      {char}
                    </span>
                  ))
                : item.main}
            </div>
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
      aria-label={t("music.favorite")}
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

/**
 * 收藏爱心：**空心描边**。
 *
 * 实心红心是"已收藏"的语义，而收藏功能尚未实装（用户 2026-11-13 D168：
 * "默认应该是空心的，红色实心表示已收藏"）——所以这里只画轮廓，不留任何
 * "已经收藏了"的误导。
 */
function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M12 20.5s-7.6-4.7-7.6-9.7A4.3 4.3 0 0 1 12 7.9a4.3 4.3 0 0 1 7.6 2.9c0 5-7.6 9.7-7.6 9.7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
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
