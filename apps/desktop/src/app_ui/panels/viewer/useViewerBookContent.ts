/**
 * 查看器：**正文取数**（分页 + 按需缓存）。
 *
 * 用户口径（2026-10-09）："固定上限 + 面板内滚动看更多，**字符缓存不需要大，
 * 滚动时按需缓存**"。因此本钩子的形态是：
 *
 * - **一页一页取**：`book.content` 每次只回一页（后端按上限只读文件开头）；
 * - **只在需要时取下一页**：滚到接近底部才发请求（`shouldLoadMore`），
 *   不是"打开就全取回来"；
 * - **切书即清空**：换一本 / 换一个文件时把已取的页丢掉（`useEffect` 依赖文件 id），
 *   否则会把上一本的正文显示在下一本上。
 *
 * **不缓存已渲染的页**：用户明确说"字符缓存不需要大"——已取回的页就在 state 里
 * 参与渲染，不需要另立一份缓存。这也让"切书"变成一次简单的 state 重置。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { useApp } from "../../core/AppContext";
import type { BookContentResult } from "../../shared/types";

/** 阅读器的取数状态。 */
export interface ViewerBookContent {
  /** 已取回的页（按取回顺序）。 */
  pages: BookContentResult[];
  /** 是否正在取（首屏用；取下一页时也用，但那时已有内容可显示）。 */
  loading: boolean;
  /** 取数失败的原因（已翻译）；`null` = 没有失败。 */
  error: string | null;
  /** 还有没有下一页。 */
  hasMore: boolean;
  /** 取下一页（幂等：正在取 / 没有更多时不重复发）。 */
  loadMore: () => void;
}

/**
 * 按当前选中的文件取正文页。
 *
 * 依赖只看 `repoId` 与 `fileId`（不看 `app` 整个对象）：`app` 在每次选中变化时
 * 都会换身份，把它放进依赖会让"点一下别处"就重跑整轮取数。
 */
export function useViewerBookContent(): ViewerBookContent {
  const app = useApp();
  const repoId = app.repoId;
  const file = app.selectedFile;
  const fileId = file?.id ?? null;

  const [pages, setPages] = useState<BookContentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 取数世代号：切书后旧请求的结果自行丢弃（否则会串到下一本上）。 */
  const generationRef = useRef(0);
  /** 正在取（防止滚动事件连续触发重复请求）。 */
  const inflightRef = useRef(false);
  const tRef = useRef(app.t);
  tRef.current = app.t;

  // 切书 / 换仓库：丢掉已取的页（用户口径"缓存不需要大"，重置即释放）。
  useEffect(() => {
    generationRef.current += 1;
    inflightRef.current = false;
    setPages([]);
    setError(null);
    setLoading(false);
  }, [repoId, fileId]);

  const fetchPage = useCallback(
    async (cursor: string | null, generation: number) => {
      if (!repoId || !fileId) return;
      inflightRef.current = true;
      setLoading(true);
      try {
        const page = await api.bookContent({ repoId, fileId, cursor });
        if (generationRef.current !== generation) return;
        // 空页（非文本类 / 无内容哈希）不追加：否则会往列表里塞一个空对象。
        if (!page.format) return;
        setPages((prev) => [...prev, page]);
        setError(null);
      } catch (e) {
        if (generationRef.current !== generation) return;
        setError(errorTextOf(tRef.current, e));
      } finally {
        if (generationRef.current === generation) {
          setLoading(false);
          inflightRef.current = false;
        }
      }
    },
    [repoId, fileId],
  );

  // 首屏：取第一页。
  useEffect(() => {
    if (!repoId || !fileId) return;
    const generation = generationRef.current;
    void fetchPage(null, generation);
  }, [repoId, fileId, fetchPage]);

  const hasMore = pages.length > 0 && pages[pages.length - 1].next_cursor !== null;

  const loadMore = useCallback(() => {
    if (inflightRef.current || !hasMore) return;
    const last = pages[pages.length - 1];
    if (!last?.next_cursor) return;
    void fetchPage(last.next_cursor, generationRef.current);
  }, [pages, hasMore, fetchPage]);

  return { pages, loading, error, hasMore, loadMore };
}
