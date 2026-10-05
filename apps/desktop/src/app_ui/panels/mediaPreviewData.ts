/**
 * 媒体预览面板：**取数与条目解析**。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 本文件只做数据这一件事——按当前仓库 / 相册 / 媒体源 / 目录 / 类型筛选取回面板
 * **整个来源**的文件，把媒体源的本地路径拼成绝对路径，再解析成可渲染的条目。
 *
 * 排序也在这里完成，且是**前端**的：后端 `file.query` 的排序键固定为
 * `(relative_path, source_id, id)` 升序（D78 键集游标，没有排序参数），
 * 所以前端排序要代表全库，就必须**先把来源翻完**——翻页的纯逻辑在
 * `mediaPreviewPaging.ts`（首屏第一页即渲染，其余页后台继续翻）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import type { FileItem, SourceItem } from "../shared/types";
import { sortFiles, type MediaSortKey, type SortDirection } from "./mediaPreviewView";
import { drainPages, MEDIA_PREVIEW_PAGE_LIMIT } from "./mediaPreviewPaging";

/** 工具条的类型筛选（`all` = 不筛）。 */
export type MediaTypeFilter = "all" | "image" | "video" | "audio";

/** 一条可渲染条目：文件本体 + 已解析的绝对路径 URL（无绝对路径时为空串）。 */
export interface MediaPreviewItem {
  file: FileItem;
  url: string;
}

/** 拼接本地绝对路径（按 base 的分隔符风格）。 */
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const normalized = rel.replace(/[\\/]/g, sep);
  return base.endsWith(sep) ? `${base}${normalized}` : `${base}${sep}${normalized}`;
}

/** 面板当前这一页的取数结果。 */
export interface MediaPreviewData {
  /** 后端返回的原始条目（滚动恢复等副作用只取它的"是否为空"信号）。 */
  files: FileItem[];
  /** 排序并解析 URL 之后的条目（三种视图共用）。 */
  items: MediaPreviewItem[];
  /**
   * 是否仍在**后台翻页**。
   *
   * 首屏第一页到手即可渲染，其余页继续翻；`loading` 为真时界面上的条目还**不是**全库，
   * 因此此时的前端排序（名称/时间/大小/类型）只代表已加载的部分。面板据此给出提示。
   */
  loading: boolean;
}

/** 取回面板当前这一页文件与媒体源，并解析成可渲染条目。 */
export function useMediaPreviewData(
  typeFilter: MediaTypeFilter,
  sortKey: MediaSortKey,
  sortDir: SortDirection,
): MediaPreviewData {
  const app = useApp();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(false);

  /**
   * 取数只依赖"**看的是哪个来源**"这四个值，**不依赖 `app` 整个对象**。
   *
   * 为什么必须拆开：`app` 的上下文对象在**每次选中变化**时都会换身份
   * （`selectedIds` / `selectedFile` 是 `AppUiApp` 里那个 `useMemo` 的依赖项）。
   * 若把 `app` 放进依赖数组，用户**每点一下缩略图**都会重跑整个取数——
   * 在"翻完全库"的语义下就是每次点击都重发上百次游标请求。这是不可接受的。
   */
  const repoId = app.repoId;
  const albumId = app.albumId;
  const sourceId = app.sourceId;
  const dirPath = app.dirPath;
  // 刷新信号要在依赖里（刷新必须重取）；状态回调只要"最新实现"，不进依赖。
  const refreshKey = app.refreshKey;
  const appRef = useRef(app);
  appRef.current = app;

  /**
   * 取数世代号：每次重新取数自增，旧世代的翻页在下一个检查点自行退出。
   *
   * 用世代号而不是 `let cancelled` 闭包，是因为翻页是**长时间**的（全库可能上百次往返）：
   * 卸载或切换来源后，旧世代必须**立刻**停止发请求，而不是等它自然跑完。
   */
  const generationRef = useRef(0);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      const current = appRef.current;
      // 没有仓库就没有可取的来源（effect 里已拦一次；这里再拦一次是为了让
      // TypeScript 收窄下面这些 `string | null`——闭包里不会继承调用点的收窄）。
      if (!repoId) return;
      setLoading(true);
      try {
        const srcsPromise = api.sourceList({ repoId });
        const fetchPage = albumId
          ? // 相册走**游标分页**（缺陷 0018）：翻到末页为止。
            (cursor: string | null) =>
              api.albumMembers({ repoId, albumId, cursor, limit: MEDIA_PREVIEW_PAGE_LIMIT })
          : (cursor: string | null) =>
              api.fileQuery({
                repoId,
                filter: {
                  sourceId: sourceId ?? undefined,
                  dirPrefix: dirPath ?? undefined,
                  mediaType: typeFilter === "all" ? undefined : typeFilter,
                },
                cursor,
                limit: MEDIA_PREVIEW_PAGE_LIMIT,
              });

        // 逐页推进：**首屏第一页到手即渲染**，其余页在后台继续翻。
        // 之所以不是"滚到底再续页"，见 `mediaPreviewPaging.ts` 的说明（前端排序需要全库）。
        //
        // 进度刷新**必须节流**，而且**只刷新首屏那一次**：每次 `setFiles` 都会让下面那个
        // O(n log n) 的前端排序重跑一遍（实测：5 万项名称排序约 281 ms，见缺陷 0018 的
        // 记录）。若每页都刷，5 万张（100 页）期间会累计重排约 100 次、单线程阻塞十余秒；
        // 即便"每 10 页刷一次"也仍有约 10 次 × 递增的全量重排（合计仍是秒级卡顿）。
        //
        // 中间过程对用户没有价值（首屏已经出图、计数另有 `loading` 提示），
        // 因此只在第一页刷一次，其余等 `drainPages` 返回后一次性落地。
        let firstPageRendered = false;
        const all = await drainPages<FileItem>(fetchPage, {
          onPage: (_added, accumulated) => {
            if (firstPageRendered) return;
            firstPageRendered = true;
            if (isCancelled()) return;
            setFiles([...accumulated]);
          },
          isCancelled,
        });

        const srcs = await srcsPromise;
        if (isCancelled()) return;
        setFiles(all);
        setSources(srcs);
      } catch (e) {
        if (isCancelled()) return;
        current.status(current.t("media.loadFailed", { err: errorTextOf(current.t, e) }), "error");
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [repoId, albumId, sourceId, dirPath, typeFilter, refreshKey],
  );

  useEffect(() => {
    if (!repoId) {
      setFiles([]);
      setSources([]);
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    const isCancelled = () => generationRef.current !== generation;
    void load(isCancelled);
    // 卸载（或依赖变化重跑）即取消：旧世代的下一次翻页检查点会直接退出。
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [repoId, load]);

  const sourceMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      map.set(s.id, s.local_path);
    }
    return map;
  }, [sources]);

  /**
   * 排序后的文件（翻页**完成**后即代表全库）。
   *
   * 后台翻页途中 `files` 只是"已取到的部分"，此时排序只代表这一部分——
   * 面板用 `loading` 给出提示（`mediaPreviewView.ts` 不再声称"只作用于已加载的一页"）。
   */
  const sortedFiles = useMemo(
    () => sortFiles(files, sortKey, sortDir),
    [files, sortKey, sortDir],
  );

  const items = useMemo(
    () =>
      sortedFiles.map((file) => {
        const base = sourceMap.get(file.source_id) ?? "";
        const full = base ? joinPath(base, file.relative_path) : "";
        return { file, url: full ? convertFileSrc(full) : "" };
      }),
    [sortedFiles, sourceMap],
  );

  return { files, items, loading };
}
