/**
 * 音乐播放器的**两种样式**（样式 1 色晕卡 / 样式 2 唱片），纯展示组件。
 *
 * 参考图定稿（用户 2026-11-13）：
 *
 * - 样式 1：左边一张大封面卡（封面 → 曲名/艺人 → 收藏图标），右边整块歌词，
 *   背景是封面取色的三层缓慢流动色晕；无封面时**只显示文字**，卡片不留空框。
 * - 样式 2：左边文字（曲名/艺人 + 歌词），右边圆形唱片，**播放中匀速转动**、
 *   暂停即停在当前角度（`animation-play-state`，不是把角度归零）；无封面时
 *   唱片不出现（用户口径："没定义封面就不显示图片"）。
 *
 * 歌词来自 `.lrc`（`parseLrc`）；**没有歌词文件就整块不渲染**；没有时间轴的
 * 纯文本歌词照样显示、只是不出现当前行高亮。当前行前后只渲染 `LRC_RADIUS` 行，
 * DOM 数不随歌词长度增长。
 *
 * 收藏**只有图标**（功能后续做）：这里刻意渲染成非交互的 `<span>`，不是禁用
 * 按钮——禁用按钮仍会进 Tab 序并被读屏读成"不可用"，而它现在什么都不是。
 */

import { useMemo } from "react";

import type { TranslationKey } from "../../i18n";
import { activeLrcIndex, lrcWindow, type LrcDoc } from "./lrc";
import { hazeVars } from "./haze";
import type { PlayerStyle } from "./playerStyle";

/** 当前行前后各渲染几行（3 行 ≈ 7 行可见，够看又不会占满整屏）。 */
const LRC_RADIUS = 3;

export interface MusicStageProps {
  /** 当前样式（在设置里切换）。 */
  style: PlayerStyle;
  /** 封面图 URL（`convertFileSrc` 过的本地资源）；`null` = 没有封面。 */
  coverUrl: string | null;
  /** 曲名（文件名推导，见 `trackInfo.ts`）。 */
  title: string;
  /** 艺人（文件名里没有 `" - "` 时为 `null`，不渲染那一行）。 */
  artist: string | null;
  /** 后端给的封面色（空数组 = 用兜底色晕）。 */
  hazeColors: readonly string[];
  /** 解析后的歌词；`null` = 没有歌词文件（整块不渲染）。 */
  lyrics: LrcDoc | null;
  /** 当前播放位置（歌词高亮用）。 */
  positionMs: number;
  /** 是否正在播放（唱片转动 + 按钮图标）。 */
  playing: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggle: () => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

export function MusicStage(props: MusicStageProps) {
  const { style, lyrics, positionMs, playing, t } = props;
  const activeIndex = useMemo(
    () => (lyrics?.synced ? activeLrcIndex(lyrics.lines, positionMs) : -1),
    [lyrics, positionMs],
  );
  const visible = useMemo(
    () => (lyrics ? lrcWindow(lyrics.lines.length, activeIndex, LRC_RADIUS) : { start: 0, end: 0 }),
    [lyrics, activeIndex],
  );

  return (
    <div className="player-music" data-style={style} style={hazeVars(props.hazeColors)}>
      <div className="player-haze" aria-hidden="true">
        <span className="player-haze-blob player-haze-blob-a" />
        <span className="player-haze-blob player-haze-blob-b" />
        <span className="player-haze-blob player-haze-blob-c" />
      </div>
      <div className="player-music-body">
        {style === "disc" ? (
          <>
            <div className="player-music-meta">
              <TrackHeading title={props.title} artist={props.artist} />
              <Lyrics lines={lyrics} start={visible.start} end={visible.end} active={activeIndex} t={t} />
            </div>
            <div className="player-disc-zone">
              {props.coverUrl ? (
                <div className="player-disc" data-playing={playing ? "true" : "false"}>
                  <div className="player-disc-groove" aria-hidden="true" />
                  <img className="player-disc-cover" src={props.coverUrl} alt="" draggable={false} />
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="player-cover-card" data-empty={props.coverUrl ? "false" : "true"}>
              {props.coverUrl ? (
                <img className="player-cover" src={props.coverUrl} alt="" draggable={false} />
              ) : null}
              <div className="player-cover-meta">
                <TrackHeading title={props.title} artist={props.artist} />
                <FavoriteIcon shape="star" t={t} />
              </div>
            </div>
            <div className="player-music-lyrics">
              <Lyrics lines={lyrics} start={visible.start} end={visible.end} active={activeIndex} t={t} />
            </div>
          </>
        )}
      </div>
      <div className="player-transport">
        <button
          type="button"
          className="player-transport-btn"
          onClick={props.onPrev}
          disabled={!props.canPrev}
          aria-label={t("player.prevTrack")}
        >
          <PrevIcon />
        </button>
        <button
          type="button"
          className="player-transport-btn player-transport-play"
          onClick={props.onToggle}
          aria-label={t(playing ? "player.pause" : "player.play")}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="player-transport-btn"
          onClick={props.onNext}
          disabled={!props.canNext}
          aria-label={t("player.nextTrack")}
        >
          <NextIcon />
        </button>
        {style === "disc" ? <FavoriteIcon shape="heart" t={t} /> : null}
      </div>
    </div>
  );
}

/** 曲名 + 艺人（样式的差异只在容器排版，文字内容一致）。 */
function TrackHeading({ title, artist }: { title: string; artist: string | null }) {
  return (
    <div className="player-track">
      <div className="player-track-title">{title}</div>
      {artist ? <div className="player-track-artist">{artist}</div> : null}
    </div>
  );
}

/** 歌词窗口（无歌词 → 什么都不渲染；纯文本歌词 → 不高亮）。 */
function Lyrics({
  lines,
  start,
  end,
  active,
  t,
}: {
  lines: LrcDoc | null;
  start: number;
  end: number;
  active: number;
  t: MusicStageProps["t"];
}) {
  if (!lines || lines.lines.length === 0) return null;
  return (
    <div
      className="player-lyrics"
      data-synced={lines.synced ? "true" : "false"}
      aria-label={t("player.lyrics")}
    >
      {lines.lines.slice(start, end).map((line, offset) => {
        const index = start + offset;
        return (
          <div
            key={`${line.timeMs}-${index}`}
            className={index === active ? "player-lyric is-active" : "player-lyric"}
          >
            {line.text}
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
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M18 5.5v13L9 12z" fill="currentColor" />
      <rect x="5" y="5.5" width="2.6" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 5.5v13L15 12z" fill="currentColor" />
      <rect x="16.4" y="5.5" width="2.6" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
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
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 20s-7-4.4-7-9a4 4 0 017-2.6A4 4 0 0119 11c0 4.6-7 9-7 9z"
        fill="currentColor"
      />
    </svg>
  );
}
