/**
 * 图书阅读器：**左侧内置面板**（目录 / 书签 / 笔记 / 高亮）。
 *
 * 四个标签页共用一条栏：顶部是标签条，下面是当前页的内容。
 * 「更多」图标菜单里的四项就是这四个标签（两个入口读同一份状态）。
 *
 * ## 目录
 *
 * 目录项由 `book.toc` 给出（EPUB 的 nav / NCX、txt 的小说章节规则、md 的标题）。
 * 层级由 `level` 决定缩进（`tocIndent`）；标题为空串时显示序号
 * （后端刻意不内联用户可见文案，见 `BookTocItem.title`）。
 * 点击 = `jumpTo(cursor)`——游标原样交给 `book.content`，前端不换算。
 *
 * 当前章按**游标数值比较**高亮（`currentTocIndex`）：当前页往往落在两条目录项之间，
 * 字符串相等永远匹配不上。
 *
 * 书签 / 笔记 / 高亮三页的取数与增删在 `useReaderAnnotations`（阶段 C 落地），
 * 本文件只负责渲染与交互。
 */

import { useMemo } from "react";

import type { Translate } from "../../i18n";
import type { BookTocItem } from "../../shared/types";
import { currentTocIndex, READER_TABS, tocIndent, tocTitleOrNull, type ReaderTab } from "./readerView";

export interface ReaderTocRailProps {
  tab: ReaderTab;
  onTabChange: (tab: ReaderTab) => void;
  /** 关闭整条栏（栏头的 × ）。 */
  onClose: () => void;
  toc: BookTocItem[];
  /** 目录是否还在取（首屏）。 */
  tocLoading: boolean;
  /** 当前页起点游标（用于高亮当前章）。 */
  cursor: string | null;
  onJump: (cursor: string) => void;
  t: Translate;
}

/** 标签页的 i18n 键（顺序即 `READER_TABS`）。 */
const TAB_LABEL_KEYS = {
  toc: "bookreader.tab.toc",
  bookmarks: "bookreader.tab.bookmarks",
  notes: "bookreader.tab.notes",
  highlights: "bookreader.tab.highlights",
} as const;

export function ReaderTocRail({
  tab,
  onTabChange,
  onClose,
  toc,
  tocLoading,
  cursor,
  onJump,
  t,
}: ReaderTocRailProps): JSX.Element {
  const activeIndex = useMemo(() => currentTocIndex(toc, cursor), [toc, cursor]);

  return (
    <aside className="br-rail br-rail-left">
      <div className="br-rail-tabs" role="tablist">
        {READER_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`br-rail-tab${tab === id ? " br-rail-tab-active" : ""}`}
            onClick={() => onTabChange(id)}
          >
            {t(TAB_LABEL_KEYS[id])}
          </button>
        ))}
        <button
          type="button"
          className="br-rail-close"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          ×
        </button>
      </div>

      <div className="br-rail-body">
        {tab === "toc" && (
          <TocList
            toc={toc}
            loading={tocLoading}
            activeIndex={activeIndex}
            onJump={onJump}
            t={t}
          />
        )}
        {tab !== "toc" && <span className="br-rail-empty dim">{t("bookreader.annotationsSoon")}</span>}
      </div>
    </aside>
  );
}

/** 目录列表（空态 / 加载态都在这里收口）。 */
function TocList({
  toc,
  loading,
  activeIndex,
  onJump,
  t,
}: {
  toc: BookTocItem[];
  loading: boolean;
  activeIndex: number;
  onJump: (cursor: string) => void;
  t: Translate;
}): JSX.Element {
  if (toc.length === 0) {
    return (
      <span className="br-rail-empty dim">
        {loading ? t("common.loading") : t("bookreader.tocEmpty")}
      </span>
    );
  }
  return (
    <ul className="br-toc">
      {toc.map((entry, index) => {
        const title = tocTitleOrNull(entry.title);
        return (
          <li key={`${entry.cursor}-${index}`}>
            <button
              type="button"
              className={`br-toc-item${index === activeIndex ? " br-toc-item-active" : ""}`}
              style={{ paddingLeft: 8 + tocIndent(entry.level) }}
              onClick={() => onJump(entry.cursor)}
              title={title ?? t("bookreader.tocUntitled", { n: index + 1 })}
            >
              {title ?? t("bookreader.tocUntitled", { n: index + 1 })}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
