/**
 * 音乐播放器的内联字形（D211）：传输控件、随机/循环、收藏、星标。
 *
 * 原先这些 SVG 都写在 `MusicStage.tsx` 里——那个文件本来就有 1000 行，
 * 光图标占了 160 行，改一个线宽要在渲染逻辑中间翻来翻去。字形只认
 * `currentColor`，尺寸写死在各字形上（传输 20–22px、辅助 17–18px）。
 *
 * 收藏相关（`FavoriteIcon` / `StarIcon` / `HeartIcon`）的语义见 `MusicStage` 文件头：
 * 收藏只是图标，功能后续做——所以爱心是**空心描边**，不代表「已收藏」。
 */

import type { TranslationKey } from "../../i18n";
/** 收藏图标（**仅显示**，功能后续做；非交互元素，见文件头注释）。 */
export function FavoriteIcon({
  shape,
  t,
}: {
  shape: "star" | "heart";
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
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

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

export function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M19 5.5v13L8.5 12z" fill="currentColor" />
      <rect x="5" y="5.5" width="2.6" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M5 5.5v13L15.5 12z" fill="currentColor" />
      <rect x="16.4" y="5.5" width="2.6" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function ShuffleIcon() {
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

export function RepeatIcon() {
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

export function RepeatOneIcon() {
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

export function StarIcon() {
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
export function HeartIcon() {
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
