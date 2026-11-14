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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { TranslationKey } from "../../i18n";
import { activeLrcIndex, lrcWindow, pairLrcLines, type LrcDoc, type LrcItem } from "./lrc";
import { stageVars } from "./haze";
import { hasRuby, parseRuby, type RubySegment } from "./ruby";
import type { MusicStyle } from "./musicStyle";
import type { RepeatMode } from "./queueView";
import { formatClock, formatMs, formatRemaining } from "./time";
import {
  LYRIC_LEAD_MS,
  lineProgress,
  lyricBandFill,
  lyricBands,
  lyricFillPercent,
  lyricIndent,
  type BoxRect,
  type LyricBand,
} from "./lyricView";

/** 当前行前后各渲染几行（2 行 ≈ 5 行可见：与参考图的歌词窗口一致，也够看）。 */
const LRC_RADIUS = 3;

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
  /** 当前播放位置（歌词高亮 + 进度条）。粒度是 `timeupdate` 的 ~4Hz，只够驱动"换句"。 */
  positionMs: number;
  /**
   * 播放头的**实时**读数（毫秒）；`null` = 读不到。给了就每帧读它推进填充——
   * `timeupdate` 的 250ms 台阶撑不起连续填充（见 `useLyricFill` 的注释）。
   */
  readPositionMs?: () => number | null;
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
  const { style, lyrics, positionMs, playing, t, readPositionMs } = props;
  const items = useMemo(() => (lyrics ? pairLrcLines(lyrics.lines) : null), [lyrics]);
  // 歌词的"当前时刻"只有一个：`positionMs + LYRIC_LEAD_MS`。行的淡入/放大过渡约 0.5s，
  // 提前一个过渡时长判定，动画收尾那一刻正好是新句开唱（用户 2026-11-13 D171）。
  // **填充进度必须用同一个时钟**——早先判定用提前量、填充用原始播放位置，两个钟差 480ms，
  // 于是高亮比声音慢半拍、末尾两个字还没亮就换句（用户 2026-11-13 D172 报的现象）。
  const clockMs = positionMs + LYRIC_LEAD_MS;
  // 当前行是 **state** 而不是 `useMemo`：推进它的是一次 rAF 循环（每帧读播放头真值），
  // 不是每次 props 变化。换句那一下才重渲染，填充本身不碰 React（见 `useLyricFill`）。
  const fill = useLyricFill(items, lyrics?.synced ?? false, clockMs, playing, readPositionMs);
  const activeIndex = fill.activeIndex;
  const visible = useMemo(
    () => (items ? lrcWindow(items.length, activeIndex, LRC_RADIUS) : { start: 0, end: 0 }),
    [items, activeIndex],
  );
  return (
    <div
      className="player-music"
      data-style={style}
      style={stageVars(props.hazeColors)}
    >
      {/*
        背景：**只用封面色板里的一两个主色**做光斑（用户 2026-11-13 口径：
        "在封面的颜色板上选 1-2 个颜色进行颜色晕的渲染，样式 1 不是直接进行封面的
        高斯模糊"）。因此这里既没有封面糊图、也没有第三种颜色。
      */}
      {/*
        色团（用户 2026-11-13 D168 口径）：要"像放大的、随时间变换的噪波"。
        形状由 CSS 里离线烘焙的噪波纹理（`--player-haze-tex-a/b/c`）给，元素自身
        只做 transform / opacity 动画 —— 全部落在合成器上，不再每帧求值滤镜
        （2026-11-14 D175 性能重做：旧版每团一个 `feTurbulence` 滤镜 + 外层
        `hue-rotate` 动画，实测 51 fps / 峰值 265ms，现在是 107 fps / 峰值 247ms）。

        2026-11-14 D177（用户：「色晕雾化不够，能看出来还是原来那个形状」）：
        每团拆成**两层**——两个兄弟元素各挂一张**不同**的噪波纹理，各自按不同节奏
        淡入淡出。单张静态纹理无论怎么转，轮廓都是那张图；两层交叉淡入时轮廓是
        两张图的和，才会"看起来一直在变"。定位/漂移放在外层 `.player-haze-cluster`
        上，两层只负责自己的透明度（mask 是元素级的，做不成子层）。
      */}
      <div className="player-haze" aria-hidden="true">
        <span className="player-haze-cluster player-haze-cluster-a">
          <span className="player-haze-blob player-haze-blob-a" />
          <span className="player-haze-blob player-haze-blob-a-alt" />
        </span>
        <span className="player-haze-cluster player-haze-cluster-b">
          <span className="player-haze-blob player-haze-blob-b" />
          <span className="player-haze-blob player-haze-blob-b-alt" />
        </span>
        <span className="player-haze-cluster player-haze-cluster-c">
          <span className="player-haze-blob player-haze-blob-c" />
          <span className="player-haze-blob player-haze-blob-c-alt" />
        </span>
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
            fillRef={fill.fillRef}
            onBands={fill.onBands}
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
            fillRef={fill.fillRef}
            onBands={fill.onBands}
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
/**
 * 鼠标按下时**不抢焦点**。
 *
 * 传输按钮是 `<button>`，浏览器默认行为是"按下即聚焦"——于是点过「播放」之后，这个按钮
 * 一直是 `document.activeElement`，再按空格 / 方向键时浏览器会把它当成"激活当前按钮"，
 * 空格又触发一次播放切换、方向键被按钮吞掉（用户 2026-11-14 D174：「最近点击的按钮，
 * 会被键盘的空格、方向键触发」）。`preventDefault()` 只挡"按下即聚焦"这一条默认行为，
 * 不挡 click（播放照常）、也不影响键盘 Tab 到按钮上——键盘用户仍可聚焦并用空格激活。
 */
const keepFocusOnStage = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

/**
 * 按钮上的"激活键"一律吞掉：空格 / 回车（原生激活）与方向键（会被面板当成切歌）。
 *
 * 用户 2026-11-14 补充：「当焦点在播放暂停图标时，空格、方向键都可以触发播放暂停」——
 * 光靠 `onMouseDown` 只挡"点一下就聚焦"，键盘 Tab、或焦点被代码设上去时仍然会中招。
 * 所以按钮本身 `tabIndex={-1}`（不进 Tab 序列）、`onMouseDown` 不抢焦点、`onKeyDown`
 * 再把这几个键拦下：焦点无论如何落在按钮上，键盘都不会二次触发播放。
 */
const swallowButtonKeys = (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
  const blocked =
    event.key === " " || event.key === "Enter" || event.key === "Spacebar" || event.key.startsWith("Arrow");
  if (!blocked) return;
  event.preventDefault();
  event.stopPropagation();
};

function Transport(props: MusicStageProps) {
  const { style, playing, t } = props;

  const shuffle = (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={keepFocusOnStage}
      onKeyDown={swallowButtonKeys}
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
      tabIndex={-1}
      onMouseDown={keepFocusOnStage}
      onKeyDown={swallowButtonKeys}
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
      tabIndex={-1}
      onMouseDown={keepFocusOnStage}
      onKeyDown={swallowButtonKeys}
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
      tabIndex={-1}
      onMouseDown={keepFocusOnStage}
      onKeyDown={swallowButtonKeys}
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
      tabIndex={-1}
      onMouseDown={keepFocusOnStage}
      onKeyDown={swallowButtonKeys}
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


/**
 * 当前句的**填充推进器**：每帧读一次播放头真值，把进度写进 CSS 自定义属性。
 *
 * 为什么不是"`positionMs` 变一次就算一次"：`positionMs` 来自 `<audio>` 的 `timeupdate`，
 * 浏览器只给 **~4Hz（250ms 一跳）**。早先靠 `transition: --player-lyric-progress 0.2s`
 * 把台阶抹平，可过渡是**每来一个新值就重启**的：200ms 过渡 + 250ms 更新的节奏下，边界
 * "追上—停住—再追"，再叠上 `timeupdate` 自身的抖动，观感就是卡顿（用户 2026-11-14 D178）。
 *
 * 现在 rAF 每帧读 `readPositionMs()`（`audio.currentTime`，精确且与音频同源）算进度，
 * 只调一次 `style.setProperty` —— 不触发 re-render（**换句**才 setState），也没有被反复
 * 重启的过渡。读不到实时读数时退回 `positionMs`（粗时钟），行为与旧版一致。
 */
function useLyricFill(
  items: readonly LrcItem[] | null,
  synced: boolean,
  clockMs: number,
  playing: boolean,
  readPositionMs?: () => number | null,
) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const fillRef = useRef<HTMLDivElement | null>(null);
  /** 循环里用的当前行号（state 的快照：不把 `activeIndex` 放进 effect 的依赖）。 */
  const indexRef = useRef(-1);
  /** 上一次真正写进 CSS 的百分比：值没变就不碰样式，省掉一次重绘。 */
  const paintedRef = useRef("");
  /** 粗时钟（props 那份）：读不到实时读数时的兜底。 */
  const coarseRef = useRef(clockMs);
  /** 当前句折行后每一行的矩形：由活动行量好交上来（单行时是 `null`）。 */
  const bandsRef = useRef<LyricBand[] | null>(null);
  /** 当前元素上是不是已经写过分行填充：切回单行时要把它撤掉。 */
  const bandedRef = useRef(false);

  useEffect(() => {
    coarseRef.current = clockMs;
  }, [clockMs]);

  const sync = useCallback((index: number) => {
    if (indexRef.current === index) return;
    indexRef.current = index;
    // 换行 → 活动行是**另一个元素**，首帧必须无条件重画；上一句量到的行数也不再作数。
    paintedRef.current = "";
    bandsRef.current = null;
    bandedRef.current = false;
    setActiveIndex(index);
  }, []);

  const paint = useCallback(
    (clock: number) => {
      const node = fillRef.current;
      const item = items?.[indexRef.current];
      if (!node || !item) return;
      const next = items[indexRef.current + 1];
      const progress = lineProgress(item.timeMs, next ? next.timeMs : null, clock);
      const bands = bandsRef.current;

      // 折行：一行一层渐变，边界是"每行自己的竖边"，填充顺序 = 阅读顺序
      // （用户 2026-11-14：「遇到一句歌词但是换行时，填充顺序变为了从上到下」）。
      if (bands && bands.length > 1) {
        const fill = lyricBandFill(bands, progress);
        if (fill.image === paintedRef.current) return;
        paintedRef.current = fill.image;
        bandedRef.current = true;
        node.style.setProperty("background-repeat", "no-repeat");
        node.style.setProperty("background-image", fill.image);
        node.style.setProperty("background-size", fill.size);
        node.style.setProperty("background-position", fill.position);
        return;
      }

      // 单行：回到 CSS 里那条静态渐变，每帧只写一个自定义属性。
      if (bandedRef.current) {
        bandedRef.current = false;
        for (const name of ["background-repeat", "background-image", "background-size", "background-position"]) {
          node.style.removeProperty(name);
        }
      }
      const pct = lyricFillPercent(progress);
      if (pct === paintedRef.current) return;
      paintedRef.current = pct;
      node.style.setProperty("--player-lyric-progress", pct);
    },
    [items],
  );

  /**
   * 活动行量完行数后回调：行数变了（换行位置随面板宽度变）就重画一次。
   * 用粗时钟先落一帧，下一帧 rAF 会用真值覆盖——只差一帧，看不见。
   */
  const onBands = useCallback(
    (bands: LyricBand[] | null) => {
      const same =
        (bands === null && bandsRef.current === null) ||
        (bands !== null &&
          bandsRef.current !== null &&
          bands.length === bandsRef.current.length &&
          bands.every((band, index) => {
            const other = bandsRef.current?.[index];
            return (
              !!other &&
              Math.abs(other.width - band.width) < 0.5 &&
              Math.abs(other.top - band.top) < 0.5 &&
              Math.abs(other.height - band.height) < 0.5
            );
          }));
      if (same && paintedRef.current !== "") return;
      bandsRef.current = bands;
      paintedRef.current = "";
      paint(coarseRef.current);
    },
    [paint],
  );

  // 播放中：每帧一次。
  useEffect(() => {
    if (!playing || !synced || !items || items.length === 0) return;
    let raf = 0;
    const step = () => {
      const live = readPositionMs?.();
      const base = typeof live === "number" && Number.isFinite(live) ? live : coarseRef.current;
      const clock = base + LYRIC_LEAD_MS;
      sync(activeLrcIndex(items, clock));
      paint(clock);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, synced, items, readPositionMs, sync, paint]);

  // 暂停 / 拖动 / 没在播：按 props 的粗时钟落一次就够，不跑循环（静止画面不该烧 CPU）。
  useEffect(() => {
    if (playing) return;
    if (!synced || !items || items.length === 0) {
      sync(-1);
      return;
    }
    sync(activeLrcIndex(items, clockMs));
    paint(clockMs);
  }, [playing, synced, items, clockMs, sync, paint]);

  return { activeIndex, fillRef, onBands };
}

/**
 * 一行歌词的文本节点：把「汉字（假名）」渲染成 `<ruby>`（用户 2026-11-14 要求）。
 * 没有注音时只输出纯文本，DOM 与以前保持一致。
 */
function LyricText({ text }: { text: string }) {
  if (!hasRuby(text)) return <>{text}</>;
  const segments: RubySegment[] = parseRuby(text);
  if (segments.length === 1 && segments[0].ruby === undefined) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.ruby ? (
          <ruby key={`${segment.text}-${index}`}>
            {segment.text}
            <rt>{segment.ruby}</rt>
          </ruby>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * 当前句：**一层文字 + 渐变蒙版**，不是"两层文字叠在一起再裁"。
 *
 * 早先用两层（底层淡色、上层高亮 + `clip-path`）时，上层是个绝对定位的盒子，盒子的
 * 裁切边会把文字外发光一起切掉，屏幕上就出现一道**白色矩形边框**（用户 2026-11-13 D173）。
 * 现在只画一份字形：`background-image` 的渐变乘 `background-clip: text`，染色只落在字形
 * 像素上，盒子没有边——自然不会有矩形。
 *
 * 换行的处理：单行时 CSS 里那条横向渐变就够（一次 `setProperty`）。折行时**一行一层**
 * 渐变、每层的位置与尺寸就是这一行的矩形，于是"先刷满第一行、再刷第二行"是按行序推的。
 * 早先折行改用的纵向渐变是把两行当一整块自上而下盖住（用户 2026-11-14：「遇到一句歌词
 * 但是换行时，填充顺序变为了从上到下」），字是在行内被垂直切开的，不是"读"的顺序。
 */
function ActiveLyricLine({
  text,
  fillRef,
  onBands,
}: {
  text: string;
  fillRef: RefObject<HTMLDivElement | null>;
  onBands: (bands: LyricBand[] | null) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [wrapped, setWrapped] = useState(false);

  /** 量这句实际占几行、每行在元素里的矩形（相对元素左上角，px）。 */
  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const base = node.getBoundingClientRect();
    const rects: BoxRect[] = [];
    // 按**文本节点**逐个量，而不是整块 `Range`：注音（`<rt>`）也是文本节点，整块量会把
    // 它算成额外的一行。注音是贴着底字画的小字，不该参与"读到哪儿"。
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const element = (current as Text).parentElement;
      if (!element || element.closest("rt")) continue;
      const range = document.createRange();
      range.selectNodeContents(current);
      for (const rect of range.getClientRects()) {
        rects.push({
          left: rect.left - base.left,
          top: rect.top - base.top,
          right: rect.right - base.left,
          bottom: rect.bottom - base.top,
        });
      }
      range.detach?.();
    }
    const bands = lyricBands(rects);
    setWrapped(bands.length > 1);
    onBands(bands.length > 1 ? bands : null);
  }, [onBands]);

  useLayoutEffect(() => {
    measure();
    // 面板宽一点/窄一点都会改变这句折在哪：跟着量。观察父级（这行本身是 `fit-content`，
    // 换行时它的宽度可能不变、只有高度变，观察自己不够稳）。
    const target = ref.current?.parentElement ?? ref.current;
    if (!target) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(target);
    return () => observer.disconnect();
  }, [measure, text]);

  // 同一个元素要供两个使用者：本组件的排版量测、外层 rAF 的每帧填充。
  const bind = (node: HTMLDivElement | null) => {
    ref.current = node;
    fillRef.current = node;
  };
  return (
    <div
      ref={bind}
      className="player-lyric-main is-filling"
      data-wrapped={wrapped ? "true" : "false"}
    >
      <LyricText text={text} />
    </div>
  );
}

/** 歌词窗口（无歌词 → 什么都不渲染；纯文本歌词 → 不高亮、不错位）。 */
function Lyrics({
  items,
  start,
  end,
  active,
  fillRef,
  onBands,
  variant,
  t,
}: {
  items: readonly LrcItem[] | null;
  start: number;
  end: number;
  active: number;
  fillRef: RefObject<HTMLDivElement | null>;
  onBands: (bands: LyricBand[] | null) => void;
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
        // 当前句的填充由 `useLyricFill` 每帧直接写进那个元素的样式（不经过 React）：
        // 这里只负责把元素挂上去，并把它量到的行数报回去。
        return (
          <div
            key={`${item.timeMs}-${index}`}
            className={isActive ? "player-lyric is-active" : "player-lyric"}
            data-distance={Math.min(Math.max(distance, 0), 3)}
            style={indent > 0 ? { marginLeft: `${indent}cqw` } : undefined}
          >
            {isActive ? (
              <ActiveLyricLine text={item.main} fillRef={fillRef} onBands={onBands} />
            ) : (
              <div className="player-lyric-main">
                <LyricText text={item.main} />
              </div>
            )}
            {item.sub ? (
              // 副行是译文，**不跑注音**：注音只属于日文原文那一行，译文里的全角括号
              // 是排版（`（合）`、`（Cover）`）而不是假名，交给 ruby 会被拆成碎字。
              <div className="player-lyric-sub">{item.sub}</div>
            ) : null}
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
