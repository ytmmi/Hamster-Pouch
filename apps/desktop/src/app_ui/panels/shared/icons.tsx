/**
 * 面板共用的内联图标：折叠箭头与文件夹（D210）、音量（D211）。
 *
 * 为什么要单独一个文件：相册树、媒体源树与打标菜单曾各自复制同一段 SVG——
 * 三份 `tree-chevron-icon`、两份 `tree-folder-icon`。尺寸、线宽、路径任何一处调整
 * 都得改三四遍，漏一处就是两棵树的箭头长得不一样。图标只认 `currentColor`，
 * 配色仍由 CSS 决定（`.tree-chevron-icon` / `.tree-folder-icon`）。
 */

import type { JSX } from "react";

/** 折叠箭头（展开时旋转 90°，样式复用 `.tree-arrow.on`）。 */
export function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="tree-chevron-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** 文件夹图标（相册与媒体源共用）。 */
export function FolderIcon(): JSX.Element {
  return (
    <svg
      className="tree-folder-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
    </svg>
  );
}
/**
 * 音量图标（三态：静音 / 一道声波 / 两道声波）。
 *
 * 视频面板与音乐面板各有一份时，尺寸、线宽、静音叉的路径都各自漂移过；现在只认
 * 这一份：`size` 决定边长（视频 18、音乐 15），`muteMark` 决定静音时是否画那道叉
 * （音乐面板的喇叭本来就不画叉）。颜色仍随 `currentColor`。
 */
export function VolumeIcon({
  volume,
  size = 18,
  muteMark = true,
}: {
  volume: number;
  size?: number;
  muteMark?: boolean;
}): JSX.Element {
  const muted = volume === 0;
  const loud = volume >= 50;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
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
      {muted && muteMark && (
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
