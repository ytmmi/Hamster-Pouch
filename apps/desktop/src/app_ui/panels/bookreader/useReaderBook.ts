/**
 * 图书阅读器：**正文与目录的取数**（分页 + 跳章）。
 *
 * ## 与查看器的取数有什么不同
 *
 * 查看器（`panels/viewer/useViewerBookContent.ts`）只做一件事：一页页往下取。
 * 阅读器多两件：
 * 1. **目录**（`book.toc`）——章节清单与跳转目标；
 * 2. **跳转**（`jumpTo(cursor)`）——把"已取回的页"整段丢掉，从目标游标重新开始。
 *
 * 游标语义由后端保证一致（`hp_book::toc` 的模块文档）：目录项的 `cursor` 原样传给
 * `book.content` 就是跳章，前端**不做任何换算**——这是两套坐标不漂移的唯一保证。
 *
 * ## 换书即重置
 *
 * 换文件 / 换仓库时把目录、页、当前游标全部清掉（`useEffect` 依赖 `repoId` + `fileId`），
 * 否则会把上一本的正文与目录显示在下一本上。取数世代号（`generationRef`）负责丢弃
 * 过期响应：跳转与"滚到底继续取"可能同时在飞，晚到的旧响应必须自己作废。
 *
 * ## 一次只取一页
 *
 * 与查看器同一条口径（用户 2026-10-09："固定上限 + 面板内滚动看更多，滚动时按需缓存"）：
 * 只有需要时才发下一次请求，**不**在打开时把整本拉回来。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { useApp } from "../../core/AppContext";
import type { BookContentResult, BookTocItem } from "../../shared/types";

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

/** 空状态（非"书" / 无选中）：所有取数都不发生。 */
function emptyBook(): Pick<ReaderBook, "toc" | "format" | "total" | "pages" | "cursor" | "loading" | "error" | "hasMore"> {
  return {
    toc: [],
    format: "",
    total: null,
    pages: [],
    cursor: null,
    loading: false,
    error: null,
    hasMore: false,
  };
}

/**
 * 按当前选中的文件取目录与正文页。
 *
 * 依赖只看 `repoId` 与 `fileId`（不看整个 `app`）：`app` 每次选中变化都会换身份，
 * 放进依赖会让"点一下别处"就重跑整轮取数。
 */
export function useReaderBook(): ReaderBook {
  const app = useApp();
  const repoId = app.repoId;
  const file = app.selectedFile;
  const fileId = file?.id ?? null;

  const [state, setState] = useState(emptyBook());
  /** 已取回的页单独存：`loadMore` 只追加，跳转只替换。 */
  const [pages, setPages] = useState<BookContentResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  /** 取数世代号：换书 / 跳转后，晚到的旧响应自行丢弃。 */
  const generationRef = useRef(0);
  /** 正在取（防止滚动与跳转连续触发重复请求）。 */
  const inflightRef = useRef(false);
  const tRef = useRef(app.t);
  tRef.current = app.t;

  const reset = useCallback(() => {
    generationRef.current += 1;
    inflightRef.current = false;
    setPages([]);
    setCursor(null);
    setState(emptyBook());
  }, []);

  // 换书 / 换仓库：目录、页、游标全部丢掉。
  useEffect(() => {
    reset();
  }, [repoId, fileId, reset]);

  /** 取一页（`cursor` 为空 = 第一页）。 */
  const fetchPage = useCallback(
    async (from: string | null, generation: number, replace: boolean) => {
      if (!repoId || !fileId) return;
      inflightRef.current = true;
      setState((prev) => ({ ...prev, loading: true }));
      try {
        const page = await api.bookContent({ repoId, fileId, cursor: from });
        if (generationRef.current !== generation) return;
        // 空页（非"书" / 无内容哈希 / 打不开的 PDF）不追加：否则会往列表里塞空对象。
        if (!page.format) {
          setState((prev) => ({ ...prev, loading: false, cursor: from }));
          return;
        }
        setPages((prev) => (replace ? [page] : [...prev, page]));
        setState((prev) => ({ ...prev, loading: false, cursor: from, error: null }));
      } catch (e) {
        if (generationRef.current !== generation) return;
        setState((prev) => ({ ...prev, loading: false, error: errorTextOf(tRef.current, e) }));
      } finally {
        if (generationRef.current === generation) inflightRef.current = false;
      }
    },
    [repoId, fileId],
  );

  // 目录：与第一页并行取（目录失败**不是**阅读失败，正文照常显示）。
  useEffect(() => {
    if (!repoId || !fileId) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const toc = await api.bookToc({ repoId, fileId });
        if (generationRef.current !== generation) return;
        setState((prev) => ({ ...prev, toc: toc.entries, format: toc.format, total: toc.total }));
      } catch {
        if (generationRef.current !== generation) return;
        setState((prev) => ({ ...prev, toc: [], total: null }));
      }
    })();
  }, [repoId, fileId]);

  // 首屏：取第一页。
  useEffect(() => {
    if (!repoId || !fileId) return;
    const generation = generationRef.current;
    void fetchPage(null, generation, true);
  }, [repoId, fileId, fetchPage]);

  const hasMore = pages.length > 0 && pages[pages.length - 1].next_cursor !== null;

  const loadMore = useCallback(() => {
    if (inflightRef.current || !hasMore) return;
    const last = pages[pages.length - 1];
    if (!last?.next_cursor) return;
    void fetchPage(last.next_cursor, generationRef.current, false);
  }, [pages, hasMore, fetchPage]);

  const jumpTo = useCallback(
    (target: string) => {
      // 跳转 = 新的世代：正在飞的旧响应（滚动触发的下一页）必须作废，
      // 否则它会把"跳转前的下一页"追加到新章节后面。
      generationRef.current += 1;
      inflightRef.current = false;
      setPages([]);
      setCursor(target);
      void fetchPage(target, generationRef.current, true);
    },
    [fetchPage],
  );

  return { ...state, pages, cursor, hasMore, loadMore, jumpTo };
}
