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
 * - **整个来源翻到末页，无条目上限**（缺陷 0018 余留项，D146）：`file.query` 与
 *   `album.members` 都按游标分页取，翻页纯逻辑与媒体预览**同一个** `drainPages`
 *   （首屏第一页到手即出图，其余页后台继续；游标严格前进 + 页数上限兜底循环安全）。
 *   为什么必须后台翻完而不是"滚到哪取到哪"：排序是**前端**的（D144），只有取完
 *   整个来源，"名称·倒序"才代表全库。`loading` 期间序列只是已取到的部分，
 *   信息栏如实提示"载入中"，不假装是全部；防御性停手（游标写坏 / 页数触顶）时
 *   `truncated = true` 同样如实标注——那是**异常兜底**，不是产品上限。
 *   排序作用于已取到的序列（与媒体预览同一口径：首屏先出、翻完后代表全库）。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
import { drainPages, type MediaPreviewPageFetcher } from "../mediaPreviewPaging";

/** `file.query` 单页条数（后端上限也是 1000）。 */
export const VIEWER_PAGE_LIMIT = 1000;

/** 序列的归属类型（信息栏据此标注来源）。 */
export type ViewerScopeKind = "album" | "source" | "repo";

export interface ViewerSequence {
  /** 序列归属（相册 / 源或子目录 / 全仓库）。 */
  kind: ViewerScopeKind;
  /** 按媒体预览的有效排序（设置缺省 + 会话覆盖）排列的图像。 */
  files: FileItem[];
  /** 当前图像在 `files` 中的下标；`-1` = 不在序列内。 */
  index: number;
  /** 仍在后台翻页：此时 `files` 只是已取到的部分，排序还不代表全库。 */
  loading: boolean;
  /** 防御性停手（游标不前进 / 页数触顶）：序列不完整，信息栏如实标注。 */
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
 * 读取浏览序列（相册成员 / 源或子目录 / 全仓库）——**整个来源翻到末页**。
 *
 * 翻页复用媒体预览的 `drainPages`（缺陷 0018 P1-A 先例，D146 接通到查看器）：
 * 首屏第一页经 `onPage` 立即交给调用方出图，其余页后台继续；取消 / 游标不前进 /
 * 页数触顶的循环安全都在那一处，这里不再自写第二套 do/while。
 * `truncated` 只在**防御性停手**（`complete === false` 且未被取消）时为真——
 * 它是异常兜底的如实标注，不是产品上限（产品上限已取消）。
 *
 * 抛错由调用方处理（面板降级为空序列 + 状态栏提示），此处不做静默兜底。
 */
export async function loadViewerFiles(
  scope: ViewerScope,
  options: {
    /** 首屏回调：第一页（图像子序列）到手即调用，不等全部翻完。 */
    onFirstPage?: (files: FileItem[]) => void;
    /** 取消判据：卸载 / 换来源后返回 `true`，翻页在下一个检查点停止。 */
    isCancelled?: () => boolean;
  } = {},
): Promise<{ files: FileItem[]; truncated: boolean }> {
  const { onFirstPage, isCancelled } = options;
  // 相册成员自缺陷 0018 起与 file.query 同形（游标分页）；相册要在前端滤图像
  //（成员查询不带媒体类型过滤），源/全库路径直接把 image 过滤下推给后端。
  const fetchPage: MediaPreviewPageFetcher<FileItem> = scope.albumId
    ? (cursor) =>
        api.albumMembers({
          repoId: scope.repoId,
          albumId: scope.albumId as string,
          cursor,
          limit: VIEWER_PAGE_LIMIT,
        })
    : (cursor) =>
        api.fileQuery({
          repoId: scope.repoId,
          filter: {
            mediaTypes: ["image"],
            sourceId: scope.sourceId ?? undefined,
            dirPrefix: scope.dirPath ?? undefined,
          },
          cursor,
          limit: VIEWER_PAGE_LIMIT,
        });

  // 进度刷新**只在首屏那一次**（媒体预览同款教训，缺陷 0018 P1-A 收尾自审 #2）：
  // 每次落地都会触发 O(n log n) 的前端全量排序，逐页刷新 = 5 万张期间上百次
  // 递增重排、合计秒级主线程阻塞。首屏先出图，其余等翻完一次性落地。
  let firstPageRendered = false;
  const drained = await drainPages<FileItem>(fetchPage, {
    onPage: (_added, accumulated) => {
      if (firstPageRendered) return;
      firstPageRendered = true;
      if (isCancelled?.()) return;
      onFirstPage?.(imagesOnly(accumulated));
    },
    isCancelled,
  });

  // 只保留图像（保序子序列）：本面板是图像查看器。file.query 路径后端已滤过，
  // 再滤一次是幂等的；相册路径靠这一步兑现"图像子序列"语义。
  const files = imagesOnly(drained);
  return { files, truncated: !drained.complete && !(isCancelled?.() ?? false) };
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
  /** 取数世代号：后台翻页可能上百次往返，旧世代必须在下一个检查点自行退出。 */
  const generationRef = useRef(0);
  // 状态回调只要"最新实现"，不进重载依赖（否则宿主上下文一换身份就重取整个来源）。
  const statusRef = useRef(status);
  statusRef.current = status;
  const tRef = useRef(t);
  tRef.current = t;

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
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    const isCancelled = () => generationRef.current !== generation;
    // 换来源先清旧序列：新来源第一页到达前不挂着上一个相册的缩略图
    //（后台翻页期间旧序列一直可见正是"看起来没换源"的观感来源）。
    setRawFiles([]);
    setLoading(true);
    setTruncated(false);
    void (async () => {
      try {
        const result = await loadViewerFiles(
          { repoId, albumId, sourceId, dirPath },
          {
            // 首屏第一页到手即出图（不等全库翻完）。
            onFirstPage: (files) => {
              if (!isCancelled()) setRawFiles(files);
            },
            isCancelled,
          },
        );
        if (isCancelled()) return;
        setRawFiles(result.files);
        setTruncated(result.truncated);
      } catch (e) {
        if (isCancelled()) return;
        setRawFiles([]);
        setTruncated(false);
        statusRef.current(
          tRef.current("imageviewer.sequenceFailed", { err: errorTextOf(tRef.current, e) }),
          "error",
        );
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    })();
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [repoId, albumId, sourceId, dirPath, refreshKey]);

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
