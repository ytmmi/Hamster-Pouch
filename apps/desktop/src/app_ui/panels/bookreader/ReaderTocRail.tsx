/**
 * 图书阅读器：**左侧内置面板**（栏头 + 目录 / 书签 / 笔记 / 高亮）。
 *
 * 栏内**自上而下三段**（与用户给的参考图逐块对应）：
 *
 * ```
 * ┌ 封面  书名           ┐  ← 栏头（ReaderBookHeader，四个标签页上方常驻）
 * │       作者：…        │
 * │       已读：N min    │
 * ├ 目录 书签 笔记 高亮 ┤  ← 标签条（当前页带下划线 + 底部横线分隔）
 * ├──────────────────────┤
 * │ 章节列表 / 批注列表  │  ← 当前标签页的内容（自己滚）
 * └──────────────────────┘
 * ```
 *
 * 栏头**不随标签切换**：它是"我正在读哪本书"，而不是某一页的内容；
 * 切到书签页时把封面收起来，用户会以为换了本书。
 *
 * 「更多」按钮直接展开整组栏；用户在此栏内切换这四个标签。
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

import { useMemo, useState, type JSX } from "react";

import type { Translate } from "../../i18n";
import type { BookTocItem, FileItem, ReaderAnnotationKind } from "../../shared/types";
import type { BookCoverOverride } from "../bookpreview/bookCoverCache";
import {
  currentTocIndex,
  READER_TABS,
  tocIndent,
  tocTitleOrNull,
  type ReaderTab,
} from "./readerView";
import { ReaderBookHeader } from "./ReaderBookHeader";
import type { ReaderAnnotationsHandle } from "./useReaderAnnotations";

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
  /** 批注的取数与增删（书签 / 笔记 / 高亮三个标签页共用）。 */
  annotations: ReaderAnnotationsHandle;
  /**
   * 新建批注时的位置信息（当前阅读位置）。
   *
   * `fallbackExcerpt` 是"没划字时用的原文"：当前页正文的开头（面板从已取回的第一页取）。
   * 有它，"没划字就点高亮"仍然得到一条有意义的高亮，而不是一条被后端拒掉的空记录。
   */
  currentPosition: {
    cursor: string;
    progress: number;
    title: string;
    fallbackExcerpt: string;
  };
  /** 当前阅读的书（栏头的封面 / 书名 / 作者）；`null` = 没有选中，栏头不渲染。 */
  book: {
    file: FileItem;
    author: string | null;
    coverUrl: string | null;
    override: BookCoverOverride | null;
    /** 本次会话已读分钟数（与顶栏同一个计数器）。 */
    readMinutes: number;
  } | null;
  t: Translate;
}

/** 标签页的 i18n 键（顺序即 `READER_TABS`）。 */
const TAB_LABEL_KEYS = {
  toc: "bookreader.tab.toc",
  bookmarks: "bookreader.tab.bookmarks",
  notes: "bookreader.tab.notes",
  highlights: "bookreader.tab.highlights",
} as const;

/** 标签页 → 批注种类（目录页不是批注）。 */
const TAB_ANNOTATION_KIND: Record<Exclude<ReaderTab, "toc">, ReaderAnnotationKind> = {
  bookmarks: "bookmark",
  notes: "note",
  highlights: "highlight",
};

export function ReaderTocRail({
  tab,
  onTabChange,
  onClose,
  toc,
  tocLoading,
  cursor,
  onJump,
  annotations,
  currentPosition,
  book,
  t,
}: ReaderTocRailProps): JSX.Element {
  const activeIndex = useMemo(() => currentTocIndex(toc, cursor), [toc, cursor]);

  return (
    <aside className="br-rail br-rail-left">
      {/* 栏头：封面 / 书名 / 作者 / 已读时长。四个标签页**共用**，切标签不收起。 */}
      {book && <ReaderBookHeader {...book} t={t} />}

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
        {tab !== "toc" && (
          <AnnotationList
            kind={TAB_ANNOTATION_KIND[tab]}
            annotations={annotations}
            currentPosition={currentPosition}
            onJump={onJump}
            t={t}
          />
        )}
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

/**
 * 批注列表（书签 / 笔记 / 高亮三个标签页共用）。
 *
 * ## 顶部是"在当前位置留一条"
 *
 * 三个标签页的差别只有 `kind` 与输入区：
 * - **书签**：一键即存（没有输入——它只有位置）；
 * - **笔记**：一个多行输入 + 保存；
 * - **高亮**：选中原文 + 可选的批注。**原文快照来自哪里**：浏览器选区
 *   （`window.getSelection()`，用户真的划了字）优先，划不到就退回**当前页的正文开头**
 *   （面板把已取回第一页的文本传进来）——这样"没划字就点高亮"仍然得到一条有意义的高亮，
 *   而不是一条空记录（后端也会拒绝空高亮）。
 *
 * ## 为什么没有"编辑"
 *
 * 批注是**留痕**：改一条旧笔记会让"我当时怎么想的"变得不可信。要改就删了重写
 * （删除是幂等的，界面上就是一行 × ）。这与"标签是活的、批注是历史"同一思路。
 */
function AnnotationList({
  kind,
  annotations,
  currentPosition,
  onJump,
  t,
}: {
  kind: ReaderAnnotationKind;
  annotations: ReaderAnnotationsHandle;
  currentPosition: {
    cursor: string;
    progress: number;
    title: string;
    fallbackExcerpt: string;
  };
  onJump: (cursor: string) => void;
  t: Translate;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const items = annotations.items.filter((item) => item.kind === kind);

  /**
   * 高亮的"选中原文"：**浏览器选区优先，划不到就用当前页开头兜底**。
   *
   * 兜底是必需的：后端拒绝空高亮（一条没有原文的高亮在列表里就是一行空白），
   * 而用户"没划字直接点高亮"是完全正常的操作顺序。
   */
  const highlightExcerpt = (): string => {
    const selected =
      typeof window === "undefined"
        ? ""
        : (window.getSelection()?.toString() ?? "").trim();
    return selected.length > 0 ? selected : currentPosition.fallbackExcerpt.trim();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const text = draft.trim();
    // 笔记必须有正文；书签不需要任何输入；高亮的原文由选区 / 兜底提供。
    if (kind === "note" && text.length === 0) return;
    const excerpt = kind === "highlight" ? highlightExcerpt() : "";
    if (kind === "highlight" && excerpt.length === 0 && text.length === 0) return;
    setSaving(true);
    const ok = await annotations.add({
      kind,
      cursor: currentPosition.cursor,
      progress: currentPosition.progress,
      title: currentPosition.title,
      excerpt,
      // 高亮：输入框里的是**批注**（可空）；笔记：输入框里的是**正文**。
      note: kind === "bookmark" ? "" : text,
    });
    setSaving(false);
    if (ok) setDraft("");
  };

  return (
    <div className="br-annotations">
      {/* 在当前位置留一条 */}
      <div className="br-annotation-new">
        {kind !== "bookmark" && (
          <textarea
            className="br-annotation-input"
            value={draft}
            rows={2}
            placeholder={
              kind === "note"
                ? t("bookreader.annotation.notePlaceholder")
                : t("bookreader.annotation.highlightPlaceholder")
            }
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
        <button
          type="button"
          className="br-btn br-annotation-add"
          disabled={
            saving ||
            (kind === "note" && draft.trim().length === 0) ||
            (kind === "highlight" &&
              draft.trim().length === 0 &&
              currentPosition.fallbackExcerpt.trim().length === 0)
          }
          onClick={() => void save()}
        >
          {saving
            ? t("common.loading")
            : kind === "bookmark"
              ? t("bookreader.annotation.addBookmark")
              : kind === "note"
                ? t("bookreader.annotation.addNote")
                : t("bookreader.annotation.addHighlight")}
        </button>
      </div>

      {annotations.error && <span className="br-rail-empty dim">{annotations.error}</span>}
      {items.length === 0 && !annotations.loading && (
        <span className="br-rail-empty dim">
          {kind === "bookmark"
            ? t("bookreader.annotation.emptyBookmarks")
            : kind === "note"
              ? t("bookreader.annotation.emptyNotes")
              : t("bookreader.annotation.emptyHighlights")}
        </span>
      )}

      <ul className="br-annotation-list">
        {items.map((item) => (
          <li key={item.id} className="br-annotation-item">
            <div className="br-annotation-head">
              <button
                type="button"
                className="br-annotation-jump"
                onClick={() => onJump(item.cursor)}
                title={t("bookreader.annotation.jump")}
              >
                {tocTitleOrNull(item.title) ?? t("bookreader.annotation.untitled")}
              </button>
              <span className="dim br-annotation-percent">
                {(item.progress / 100).toFixed(2)}%
              </span>
              <button
                type="button"
                className="br-annotation-delete"
                onClick={() => void annotations.remove(item.id)}
                aria-label={t("common.remove")}
                title={t("common.remove")}
              >
                ×
              </button>
            </div>
            {item.excerpt.length > 0 && (
              <blockquote className="br-annotation-excerpt">{item.excerpt}</blockquote>
            )}
            {item.note.length > 0 && <p className="br-annotation-note">{item.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
