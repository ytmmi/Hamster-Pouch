/**
 * 图书预览面板：**取数与条目解析**。
 *
 * 与媒体预览面板（`mediaPreviewData.ts`）的差别只有一处，其余口径完全一致：
 * - 过滤条件写死 `mediaTypes: ['text']`（面板看的就是文本类文件：`txt` / `md` / `epub`），
 *   按**当前仓库 + 当前源 + 当前目录**取——**媒体预览则显式只要三种媒体类型**，
 *   两边各取所需、互不重叠（2026-10-08 用户口径「媒体预览不包含 text 类型，
 *   text 类型在图书预览显示」）；
 * - **不按相册取**：相册的成员分页 SQL 只认 `image` / `video` / `audio` 三个字面量
 *   （`hp-store` 的 `query_album_members_page`），文本类进不了相册成员列表。
 *   因此在相册被选中时，本面板仍按源/目录列文本文件——而不是显示一个空列表，
 *   把"相册不支持文本"伪装成"这里没有书"。
 *
 * 游标翻页复用**同一份**纯逻辑（`mediaPreviewPaging.drainPages`）：首屏第一页到手即渲染，
 * 其余页后台继续翻（严格前进 + 页数上限两道循环安全闸门都在这份实现里，不重写第二套）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { useApp } from "../../core/AppContext";
import type { FileItem } from "../../shared/types";
import { drainPages } from "../mediaPreviewPaging";

/** 每页条数（文本库比图库小得多，页大小取整百即可）。 */
const BOOK_PREVIEW_PAGE_LIMIT = 200;

/** 面板当前这一批取数结果。 */
export interface BookPreviewData {
  /** 排序前的原始条目（顺序即 `file.query` 的键：相对路径升序）。 */
  items: FileItem[];
  /** 是否仍在**后台翻页**（提示"列表还不是全部"）。 */
  loading: boolean;
}

/**
 * 取回文本类文件列表。
 *
 * 依赖只看"看的是哪个来源"这四个值，**不看 `app` 整个对象**——`app` 在每次选中变化时
 * 都会换身份，把它放进依赖会让"点一下别人"就重跑整轮翻页（`mediaPreviewData.ts` 的
 * 同一处坑，理由见那里的长注释）。
 */
export function useBookPreviewData(): BookPreviewData {
  const app = useApp();
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);

  const repoId = app.repoId;
  const sourceId = app.sourceId;
  const dirPath = app.dirPath;
  const refreshKey = app.refreshKey;
  const appRef = useRef(app);
  appRef.current = app;

  /** 取数世代号：旧世代的翻页在下一个检查点自行退出（切换来源后立刻停，不空跑完）。 */
  const generationRef = useRef(0);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      if (!repoId) return;
      setLoading(true);
      try {
        const all = await drainPages<FileItem>(
          (cursor) =>
            api.fileQuery({
              repoId,
              filter: {
                mediaTypes: ["text"],
                sourceId: sourceId ?? undefined,
                dirPrefix: dirPath ?? undefined,
              },
              cursor,
              limit: BOOK_PREVIEW_PAGE_LIMIT,
            }),
          {
            // 首屏第一页到手即渲染；本面板**不做前端排序**，所以中间过程刷新没有
            // "每次刷新都重排一遍全库"的代价（媒体预览必须节流的原因在这里不存在）。
            onPage: (_added, accumulated) => {
              if (isCancelled()) return;
              setItems([...accumulated]);
            },
            isCancelled,
          },
        );
        if (isCancelled()) return;
        setItems(all);
      } catch (e) {
        if (isCancelled()) return;
        appRef.current.status(
          appRef.current.t("book.loadFailed", { err: errorTextOf(appRef.current.t, e) }),
          "error",
        );
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [repoId, sourceId, dirPath, refreshKey],
  );

  useEffect(() => {
    if (!repoId) {
      setItems([]);
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    const isCancelled = () => generationRef.current !== generation;
    void load(isCancelled);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [repoId, load]);

  return { items, loading };
}
