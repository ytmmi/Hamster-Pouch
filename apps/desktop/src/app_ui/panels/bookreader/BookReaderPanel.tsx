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
 * 右上角的**「更多」图标**（2×2 四个圆角方块）直接开合左右两栏：
 * 左侧默认显示目录（栏内可切换书签 / 笔记 / 高亮），右侧显示阅读选项；不弹出第二层项目菜单。
 *
 * ## 状态归属
 *
 * 本文件只持有**界面状态**（左右栏是否展开、当前标签、是否全屏）
 * 与会话计时；阅读选项在 `useReaderSettings`（落库），正文与目录在 `useReaderBook`。
 * 跳章用 `key={cursor}` **重新挂载阅读区**（滚动位置与当前页天然回到开头，
 * 不必在 effect 里与渲染竞态）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import { ReaderFooter } from "./ReaderFooter";
import { ReaderMoreMenu } from "./ReaderMoreMenu";
import { ReaderOptionsRail } from "./ReaderOptionsRail";
import { ReaderTocRail } from "./ReaderTocRail";
import { ReaderStage } from "./ReaderStage";
import { useReaderAnnotations } from "./useReaderAnnotations";
import { useReaderBook } from "./useReaderBook";
import { useReaderBookIdentity } from "./useReaderBookIdentity";
import { useReaderSettings } from "./useReaderSettings";
import {
  currentTocIndex,
  estimateReadMinutes,
  isBookMediaType,
  isReaderTab,
  readerChapterProgress,
  readerPageCursors,
  readerPositionFromPage,
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

/**
 * 高亮兜底原文的长度（字符）。
 *
 * 取 200 的理由：一条高亮的 `excerpt` 是"我当时划的这句话"——用户没划字时，
 * 拿当前页开头一小段作为锚点比"整页正文"更接近高亮的语义（列表里也不会撑成一大坨）。
 */
const ANNOTATION_FALLBACK_EXCERPT_CHARS = 200;

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

/**
 * 把一页的块拼成纯文本（高亮兜底原文用）。
 *
 * 与 `countBlockChars` 同一套遍历：块模型的容器种类多（列表 / 引用 / 脚注 / 定义列表），
 * 只取 `spans` 会漏掉列表与引用里的正文——那正是小说里最常划的部分。
 */
function collectBlockText(blocks: BookBlockItem[]): string {
  const parts: string[] = [];
  const walk = (list: BookBlockItem[]): void => {
    for (const block of list) {
      if (block.text) parts.push(block.text);
      if (block.spans) for (const span of block.spans) parts.push(span.text);
      if (block.head) for (const cell of block.head) for (const span of cell) parts.push(span.text);
      if (block.rows) {
        for (const row of block.rows) {
          for (const cell of row.cells) for (const span of cell) parts.push(span.text);
        }
      }
      if (block.list_items) for (const item of block.list_items) walk(item.blocks);
      if (block.blocks) walk(block.blocks);
      if (block.definitions) {
        for (const definition of block.definitions) {
          for (const span of definition.term) parts.push(span.text);
          for (const group of definition.definitions) walk(group);
        }
      }
    }
  };
  walk(blocks);
  return parts.join("\n");
}

export function BookReaderPanel({ api: panelApi }: BookReaderPanelProps = {}): JSX.Element {
  const app = useApp();
  const t = app.t;
  const handle = useReaderSettings(panelApi);
  const settings = handle.settings;
  const book = useReaderBook();
  const annotations = useReaderAnnotations();
  /** 栏头要的身份信息（封面 / 作者 / 用户自设的封面覆盖）。 */
  const identity = useReaderBookIdentity(app.repoId, app.selectedFile);

  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 左侧内置面板当前标签。两栏统一开合，默认展示目录与阅读选项。 */
  const [leftTab, setLeftTab] = useState<ReaderTab>("toc");
  const [railsOpen, setRailsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * **当前可见页**（`{ visibleIndex, offsetInPage }`），由阅读区按 DOM 上报。
   *
   * 为什么不是"一个 0–1 的比例"：整段的像素比例与"第几章"没有固定关系
   * （章长不等），乘起来会跳整章。这里拿到的是"第几页 + 页内比例"，
   * 面板只在**单页内部**插值，跨页位置由页序号精确给出。
   */
  const [visiblePage, setVisiblePage] = useState({ visibleIndex: 0, offsetInPage: 0 });

  /** 本次阅读开始时刻（换书即重新计时）——参考图的"本次阅读时间 N 分钟"。 */
  const sessionStartRef = useRef(Date.now());
  const [clock, setClock] = useState(() => Date.now());

  const file = app.selectedFile;
  const fileId = file?.id ?? null;

  // 换书：会话计时归零，并恢复左栏目录标签（两栏开合状态保持为当前视图设置）。
  // 位置也归零：换一本书却沿用上一本的滚动比例，进度条会从中间开始。
  useEffect(() => {
    sessionStartRef.current = Date.now();
    setClock(Date.now());
    setLeftTab("toc");
    setVisiblePage({ visibleIndex: 0, offsetInPage: 0 });
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

  // ==================== 进度 / 章数 ====================

  /**
   * **每页的游标区间** `[start, end)`——章节数与目录对得上的关键。
   *
   * `BookContentResult` 自带 `next_cursor`，所以每页的起点是**精确已知**的
   * （见 `readerPageCursors`），不需要任何估算。epub / pdf 的区间就是
   * `[section, section+1)`，与目录项的 `cursor` **同一坐标**，因此逐项对得上。
   *
   * 段起点用 `book.segmentStart`（不是 `book.cursor`——后者只是跳转目标，
   * 首屏与 `loadMore` 都不更新，见 `ReaderBook.segmentStart` 的两字段分工）。
   */
  const pageCursors = useMemo(
    () => readerPageCursors(book.pages, book.segmentStart),
    [book.pages, book.segmentStart],
  );
  /** 全书总单位数：纯文本 / Markdown 来自 `book.toc` 的 `total`；
   * epub / pdf 用 `section_count`（它们的 `book.total` 恒为 `null`）。 */
  const totalUnits = format === "epub" || format === "pdf"
    ? (first?.section_count ?? null)
    : book.total;

  /**
   * 全书**绝对位置**（游标单位）：本章进度与进度用它。
   *
   * **只在单页内部插值**：`页起点 + 页内比例 × 该页跨度`。
   * 不用"段起点 + 整段像素比例 × 已载入单位"——那两个量一个是像素、一个是
   * 章数/字符数，章节长短不等时必然错位（加载更多后位置会跳整章）。
   */
  const absolutePosition = useMemo(
    () => readerPositionFromPage(visiblePage.visibleIndex, visiblePage.offsetInPage, pageCursors),
    [visiblePage, pageCursors],
  );

  /**
   * **当前页的起始游标** = 章节判定的唯一依据（用户口径："章节数直接读取目录和
   * 当前章节计算不就可以了"）。
   *
   * 为什么**不用**带小数的 `absolutePosition`：章是**离散**的，页内读到 60% 仍然
   * 是同一章。用带小数的位置去比目录游标，只要小数部分刚好越过下一条目录项
   * （目录游标也可能是小数，或页内比例算出来偏大），章号就会**提前**跳一位——
   * 这正是"章节数和目录对不上"的来源。取整数页起点就没有这个空间。
   */
  const currentPageCursor = useMemo(() => {
    if (pageCursors.length === 0) return null;
    const index =
      visiblePage.visibleIndex < 0 || visiblePage.visibleIndex >= pageCursors.length
        ? 0
        : Math.floor(visiblePage.visibleIndex);
    const start = pageCursors[index]?.start;
    return Number.isFinite(start) ? Math.floor(start) : null;
  }, [pageCursors, visiblePage.visibleIndex]);

  /** 全书当前进度（0–1）：由绝对位置直接除以总量（与章节数同源，不会各说各话）。 */
  const progress =
    absolutePosition === null || totalUnits === null || totalUnits <= 0
      ? null
      : Math.min(1, Math.max(0, absolutePosition / totalUnits));

  /** 本章进度（0–1）：按目录区间算；目录为空（PDF / 无可识别章节）时整项不显示。 */
  const chapterProgress = useMemo(
    () => readerChapterProgress(book.toc, absolutePosition, totalUnits),
    [book.toc, absolutePosition, totalUnits],
  );

  /**
   * 章数 = **目录**里"当前页游标落在第几项 / 共几项"（用户口径："章节数直接读取
   * 目录和当前章节计算不就可以了"）。
   *
   * 判据是 `currentPageCursor`（整数页起点）而不是带小数的 `absolutePosition`：
   * 章是离散的，页内读了多少不该改变章号。目录为空（PDF / 无可识别章节）→ `null`。
   */
  const chaptersInfo = useMemo(() => {
    if (book.toc.length === 0 || currentPageCursor === null) return null;
    const at = currentTocIndex(book.toc, String(currentPageCursor));
    return { at: at + 1, total: book.toc.length };
  }, [book.toc, currentPageCursor]);

  /**
   * 顶栏的章节标题：与 `chaptersInfo` **同一个判据**（`currentPageCursor`）。
   *
   * 两处若各用各的，滚过边界时会出现"章节数已经 3 / 14、标题还写着第一章"。
   */
  const chapterTitle = useMemo(() => {
    const index =
      currentPageCursor === null ? -1 : currentTocIndex(book.toc, String(currentPageCursor));
    const fromToc = index >= 0 ? tocTitleOrNull(book.toc[index]?.title) : null;
    return fromToc ?? tocTitleOrNull(first?.title) ?? null;
  }, [book.toc, currentPageCursor, first?.title]);

  const sessionMinutes = Math.max(0, Math.floor((clock - sessionStartRef.current) / 60_000));
  const pageMinutes = estimateReadMinutes(countPageChars(first));

  /**
   * 左栏**栏头**的登记信息：只在"选中了一本书"时才给（否则整块不渲染）。
   *
   * `readMinutes` 与顶栏的「本次阅读时间」是**同一个**计数器（`sessionMinutes`），
   * 不是另算一份——同一个数字出现在两处，不该有两套口径。
   */
  const railBook = useMemo(() => {
    if (!file || !isBook) return null;
    return {
      file,
      author: identity.author,
      coverUrl: identity.coverUrl,
      override: identity.override,
      readMinutes: sessionMinutes,
    };
  }, [file, isBook, identity, sessionMinutes]);

  /**
   * 新建批注时的位置信息（当前阅读位置）。
   *
   * `fallbackExcerpt` = **当前页正文的开头**（前 200 字符）：用户没划字就点高亮时用它，
   * 于是仍然得到一条有意义的高亮，而不是一条被后端拒掉的空记录。
   *
   * `cursor` 用**连续位置**取整（不是取数游标）：批注的落点应当是"我划下这句时
   * 读到哪儿"，而不是"这一页加载时从哪儿开始"——后者在长章里会偏差整页。
   * 与 `chaptersInfo` / `chapterTitle` / 进度**同一个判据**，四处不会互相矛盾。
   */
  const annotationPosition = useMemo(() => {
    const text = first?.text ?? collectBlockText(first?.blocks ?? []);
    return {
      cursor: absolutePosition === null ? "0" : String(Math.floor(absolutePosition)),
      progress: progress === null ? 0 : Math.round(progress * 10_000),
      title: chapterTitle ?? "",
      fallbackExcerpt: text.slice(0, ANNOTATION_FALLBACK_EXCERPT_CHARS),
    };
  }, [absolutePosition, chapterTitle, first, progress]);

  // 「更多」只有一个入口：直接同时开合目录/批注栏与阅读选项栏。
  const toggleRails = useCallback(() => {
    setRailsOpen((open) => !open);
  }, []);

  /**
   * 点击**正文区域**收起两栏（用户 2026-10-17 口径："点击更多后，点击正文区域可以
   * 隐藏两栏（等同于再次点击更多）"）。
   *
   * **只在两栏展开时才把回调传下去**（`railsOpen ? collapseRails : undefined`）：
   * 这是"两栏没开就不该有副作用"的**结构性**保证——比在回调里判一次更硬，
   * 因为收起状态下手压根不存在这个 handler。点击本身该不该触发由纯函数
   * `bodyClickHidesRails` 判（点在链接 / 分页按钮 / 划词时都不收起）。
   */
  const collapseRails = useCallback(() => {
    setRailsOpen(false);
  }, []);

  const emptyText = !file
    ? t("common.noSelection")
    : !isBook
      ? t("bookreader.notBook")
      : t("bookreader.noContent");

  return (
    <div className="panel br-root" ref={rootRef}>
      {/* 顶部：退出阅读 / 章节标题 / 阅读时长 / 全屏 / 更多 */}
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
          expanded={railsOpen}
          anyActive={railsOpen}
          onToggle={toggleRails}
          t={t}
        />
      </div>

      {/* 主体：左栏（目录等）/ 阅读区 / 右栏（阅读选项） */}
      <div className="br-body">
        {railsOpen && (
          <ReaderTocRail
            tab={leftTab}
            onTabChange={(tab) => setLeftTab(isReaderTab(tab) ? tab : "toc")}
            onClose={() => setRailsOpen(false)}
            toc={book.toc}
            tocLoading={book.loading && book.toc.length === 0}
            // 目录高亮也跟**连续位置**走：否则滚过章节边界后目录还亮着上一章，
            // 与底部「章节数」显示的章号互相矛盾。
            cursor={currentPageCursor === null ? null : String(currentPageCursor)}
            onJump={book.jumpTo}
            annotations={annotations}
            currentPosition={annotationPosition}
            book={railBook}
            t={t}
          />
        )}

        <ReaderStage
          // 跳章 = 换 key 重新挂载：滚动位置与"当前页"一起回到开头。
          //
          // **必须用取数游标 `book.cursor`，不能用 `absolutePosition`**：后者随滚动
          // 连续变化，拿它当 key 会在每一帧把阅读区卸载重建——滚动位置每动一下就
          // 被重置到开头，（且每次重建都重跑分页测量）。"实时"的是底部读数，
          // 不是阅读区实例。
          key={`${fileId ?? "-"}:${book.cursor ?? "start"}`}
          pages={book.pages}
          settings={settings}
          loading={book.loading}
          error={book.error}
          hasMore={book.hasMore}
          onNeedMore={book.loadMore}
          emptyText={emptyText}
          // 两栏收起时不传回调：收起是幂等的空操作，但"点击正文有副作用"这件事
          // 不该在两栏没开时也成立（结构性保证，不靠回调里再判一次）。
          onBodyClick={railsOpen ? collapseRails : undefined}
          onPositionChange={setVisiblePage}
          t={t}
        />

        {railsOpen && (
          <ReaderOptionsRail handle={handle} onClose={() => setRailsOpen(false)} t={t} />
        )}
      </div>

      <ReaderFooter
        progress={progress}
        chapterProgress={chapterProgress === null ? null : chapterProgress.progress}
        chapters={chaptersInfo}
        capped={Boolean(first?.capped) && !book.hasMore}
        t={t}
      />
    </div>
  );
}
