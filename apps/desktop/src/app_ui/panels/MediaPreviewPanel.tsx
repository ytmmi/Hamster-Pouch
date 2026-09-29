/**
 * 媒体预览面板。
 *
 * 顶部左侧是**模式**切换（「预览图」/「文件名」）；右侧是**视图**与**排序**两个下拉。
 *
 * ## 视图（只在「预览图」模式下有效）
 *
 * - **平铺**（`tile`）：单元格**宽度固定**、缩略图统一**方形并裁剪填满**（`cover`）；
 * - **自适应**（`adaptive`，缺省）：单元格宽度**随面板宽度伸展**、缩略图按**自身宽高比完整显示**；
 * - **瀑布流**（`masonry`）：**固定列宽**、**行高随图像宽高比**变化的多列排布。
 *
 * 三者的取值域、判定与列分配都在 `mediaPreviewView.ts`（纯函数、无框架依赖，
 * 门禁可直接 import 断言），本文件只负责渲染。切到「文件名」模式时视图下拉**置灰**
 * ——它只改变缩略图的排布方式。
 *
 * ## 排序
 *
 * 排序键（名称 / 时间 / 大小 / 类型）与方向（正序 / 倒序，下拉里由一条横线分隔）
 * 对两种模式同时生效。排序是**前端**的：只作用于面板**已加载**的那一页
 * （`file.query` 的 `limit`），后端的查询顺序是分页游标的基准（D78），不在这里改。
 *
 * ## 视图与排序的缺省值来自**面板设置**
 *
 * 声明在 `packages/config/src/panels.ts` 的 `media.settings`（「全部设置 → 面板 → 媒体预览」），
 * 读取与热加载走 `shared/settingValue.ts` 的四条触发源。面板右上角的下拉是**本会话内**的
 * 临时覆盖（模块级变量，与滚动位置同一口径：面板被 dockview 卸载重建后仍保持）。
 * 用户在「全部设置」里改动该项时**放弃**本次会话的覆盖——否则就是
 * `docs/spec/panel-standard.md` 点名的那类缺陷："改了设置没反应"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { panelSettingStorageKey, resolveSizeUnit, SETTING_KEYS } from "@hamster-pouch/config";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { formatByteSize } from "../shared/format";
import { usePanelForeground } from "../shared/panelForeground";
import {
  useHostSettingValue,
  usePanelSettingValue,
  usePanelSwitch,
} from "../shared/settingValue";
import { useApp } from "../core/AppContext";
import { subscribeSettingChanged } from "../core/settingChangeStore";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { ContextMenu } from "../menu/ContextMenu";
import type { TranslationKey } from "../i18n";
import type { FileItem, SourceItem } from "../shared/types";
import { ThumbCell } from "./mediaPreviewCell";
import { ToolbarDropdown, type DropdownOption } from "./mediaPreviewDropdown";
import {
  MEDIA_IMAGE_SIZE_MAX,
  MEDIA_IMAGE_SIZE_MIN,
  MEDIA_IMAGE_SIZE_STEP,
  MEDIA_PANEL_ID,
  MEDIA_SORT_KEYS,
  MEDIA_VIEW_MODES,
  MASONRY_GAP,
  SORT_DIRECTIONS,
  clampImageSize,
  distributeColumns,
  fileName,
  isMediaSortKey,
  isMediaViewMode,
  isSortDirection,
  masonryColumnCount,
  mediaViewClass,
  sortFiles,
  type MediaSortKey,
  type MediaViewMode,
  type SortDirection,
} from "./mediaPreviewView";

/** 模式：预览图（三种视图）/ 文件名列表。 */
type ViewMode = "thumb" | "name";
type TypeFilter = "all" | "image" | "video" | "audio";

/** 面板设置的落库键（`panel.media.<key>`；声明见 `packages/config/src/panels.ts`）。 */
const VIEW_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "view");
const IMAGE_SIZE_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "imageSize");
const SORT_KEY_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "sortKey");
const SORT_DIR_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "sortDir");

/**
 * 跨挂载保存面板内选择：面板被 dockview 卸载重建时也能恢复浏览进度与排布方式。
 *
 * `session*` 为 `null` = 跟随面板设置（注册表缺省或用户在「全部设置」里的选择）。
 */
let savedThumbScroll = 0;
let savedNameScroll = 0;
let sessionView: MediaViewMode | null = null;
let sessionImageSize: number | null = null;
let sessionSortKey: MediaSortKey | null = null;
let sessionSortDir: SortDirection | null = null;

/** 视图 / 排序键 / 方向 → i18n 键（与注册表候选的 `title_key` 同形）。 */
function viewLabelKey(view: MediaViewMode): TranslationKey {
  return `media.settings.view.${view}`;
}
function sortKeyLabelKey(key: MediaSortKey): TranslationKey {
  return `media.settings.sortKey.${key}`;
}
function sortDirLabelKey(dir: SortDirection): TranslationKey {
  return `media.settings.sortDir.${dir}`;
}

/** 拼接本地绝对路径（按 base 的分隔符风格）。 */
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const normalized = rel.replace(/[\\/]/g, sep);
  return base.endsWith(sep) ? `${base}${normalized}` : `${base}${sep}${normalized}`;
}

/**
 * 把"每帧都会换身份"的回调收敛为**恒定引用**，好让 `ThumbCell` 的 `memo` 真正生效。
 *
 * 为什么需要它：`app` 上下文对象在**每次选中变化**时都会换身份，于是依赖 `app` 的
 * `useCallback` 也全部换身份——300 个单元的 props 逐个"变了"，`memo` 形同虚设。
 * 这里把最新实现放进 ref、对外只暴露一个恒定引用；单元只在 `selected` 真的变化时重渲。
 * 语义与直接传原函数**完全一致**（调用时读的是最新实现，不存在闭包过期）。
 */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** 右键上下文菜单位置与目标文件。 */
interface ContextMenuState {
  x: number;
  y: number;
  file: FileItem;
}

export interface MediaPreviewPanelProps {
  /**
   * dockview 面板 API（可选）。
   *
   * 用途只有一个：面板从后台标签回到前台时补读一次面板设置——用户在后台标签期间改了
   * 缺省视图/排序，切回来必须已经生效。独立单面板窗口传的是恒激活替身，同样可用。
   */
  api?: PanelRenderCtx["api"];
}

export function MediaPreviewPanel({ api: panelApi }: MediaPreviewPanelProps = {}): JSX.Element {
  const app = useApp();
  const [viewMode, setViewMode] = useState<ViewMode>("thumb");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 右键上下文菜单状态（null=关闭）
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // 内联重命名输入状态
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  // 面板设置的**缺省**视图/尺寸/排序：`usePanelSettingValue` 已按声明归一化
  // （非法取值回落缺省），并带四条独立热加载触发源。
  const defaultView = usePanelSettingValue(MEDIA_PANEL_ID, "view", panelApi);
  const defaultImageSize = usePanelSettingValue(MEDIA_PANEL_ID, "imageSize", panelApi);
  const defaultSortKey = usePanelSettingValue(MEDIA_PANEL_ID, "sortKey", panelApi);
  const defaultSortDir = usePanelSettingValue(MEDIA_PANEL_ID, "sortDir", panelApi);
  // 开关型面板设置（缩略图下是否显示文件名）：读法与查看器的信息栏开关同款。
  const showFileName = usePanelSwitch(MEDIA_PANEL_ID, "showFileName", { api: panelApi });
  /**
   * **后台标签冻结**：面板内容被同组别的标签盖住时不渲染条目容器（下面三个分支都带这个条件）。
   *
   * 判据只看 `isVisible`（= 本面板是所在组的**激活标签**）；**不能**加 `isActive`
   * ——那表示"本组也是当前聚焦的组"，用户点媒体源/相册时它会变 false，于是"点源不刷新、
   * 非得点一下媒体预览才显示"（实测缺陷，详见 `shared/panelForeground.ts` 的说明）。
   *
   * dockview 会把被盖住的标签组件留在 DOM 里（本面板还被设成 `renderer: "always"`，
   * 为的是切换 tab 不丢滚动位置），于是它会继续参与每一次选中变更的渲染、继续为离屏单元
   * 请求缩略图与解码波形——都是用户看不到的纯浪费。冻结后这部分成本只剩工具栏那一行；
   * 切回该标签时重新渲染（缩略图/波形都有共享缓存），滚动位置由模块级变量恢复。
   */
  const foreground = usePanelForeground(panelApi);
  /**
   * 体积单位制是**宿主设置**（全部设置 → 界面 → 其他设置 → 体积单位），元数据面板已在用；
   * 列表视图这里只**消费**同一份口径（`formatByteSize` + `resolveSizeUnit`），
   * **不**自带同名面板设置——两套单位解析必然漂移（`docs/spec/panel-standard.md` 第 5.3 节）。
   */
  const sizeUnit = resolveSizeUnit(useHostSettingValue(SETTING_KEYS.sizeUnit, panelApi));

  // 本会话内的覆盖（`null` = 跟随面板设置）；初值取自模块级变量，跨面板重建保持。
  const [viewOverride, setViewOverride] = useState<MediaViewMode | null>(() => sessionView);
  const [imageSizeOverride, setImageSizeOverride] = useState<number | null>(
    () => sessionImageSize,
  );
  const [sortKeyOverride, setSortKeyOverride] = useState<MediaSortKey | null>(
    () => sessionSortKey,
  );
  const [sortDirOverride, setSortDirOverride] = useState<SortDirection | null>(
    () => sessionSortDir,
  );

  const view: MediaViewMode =
    viewOverride ?? (isMediaViewMode(defaultView) ? defaultView : "adaptive");
  /** 图片尺寸（px）：平铺 / 瀑布流 = 单元格宽度，自适应 = 行高。范围由面板夹紧。 */
  const imageSize = clampImageSize(imageSizeOverride ?? defaultImageSize);
  const sortKey: MediaSortKey =
    sortKeyOverride ?? (isMediaSortKey(defaultSortKey) ? defaultSortKey : "name");
  const sortDir: SortDirection =
    sortDirOverride ?? (isSortDirection(defaultSortDir) ? defaultSortDir : "asc");

  /**
   * 用户在「全部设置」里显式改动了本面板的设置 → **放弃**本会话的手动覆盖。
   *
   * 只认「本窗口的显式写入」这一条通路（本地广播携带落库键），不做"缺省值变了就清覆盖"
   * 的推断：后者会在面板重建时（设置异步读回、首帧还是声明缺省）把用户刚选的视图抹掉。
   */
  useEffect(
    () =>
      subscribeSettingChanged((key) => {
        if (key === VIEW_STORAGE_KEY) {
          sessionView = null;
          setViewOverride(null);
        } else if (key === IMAGE_SIZE_STORAGE_KEY) {
          sessionImageSize = null;
          setImageSizeOverride(null);
        } else if (key === SORT_KEY_STORAGE_KEY) {
          sessionSortKey = null;
          setSortKeyOverride(null);
        } else if (key === SORT_DIR_STORAGE_KEY) {
          sessionSortDir = null;
          setSortDirOverride(null);
        }
      }),
    [],
  );

  /** 面板内选视图（本会话内记住）。 */
  const chooseView = useCallback((next: string) => {
    if (!isMediaViewMode(next)) return;
    sessionView = next;
    setViewOverride(next);
  }, []);

  /** 面板内拖滑条改图片尺寸（本会话内记住）。 */
  const chooseImageSize = useCallback((next: number) => {
    const clamped = clampImageSize(next);
    sessionImageSize = clamped;
    setImageSizeOverride(clamped);
  }, []);

  /** 面板内选排序：排序键与方向共用一个下拉（`value` 决定改哪一项）。 */
  const chooseSort = useCallback((next: string) => {
    if (isMediaSortKey(next)) {
      sessionSortKey = next;
      setSortKeyOverride(next);
    } else if (isSortDirection(next)) {
      sessionSortDir = next;
      setSortDirOverride(next);
    }
  }, []);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setFiles([]);
      setSources([]);
      return;
    }
    try {
      const [page, srcs] = await Promise.all([
        app.albumId
          ? api.albumMembers({ repoId: app.repoId, albumId: app.albumId })
          : api
              .fileQuery({
                repoId: app.repoId,
                filter: {
                  sourceId: app.sourceId ?? undefined,
                  dirPrefix: app.dirPath ?? undefined,
                  mediaType: typeFilter === "all" ? undefined : typeFilter,
                },
                limit: 300,
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

  // 预览图模式（网格 / 瀑布流共用同一容器引用）：恢复并跟踪滚动位置
  useEffect(() => {
    if (viewMode !== "thumb") return;
    const el = gridRef.current;
    if (!el) return;
    el.scrollTop = savedThumbScroll;
    const onScroll = () => {
      savedThumbScroll = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // `foreground`：后台冻结时容器不存在，切回前台后要重新挂监听并恢复滚动位置。
  }, [viewMode, view, foreground, app.repoId, files.length > 0]);

  // 列表模式：恢复并跟踪滚动位置
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = savedNameScroll;
    const onScroll = () => {
      savedNameScroll = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, foreground, app.repoId, files.length > 0]);

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

  /**
   * 瀑布流列数（按容器宽度与**图片尺寸**算，`ResizeObserver` 跟随面板尺寸变化）。
   * 只在瀑布流视图下测量：其余视图不需要 JS 参与布局。
   * `foreground` 入依赖：后台冻结时容器不在 DOM 里、观察器也没跑，切回来要重新量一次
   * （否则隐藏期间面板被调整过尺寸，列数会是旧的）。
   */
  const [masonryColumns, setMasonryColumns] = useState(1);
  useEffect(() => {
    if (view !== "masonry" || viewMode !== "thumb") return;
    const el = gridRef.current;
    if (!el) return;
    const measure = () =>
      setMasonryColumns(masonryColumnCount(el.clientWidth, imageSize, MASONRY_GAP));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view, viewMode, foreground, imageSize, app.repoId, items.length > 0]);

  /**
   * 图片尺寸以 **CSS 变量**下发（`--mp-image-size`），三种视图各自消费：
   * 平铺 = `grid-template-columns`、瀑布流 = 列宽 `flex-basis`、自适应 = 缩略图**行高**。
   * 一处设置、三种排布同一口径，也就不会再出现"瀑布流比平铺宽一大截"。
   */
  const containerStyle = useMemo(
    () => ({ "--mp-image-size": `${imageSize}px` }) as CSSProperties,
    [imageSize],
  );

  /** 分到各列的条目（保持从左到右的序号顺序；见 `distributeColumns` 的口径说明）。 */
  const columns = useMemo(
    () => distributeColumns(items, masonryColumns),
    [items, masonryColumns],
  );

  const repoId = app.repoId;
  const setSelectedIds = app.setSelectedIds;
  // Shift 范围选择的锚点（上一次点击项，随面板实例保存）。
  const anchorRef = useRef<string | null>(null);
  // selection_change 异步取 context 的过期令牌：只让最后一次选中上报生效。
  const selectionTokenRef = useRef(0);

  // 切换仓库或筛选（列表内容变化）时清空多选，避免残留失效选择。
  useEffect(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, [app.repoId, typeFilter, setSelectedIds]);

  /**
   * 选中变化上报蓝图引擎（RFC 0007 实现期开放点）：`selection_change` 事件源，
   * 并携带 `rating >=` / `has_tag ==` 条件求值所需的运行时 context（评分 + 人工/自动 tag 名）。
   * context 是异步取的，故用令牌丢弃过期响应，避免快速切换选中时旧结果误触发规则。
   */
  const dispatchSelectionChange = useCallback(
    (file: FileItem) => {
      if (!app.repoId) {
        return;
      }
      const token = ++selectionTokenRef.current;
      const currentRepo = app.repoId;
      void (async () => {
        let rating: number | undefined;
        let tags: string[] | undefined;
        try {
          const [r, tagResult] = await Promise.all([
            api.ratingGet({ repoId: currentRepo, fileId: file.id }),
            api.tagForFile({ repoId: currentRepo, fileId: file.id }),
          ]);
          rating = r ?? undefined;
          tags = [...tagResult.manual, ...tagResult.auto].map((t) => t.name);
        } catch {
          // context 取不到时按缺失处理（rating/has_tag 条件求值为 false，不阻塞选中上报）。
        }
        if (token !== selectionTokenRef.current) {
          return;
        }
        app.dispatch({
          trigger: "selection_change",
          target: { mediaType: file.media_type, fileId: file.id },
          context: { rating, tags },
        });
      })();
    },
    [app],
  );

  /**
   * 点击选择：
   * - 无修饰：单选（清空其余）；
   * - Shift+左键：从锚点到当前项的连续范围多选（类似资源管理器）；
   * - Ctrl/Cmd+左键：切换单项选中。
   */
  const handleSelect = useCallback(
    (file: FileItem, mods: { shift: boolean; ctrl: boolean }) => {
      const next = new Set(app.selectedIds);
      // 锚点缺失（如面板重建）时回退到全局主选中项。
      const anchor = anchorRef.current ?? app.selectedFile?.id ?? null;
      if (mods.shift && anchor) {
        const from = items.findIndex((it) => it.file.id === anchor);
        const to = items.findIndex((it) => it.file.id === file.id);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          next.clear();
          for (let i = start; i <= end; i += 1) {
            next.add(items[i].file.id);
          }
          app.setSelectedIds(next);
          app.setSelectedFile(file);
          dispatchSelectionChange(file);
          return;
        }
      }
      if (mods.ctrl) {
        if (next.has(file.id)) {
          next.delete(file.id);
        } else {
          next.add(file.id);
        }
        anchorRef.current = file.id;
        app.setSelectedIds(next);
        app.setSelectedFile(file);
        dispatchSelectionChange(file);
        return;
      }
      anchorRef.current = file.id;
      app.setSelectedIds(new Set([file.id]));
      app.setSelectedFile(file);
      dispatchSelectionChange(file);
      // 单击事件上报蓝图引擎（默认蓝图无单击规则，行为不变；用户蓝图可响应）。
      app.dispatch({
        trigger: "click",
        target: { mediaType: file.media_type, fileId: file.id },
      });
    },
    [app, items, dispatchSelectionChange],
  );

  /** 双击上报（默认蓝图据此切换查看器 / 播放器）。 */
  const handleDoubleClick = useCallback(
    (file: FileItem) => {
      app.dispatch({
        trigger: "double_click",
        target: { mediaType: file.media_type, fileId: file.id },
      });
    },
    [app],
  );
  const selectedCount = useMemo(
    () => items.reduce((n, it) => (app.selectedIds.has(it.file.id) ? n + 1 : n), 0),
    [items, app.selectedIds],
  );

  // 右键菜单：点击外部或按 Esc 关闭（镜像 AlbumPanel / SourcePanel 模式）
  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
      setRenaming(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /**
   * 拖拽起始：若拖拽项不在当前选中集合内，先单选它，
   * 再将选中集序列化为 dataTransfer 载荷。
   */
  const handleDragStart = useCallback(
    (file: FileItem, e: DragEvent) => {
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
      // 载荷 = 拖拽后的选中集（单选时为 [file.id]，否则为现有选中集）
      const payload = app.selectedIds.has(file.id)
        ? [...app.selectedIds]
        : [file.id];
      e.dataTransfer.setData("application/x-hp-files", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    },
    [app],
  );

  /**
   * 右键菜单：未选中项先单选，已选中则保持多选；
   * 在光标位置打开自定义上下文菜单。
   */
  const handleContextMenu = useCallback(
    (file: FileItem, e: ReactMouseEvent) => {
      e.preventDefault();
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
      setMenu({ x: e.clientX, y: e.clientY, file });
    },
    [app],
  );

  /**
   * 删除选中文件：
   * - 相册上下文 → 移出相册（albumRemoveMember）；
   * - 源/目录上下文 → 移入系统回收站（fileTrash）。
   * 完成后清空选中集并刷新。
   */
  const handleDelete = useCallback(async () => {
    if (!app.repoId || app.selectedIds.size === 0) return;
    setMenu(null);
    const fileIds = [...app.selectedIds];
    try {
      if (app.albumId) {
        const r = await api.albumRemoveMember({
          repoId: app.repoId,
          albumId: app.albumId,
          fileIds,
        });
        app.status(app.t("media.removedFromAlbum", { count: r.removed }), "ok");
      } else {
        const n = await api.fileTrash({ repoId: app.repoId, fileIds });
        app.status(app.t("media.trashed", { count: n }), "ok");
      }
      app.setSelectedIds(new Set());
      app.refresh();
    } catch (e) {
      app.status(app.t("media.deleteFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app]);

  /** 确认内联重命名：调用 fileRename，成功后刷新。 */
  const confirmRename = useCallback(async () => {
    if (!menu || !app.repoId) return;
    const newName = renameValue.trim();
    if (!newName) {
      app.status(app.t("media.nameRequired"), "error");
      return;
    }
    try {
      await api.fileRename({
        repoId: app.repoId,
        fileId: menu.file.id,
        newName,
      });
      app.status(app.t("media.renamed"), "ok");
      app.refresh();
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
    }
    setRenaming(false);
    setMenu(null);
  }, [menu, renameValue, app]);

  /** 复制单个文件绝对路径到剪贴板。 */
  const copyPath = useCallback(async () => {
    if (!menu || !app.repoId) return;
    setMenu(null);
    try {
      const path = await api.filePath({
        repoId: app.repoId,
        fileId: menu.file.id,
      });
      await navigator.clipboard.writeText(path);
      app.status(app.t("media.pathCopied"), "ok");
    } catch (e) {
      app.status(app.t("media.pathCopyFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [menu, app]);

  /**
   * 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息 / 调色板）。
   *
   * 这是**后台任务**（用户口径：与「源全量」同款浮窗）：这里只负责发起，
   * 进度浮窗与取消按钮、以及结束后的状态文案与刷新都由 `scan.*` 事件驱动
   * （`core/taskStore.ts`）。因此调用方**不**自己弹 "已重新分析"、也不自己 `refresh()`——
   * 否则会出现"浮窗还没收起、状态栏先说完成了"这类两条真相对撞。
   */
  const reanalyze = useCallback(async () => {
    if (!menu || !app.repoId) return;
    setMenu(null);
    try {
      await api.fileReanalyze({
        repoId: app.repoId,
        fileId: menu.file.id,
      });
    } catch (e) {
      // 任务登记失败（如已有长任务在跑）才在这里报错；任务本身的失败由 scan.error 上报。
      app.status(app.t("media.reanalyzeFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [menu, app]);

  /**
   * 容器级快捷键（网格 / 瀑布流 / 列表共用）：
   * Ctrl+A 全选、Esc 取消、Delete 删除选中。
   */
  const handleContainerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        app.setSelectedIds(new Set(items.map((it) => it.file.id)));
      } else if (e.key === "Escape") {
        app.setSelectedIds(new Set());
      } else if (e.key === "Delete" && app.selectedIds.size > 0) {
        e.preventDefault();
        void handleDelete();
      }
    },
    [app, items, handleDelete],
  );

  /** 点空白处取消选择（网格 / 瀑布流的容器本身，不含单元）。 */
  const handleContainerClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        app.setSelectedIds(new Set());
        app.setSelectedFile(null);
      }
    },
    [app],
  );

  /**
   * 传给缩略图单元的四个回调：全部收敛为**恒定引用**，`ThumbCell` 的 `memo` 才有意义
   * （见 `useStableCallback` 的说明——`app` 每次都换身份，直接传等于没有 memo）。
   */
  const cellSelect = useStableCallback(handleSelect);
  const cellDoubleClick = useStableCallback(handleDoubleClick);
  const cellDragStart = useStableCallback(handleDragStart);
  const cellContextMenu = useStableCallback(handleContextMenu);

  const renderCell = useCallback(
    (file: FileItem, url: string) => (
      <ThumbCell
        key={file.id}
        file={file}
        repoId={repoId ?? ""}
        url={url}
        selected={app.selectedIds.has(file.id)}
        showName={showFileName}
        onSelect={cellSelect}
        onDoubleClick={cellDoubleClick}
        onDragStart={cellDragStart}
        onContextMenu={cellContextMenu}
        t={app.t}
      />
    ),
    [
      repoId,
      app.selectedIds,
      app.t,
      showFileName,
      cellSelect,
      cellDoubleClick,
      cellDragStart,
      cellContextMenu,
    ],
  );

  /**
   * 「视图」下拉：**由取值域派生**（不写第二份清单），仅在「预览图」模式下有效
   * （列表模式置灰并给出原因）。
   */
  const viewOptions: DropdownOption[] = MEDIA_VIEW_MODES.map((mode) => ({
    value: mode,
    label: app.t(viewLabelKey(mode)),
    selected: view === mode,
  }));

  /**
   * 「排序」下拉：四个排序键 + **一条横线** + 正序 / 倒序（用户口径）。
   *
   * 两组都由各自的取值域派生，横线挂在**方向组的第一项**之前（`ruleBefore`），
   * 因此它既不会跑到最上面，也不会在项数变化时错位。
   */
  const sortOptions: DropdownOption[] = [
    ...MEDIA_SORT_KEYS.map((key) => ({
      value: key,
      label: app.t(sortKeyLabelKey(key)),
      selected: sortKey === key,
    })),
    ...SORT_DIRECTIONS.map((dir, index) => ({
      value: dir,
      label: app.t(sortDirLabelKey(dir)),
      selected: sortDir === dir,
      ruleBefore: index === 0,
    })),
  ];

  return (
    <div className="panel mp-panel">
      <div className="mp-toolbar">
        <div className="mp-toggle">
          <button
            className={viewMode === "thumb" ? "active" : ""}
            onClick={() => setViewMode("thumb")}
          >
            {app.t("media.viewThumb")}
          </button>
          <button
            className={viewMode === "name" ? "active" : ""}
            onClick={() => setViewMode("name")}
          >
            {app.t("media.viewName")}
          </button>
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
        >
          <option value="all">{app.t("media.filter.all")}</option>
          <option value="image">{app.t("media.filter.image")}</option>
          <option value="video">{app.t("media.filter.video")}</option>
          <option value="audio">{app.t("media.filter.audio")}</option>
        </select>
        <span className="mp-count">
          {selectedCount > 0
            ? app.t("media.selectedCount", {
                selected: selectedCount,
                total: items.length,
              })
            : app.t("media.itemCount", { count: items.length })}
        </span>
        {/* 图片尺寸滑条：位置固定在「视图」**左边**（用户口径），只影响「预览图」模式。 */}
        <span className="mp-size">
          <span className="mp-size-label">{app.t("media.settings.imageSize")}</span>
          <input
            type="range"
            className="mp-size-range"
            min={MEDIA_IMAGE_SIZE_MIN}
            max={MEDIA_IMAGE_SIZE_MAX}
            step={MEDIA_IMAGE_SIZE_STEP}
            value={imageSize}
            disabled={viewMode !== "thumb"}
            aria-label={app.t("media.settings.imageSize")}
            title={`${app.t("media.imageSizeHint")} — ${imageSize}px`}
            onChange={(e) => chooseImageSize(Number(e.target.value))}
          />
          <span className="mp-size-value">{imageSize}</span>
        </span>
        <ToolbarDropdown
          labelKey="media.settings.view"
          currentLabel={app.t(viewLabelKey(view))}
          options={viewOptions}
          disabled={viewMode !== "thumb"}
          disabledHint={app.t("media.viewOnlyInThumb")}
          t={app.t}
          onSelect={chooseView}
        />
        <ToolbarDropdown
          labelKey="media.settings.sortKey"
          currentLabel={`${app.t(sortKeyLabelKey(sortKey))} · ${app.t(sortDirLabelKey(sortDir))}`}
          options={sortOptions}
          t={app.t}
          onSelect={chooseSort}
        />
      </div>

      {!repoId && <span className="placeholder">{app.t("common.pleaseOpenRepo")}</span>}

      {/* 三个条目容器都在**前台**才渲染（后台标签冻结，见 `foreground` 的说明）。 */}
      {repoId && foreground && viewMode === "thumb" && view === "masonry" && (
        <div
          className="mp-masonry"
          ref={gridRef}
          style={containerStyle}
          tabIndex={0}
          onKeyDown={handleContainerKeyDown}
          onClick={handleContainerClick}
        >
          {items.length === 0 ? (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          ) : (
            columns.map((column, index) => (
              <div className="mp-masonry-col" key={index}>
                {column.map(({ file, url }) => renderCell(file, url))}
              </div>
            ))
          )}
        </div>
      )}

      {repoId && foreground && viewMode === "thumb" && view !== "masonry" && (
        <div
          className={`mp-grid ${mediaViewClass(view)}`}
          ref={gridRef}
          style={containerStyle}
          tabIndex={0}
          onKeyDown={handleContainerKeyDown}
          onClick={handleContainerClick}
        >
          {items.length === 0 ? (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          ) : (
            items.map(({ file, url }) => renderCell(file, url))
          )}
        </div>
      )}

      {repoId && foreground && viewMode === "name" && (
        <div
          className="mp-list"
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleContainerKeyDown}
        >
          {items.map(({ file }) => (
            <button
              key={file.id}
              className={`mp-row ${
                app.selectedIds.has(file.id) ? "selected" : ""
              }`}
              draggable
              onClick={(e) =>
                handleSelect(file, {
                  shift: e.shiftKey,
                  ctrl: e.ctrlKey || e.metaKey,
                })
              }
              onDoubleClick={() => handleDoubleClick(file)}
              onDragStart={(e) => handleDragStart(file, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                handleContextMenu(file, e);
              }}
            >
              <span className={`mp-badge ${file.media_type}`}>
                {file.media_type}
              </span>
              <span className="mp-row-name">{file.relative_path}</span>
              {/* 体积走**宿主设置**的体积单位（二进制 KiB/MiB/GiB ↔ 十进制 KB/MB/GB），
                  与元数据面板同一份格式化函数；此前这里直接印裸字节数。 */}
              <span className="mp-row-size">{formatByteSize(file.size, sizeUnit)}</span>
            </button>
          ))}
          {items.length === 0 && (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          )}
        </div>
      )}

      {/* 右键上下文菜单 */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          {renaming ? (
            <div className="menu-item-row">
              <input
                className="menu-input"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirmRename();
                  } else if (e.key === "Escape") {
                    setRenaming(false);
                    setMenu(null);
                  }
                }}
              />
              <button
                className="menu-item small"
                onClick={() => void confirmRename()}
              >
                ✓
              </button>
            </div>
          ) : (
            <>
              {selectedCount === 1 && (
                <button
                  className="menu-item"
                  onClick={() => {
                    setRenaming(true);
                    setRenameValue(fileName(menu.file.relative_path));
                  }}
                >
                  {app.t("common.rename")}
                </button>
              )}
              {selectedCount === 1 && (
                <button
                  className="menu-item"
                  onClick={() => void copyPath()}
                >
                  {app.t("media.copyPath")}
                </button>
              )}
              {selectedCount === 1 && (
                <button
                  className="menu-item"
                  onClick={() => void reanalyze()}
                >
                  {app.t("media.reanalyzeFile")}
                </button>
              )}
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => void handleDelete()}
              >
                {app.t("media.delete")}
              </button>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
