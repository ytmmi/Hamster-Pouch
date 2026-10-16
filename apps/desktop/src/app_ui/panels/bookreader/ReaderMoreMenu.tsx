/**
 * 图书阅读器右上角的**「更多」图标 + 内置面板菜单**。
 *
 * ## 图标
 *
 * 矢量图标（`currentColor` 填充，随主题变色）：**2×2 的四个圆角方块**——
 * 用户口径里的"4 个正方形或 3 个正方形一个圆形组成的矢量图标"取前一种。
 * 不用字体图标 / 图片：图标必须随主题与禁用态变色，且不该多一次资源请求。
 *
 * ## 菜单
 *
 * 点击展开**阅读器的内置面板**（目录 / 书签 / 笔记 / 高亮 / 阅读选项）。
 * 每一项是一次**开合切换**：已展开的项带勾选态，再点一次收起。
 * 左右两侧的栏因此有两个入口（图标菜单 + 栏内标签页），
 * 两个入口读的是同一份状态（`BookReaderPanel` 持有）。
 *
 * 关闭方式三选一（缺一都会让用户觉得"点不掉"）：再点图标 / 点菜单外 / Esc。
 */

import { useEffect, useRef } from "react";

import type { Translate } from "../../i18n";

/** 菜单项（内置面板）。 */
export interface ReaderMenuEntry {
  /** 稳定 id（目录 / 书签 / 笔记 / 高亮 / 阅读选项）。 */
  id: string;
  /** 展示文案（已翻译）。 */
  label: string;
  /** 当前是否已展开。 */
  active: boolean;
  /** 点击行为（切换该项）。 */
  onPick: () => void;
}

export interface ReaderMoreMenuProps {
  open: boolean;
  /** 是否有任何内置面板处于展开态（决定图标是否高亮）。 */
  anyActive: boolean;
  entries: ReaderMenuEntry[];
  onToggle: () => void;
  onClose: () => void;
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
  open,
  anyActive,
  entries,
  onToggle,
  onClose,
  t,
}: ReaderMoreMenuProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点菜单**外面**收起。用 `mousedown` 而不是 `click`：拖选正文时松手不该留下菜单。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="br-more" ref={rootRef}>
      <button
        type="button"
        className={`br-btn br-more-btn${anyActive ? " br-more-btn-active" : ""}`}
        aria-label={t("bookreader.more")}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("bookreader.more")}
        onClick={onToggle}
      >
        <MoreGridIcon />
      </button>
      {open && (
        <div className="br-more-menu" role="menu">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={entry.active}
              className={`br-more-item${entry.active ? " br-more-item-active" : ""}`}
              onClick={entry.onPick}
            >
              <span className="br-more-check">{entry.active ? "✓" : ""}</span>
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
