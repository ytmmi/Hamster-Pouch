/**
 * 图书阅读器：**正文与目录的取数**（分页 + 跳章）。
 *
 * ## 与查看器的取数有什么不同
 *
 * 正文的分页状态机是共用的（`shared/useBookPages.ts`，D209）：一页一页取、滚到底再取、
 * 切书即清空、晚到响应作废，这些两个面板一模一样。阅读器多两件：
 * 1. **目录**（`book.toc`）——章节清单与跳转目标；
 * 2. **跳转**（`jumpTo(cursor)`）——把"已取回的页"整段丢掉，从目标游标重新开始。
 *
 * 游标语义由后端保证一致（`hp_book::toc` 的模块文档）：目录项的 `cursor` 原样传给
 * `book.content` 就是跳章，前端**不做任何换算**——这是两套坐标不漂移的唯一保证。
 *
 * ## 换书即重置
 *
 * 换文件 / 换仓库时把目录、页、当前游标全部清掉（页由共享钩子的重置 effect 负责，
 * 目录由本文件的 effect 负责），否则会把上一本的正文与目录显示在下一本上。取数世代号
 * （`generation`）负责丢弃过期响应：跳转与"滚到底继续取"可能同时在飞，晚到的旧响应必须自己作废。
 *
 * ## 一次只取一页
 *
 * 与查看器同一条口径（用户 2026-10-09："固定上限 + 面板内滚动看更多，滚动时按需缓存"）：
 * 只有需要时才发下一次请求，**不**在打开时把整本拉回来。
 */

import { useEffect, useState } from "react";

import { useApp } from "../../core/AppContext";
import * as api from "../../shared/api";
import type { BookContentResult, BookTocItem } from "../../shared/types";
import { useBookPages } from "../../shared/useBookPages";

/** 阅读器的取数状态。 */
export interface ReaderBook {
  /** 目录项（`book.toc` 的结果；可能为空 = 这本书没有目录）。 */
  toc: BookTocItem[];
  /** 目录对应格式（`text` / `markdown` / `epub` / `pdf`；空串 = 还不是"书"）。 */
  format: string;
  /**
   * 全书总单位数（txt = 字符数、md = 顶层块数、epub / pdf = 章节数 / 页数）；
   * `null` = 后端没给出（打不开的书）。
   */
  total: number | null;
  /** 已取回的页（按取回顺序）。 */
  pages: BookContentResult[];
  /**
   * **本次阅读段的起点游标**（`book.content` 的 cursor）。
   *
   * 与 [`ReaderBook.cursor`] 的区别是这次修订（2026-10-17）的核心：
   *
   * | 字段 | 何时变 | 用途 |
   * | --- | --- | --- |
   * | `cursor`（跳转目标） | **只有 `jumpTo`** 会改；首屏与 `loadMore` 都不动它 | 阅读区 `key`（跳章才重挂载） |
   * | `segmentStart`（本字段） | 首屏 = `"0"`、跳转 = 目标、**`loadMore` 不变** | 进度 / 章节数的**绝对位置基准** |
   *
   * 为什么必须分开：`cursor` 首屏是 `null`、`loadMore` 也不更新，于是"已载入这一段的
   * 起点"在任何**非跳转**路径上都是 `null`/`0`——用它当基准，读完整本书位置都停在开头，
   * 章节数永远显示第 1 章（用户实测："本来下一章是第4章-序章，计数结果变回1了"）。
   * 反过来把 `cursor` 改成"最新一页的起点"又会让 `key` 每加载一页就重挂载阅读区。
   * 两个语义各有各的消费方，因此**分成两个字段**，而不是让一个变量同时承担两件事。
   */
  segmentStart: string;
  /** 当前页起点游标；`null` = 从第一页开始。 */
  cursor: string | null;
  loading: boolean;
  /** 取数失败的原因（已翻译）；`null` = 没有失败。 */
  error: string | null;
  hasMore: boolean;
  /** 取下一页（幂等：正在取 / 没有更多时不重复发）。 */
  loadMore: () => void;
  /** 跳到某个游标（目录点击；会丢掉已取回的页）。 */
  jumpTo: (cursor: string) => void;
}

/** 目录的三元组（与正文页分开存：目录失败**不是**阅读失败）。 */
interface TocState {
  toc: BookTocItem[];
  format: string;
  total: number | null;
}

const EMPTY_TOC: TocState = { toc: [], format: "", total: null };

/**
 * 按当前选中的文件取目录与正文页。
 *
 * 依赖只看 `repoId` 与 `fileId`（不看整个 `app`）：`app` 每次选中变化都会换身份，
 * 放进依赖会让"点一下别处"就重跑整轮取数。
 */
export function useReaderBook(): ReaderBook {
  const app = useApp();
  const repoId = app.repoId;
  const fileId = app.selectedFile?.id ?? null;
  const book = useBookPages();
  const generation = book.generation;

  const [tocState, setTocState] = useState<TocState>(EMPTY_TOC);

  // 目录：与第一页并行取（目录失败**不是**阅读失败，正文照常显示）。
  useEffect(() => {
    if (!repoId || !fileId) {
      setTocState(EMPTY_TOC);
      return;
    }
    const at = generation();
    void (async () => {
      try {
        const toc = await api.bookToc({ repoId, fileId });
        if (generation() !== at) return;
        setTocState({ toc: toc.entries, format: toc.format, total: toc.total });
      } catch {
        if (generation() !== at) return;
        setTocState(EMPTY_TOC);
      }
    })();
  }, [repoId, fileId, generation]);

  return {
    toc: tocState.toc,
    format: tocState.format,
    total: tocState.total,
    pages: book.pages,
    segmentStart: book.segmentStart,
    cursor: book.jumpTarget,
    loading: book.loading,
    error: book.error,
    hasMore: book.hasMore,
    loadMore: book.loadMore,
    jumpTo: book.jumpTo,
  };
}
