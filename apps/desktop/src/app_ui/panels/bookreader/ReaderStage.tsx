/**
 * 图书阅读器：**阅读区**（正文 + 翻页）。
 *
 * ## 三种翻页方式（「阅读选项 → 翻页方式」）
 *
 * - `scroll`：**连续滚动**——`overflow: auto` 的纵向滚动，滚到接近底部取下一页。
 * - `page` / `spread`：**整页翻页**（单页 / 双页）——用 CSS 多栏实现：
 *   `column-width` = 一页宽、容器高度固定，浏览器于是把内容**横向**排成若干栏，
 *   再用 `translateX` 一页一页推。这样"翻页"是真实的分栏结果，
 *   而不是"把滚动条切成一段段"（后者会在段落中间断开、还会因为字体不同而错位）。
 *
 * 分页模式的"还有没有下一页"与滚动模式不同：没有"滚到底"这个信号，
 * 判据是**已经在最后一页**（`shouldLoadMorePages`，在 `readerView.ts` 里）。
 *
 * ## 为什么用 `key` 重置阅读区
 *
 * 跳章（目录点击）时整段内容换掉，滚动位置与当前页都必须回到开头。
 * 面板给本组件传 `key={当前游标}`，于是跳章就是**重新挂载**——
 * 比"在 effect 里手动 scrollTop = 0 并 setPage(0)"少一整类竞态
 * （内容还没渲染完就置顶 = 置顶无效）。
 *
 * ## 字体/间距/配色都在这里落地
 *
 * 「阅读选项」的 12 项里，只有翻页方式参与布局计算，其余都是 CSS 变量：
 * 字号 / 行高 / 字间距 / 段间距 / 页边距 / 页宽 / 字体 / 对齐 / 背景 / 文字色 / 亮度。
 * 这样"改字号"不会触发 React 重排 —— 只改一个自定义属性。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, UIEvent } from "react";

import type { Translate } from "../../i18n";
import type { BookContentResult } from "../../shared/types";
import { BookBlocks } from "../viewer/BookBlocks";
import {
  accumulateWheelStep,
  bodyClickHidesRails,
  clampReaderPage,
  fractionWorthReporting,
  isInteractiveTarget,
  normalizeWheelDelta,
  readerColumnsPerScreen,
  readerPagination,
  shouldLoadMorePages,
  READER_COLUMN_GAP,
  READER_WHEEL_STEP_PX,
  type ReaderPagination,
} from "./readerView";
import type { ReaderSettings } from "./useReaderSettings";

/** 分页模式下"当前页"的重置键：游标变化即重新挂载（见文件头）。 */
export interface ReaderStageProps {
  pages: BookContentResult[];
  settings: ReaderSettings;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** 需要下一页（滚动到底 / 翻到最后一页）。 */
  onNeedMore: () => void;
  /** 是否为空态（非"书" / 无正文）：由面板决定文案。 */
  emptyText: string | null;
  /**
   * 点击**正文区域**（不含链接 / 分页按钮 / 划词）。
   *
   * 面板用它收起左右两栏（用户 2026-10-17 口径："点击更多后，点击正文区域可以隐藏
   * 两栏（等同于再次点击更多）"）。**判据不在面板里**：是否该触发由
   * `bodyClickHidesRails` 这个纯函数决定，组件只负责从事件与 DOM 取值。
   */
  onBodyClick?: () => void;
  /**
   * **阅读位置**变化：`{ visibleIndex, offsetInPage }`。
   *
   * 面板据此算绝对位置（`readerPositionFromPage`）→ 进度 / 本章进度 / 章节数。
   *
   * 为什么不是"一个 0–1 的全局比例"：那个比例是**像素**的，而位置总量是**结构**的
   * （章数 / 字符数），章节长短不等时两者不成比例，乘起来会跳整章——这正是
   * "章节数乱跳"的根因。这里给出"第几页 + 页内比例"，面板只在**单页内部**插值，
   * 跨页位置由页序号精确给出，因此章节号与目录逐项对得上。
   */
  onPositionChange?: (position: { visibleIndex: number; offsetInPage: number }) => void;
  t: Translate;
}

export function ReaderStage({
  pages,
  settings,
  loading,
  error,
  hasMore,
  onNeedMore,
  emptyText,
  onBodyClick,
  onPositionChange,
  t,
}: ReaderStageProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  /** 分页几何（栏宽 / 栏数 / 页数 / 步进）：一次测量、一处算术。 */
  const [pagination, setPagination] = useState<ReaderPagination>({
    columnWidth: 0,
    columnCount: 1,
    pageCount: 1,
    pitch: 1,
  });
  /** 滚轮增量的**累积器**（见 `accumulateWheelStep`：一次物理滚动 ≠ 一个事件）。 */
  const wheelAccumRef = useRef(0);
  /**
   * 上一次**上报**过的相对位置（0–1）。
   *
   * 用来挡掉无意义的重渲染（`fractionWorthReporting`）：滚动事件一秒几十次，
   * 每次都让面板重算并重画整块正文会明显掉帧，而小于 0.01% 的变化在界面上
   * 根本看不出来。用 ref 而不是 state：它只用于比较，不参与渲染。
   */
  const reportedFractionRef = useRef(0);

  const columns = readerColumnsPerScreen(settings.viewMode);
  const paged = settings.viewMode !== "scroll";
  const pageCount = pagination.pageCount;

  /** 面板可用宽度（分页栏宽按它算）；`ResizeObserver` 跟随面板尺寸变化。 */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * 分页几何重算：**内容流的总宽**（`scrollWidth`）决定栏数与页数。
   *
   * 依赖 `pages` / `width` / `columns`：取回新的一页、面板变宽、切换单双页都要重算。
   * 用 `requestAnimationFrame` 等一次布局——多栏排版是同步发生的，
   * 但 React 提交后立刻读 `scrollWidth` 会读到**上一帧**的宽度。
   */
  useEffect(() => {
    if (!paged) {
      setPagination({ columnWidth: 0, columnCount: 1, pageCount: 1, pitch: 1 });
      setPage(0);
      return;
    }
    const el = flowRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const next = readerPagination(el.scrollWidth, width, columns, READER_COLUMN_GAP);
      setPagination(next);
      setPage((current) => clampReaderPage(current, next.pageCount));
    });
    return () => cancelAnimationFrame(frame);
  }, [paged, pages, width, columns]);

  /**
   * 上报**阅读位置变化**（2026-10-17 第二次修正）。
   *
   * ## 为什么上报的是"可见页 + 页内比例"，而不是一个全局比例
   *
   * 早期版本把整个已载入区段当成一个整体，上报 `scrollTop / 可滚高度`，
   * 面板再乘"已载入单位数"——那两个量**不成比例**（像素 vs 章数），
   * 章节长短不等时会算出跳整章的位置（见 `readerPositionFromVisiblePage` 的推导）。
   *
   * 现在改成：每页渲染时带 `data-page-index`，这里用 `elementFromPoint` 认出
   * **当前真正显示的是第几页**，只在该页内部取像素比例。页内比例是同一页内部的量，
   * 不存在跨页的比例失配；而且加载更多页不会改变已显示页的起始单位——
   * 位置因此不会因为加载而跳。
   *
   * 分页模式无需探测：`page` 状态本身就是"第几屏"，直接用它换算可见页。
   */
  /**
   * 上报**阅读位置**：`{ visibleIndex, offsetInPage }`。
   *
   * ## 为什么上报的是"可见页 + 页内比例"，而不是一个全局比例
   *
   * 早期版本把整个已载入区段当成一个整体，上报 `scrollTop / 可滚高度`，
   * 面板再乘"已载入单位数"——那两个量**不成比例**（像素 vs 章数），
   * 章节长短不等时会算出跳整章的位置；`loadMore` 又会改变分母，于是加载瞬间跳几章。
   *
   * 现在：每页渲染时带 `data-page-index`，这里认出**当前真正显示的是第几页**，
   * 只在该页内部取像素比例。页内比例是同一页内部的量，不存在跨页的方向失配；
   * 而且加载更多页不会改变已显示页的起点——位置因此不会因为加载而跳。
   *
   * ## 探测点为什么用 `.br-flow`（内容框）而不是 `.br-stage`（舞台框）
   *
   * `.br-stage` 带 `padding: var(--br-page-margin)`，**上限 80px**。若以舞台左上角
   * 往里 40px 取探测点，页边距一旦超过 40px，这个点就落在**内边距**里：
   * `elementFromPoint` 返回舞台本身，`closest("[data-page-index]")` 得到 `null`，
   * `visibleIndex` 变成 `-1` → 章节数退回第 1 章（用户报的就是这个现象的一个触发路径）。
   * 以 `.br-flow`（内容框，位于内边距之内）取点就不会踩到内边距；
   * 再把它夹进"可视区 ∩ 内容框"，横竖两种排版都稳。
   */
  const reportPosition = useCallback(() => {
    if (!onPositionChange) return;
    const host = hostRef.current;
    const flow = flowRef.current;
    if (!host || !flow) return;

    const hostRect = host.getBoundingClientRect();
    const flowRect = flow.getBoundingClientRect();

    // 探测点：内容框内取一点，并夹进舞台的可视范围（滚动后内容框会上移）。
    const probeX = flowRect.left + Math.min(flowRect.width / 2, 40);
    const rawY = Math.max(hostRect.top + 2, flowRect.top + 2);
    const probeY = Math.min(rawY, Math.min(hostRect.bottom, flowRect.bottom) - 2);

    const probe = document.elementFromPoint(probeX, probeY);
    const pageEl = probe?.closest?.("[data-page-index]") as HTMLElement | null;

    let visibleIndex = -1;
    let offsetInPage = 0;
    if (pageEl) {
      visibleIndex = Number(pageEl.dataset.pageIndex ?? "-1");
      const pageRect = pageEl.getBoundingClientRect();
      if (paged) {
        /*
         * 横向排版（`column-count` 多栏 + `translateX`）：页内比例 = 视口左缘
         * 相对该页左缘的位置。
         *
         * 视口左缘用 `hostRect.left + host.clientLeft` 而不是 `hostRect.left`：
         * 舞台若有左边框，内容区的实际起点要往里一个 `clientLeft`，否则比例会
         * 有一个固定偏移（边框越粗越明显）。
         */
        offsetInPage =
          pageRect.width > 0
            ? (hostRect.left + host.clientLeft - pageRect.left) / pageRect.width
            : 0;
      } else {
        // 纵向排版：页内比例 = 视口上缘相对该页上缘的位置。
        offsetInPage =
          pageRect.height > 0 ? (hostRect.top - pageRect.top) / pageRect.height : 0;
      }
    }

    // 节流键用"页号 + 页内比例"：跨页必然变化，页内细碎滚动按 1e-4 挡掉。
    const next = visibleIndex + offsetInPage;
    if (!fractionWorthReporting(reportedFractionRef.current, next)) return;
    reportedFractionRef.current = next;
    onPositionChange({ visibleIndex, offsetInPage });
  }, [onPositionChange, paged]);

  /** 滚动模式：滚到接近底部 → 取下一页，并把阅读位置报给面板。 */
  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      reportPosition();
      if (
        shouldLoadMorePages(
          settings.viewMode,
          el.scrollTop,
          el.scrollHeight,
          el.clientHeight,
          hasMore,
          false,
        )
      ) {
        onNeedMore();
      }
    },
    [hasMore, onNeedMore, reportPosition, settings.viewMode],
  );

  /**
   * 分页模式：滚轮 / 方向键 / PageUp·PageDown 翻页；翻到最后一页继续取下一页。
   *
   * **这里不上报位置**：翻页的唯一结果是 `setPage`，而"位置跟随"由下面那条
   * `[pages, paged, page, pageCount, width]` 的 effect 统一做——它依赖 `page`，
   * 翻页后必然重跑。在两处都报会让"位置从哪来"有两个入口，改一处漏一处时
   * 门禁也很难说清到底是哪一条在起作用（本条断言最初就是被冗余代码垫绿的）。
   */
  const flipTo = useCallback(
    (target: number) => {
      const next = clampReaderPage(target, pageCount);
      setPage(next);
      if (next >= pageCount - 1) onNeedMore();
    },
    [onNeedMore, pageCount],
  );

  /**
   * 分页模式的滚轮翻页（**原生监听器 + `{ passive: false }`**）。
   *
   * 为什么不能用 React 的 `onWheel`：React 在根节点上把 `wheel` 注册成
   * **passive** 监听器，`preventDefault()` 会被忽略——浏览器的原生滚动照常发生，
   * 于是"分页"退化成"普通滚动"（用户 2026-10-16 实测反馈："单页和双页滚轮滚动一次
   * 应该是一页，现在的方式和普通滚动无区别"）。本项目已在
   * `panels/bookpreview/BookCard.tsx` 记录过同一个坑，这里沿用同一条处置。
   *
   * 累积口径见 `accumulateWheelStep`：一次物理滚动（鼠标一格 / 触控板一滑）
   * 算"一次"，翻**一页**；`preventDefault()` 同时掐掉原生滚动，两者缺一不可。
   */
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !paged) return;
    const onWheel = (event: WheelEvent) => {
      // 只认主要方向（触控板横滑与竖滚都可能出现；取绝对值大的那个）。
      const raw =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const delta = normalizeWheelDelta(raw, event.deltaMode);
      if (delta === 0) return;
      // 先拦下原生滚动：否则内容会在平移的同时被浏览器滚走。
      event.preventDefault();
      const { accumulated, step } = accumulateWheelStep(
        wheelAccumRef.current,
        delta,
        READER_WHEEL_STEP_PX,
      );
      wheelAccumRef.current = accumulated;
      if (step === 0) return;
      // 用函数式更新读**最新**页码：滚轮事件在 effect 之外，闭包里的 `page` 会过期。
      // 位置**不在这里报**：`setPage` 会让下面那条依赖 `page` 的 effect 跑一次，
      // 上报口径只留那一个入口（两处都报时改一条漏一条也照样"看起来对"）。
      setPage((current) => {
        const next = clampReaderPage(current + step, pageCount);
        if (next >= pageCount - 1) onNeedMore();
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [paged, pageCount, onNeedMore]);

  /**
   * **正文变长 / 分页几何变化后重新探测位置**（`pages` 增长、面板变宽、切单双页）。
   *
   * 为什么必须补这一条：`reportPosition` 是**读 DOM** 的（`data-page-index` +
   * 元素几何），而上面几处上报都挂在事件上（scroll / wheel / 翻页）。这三种变化
   * **不产生任何事件**（用户没动），DOM 却已经变了——不补就会拿着旧位置显示。
   *
   * 用 `requestAnimationFrame` 等一次布局：`pages` 变化后 React 才刚提交，
   * 同步读几何会读到上一帧（同分页几何那条 effect 的处置）。
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => reportPosition());
    return () => cancelAnimationFrame(frame);
  }, [pages, paged, page, pageCount, width, reportPosition]);

  /** 换页 / 换书 / 切换翻页方式：清掉滚轮累积，免得"上一次的半格"带到下一页。 */
  useEffect(() => {
    wheelAccumRef.current = 0;
  }, [paged, pageCount, settings.viewMode]);

  /**
   * 重新挂载（跳章用 `key={游标}`）后立刻探测一次位置。
   *
   * 不在这里"人为归零"：位置是**读 DOM** 得出的，挂载后 DOM 就在开头，
   * 探测自然得到第 0 页——手写一个 0 反而会在"跳到的章不是第 0 页"时给出错值。
   */
  useEffect(() => {
    reportedFractionRef.current = Number.NaN;
    const frame = requestAnimationFrame(() => reportPosition());
    return () => cancelAnimationFrame(frame);
    // 只在挂载时跑一次（`key` 变化即重新挂载）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!paged) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        flipTo(page + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        flipTo(page - 1);
      }
    },
    [flipTo, page, paged],
  );

  /**
   * 点击**正文区域** → 面板收起左右两栏（用户 2026-10-17 口径）。
   *
   * 两条否决判据都在纯函数 `bodyClickHidesRails` 里（点在链接或分页按钮里 /
   * 正在划词），组件只负责把**事件与 DOM 的事实**取出来喂给它：
   *
   * - `interactive`：`closest` 比 tagName 准——正文里可点的通常是链接内部的 `<span>`；
   * - `hasSelection`：用户划完词松手同样会触发 `click`，此时选区非空；
   *   不排除的话"划一句话准备加高亮"会顺手把目录关掉。
   *
   * "两栏没开"不在这里判：面板只在展开时才把回调传下来（`onBodyClick` 可选）。
   *
   * 用 React 的 `onClick`（不是原生监听器）：这里不需要 `preventDefault`，
   * 与 D113 ⑬③ 那个 `wheel` 的 passive 坑无关。
   */
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onBodyClick) return;
      const selection =
        typeof window === "undefined" ? "" : (window.getSelection()?.toString() ?? "");
      const hides = bodyClickHidesRails({
        interactive: isInteractiveTarget(
          e.target as unknown as { closest?: (selector: string) => unknown },
        ),
        hasSelection: selection.trim().length > 0,
      });
      if (hides) onBodyClick();
    },
    [onBodyClick],
  );

  /**
   * 首屏内容不足一屏时也要继续取：`scroll` 事件不会因为"内容变多"而自动触发，
   * 用户看到的会是一小段正文加一大片空白，且没有任何方式触发下一页。
   */
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !hasMore || loading) return;
    if (settings.viewMode === "scroll" && el.scrollHeight <= el.clientHeight + 1) onNeedMore();
    if (settings.viewMode !== "scroll" && page >= pageCount - 1) onNeedMore();
  }, [pages, hasMore, loading, page, pageCount, settings.viewMode, onNeedMore]);

  const style = useMemo(
    () =>
      ({
        "--br-font-size": `${settings.fontSize}px`,
        "--br-line-height": String(settings.lineHeight / 100),
        "--br-letter-spacing": `${settings.letterSpacing}px`,
        "--br-paragraph-spacing": `${settings.paragraphSpacing}px`,
        "--br-page-margin": `${settings.pageMargin}px`,
        "--br-max-width": `${settings.pageWidth}%`,
        "--br-columns": String(columns),
        "--br-column-gap": `${READER_COLUMN_GAP}px`,
        "--br-brightness": String(settings.brightness / 100),
      }) as CSSProperties,
    [columns, settings],
  );

  const className = [
    "br-stage",
    `br-bg-${settings.bg}`,
    `br-text-${settings.text}`,
    `br-font-${settings.fontFamily}`,
    `br-align-${settings.textAlign}`,
    paged ? "br-stage-paged" : "br-stage-scroll",
  ].join(" ");

  return (
    <div
      className={className}
      style={style}
      ref={hostRef}
      tabIndex={0}
      onClick={handleClick}
      onScroll={paged ? undefined : handleScroll}
      onKeyDown={handleKeyDown}
    >
      {error && <span className="placeholder">{error}</span>}
      {!error && pages.length === 0 && loading && (
        <span className="placeholder">{t("common.loading")}</span>
      )}
      {!error && pages.length === 0 && !loading && emptyText && (
        <span className="placeholder">{emptyText}</span>
      )}

      {pages.length > 0 && (
        <div
          className="br-flow"
          ref={flowRef}
          style={
            paged
              ? // 平移**一屏**（`pitch` = 屏内栏数 × 列距），不是"一栏"——
                // 双页模式下按一栏平移会让正文在屏幕里横向漂半格。
                { transform: `translateX(-${page * pagination.pitch}px)` }
              : undefined
          }
        >
          <div className="vr-content br-content">
            {pages.map((item, index) => (
              /*
               * 每页包一层带 `data-page-index` 的容器：位置探测靠它认出"当前显示的是第几页"。
               *
               * 为什么必须逐页标记：绝对位置要由**页序号**精确给出（章节数与目录对得上
               * 全靠这一点），而不是靠"整段滚动了百分之多少"去猜——后者与章数不成比例。
               * `display: contents` 让这层不影响排版（epub 的分栏与 md 的块间距都不变）。
               */
              <div key={index} className="br-page" data-page-index={index}>
                {item.format === "text" ? (
                  <p className="vr-text">{item.text}</p>
                ) : (
                  <BookBlocks
                    blocks={item.blocks ?? []}
                    imageFallback={t("viewer.imageUnavailable")}
                  />
                )}
              </div>
            ))}
          </div>
          {loading && <div className="vr-more dim">{t("common.loading")}</div>}
          {!loading && !hasMore && (
            <div className="vr-more dim">{t("bookreader.endOfBook")}</div>
          )}
        </div>
      )}

      {paged && (
        <div className="br-pager">
          <button
            type="button"
            className="br-btn"
            disabled={page <= 0}
            onClick={() => flipTo(page - 1)}
            title={t("bookreader.prevPage")}
          >
            ‹
          </button>
          <span className="dim">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="br-btn"
            onClick={() => flipTo(page + 1)}
            title={t("bookreader.nextPage")}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
