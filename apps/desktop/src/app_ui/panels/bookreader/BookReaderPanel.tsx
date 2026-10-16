/**
 * 图书阅读器面板（`panel.bookreader`）— **完整阅读**一本书（txt / md / epub / pdf）。
 *
 * ## 与查看器（`panel.viewer`）的分工
 *
 * 查看器的口径是"**显示书的开头内容**、范围为面板大小、滚动看更多"（D98），
 * 它**没有**目录跳转与阅读选项——那是刻意的范围收窄。本面板是它的消费者侧补齐：
 * 同一套正文块与分页命令（`book.content`），加上**目录**（`book.toc`）、
 * **阅读选项**（面板设置 `panel.bookreader.*`）、左右两侧的内置面板与底部进度。
 *
 * ## 界面结构（与用户给的参考图逐块对应）
 *
 * ```
 * ┌ [退出阅读] 章节标题 · 文件名   本次阅读时间 N 分钟 读完本页约需 M 分钟 [书签][全屏模式][▦ 更多] ┐
 * │ ┌ 目录 书签 笔记 高亮 ┐ ┌──────── 阅读区（滚动 / 单页 / 双页）────────┐ ┌ 阅读选项 ┐ │
 * │ └────────────────────┘ └───────────────────────────────────────────┘ └──────────┘ │
 * └ 当前进度 x.xx%            页数 a/b            章节数 c/d                            ┘
 * ```
 *
 * 右上角的**「更多」图标**（2×2 四个圆角方块）展开**内置面板菜单**：
 * 目录 / 书签 / 笔记 / 高亮 / 阅读选项——点一下开，再点一下合；
 * 点菜单外或按 Esc 同样收起（`ReaderMoreMenu`）。
 *
 * ## 状态归属
 *
 * 本文件只持有**界面开关**（左右栏是否展开、当前标签、菜单是否打开、是否全屏）
 * 与会话计时；阅读选项在 `useReaderSettings`（落库），正文与目录在 `useReaderBook`。
 * 跳章用 `key={cursor}` **重新挂载阅读区**（滚动位置与当前页天然回到开头，
 * 不必在 effect 里与渲染竞态）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import type { TranslationKey } from "../../i18n";
import { ReaderFooter } from "./ReaderFooter";
import { ReaderMoreMenu, type ReaderMenuEntry } from "./ReaderMoreMenu";
import { ReaderOptionsRail } from "./ReaderOptionsRail";
import { ReaderTocRail } from "./ReaderTocRail";
import { ReaderStage } from "./ReaderStage";
import { useReaderBook } from "./useReaderBook";
import { useReaderSettings } from "./useReaderSettings";
import {
  currentTocIndex,
  estimateReadMinutes,
  isBookMediaType,
  isReaderTab,
  readerProgress,
  tocTitleOrNull,
  type ReaderTab,
} from "./readerView";
import type { BookBlockItem, BookContentResult } from "../../shared/types";

export interface BookReaderPanelProps {
  /**
   * dockview 面板 API（可选）。
   *
   * 两个用途：① 「退出阅读」在**非全屏**时关闭本面板；② 面板从后台标签回到前台时
   * 阅读选项补读一次（`useReaderSettings` 的第 4 条触发源）。独立单面板窗口
   * （`SinglePanelHost`）传的是恒激活替身，同样可用。
   */
  api?: PanelRenderCtx["api"];
}

/** 一页正文的字符数（估算"读完本页约需几分钟"）。 */
function countPageChars(page: BookContentResult | undefined): number {
  if (!page) return 0;
  if (page.text) return page.text.length;
  return countBlockChars(page.blocks ?? []);
}

function countBlockChars(blocks: BookBlockItem[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.text) total += block.text.length;
    if (block.spans) {
      for (const span of block.spans) total += span.text.length;
    }
    if (block.head) {
      for (const cell of block.head) {
        for (const span of cell) total += span.text.length;
      }
    }
    if (block.rows) {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          for (const span of cell) total += span.text.length;
        }
      }
    }
    if (block.label) total += block.label.length;
    if (block.list_items) {
      for (const item of block.list_items) total += countBlockChars(item.blocks);
    }
    if (block.blocks) total += countBlockChars(block.blocks);
    if (block.definitions) {
      for (const definition of block.definitions) {
        for (const span of definition.term) total += span.text.length;
        for (const group of definition.definitions) total += countBlockChars(group);
      }
    }
  }
  return total;
}

export function BookReaderPanel({ api: panelApi }: BookReaderPanelProps = {}): JSX.Element {
  const app = useApp();
  const t = app.t;
  const handle = useReaderSettings(panelApi);
  const settings = handle.settings;
  const book = useReaderBook();

  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 左侧内置面板当前标签（`null` = 收起）。 */
  const [leftTab, setLeftTab] = useState<ReaderTab | null>(null);
  const [rightOpen, setRightOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  /** 本次阅读开始时刻（换书即重新计时）——参考图的"本次阅读时间 N 分钟"。 */
  const sessionStartRef = useRef(Date.now());
  const [clock, setClock] = useState(() => Date.now());

  const file = app.selectedFile;
  const fileId = file?.id ?? null;

  // 换书：会话计时归零，并把两侧栏恢复成默认（不继承上一本的阅读状态）。
  useEffect(() => {
    sessionStartRef.current = Date.now();
    setClock(Date.now());
    setMenuOpen(false);
  }, [fileId]);

  // 阅读时长每一分钟刷新一次（30s 一跳，保证跨分钟时最多晚 30s 更新）。
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 全屏状态跟随浏览器（用户按 Esc 退出全屏时按钮文案必须跟着变）。
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void el.requestFullscreen().catch(() => {
      // WebView 拒绝全屏（策略 / 权限）不该静默失败：如实告诉用户。
      app.status(t("bookreader.fullscreenFailed"), "error");
    });
  }, [app, t]);

  /** 「退出阅读」：全屏时先退出全屏，否则关闭面板（没有面板 API 时无事可做）。 */
  const exitReading = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    panelApi?.close();
  }, [panelApi]);

  const isBook = isBookMediaType(file?.media_type);
  const first = book.pages[0];
  const format = first?.format ?? book.format;

  // ==================== 进度 / 页数 / 章数 ====================

  const cursorNumber = book.cursor === null ? null : Number(book.cursor);
  const progress = readerProgress(
    format,
    first?.section ?? 0,
    first?.section_count ?? null,
    book.cursor,
    book.total,
  );

  /** 页数：把游标按"一页的单位长"折算（单位长取自**已取回的第一页**）。 */
  const pagesInfo = useMemo(() => {
    if (!first) return null;
    if (format === "epub" || format === "pdf") {
      if (!first.section_count) return null;
      return { at: first.section + 1, total: first.section_count };
    }
    if (book.total === null || cursorNumber === null || !Number.isFinite(cursorNumber)) return null;
    const unit =
      format === "markdown"
        ? Math.max(1, (first.blocks ?? []).length)
        : Math.max(1, (first.text ?? "").length);
    return {
      at: Math.floor(cursorNumber / unit) + 1,
      total: Math.max(1, Math.ceil(book.total / unit)),
    };
  }, [book.total, cursorNumber, first, format]);

  /** 章数：目录里的位置（目录为空 = 这本书没有目录，整项不显示）。 */
  const chaptersInfo = useMemo(() => {
    if (book.toc.length === 0) return null;
    const at = currentTocIndex(book.toc, book.cursor);
    return { at: at + 1, total: book.toc.length };
  }, [book.toc, book.cursor]);

  const chapterTitle = useMemo(() => {
    const index = currentTocIndex(book.toc, book.cursor);
    const fromToc = index >= 0 ? tocTitleOrNull(book.toc[index]?.title) : null;
    return fromToc ?? tocTitleOrNull(first?.title) ?? null;
  }, [book.toc, book.cursor, first?.title]);

  const sessionMinutes = Math.max(0, Math.floor((clock - sessionStartRef.current) / 60_000));
  const pageMinutes = estimateReadMinutes(countPageChars(first));

  // ==================== 「更多」菜单 ====================

  const toggleTab = useCallback((tab: ReaderTab) => {
    setLeftTab((current) => (current === tab ? null : tab));
    setMenuOpen(false);
  }, []);

  const menuEntries: ReaderMenuEntry[] = [
    ...(["toc", "bookmarks", "notes", "highlights"] as const).map((tab) => ({
      id: tab,
      label: t(`bookreader.tab.${tab}` as TranslationKey),
      active: leftTab === tab,
      onPick: () => toggleTab(tab),
    })),
    {
      id: "options",
      label: t("bookreader.options"),
      active: rightOpen,
      onPick: () => {
        setRightOpen((open) => !open);
        setMenuOpen(false);
      },
    },
  ];

  const emptyText = !file
    ? t("common.noSelection")
    : !isBook
      ? t("bookreader.notBook")
      : t("bookreader.noContent");

  return (
    <div className="panel br-root" ref={rootRef}>
      {/* 顶部：退出阅读 / 章节标题 / 阅读时长 / 书签 / 全屏 / 更多 */}
      <div className="br-top">
        <button type="button" className="br-btn" onClick={exitReading}>
          {t("bookreader.exit")}
        </button>
        <div className="br-top-title">
          <b>{chapterTitle ?? file?.relative_path ?? ""}</b>
          {chapterTitle && <span className="dim"> · {file?.relative_path}</span>}
        </div>
        <div className="br-top-meta dim">
          <span>{t("bookreader.sessionTime", { min: sessionMinutes })}</span>
          {pageMinutes !== null && (
            <span>{t("bookreader.pageTime", { min: pageMinutes })}</span>
          )}
        </div>
        <button
          type="button"
          className="br-btn"
          disabled={!isBook}
          onClick={toggleFullscreen}
        >
          {fullscreen ? t("bookreader.exitFullscreen") : t("bookreader.fullscreen")}
        </button>
        <ReaderMoreMenu
          open={menuOpen}
          anyActive={leftTab !== null || rightOpen}
          entries={menuEntries}
          onToggle={() => setMenuOpen((open) => !open)}
          onClose={() => setMenuOpen(false)}
          t={t}
        />
      </div>

      {/* 主体：左栏（目录等）/ 阅读区 / 右栏（阅读选项） */}
      <div className="br-body">
        {leftTab !== null && (
          <ReaderTocRail
            tab={leftTab}
            onTabChange={(tab) => setLeftTab(isReaderTab(tab) ? tab : null)}
            onClose={() => setLeftTab(null)}
            toc={book.toc}
            tocLoading={book.loading && book.toc.length === 0}
            cursor={book.cursor}
            onJump={book.jumpTo}
            t={t}
          />
        )}

        <ReaderStage
          // 跳章 = 换 key 重新挂载：滚动位置与"当前页"一起回到开头。
          key={`${fileId ?? "-"}:${book.cursor ?? "start"}`}
          pages={book.pages}
          settings={settings}
          loading={book.loading}
          error={book.error}
          hasMore={book.hasMore}
          onNeedMore={book.loadMore}
          emptyText={emptyText}
          t={t}
        />

        {rightOpen && (
          <ReaderOptionsRail handle={handle} onClose={() => setRightOpen(false)} t={t} />
        )}
      </div>

      <ReaderFooter
        progress={progress}
        pages={pagesInfo}
        chapters={chaptersInfo}
        capped={Boolean(first?.capped) && !book.hasMore}
        t={t}
      />
    </div>
  );
}
