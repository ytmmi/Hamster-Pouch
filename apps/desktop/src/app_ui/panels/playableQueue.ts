/**
 * **可播放队列**（当前音频 / 视频所属的相册或源，顺序与媒体预览一致）。
 *
 * 音乐播放器面板（`kind = "audio"`）、媒体播放器面板（`kind = "any"`）与任何将来
 * 需要"按播放器顺序走一格"的面板共用这一份实现：各写一遍必然漂移（排序、范围优先级、
 * 取消语义全都要对齐）。
 *
 * - `kind = "audio"` / `"video"`：队列只装该类型（音乐面板的上一首/下一首不跨类型）。
 * - `kind = "any"`：音频与视频混在一条队列里，**顺序就是媒体预览看到的顺序**——
 *   媒体播放器面板用它（用户 2026-11-13 裁决："一条队列混合音频与视频"），
 *   于是 ←/→ 在同一个面板里可以连续走完一段混排内容。
 *
 * 跨类型的步进仍由 `queueView.stepPlayable` 兜一层：传 `"audio"` / `"video"` 时
 * 只在同类里走，不会从 mp3 跳到 mp4。
 *
 * 来源优先级与媒体预览/图像查看器**同一条口径**（`viewerScopeOf` /
 * `scopeKindOf` 直接复用，不写第三份）：相册 → 源或子目录 → 全仓库。
 * 排序同样复用媒体预览的有效排序（`panel.media.sortKey` / `sortDir` + 会话覆盖
 * `mediaSortStore` + 纯函数 `sortFiles`），于是"媒体预览里看到的名字顺序"就是
 * "下一首"的顺序。
 *
 * 翻页复用 `drainPages`（首屏先出、后台翻完整个来源）；`INDEX_PAGE_LIMIT` 与
 * 图像查看器同为 1000（后端单页上限）。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { usePanelSettingValue } from "../shared/settingValue";
import { getMediaSortSession, subscribeMediaSort } from "../core/mediaSortStore";
import type { FileItem } from "../shared/types";
import type { AppContextValue } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import {
  indexOfSelected,
  type ViewerScope,
} from "./imageviewer/useViewerSequence";
import { isMediaSortKey, isSortDirection, MEDIA_PANEL_ID, sortFiles } from "./mediaPreviewView";
import { drainPages, type MediaPreviewPageFetcher } from "./mediaPreviewPaging";
import { playableFiles, playableKindOf, type PlayableKind } from "./music/queueView";

/** 单页条数（`file.query` / `album.members` 的后端上限同样是 1000）。 */
export const QUEUE_PAGE_LIMIT = 1000;

/**
 * 队列口径：只要一种媒体类型，或"可播放的都收"（`"any"`）。
 *
 * `"any"` 存在的理由：媒体播放器面板既能放视频也能放音频（用户 2026-11-13 裁决：
 * "视频播放器可以播放音频，只是音频只有基础功能"），它的一条队列要同时覆盖两者。
 */
export type QueueKind = PlayableKind | "any";

/** 队列：当前范围里的可播放文件 + 当前位置。 */
export interface PlayableQueue {
  files: FileItem[];
  /** 当前文件在 `files` 中的下标；`-1` = 不在队列内。 */
  index: number;
  loading: boolean;
  truncated: boolean;
}

/**
 * 加载并跟踪可播放队列（仓库 / 相册 / 源 / 子目录 / 刷新计数变化即重载）。
 *
 * 排序不进重载依赖（与媒体预览、图像查看器同一口径）：改排序只重排已取到的
 * `files`，不重发游标请求。
 */
export function usePlayableQueue(
  app: AppContextValue,
  panelApi: PanelRenderCtx["api"] | undefined,
  kind: QueueKind,
): PlayableQueue {
  const { repoId, albumId, sourceId, dirPath, refreshKey, selectedFile, status, t } = app;
  const [rawFiles, setRawFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const generationRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  const tRef = useRef(t);
  tRef.current = t;

  const defaultSortKey = usePanelSettingValue(MEDIA_PANEL_ID, "sortKey", panelApi);
  const defaultSortDir = usePanelSettingValue(MEDIA_PANEL_ID, "sortDir", panelApi);
  const sortSession = useSyncExternalStore(
    subscribeMediaSort,
    getMediaSortSession,
    getMediaSortSession,
  );
  const sortKey = sortSession.key ?? (isMediaSortKey(defaultSortKey) ? defaultSortKey : "name");
  const sortDir = sortSession.dir ?? (isSortDirection(defaultSortDir) ? defaultSortDir : "asc");

  useEffect(() => {
    // `"any"` 时不做类型过滤：一条队列里音频与视频按媒体预览的顺序混排。
    const keepKind = (items: FileItem[]) =>
      kind === "any"
        ? playableFiles(items)
        : playableFiles(items).filter((file) => playableKindOf(file) === kind);
    const scope: ViewerScope | null = repoId
      ? { repoId, albumId, sourceId, dirPath }
      : null;
    if (!scope) {
      setRawFiles([]);
      setTruncated(false);
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    const isCancelled = () => generationRef.current !== generation;
    setRawFiles([]);
    setLoading(true);
    setTruncated(false);
    void (async () => {
      try {
        const fetchPage: MediaPreviewPageFetcher<FileItem> = scope.albumId
          ? (cursor) =>
              api.albumMembers({
                repoId: scope.repoId,
                albumId: scope.albumId as string,
                cursor,
                limit: QUEUE_PAGE_LIMIT,
              })
          : (cursor) =>
              api.fileQuery({
                repoId: scope.repoId,
                filter: {
                  mediaTypes: [kind],
                  sourceId: scope.sourceId ?? undefined,
                  dirPrefix: scope.dirPath ?? undefined,
                },
                cursor,
                limit: QUEUE_PAGE_LIMIT,
              });
        let firstRendered = false;
        const drained = await drainPages<FileItem>(fetchPage, {
          onPage: (_added, accumulated) => {
            if (firstRendered) return;
            firstRendered = true;
            if (isCancelled()) return;
            setRawFiles(keepKind(accumulated));
          },
          isCancelled,
        });
        if (isCancelled()) return;
        setRawFiles(keepKind(drained));
        setTruncated(!drained.complete);
      } catch (e) {
        if (isCancelled()) return;
        setRawFiles([]);
        setTruncated(false);
        statusRef.current(
          tRef.current(kind === "audio" ? "music.queueFailed" : "player.queueFailed", {
            err: errorTextOf(tRef.current, e),
          }),
          "error",
        );
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    })();
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [repoId, albumId, sourceId, dirPath, refreshKey, kind]);

  const files = useMemo(
    () => sortFiles(rawFiles, sortKey, sortDir),
    [rawFiles, sortKey, sortDir],
  );
  const index = useMemo(() => indexOfSelected(files, selectedFile), [files, selectedFile]);
  return { files, index, loading, truncated };
}
