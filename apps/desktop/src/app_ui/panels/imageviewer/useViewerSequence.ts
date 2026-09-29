/**
 * 图像查看器：胶片栏的**浏览序列**（当前图像所属的相册或源，顺序与之保持一致）。
 *
 * 来源优先级与媒体预览面板**同一条口径**：
 *
 * 1. 选中了相册（`app.albumId`）→ `album.members` 的可见成员；
 * 2. 否则选中了源/子目录（`app.sourceId` / `app.dirPath`）→ `file.query` 按同一过滤条件；
 * 3. 都没有 → 全仓库图像（面板可独立打开，不该是空壳）。
 *
 * 两点**有意选择**（不是遗漏）：
 * - 序列只取 `media_type = image`：本面板是**图像**查看器，夹带视频/音频会让
 *   上一张/下一张跳到无法显示的文件上；过滤是**保序子序列**，"顺序与相册/源一致"仍成立。
 * - 分页读到 `VIEWER_MAX_FILES` 为止：`file.query` 单页上限 1000（后端 `FILE_QUERY_MAX_LIMIT`），
 *   相册成员无分页。命中上限时 `truncated = true`，信息栏如实标注，**不假装是全部**。
 */

import { useEffect, useMemo, useState } from "react";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import type { FileItem } from "../../shared/types";
import type { AppContextValue } from "../../core/AppContext";

/** `file.query` 单页条数（后端上限也是 1000）。 */
export const VIEWER_PAGE_LIMIT = 1000;

/** 胶片栏最多加载的图像数（两页）。 */
export const VIEWER_MAX_FILES = 2000;

/** 序列的归属类型（信息栏据此标注来源）。 */
export type ViewerScopeKind = "album" | "source" | "repo";

export interface ViewerSequence {
  /** 序列归属（相册 / 源或子目录 / 全仓库）。 */
  kind: ViewerScopeKind;
  /** 按来源顺序排列的图像。 */
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
    const members = await api.albumMembers({ repoId: scope.repoId, albumId: scope.albumId });
    const files = imagesOnly(members);
    // 相册成员无分页：超过上限是真实截断，必须如实标注。
    return files.length > VIEWER_MAX_FILES
      ? { files: files.slice(0, VIEWER_MAX_FILES), truncated: true }
      : { files, truncated: false };
  }

  const files: FileItem[] = [];
  let cursor: string | null = null;
  let truncated = false;
  do {
    const page = await api.fileQuery({
      repoId: scope.repoId,
      filter: {
        mediaType: "image",
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

/** 加载并跟踪浏览序列（仓库 / 相册 / 源 / 子目录 / 刷新计数变化即重载）。 */
export function useViewerSequence(app: AppContextValue): ViewerSequence {
  const { repoId, albumId, sourceId, dirPath, refreshKey, selectedFile, status, t } = app;
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!repoId) {
      setFiles([]);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await loadViewerFiles({ repoId, albumId, sourceId, dirPath });
        if (cancelled) return;
        setFiles(result.files);
        setTruncated(result.truncated);
      } catch (e) {
        if (cancelled) return;
        setFiles([]);
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

  const kind = useMemo(
    () => scopeKindOf({ repoId: repoId ?? "", albumId, sourceId, dirPath }),
    [repoId, albumId, sourceId, dirPath],
  );
  const index = useMemo(() => indexOfSelected(files, selectedFile), [files, selectedFile]);

  return { kind, files, index, loading, truncated };
}
