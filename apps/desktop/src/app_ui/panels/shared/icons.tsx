/**
 * 树面板共用的两个内联图标（D210）：折叠箭头与文件夹。
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
