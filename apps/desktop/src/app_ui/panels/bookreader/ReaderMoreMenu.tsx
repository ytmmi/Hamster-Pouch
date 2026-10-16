/**
 * 图书阅读器右上角的**「更多」图标**。
 *
 * 点击直接开合左右两栏：左侧默认显示目录（栏内可切换书签 / 笔记 / 高亮），
 * 右侧显示阅读选项。这里不再弹出第二层项目菜单。
 */

import type { Translate } from "../../i18n";

export interface ReaderMoreMenuProps {
  /** 当前左右两栏是否都已展开（用于按钮的 aria-expanded）。 */
  expanded: boolean;
  /** 是否有任一内置栏展开（决定图标是否高亮）。 */
  anyActive: boolean;
  onToggle: () => void;
  t: Translate;
}

/**
 * 「更多」图标（四个圆角方块的 2×2 网格）。
 *
 * `aria-hidden`：图标本身不承载语义，可访问名由外层按钮的 `aria-label` 给。
 */
export function MoreGridIcon(): JSX.Element {
  return (
    <svg
      className="br-more-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="6" height="6" rx="1.4" />
      <rect x="9" y="1" width="6" height="6" rx="1.4" />
      <rect x="1" y="9" width="6" height="6" rx="1.4" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" />
    </svg>
  );
}

export function ReaderMoreMenu({
  expanded,
  anyActive,
  onToggle,
  t,
}: ReaderMoreMenuProps): JSX.Element {
  return (
    <div className="br-more">
      <button
        type="button"
        className={`br-btn br-more-btn${anyActive ? " br-more-btn-active" : ""}`}
        aria-label={t("bookreader.more")}
        aria-expanded={expanded}
        title={t("bookreader.more")}
        onClick={onToggle}
      >
        <MoreGridIcon />
      </button>
    </div>
  );
}
