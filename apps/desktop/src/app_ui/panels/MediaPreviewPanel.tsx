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
import { ThumbCell } from "./mediaPreviewCell";
import { useMediaFileActions } from "./mediaPreviewActions";
import { useMediaPreviewData, type MediaTypeFilter } from "./mediaPreviewData";
import { MediaContextMenu, useMediaContextMenu } from "./mediaPreviewMenu";
import { useMediaSelection } from "./mediaPreviewSelection";
import { useMediaViewState } from "./mediaPreviewSession";
import { MediaPreviewToolbar, type MediaPreviewMode } from "./mediaPreviewToolbar";
import {
  MASONRY_GAP,
  distributeColumns,
  masonryColumnCount,
  mediaViewClass,
} from "./mediaPreviewView";

/**
 * 跨挂载保存滚动位置：面板被 dockview 卸载重建时也能恢复浏览进度。
 *
 * 与 `mediaPreviewSession.ts` 的视图/排序**本会话覆盖**同一口径（模块级变量，不落库）。
 */
let savedThumbScroll = 0;
let savedNameScroll = 0;

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
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // 面板**已加载**的那一页文件与排序 / 解析后的条目（取数在 `mediaPreviewData.ts`）。
  const { files, items } = useMediaPreviewData(typeFilter, sortKey, sortDir);

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

  return (
    <div className="panel mp-panel">
      <MediaPreviewToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        selectedCount={selectedCount}
        totalCount={items.length}
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
