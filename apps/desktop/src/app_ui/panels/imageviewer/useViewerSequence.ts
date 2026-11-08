/**
 * 图像查看器：胶片栏的**浏览序列**（当前图像所属的相册或源，顺序与媒体预览一致）。
 *
 * 来源优先级与媒体预览面板**同一条口径**：
 *
 * 1. 选中了相册（`app.albumId`）→ `album.members` 的可见成员；
 * 2. 否则选中了源/子目录（`app.sourceId` / `app.dirPath`）→ `file.query` 按同一过滤条件；
 * 3. 都没有 → 全仓库图像（面板可独立打开，不该是空壳）。
 *
 * **排序与媒体预览同一份有效值**（缺陷 0039 / D144）：后端查询顺序固定为
 * `(relative_path, source_id, id)` 升序（D78 键集游标，没有排序参数），媒体预览的
 * 「名称/时间/大小/类型 × 正序/倒序」是**前端排序**（设置缺省 + 工具条会话覆盖）。
 * 本面板读**同一批设置键**（`panel.media.sortKey` / `sortDir`，四条热加载触发源）
 * 并叠加**同一个会话覆盖 store**（`core/mediaSortStore.ts`），再经**同一个纯函数**
 * `sortFiles` 排序——用户在媒体预览里改成「名称·倒序」，胶片栏必须跟着倒序，
 * 而不是继续按查询顺序正序排列。
 *
 * 两点**有意选择**（不是遗漏）：
 * - 序列只取 `media_type = image`：本面板是**图像**查看器，夹带视频/音频会让
 *   上一张/下一张跳到无法显示的文件上；过滤是**保序子序列**，"顺序与来源一致"仍成立。
 * - 分页读到 `VIEWER_MAX_FILES` 为止：`file.query` 与 `album.members` 单页上限都是 1000，
 *   两者都按**游标分页**取（缺陷 0018 后相册也有游标了）。命中上限时 `truncated = true`，
 *   信息栏如实标注，**不假装是全部**。排序作用于已取到的序列（截断时即前 N 张的排序）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { usePanelSettingValue } from "../../shared/settingValue";
import {
  getMediaSortSession,
  subscribeMediaSort,
} from "../../core/mediaSortStore";
import type { FileItem } from "../../shared/types";
import type { AppContextValue } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import {
  isMediaSortKey,
  isSortDirection,
  MEDIA_PANEL_ID,
  sortFiles,
} from "../mediaPreviewView";

/** `file.query` 单页条数（后端上限也是 1000）。 */
export const VIEWER_PAGE_LIMIT = 1000;

/** 胶片栏最多加载的图像数（两页）。 */
export const VIEWER_MAX_FILES = 2000;

/** 序列的归属类型（信息栏据此标注来源）。 */
export type ViewerScopeKind = "album" | "source" | "repo";

export interface ViewerSequence {
  /** 序列归属（相册 / 源或子目录 / 全仓库）。 */
  kind: ViewerScopeKind;
  /** 按媒体预览的有效排序（设置缺省 + 会话覆盖）排列的图像。 */
  files: FileItem[];
  /** 当前图像在 `files` 中的下标；`-1` = 不在序列内。 */
  index: number;
  loading: boolean;
  /** 命中 `VIEWER_MAX_FILES` 上限（序列只覆盖来源的前 N 张）。 */
  truncated: boolean;
}

/** 浏览序列的过滤条件（从应用上下文取，纯数据、无 React 依赖）。 */
export interface ViewerScope {
  repoId: string;
  albumId: string | null;
  sourceId: string | null;
  dirPath: string | null;
}

/** 从应用上下文解析当前浏览范围（无仓库 → `null`）。 */
export function viewerScopeOf(app: AppContextValue): ViewerScope | null {
  if (!app.repoId) return null;
  return {
    repoId: app.repoId,
    albumId: app.albumId,
    sourceId: app.sourceId,
    dirPath: app.dirPath,
  };
}

/** 范围类型（相册优先，其次源，最后全仓库）。 */
export function scopeKindOf(scope: ViewerScope): ViewerScopeKind {
  if (scope.albumId) return "album";
  if (scope.sourceId || scope.dirPath) return "source";
  return "repo";
}

/** 只保留图像（面板语义，见文件头注释）。 */
function imagesOnly(files: readonly FileItem[]): FileItem[] {
  return files.filter((f) => f.media_type === "image");
}

/**
 * 读取浏览序列（相册成员 / 源或子目录 / 全仓库）。
 *
 * 抛错由调用方处理（面板降级为空序列 + 状态栏提示），此处不做静默兜底。
 */
export async function loadViewerFiles(
  scope: ViewerScope,
): Promise<{ files: FileItem[]; truncated: boolean }> {
  if (scope.albumId) {
    // 相册成员改为**游标分页**（缺陷 0018）：旧实现一次性取回全部成员，
    // 大相册会把全部行读进内存。这里翻页取到 `VIEWER_MAX_FILES` 为止，
    // 超过上限即如实标注 `truncated`（不假装是全部）。
    const files: FileItem[] = [];
    let cursor: string | null = null;
    let truncated = false;
    do {
      const page = await api.albumMembers({
        repoId: scope.repoId,
        albumId: scope.albumId,
        cursor,
        limit: VIEWER_PAGE_LIMIT,
      });
      // 只保留图像（保序子序列）：本面板是图像查看器。
      files.push(...imagesOnly(page.items));
      cursor = page.nextCursor;
      if (files.length >= VIEWER_MAX_FILES) {
        truncated = cursor !== null || files.length > VIEWER_MAX_FILES;
        break;
      }
    } while (cursor);
    return { files: files.slice(0, VIEWER_MAX_FILES), truncated };
  }

  const files: FileItem[] = [];
  let cursor: string | null = null;
  let truncated = false;
  do {
    const page = await api.fileQuery({
      repoId: scope.repoId,
      filter: {
        mediaTypes: ["image"],
        sourceId: scope.sourceId ?? undefined,
        dirPrefix: scope.dirPath ?? undefined,
      },
      cursor,
      limit: VIEWER_PAGE_LIMIT,
    });
    files.push(...page.items);
    cursor = page.nextCursor;
    if (files.length >= VIEWER_MAX_FILES) {
      truncated = cursor !== null || files.length > VIEWER_MAX_FILES;
      break;
    }
  } while (cursor);
  return { files: files.slice(0, VIEWER_MAX_FILES), truncated };
}

/**
 * 当前图像在序列中的下标：先按 `id`，再按 `(source_id, relative_path)` 兜底
 * ——重新扫描后 file id 可能变化，而图像仍在同一来源的同一路径上。
 */
export function indexOfSelected(files: readonly FileItem[], file: FileItem | null): number {
  if (!file) return -1;
  const byId = files.findIndex((f) => f.id === file.id);
  if (byId >= 0) return byId;
  return files.findIndex(
    (f) => f.source_id === file.source_id && f.relative_path === file.relative_path,
  );
}

/**
 * 加载并跟踪浏览序列（仓库 / 相册 / 源 / 子目录 / 刷新计数变化即重载）。
 *
 * 排序**不进重载依赖**：排序是前端纯函数（`sortFiles`），改排序只重排已取到的
 * `files`（`useMemo`），不得重发游标请求——与媒体预览 `mediaPreviewData.ts` 的
 * "取数依赖不含排序"同一口径。
 *
 * `panelApi` 用于设置热加载第 4 条触发源（面板从后台标签回到前台补读）；
 * 不传也能工作（少一条触发源）。
 */
export function useViewerSequence(
  app: AppContextValue,
  panelApi?: PanelRenderCtx["api"],
): ViewerSequence {
  const { repoId, albumId, sourceId, dirPath, refreshKey, selectedFile, status, t } = app;
  const [rawFiles, setRawFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  // 媒体预览的排序设置缺省（同一批落库键、同一份声明归一化与四条热加载触发源）。
  const defaultSortKey = usePanelSettingValue(MEDIA_PANEL_ID, "sortKey", panelApi);
  const defaultSortDir = usePanelSettingValue(MEDIA_PANEL_ID, "sortDir", panelApi);
  // 媒体预览工具条的会话覆盖（同一份 store：面板里改「名称·倒序」这里立刻跟着变）。
  const sortSession = useSyncExternalStore(subscribeMediaSort, getMediaSortSession, getMediaSortSession);
  const sortKey = sortSession.key ?? (isMediaSortKey(defaultSortKey) ? defaultSortKey : "name");
  const sortDir = sortSession.dir ?? (isSortDirection(defaultSortDir) ? defaultSortDir : "asc");

  useEffect(() => {
    if (!repoId) {
      setRawFiles([]);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await loadViewerFiles({ repoId, albumId, sourceId, dirPath });
        if (cancelled) return;
        setRawFiles(result.files);
        setTruncated(result.truncated);
      } catch (e) {
        if (cancelled) return;
        setRawFiles([]);
        setTruncated(false);
        status(t("imageviewer.sequenceFailed", { err: errorTextOf(t, e) }), "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, albumId, sourceId, dirPath, refreshKey, status, t]);

  // 与媒体预览同一个纯函数、同一份有效排序（缺陷 0039）：不得在这里另写比较器。
  const files = useMemo(
    () => sortFiles(rawFiles, sortKey, sortDir),
    [rawFiles, sortKey, sortDir],
  );

  const kind = useMemo(
    () => scopeKindOf({ repoId: repoId ?? "", albumId, sourceId, dirPath }),
    [repoId, albumId, sourceId, dirPath],
  );
  const index = useMemo(() => indexOfSelected(files, selectedFile), [files, selectedFile]);

  return { kind, files, index, loading, truncated };
}
