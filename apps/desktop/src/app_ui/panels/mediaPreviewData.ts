/**
 * 媒体预览面板：**已加载文件页的取数与条目解析**。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 本文件只做数据这一件事——按当前仓库 / 相册 / 媒体源 / 目录 / 类型筛选取回面板
 * **已加载**的那一页文件，把媒体源的本地路径拼成绝对路径，再解析成可渲染的条目。
 *
 * 排序也在这里完成，且是**前端**的：只作用于面板**已加载**的那一页（`file.query` 的
 * `limit`），后端的查询顺序是分页游标的基准（D78），不在这里改。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import type { FileItem, SourceItem } from "../shared/types";
import { sortFiles, type MediaSortKey, type SortDirection } from "./mediaPreviewView";

/** 工具条的类型筛选（`all` = 不筛）。 */
export type MediaTypeFilter = "all" | "image" | "video" | "audio";

/**
 * 面板**一次取数**的页大小。
 *
 * 缺陷 0018 之前这里是写死的 `300`，而且**没有任何续页入口**——第 301 张之后
 * 永远看不到。现在两种来源都按游标分页取到 `MEDIA_PREVIEW_MAX_ITEMS` 为止。
 */
export const MEDIA_PREVIEW_PAGE_LIMIT = 500;

/**
 * 面板单次装载的**条目上限**。
 *
 * 为什么不无限翻页：条目容器目前**没有虚拟化**（三种视图都是 `items.map`），
 * 每个单元还要各建一个 `IntersectionObserver`（`mediaPreviewCell.tsx`）。
 * 无上限地翻页只会把"看不到"换成"卡死"。这里给一个有界值，配合后续的
 * 虚拟化再放宽——当前先保证"能翻到远多于 300 张"，而不是假装能一次装下全库。
 */
export const MEDIA_PREVIEW_MAX_ITEMS = 2000;

/**
 * 相册成员按游标分页取到上限（缺陷 0018）。
 *
 * `album.members` 现在与 `file.query` 同形（`items` + `nextCursor`），
 * 因此这里与源路径共用同一套翻页写法。
 */
async function fetchAlbumPage(repoId: string, albumId: string): Promise<FileItem[]> {
  const out: FileItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await api.albumMembers({
      repoId,
      albumId,
      cursor,
      limit: MEDIA_PREVIEW_PAGE_LIMIT,
    });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (out.length >= MEDIA_PREVIEW_MAX_ITEMS) {
      break;
    }
  } while (cursor);
  return out.slice(0, MEDIA_PREVIEW_MAX_ITEMS);
}

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
  /** 后端返回的原始一页（滚动恢复等副作用只取它的"是否为空"信号）。 */
  files: FileItem[];
  /** 排序并解析 URL 之后的条目（三种视图共用）。 */
  items: MediaPreviewItem[];
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

  const load = useCallback(async () => {
    if (!app.repoId) {
      setFiles([]);
      setSources([]);
      return;
    }
    try {
      const [page, srcs] = await Promise.all([
        app.albumId
          ? // 相册走**游标分页**（缺陷 0018）：取到面板上限为止。
            // 旧实现一次性取回全部成员，大相册会把全部行读进内存并渲染成 DOM。
            fetchAlbumPage(app.repoId, app.albumId)
          : api
              .fileQuery({
                repoId: app.repoId,
                filter: {
                  sourceId: app.sourceId ?? undefined,
                  dirPrefix: app.dirPath ?? undefined,
                  mediaType: typeFilter === "all" ? undefined : typeFilter,
                },
                limit: MEDIA_PREVIEW_PAGE_LIMIT,
              })
              .then((p) => p.items),
        api.sourceList({ repoId: app.repoId }),
      ]);
      setFiles(page);
      setSources(srcs);
    } catch (e) {
      app.status(app.t("media.loadFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app, typeFilter]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  const sourceMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      map.set(s.id, s.local_path);
    }
    return map;
  }, [sources]);

  /** 排序后的文件（面板已加载的那一页；后端查询顺序是分页游标的基准，不在这里改）。 */
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

  return { files, items };
}
