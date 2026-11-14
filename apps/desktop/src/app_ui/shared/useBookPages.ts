/**
 * 图书正文的**取数状态机**（D209）：查看器与阅读器共用同一份分页逻辑。
 *
 * 两个面板的用户口径是同一条（2026-10-09）："固定上限 + 面板内滚动看更多，**字符缓存不需要大**，
 * 滚动时按需缓存"。因此形态固定为：
 *
 * - **一页一页取**：`book.content` 每次只回一页（后端按上限只读文件开头）；
 * - **只在需要时取下一页**：消费方滚到接近底部才调 `loadMore`，不是"打开就全取回来"；
 * - **切书即清空**：换文件 / 换仓库时把已取的页丢掉（否则会把上一本的正文显示在下一本上）；
 * - **一次只取一页**：`loadMore` 幂等（正在取 / 没有更多时不重复发）；
 * - **晚到的旧响应自行作废**：`generation` 每次重置 / 跳转都自增，响应回来先比对世代号。
 *
 * ## 为什么两个面板共用一份
 *
 * 阅读器比查看器多两件东西——目录（`book.toc`）与跳章（`jumpTo`）——但"页"的状态机完全相同。
 * D209 之前这两份各写一遍：世代号、在途旗、空页不追加、失败翻译、`hasMore` 由 `next_cursor` 判定，
 * 每一条都在两个文件里各存一份。凡是"同一件事的两份实现"，迟早只有一份被修（阅读器那次
 * `segmentStart` 的回归就是这么来的），所以这里收成一份，两个 hook 只做字段映射。
 *
 * ## `segmentStart` 与 `jumpTarget` 为什么是两个字段
 *
 * | 字段 | 何时变 | 用途 |
 * | --- | --- | --- |
 * | `jumpTarget` | **只有 `jumpTo`** 会改；首屏与 `loadMore` 都不动它 | 阅读区 `key`（跳章才重挂载） |
 * | `segmentStart` | 首屏 = `"0"`、跳转 = 目标、**`loadMore` 不变** | 进度 / 章节数的**绝对位置基准** |
 *
 * 让一个变量同时承担两件事必然坏一半：用 `jumpTarget` 当基准时，非跳转路径上它一直是
 * `null`，读完整本书位置都停在开头（章节数永远显示第 1 章，用户实测过）；反过来让
 * `jumpTarget` 跟着"最新一页的起点"走，`key` 就每加载一页变一次、阅读区反复重挂载。
 *
 * 查看器不使用这两个字段（它不显示章节进度，也没有目录跳转），但它们的状态机仍由这里维护，
 * 免得以后加跳转时再抄一遍。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useApp } from "../core/AppContext";
import * as api from "./api";
import { errorTextOf } from "./api/response";
import type { BookContentResult } from "./types";

/** 正文取数的对外状态。 */
export interface BookPages {
  /** 已取回的页（按取回顺序）。 */
  pages: BookContentResult[];
  /** 是否正在取（首屏用；取下一页时也用，但那时已有内容可显示）。 */
  loading: boolean;
  /** 取数失败的原因（已翻译）；`null` = 没有失败。 */
  error: string | null;
  /** 还有没有下一页（由最后一页的 `next_cursor` 判定，不由前端估算）。 */
  hasMore: boolean;
  /** 本段起点游标（首屏 `"0"`、跳转 = 目标、`loadMore` 不动）。 */
  segmentStart: string;
  /** 跳转目标游标（只有 `jumpTo` 会改）；`null` = 从第一页开始。 */
  jumpTarget: string | null;
  /** 取下一页（幂等：正在取 / 没有更多时不重复发）。 */
  loadMore: () => void;
  /** 跳到某个游标（会丢掉已取回的页，并作废在途响应）。 */
  jumpTo: (cursor: string) => void;
  /** 读当前世代号（并行取数——例如目录——用它判断响应是否过期）。 */
  generation: () => number;
}

/**
 * 按当前选中的文件取正文页。
 *
 * 依赖只看 `repoId` 与 `fileId`（不看整个 `app`）：`app` 每次选中变化都会换身份，
 * 放进依赖会让"点一下别处"就重跑整轮取数。
 */
export function useBookPages(): BookPages {
  const app = useApp();
  const repoId = app.repoId;
  const fileId = app.selectedFile?.id ?? null;

  const [pages, setPages] = useState<BookContentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segmentStart, setSegmentStart] = useState("0");
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);

  /** 取数世代号：换书 / 跳转后，晚到的旧响应自行丢弃。 */
  const generationRef = useRef(0);
  /** 正在取（防止滚动与跳转连续触发重复请求）。 */
  const inflightRef = useRef(false);
  const tRef = useRef(app.t);
  tRef.current = app.t;

  // 换书 / 换仓库：页、游标、错误全部丢掉（用户口径"缓存不需要大"，重置即释放）。
  useEffect(() => {
    generationRef.current += 1;
    inflightRef.current = false;
    setPages([]);
    setSegmentStart("0");
    setJumpTarget(null);
    setLoading(false);
    setError(null);
  }, [repoId, fileId]);

  /**
   * 取一页（`from` 为空 = 第一页）。
   *
   * **`segmentStart` 只由调用方决定，不在这里改**：首屏保持 `"0"`（重置已置 `"0"`），
   * `loadMore` **不动**（这一段的起点没变），`jumpTo` 由它自己置为目标。
   */
  const fetchPage = useCallback(
    async (from: string | null, generation: number, replace: boolean) => {
      if (!repoId || !fileId) return;
      inflightRef.current = true;
      setLoading(true);
      try {
        const page = await api.bookContent({ repoId, fileId, cursor: from });
        if (generationRef.current !== generation) return;
        // 空页（非"书" / 无内容哈希 / 打不开的 PDF）不追加：否则会往列表里塞一个空对象。
        if (!page.format) return;
        setPages((prev) => (replace ? [page] : [...prev, page]));
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
    void fetchPage(null, generationRef.current, true);
  }, [repoId, fileId, fetchPage]);

  const hasMore = pages.length > 0 && pages[pages.length - 1].next_cursor !== null;

  /**
   * 继续取下一页。
   *
   * **不碰 `jumpTarget` / `segmentStart`**：加载更多是把**同一段**的后续页接上来，
   * 段的起点没变。改了会让 `key` 每页变一次（阅读区重挂载），且"段起点"往后漂。
   */
  const loadMore = useCallback(() => {
    if (inflightRef.current || !hasMore) return;
    const last = pages[pages.length - 1];
    if (!last?.next_cursor) return;
    void fetchPage(last.next_cursor, generationRef.current, false);
  }, [pages, hasMore, fetchPage]);

  /** 跳转 = 新的世代（在途的旧响应必须作废），页整段替换。 */
  const jumpTo = useCallback(
    (target: string) => {
      generationRef.current += 1;
      inflightRef.current = false;
      setPages([]);
      // 两处一起改：`jumpTarget` 让阅读区重挂载，`segmentStart` 让进度以目标位置为基准。
      setJumpTarget(target);
      setSegmentStart(target);
      void fetchPage(target, generationRef.current, true);
    },
    [fetchPage],
  );

  const generation = useCallback(() => generationRef.current, []);

  return {
    pages,
    loading,
    error,
    hasMore,
    segmentStart,
    jumpTarget,
    loadMore,
    jumpTo,
    generation,
  };
}
