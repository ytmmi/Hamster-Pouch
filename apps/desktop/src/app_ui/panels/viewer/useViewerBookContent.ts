/**
 * 查看器：**正文取数**（分页 + 按需缓存）。
 *
 * 分页状态机在 `shared/useBookPages.ts`（D209）：查看器与图书阅读器共用一份——
 * 同样的一页一页取、滚到接近底部才取下一页、切书即清空、晚到的旧响应自行作废。
 * 本文件只做字段映射：查看器不显示章节进度、也没有目录跳转，因此不消费
 * `segmentStart` / `jumpTarget` / `jumpTo`（它们仍由共享钩子维护）。
 *
 * **不缓存已渲染的页**：用户明确说"字符缓存不需要大"——已取回的页就在 state 里
 * 参与渲染，不需要另立一份缓存。这也让"切书"变成一次简单的 state 重置。
 *
 * **PDF 的"页"是整页位图**（后端栅格化，一页一个 `image` 块）：对共享状态机与文本类
 * **完全同形**——同样的游标、同样的"滚到底再取下一页"。位图本身的落盘缓存由**后端**
 * 按内容哈希负责（`<hash>.book-<页码>-0.jpg`），前端这一层不需要区别对待。
 */

import { useBookPages } from "../../shared/useBookPages";
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

/** 按当前选中的文件取正文页。 */
export function useViewerBookContent(): ViewerBookContent {
  const book = useBookPages();
  return {
    pages: book.pages,
    loading: book.loading,
    error: book.error,
    hasMore: book.hasMore,
    loadMore: book.loadMore,
  };
}
