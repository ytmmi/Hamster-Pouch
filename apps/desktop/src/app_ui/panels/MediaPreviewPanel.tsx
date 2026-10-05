/**
 * 媒体预览面板：**面板装配与条目容器渲染**。
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
 * 门禁可直接 import 断言），本文件只把各分块装配起来并渲染三种条目容器。
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
 * 这条解析在 `mediaPreviewSession.ts`。
 *
 * ## 本面板的分块（单文件 1200 行硬上限）
 *
 * - `mediaPreviewData.ts`：已加载文件页的取数与条目解析；
 * - `mediaPreviewSession.ts`：视图 / 尺寸 / 排序的有效取值；
 * - `mediaPreviewToolbar.tsx`：顶部工具条；
 * - `mediaPreviewMenu.tsx`：右键上下文菜单；
 * - `mediaPreviewActions.ts`：四类文件操作动作；
 * - `mediaPreviewSelection.ts`：选中集与蓝图事件上报；
 * - `mediaPreviewCell.tsx`：缩略图单元；`mediaPreviewView.ts`：取值域与纯函数。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

import { resolveSizeUnit, SETTING_KEYS } from "@hamster-pouch/config";

import { formatByteSize } from "../shared/format";
import { usePanelForeground } from "../shared/panelForeground";
import { useHostSettingValue } from "../shared/settingValue";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import type { FileItem } from "../shared/types";
import { ThumbCell, ratioCache } from "./mediaPreviewCell";
import { useMediaFileActions } from "./mediaPreviewActions";
import { useMediaPreviewData, type MediaTypeFilter } from "./mediaPreviewData";
import { MediaContextMenu, useMediaContextMenu } from "./mediaPreviewMenu";
import { useMediaSelection } from "./mediaPreviewSelection";
import { createScrollSlot, onScrollEvent, planScrollApply } from "./mediaPreviewScroll";
import { useMediaViewState } from "./mediaPreviewSession";
import { MediaPreviewToolbar, type MediaPreviewMode } from "./mediaPreviewToolbar";
import { DEFAULT_CELL_RATIO, MASONRY_GAP, distributeColumns, masonryColumnCount, mediaViewClass } from "./mediaPreviewView";
import {
  adaptiveCellIntrinsicHeight,
  chunkRows,
  listRowHeight,
  masonryCellHeight,
  MEDIA_LIST_ROW_GAP,
  MEDIA_TILE_ROW_GAP,
  tileRowHeight,
} from "./mediaPreviewVirtual";
import {
  useContainerRef,
  useFixedRowVirtualizer,
  useMeasuredRowVirtualizer,
} from "./mediaPreviewVirtualRows";

/**
 * 跨挂载保存滚动位置：面板被 dockview 卸载重建时也能恢复浏览进度。
 *
 * 与 `mediaPreviewSession.ts` 的视图/排序**本会话覆盖**同一口径（模块级变量，不落库）。
 *
 * 存的是 [`ScrollSlot`] 而不是一个裸数字：全库**后台翻页**之后，"恢复的时机"与
 * "内容的长度"不再同步，需要额外记住"这个目标现在还到不了、内容变长后要再试"。
 * 判定逻辑全在 `mediaPreviewScroll.ts`（纯函数、门禁直接断言）。
 */
const thumbScroll = createScrollSlot();
const nameScroll = createScrollSlot();

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
  const [viewMode, setViewMode] = useState<MediaPreviewMode>("thumb");
  const [typeFilter, setTypeFilter] = useState<MediaTypeFilter>("all");
  // 网格容器（平铺 / 自适应 / 瀑布流共用）：虚拟化要拿到**滚动容器元素**，
  // 且容器是条件渲染的——`useContainerRef` 用 callback ref 把"容器已就绪"变成可依赖信号。
  const {
    ref: gridContainerRef,
    elementRef: gridRef,
    version: gridVersion,
  } = useContainerRef();
  // 列表容器：虚拟化要**测量真实行高**（文字度量随语言/缩放变化，猜死会越滚越偏），
  // 因此容器与 callback ref 走 `useContainerRef`（挂载/切换后重跑一次测量）。
  const {
    ref: listContainerRef,
    elementRef: listRef,
    version: listVersion,
  } = useContainerRef();

  // 面板设置的**缺省**视图 / 尺寸 / 排序（`usePanelSettingValue` 已按声明归一化，
  // 非法取值回落缺省）叠加本会话覆盖后的**有效取值**，解析全在 `mediaPreviewSession.ts`；
  // 开关型设置「显示文件名」同款读取（`usePanelSwitch`）。
  const {
    view,
    imageSize,
    sortKey,
    sortDir,
    showFileName,
    chooseView,
    chooseImageSize,
    chooseSort,
  } = useMediaViewState(panelApi);

  // 面板**已加载**的文件与排序 / 解析后的条目（取数在 `mediaPreviewData.ts`）。
  // `loading`：全库可翻之后取数是"首屏第一页 + 后台继续翻完"，翻页期间计数如实提示；
  // 滚动位置恢复也要用它——翻完之后内容不再变长，恢复该收敛而不是永远挂着。
  const { items, loading } = useMediaPreviewData(typeFilter, sortKey, sortDir);

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

  // 选中集与蓝图事件上报（`mediaPreviewSelection.ts`）：按拆分前的名字解构，
  // 好让条目容器与缩略图单元拿到的回调和原来一致。
  const {
    selectedCount,
    select: handleSelect,
    doubleClick: handleDoubleClick,
    dragStart: handleDragStart,
    ensureSelected,
    selectAll,
    clear,
  } = useMediaSelection(items, typeFilter);

  // 四类文件操作（删除选中 / 重命名 / 复制路径 / 重新分析，见 `mediaPreviewActions.ts`）。
  const actions = useMediaFileActions();

  // 右键菜单的开关状态与光标定位（见 `mediaPreviewMenu.tsx`）。
  const menu = useMediaContextMenu();

  // 预览图模式（网格 / 瀑布流共用同一容器引用）：恢复并跟踪滚动位置
  useEffect(() => {
    if (viewMode !== "thumb") return;
    const el = gridRef.current;
    if (!el) return;
    el.scrollTop = planScrollApply(
      thumbScroll,
      el.scrollHeight,
      el.clientHeight,
      !loading,
    );
    const onScroll = () => {
      onScrollEvent(thumbScroll, el.scrollTop, el.scrollHeight, el.clientHeight);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // `foreground`：后台冻结时容器不存在，切回前台后要重新挂监听并恢复滚动位置。
    //
    // `items.length` / `loading`：**后台翻页**下内容会一轮轮变长（缺陷 0018 P1-A）。
    // 只依赖"从无到有"这个布尔时，第一页到手就恢复一次、被夹住，之后内容再长也不再重试
    // → 深位置永远恢复不回去。带上这两个值，每翻到新内容就重试一次。
  }, [viewMode, view, foreground, app.repoId, items.length, loading]);

  // 列表模式：恢复并跟踪滚动位置
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = planScrollApply(
      nameScroll,
      el.scrollHeight,
      el.clientHeight,
      !loading,
    );
    const onScroll = () => {
      onScrollEvent(nameScroll, el.scrollTop, el.scrollHeight, el.clientHeight);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, foreground, app.repoId, items.length, loading]);

  /**
   * 网格容器的**宽度与列数**（`ResizeObserver` 跟随面板尺寸变化）。
   *
   * 两个视图都要用：
   * - 瀑布流：列数（`masonryColumnCount`）；
   * - 平铺：**切行**用同一套列数公式——虚拟化必须知道"CSS 会排几列"，否则
   *   按错的列数切行会直接表现为行错位/留白。
   *
   * `foreground` 入依赖：后台冻结时容器不在 DOM 里、观察器也没跑，切回来要重新量一次
   * （否则隐藏期间面板被调整过尺寸，列数会是旧的）。
   */
  const [masonryColumns, setMasonryColumns] = useState(1);
  const [gridWidth, setGridWidth] = useState(0);
  useEffect(() => {
    if (viewMode !== "thumb") return;
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      setGridWidth(el.clientWidth);
      setMasonryColumns(masonryColumnCount(el.clientWidth, imageSize, MASONRY_GAP));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view, viewMode, foreground, imageSize, app.repoId, items.length > 0]);

  /**
   * 图片尺寸以 **CSS 变量**下发（`--mp-image-size`），三种视图各自消费：
   * 平铺 = `grid-template-columns`、瀑布流 = 列宽 `flex-basis`、自适应 = 缩略图**行高**。
   * 一处设置、三种排布同一口径，也就不会再出现"瀑布流比平铺宽一大截"。
   *
   * `--mp-tile-columns` 是**平铺虚拟化的前提**：列数由面板按同一公式算好下发，
   * CSS 与"我们按几列切行"必须一致（`repeat(auto-fill, …)` 的话 JS 无从得知列数）。
   */
  const containerStyle = useMemo(
    () =>
      ({
        "--mp-image-size": `${imageSize}px`,
        "--mp-tile-columns": String(Math.max(1, masonryColumns)),
      }) as CSSProperties,
    [imageSize, masonryColumns],
  );

  /** 分到各列的条目（保持从左到右的序号顺序；见 `distributeColumns` 的口径说明）。 */
  const columns = useMemo(
    () => distributeColumns(items, masonryColumns),
    [items, masonryColumns],
  );

  /**
   * **列表视图的虚拟化**（缺陷 0018 P1-A）。
   *
   * 行高不猜死：`useMeasuredRowVirtualizer` 渲染后用 `measureRef` 量回真实高度，
   * 首帧用 `listRowHeight()` 估计。这样字体度量、语言、系统缩放变化都不会让
   * "行号 × 行高"与实际布局错位。
   */
  const listVirtual = useMeasuredRowVirtualizer(
    listRef,
    viewMode === "name" ? items.length : 0,
    listRowHeight(),
    listVersion,
    MEDIA_LIST_ROW_GAP,
  );

  /**
   * **平铺视图的虚拟化**：一行 `列数` 个单元，行高是常量（缩略图方形 + 可选文件名），
   * 因此内容总高度 = `行数 × 行高`，不依赖测量、滚动条不会抖。
   *
   * 列数用与 CSS `repeat(var(--mp-tile-columns), …)` 相同的公式（`masonryColumnCount`），
   * 于是"CSS 排几列"与"我们按几列切行"永远一致——不一致会表现为行错位/留白。
   */
  const tilePerRow = masonryColumnCount(gridWidth, imageSize, MASONRY_GAP);
  const tileRows = useMemo(
    () => (view === "tile" && viewMode === "thumb" ? chunkRows(items, tilePerRow) : []),
    [items, tilePerRow, view, viewMode],
  );
  const tileRowH = tileRowHeight(imageSize, showFileName);
  const tileVirtual = useFixedRowVirtualizer(
    gridRef,
    view === "tile" && viewMode === "thumb" ? tileRows.length : 0,
    tileRowH,
    gridVersion,
    MEDIA_TILE_ROW_GAP,
  );

  const repoId = app.repoId;

  /**
   * 缩略图单元的 **`content-visibility: auto` 占位高度**（px，按文件算）。
   *
   * 自适应与瀑布流此前**显式关掉**了跳过渲染，因为样式表里写死的
   * `contain-intrinsic-size: auto 140px` 与它们"行高由宽高比推出"的真实高度无关，
   * 离屏单元塌成 140px 会让滚动高度随滚动变化（滚动条抖动、位置漂移）。
   *
   * 但根因是**占位值写错**，不是"跳过渲染不可用"：按当前视图算一个接近真实的值即可。
   * - 自适应：行高被 `--mp-row-max-factor: 2` 封顶、铺满一行时约等于图片尺寸；
   * - 瀑布流：**逐个文件**算——列宽 ÷ 该文件宽高比（宽高比取自 `ratioCache`，
   *   量过就精确；没量过按 1:1 占位，量完随 `ratio` 状态一起重算）；
   * - 平铺/列表：行高本来就固定，返回 `undefined` 沿用样式表缺省。
   */
  const cellIntrinsicHeight = useCallback(
    (file: FileItem): number | undefined => {
      if (view === "adaptive") return adaptiveCellIntrinsicHeight(imageSize, showFileName);
      if (view === "masonry") {
        const ratio = ratioCache.get(file.id) ?? DEFAULT_CELL_RATIO;
        return masonryCellHeight(imageSize, ratio, showFileName);
      }
      return undefined;
    },
    [view, imageSize, showFileName],
  );

  /**
   * 右键菜单：未选中项先单选，已选中则保持多选；
   * 在光标位置打开自定义上下文菜单。
   */
  const handleContextMenu = useCallback(
    (file: FileItem, e: ReactMouseEvent) => {
      ensureSelected(file);
      menu.open(file, e);
    },
    [ensureSelected, menu],
  );

  /**
   * 容器级快捷键（网格 / 瀑布流 / 列表共用）：
   * Ctrl+A 全选、Esc 取消、Delete 删除选中。
   */
  const handleContainerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
      } else if (e.key === "Escape") {
        clear();
      } else if (e.key === "Delete" && app.selectedIds.size > 0) {
        e.preventDefault();
        void actions.deleteSelected();
      }
    },
    [app, selectAll, clear, actions],
  );

  /** 点空白处取消选择（网格 / 瀑布流的容器本身，不含单元）。 */
  const handleContainerClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        clear();
        app.setSelectedFile(null);
      }
    },
    [app, clear],
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
        intrinsicHeight={cellIntrinsicHeight(file)}
        nearViewport={view === "tile"}
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
      cellIntrinsicHeight,
      view,
      cellSelect,
      cellDoubleClick,
      cellDragStart,
      cellContextMenu,
    ],
  );

  return (
    <div className="panel mp-panel">
      <MediaPreviewToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        selectedCount={selectedCount}
        totalCount={items.length}
        loading={loading}
        view={view}
        imageSize={imageSize}
        sortKey={sortKey}
        sortDir={sortDir}
        onChooseView={chooseView}
        onChooseImageSize={chooseImageSize}
        onChooseSort={chooseSort}
        t={app.t}
      />

      {!repoId && <span className="placeholder">{app.t("common.pleaseOpenRepo")}</span>}

      {/* 三个条目容器都在**前台**才渲染（后台标签冻结，见 `foreground` 的说明）。 */}
      {repoId && foreground && viewMode === "thumb" && view === "masonry" && (
        <div
          className="mp-masonry"
          ref={gridContainerRef}
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
          ref={gridContainerRef}
          style={containerStyle}
          tabIndex={0}
          onKeyDown={handleContainerKeyDown}
          onClick={handleContainerClick}
        >
          {items.length === 0 ? (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          ) : view === "tile" ? (
            /* 平铺：按行虚拟化。行高是常量（缩略图方形 + 可选文件名），
               内容总高度 = 行数 × 行高，不依赖测量，滚动条不会抖。 */
            <div className="mp-virtual" style={{ height: tileVirtual.totalSize }}>
              {tileVirtual.rows.map((row) => (
                <div
                  key={row.index}
                  className="mp-virtual-row mp-virtual-grid"
                  style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                >
                  {(tileRows[row.index] ?? []).map(({ file, url }) => renderCell(file, url))}
                </div>
              ))}
            </div>
          ) : (
            /* 自适应：行高随图片宽高比变化，**断行由 CSS flex-wrap 决定**，
               JS 无法在不测量每张图的情况下复现——见 `mediaPreviewVirtual.ts` 的说明。
               因此这里仍渲染全部条目，靠 `.mp-cell` 的 `content-visibility` 跳过离屏渲染。 */
            items.map(({ file, url }) => renderCell(file, url))
          )}
        </div>
      )}

      {repoId && foreground && viewMode === "name" && (
        <div
          className="mp-list"
          ref={listContainerRef}
          tabIndex={0}
          onKeyDown={handleContainerKeyDown}
        >
          {items.length === 0 ? (
            <span className="placeholder">{app.t("media.noFiles")}</span>
          ) : (
            /* 列表：按行虚拟化。行高由文字度量决定，渲染后**测量**回真实高度
               （`measureRef`），因此不把字体行高猜死。 */
            <div className="mp-virtual" style={{ height: listVirtual.totalSize }}>
              {listVirtual.rows.map((row) => {
                const item = items[row.index];
                if (!item) return null;
                const { file } = item;
                return (
                  <div
                    key={file.id}
                    ref={listVirtual.measureRef}
                    // `data-index` 是 `measureElement` 的**必需属性**：虚拟化库靠它把
                    // 被测量的 DOM 节点反查回行号（`indexFromElement` 读的就是这个属性）。
                    // 少了它 `indexFromElement` 返回 -1、`isIndexInRange(-1)` 为假，
                    // 测量被**整条跳过**（元素连观察都不会被观察），行高永远是首帧估计值
                    // ——"测量行高"这个设计就完全失效了。库会在控制台打
                    // `Missing attribute name 'data-index={index}'`。
                    data-index={row.index}
                    className="mp-virtual-row mp-virtual-list"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <button
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 右键上下文菜单（开关与菜单项见 `mediaPreviewMenu.tsx`） */}
      {menu.target && (
        <MediaContextMenu
          target={menu.target}
          selectedCount={selectedCount}
          actions={actions}
          onClose={menu.close}
          t={app.t}
        />
      )}
    </div>
  );
}
