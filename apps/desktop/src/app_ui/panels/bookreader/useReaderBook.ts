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

/** 空状态（非"书" / 无选中）：所有取数都不发生。 */
function emptyBook(): Pick<
  ReaderBook,
  "toc" | "format" | "total" | "pages" | "cursor" | "segmentStart" | "loading" | "error" | "hasMore"
> {
  return {
    toc: [],
    format: "",
    total: null,
    pages: [],
    cursor: null,
    // 没有书时也按"从头"给：消费方据此算出的进度本来就是 `null`（总量也没有）。
    segmentStart: "0",
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
  /**
   * 跳转目标（**只有 `jumpTo` 会改**；首屏与 `loadMore` 都不动它）。
   *
   * 消费方是阅读区的 `key`：跳章要重新挂载，加载更多**不能**重挂载。
   */
  const [cursor, setCursor] = useState<string | null>(null);
  /**
   * 本次阅读段的**起点游标**（首屏 `"0"`、跳转 = 目标、`loadMore` 不变）。
   *
   * 这是"已载入正文从哪儿开始"的唯一真相：进度与章节数的绝对位置都靠它。
   * 详见 [`ReaderBook.segmentStart`] 的两字段分工说明。
   */
  const [segmentStart, setSegmentStart] = useState("0");

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
    setSegmentStart("0");
    setState(emptyBook());
  }, []);

  // 换书 / 换仓库：目录、页、游标全部丢掉。
  useEffect(() => {
    reset();
  }, [repoId, fileId, reset]);

  /**
   * 取一页（`cursor` 为空 = 第一页）。
   *
   * **`segmentStart` 只由调用方决定，不在这里改**（2026-10-17 修订）：
   * - 首屏：`segmentStart` 保持 `"0"`（重扫/换书时 `reset` 已置 `"0"`）；
   * - `loadMore`：**不动**——已经载入的这一段从头到尾覆盖 `[segmentStart, 当前页]`，
   *   每加载一页就把起点往后挪，会把"已读多少"算少（读完整本书章节数还在前面）；
   * - `jumpTo`：由 `jumpTo` 自己置为目标。
   *
   * 旧实现在这里写 `cursor: from`，于是 `state.cursor` 在每次 `loadMore` 后都变成
   * 最新一页的起点——既让 `key` 变化（阅读区重挂载），又让"段起点"漂移。
   */
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
          setState((prev) => ({ ...prev, loading: false }));
          return;
        }
        setPages((prev) => (replace ? [page] : [...prev, page]));
        setState((prev) => ({ ...prev, loading: false, error: null }));
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

  // 首屏：取第一页，并把"本次阅读段起点"归到 0（`book.content` 缺省 cursor 的语义）。
  useEffect(() => {
    if (!repoId || !fileId) return;
    const generation = generationRef.current;
    setSegmentStart("0");
    void fetchPage(null, generation, true);
  }, [repoId, fileId, fetchPage]);

  const hasMore = pages.length > 0 && pages[pages.length - 1].next_cursor !== null;

  /**
   * 继续取下一页。
   *
   * **不碰 `cursor` / `segmentStart`**：加载更多是把**同一段**的后续页接上来，
   * 段的起点没变（见 [`ReaderBook.segmentStart`]）。早期实现在这里写
   * `setState({cursor: from})`，于是每加载一页 `key` 就变一次、阅读区重挂载，
   * 且"段起点"往后漂——读完整本书章节数仍停在开头几章。
   */
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
      // 两处一起改：`cursor` 让阅读区重挂载（跳章要回到开头），
      // `segmentStart` 让进度 / 章节数以**目标位置**为基准。
      setCursor(target);
      setSegmentStart(target);
      void fetchPage(target, generationRef.current, true);
    },
    [fetchPage],
  );

  return { ...state, pages, cursor, segmentStart, hasMore, loadMore, jumpTo };
}
