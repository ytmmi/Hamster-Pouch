/**
 * 图书阅读器：**阅读区**（正文 + 翻页）。
 *
 * ## 三种翻页方式（「阅读选项 → 翻页方式」）
 *
 * - `scroll`：**连续滚动**——`overflow: auto` 的纵向滚动，滚到接近底部取下一页。
 * - `page` / `spread`：**整页翻页**（单页 / 双页）——用 CSS 多栏实现：
 *   `column-count` = 一屏栏数、纸张高度固定，浏览器于是把内容**横向**排成若干栏，
 *   再用 `translateX` 一屏一屏推。这样"翻页"是真实的分栏结果，
 *   而不是"把滚动条切成一段段"（后者会在段落中间断开、还会因为字体不同而错位）。
 *
 * 分页模式的"还有没有下一页"与滚动模式不同：没有"滚到底"这个信号，
 * 判据是**已经在最后一页**（`shouldLoadMorePages`，在 `readerView.ts` 里）。
 *
 * ## 纸张：单页 = 一张居中容器；双页 = 一对相贴的居中容器（用户 2026-10-17 口径）
 *
 * > "翻页方式为单页和双页时，单页应为一个居中容器，双页应为一对居中的容器，
 * >  并且都是跟随自适应大小的。"
 *
 * 落点是三层（几何全部由 [`readerPagedLayout`] 算出，这里只把数值套到 CSS 变量上）：
 *
 * ```
 * .br-stage-paged            ← 阅读区（外圈"桌面"底色，纸张在其中**居中**）
 *   └ .br-paper              ← 纸张容器（宽 = 纸宽、高 = 纸高，`margin: 0 auto`）
 *       └ .br-flow           ← 正文多栏流（宽 = 一屏、四周各内缩一个纸边）
 *           └ .br-face × N   ← **纸页**（宽 = 栏宽 + 2×纸边，N 张逐像素铺满纸张）
 * ```
 *
 * 为什么纸页是**独立的一层**而不是"给每一栏上背景"：CSS 多栏无法直接给单栏上背景色，
 * 而 `column-*` 只作用在**一个盒子**的**内容**上。因此这里用"纸张盒 + `N` 个绝对定位的
 * 纸页层"来表达：纸页在正文之下（`z-index: -1` 或先渲染），正文栏照旧由浏览器排布。
 * 两者只需**宽度相等**就能对齐——`faceWidth = columnWidth + 2·inset`，
 * 而正文栏的外缩正是同一个 `inset`（见 `readerView.ts` 的等式）。
 *
 * "跟随自适应大小" = 纸张宽按可用宽 × 「页面宽度」、高按可用高：面板一大，
 * 纸一大、栏宽变大、正文**按新栏宽重排**（`ResizeObserver` 驱动，不是缩放变换）。
 *
 * ## 仿真背景（图书阴影）
 *
 * 纸张之外是加深的"桌面"，纸张之内是"纸页"——纸色取自**背景预设**（不是另立一套配色，
 * 否则"换背景色"在分页模式下会失效），纸页带柔和投影，双页相贴处加一道**书脊缝**。
 * 关掉「仿真背景（图书阴影）」开关即回到"无纸、无影、无桌面"的朴素分页观感
 * （正文照旧居中分栏，只是没有纸张这层包装）。
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
 * 「阅读选项」的各里，只有翻页方式与页面宽度参与布局计算，其余都是 CSS 变量：
 * 字号 / 行高 / 字间距 / 段间距 / 页边距 / 页宽 / 字体 / 对齐 / 背景 / 文字色 / 亮度。
 * 这样"改字号"不会触发 React 重排 —— 只改一个自定义属性。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, UIEvent } from "react";

import type { Translate } from "../../i18n";
import type { BookContentResult } from "../../shared/types";
import { BookBlocks } from "../viewer/BookBlocks";
import { collectBlockText } from "./bookText";
import {
  accumulateWheelStep,
  bodyClickHidesRails,
  clampReaderPage,
  fractionWorthReporting,
  isInteractiveTarget,
  normalizeWheelDelta,
  readerBodyProfile,
  readerColumnsPerScreen,
  readerPagedLayout,
  readerPagination,
  shouldLoadMorePages,
  READER_DESK_PADDING,
  READER_DESK_PADDING_FULLSCREEN_Y,
  READER_PARA_INDENT_EM,
  READER_SPINE_SHADOW_PX,
  READER_WHEEL_STEP_PX,
  type ReaderBodyProfile,
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
   * 是否处于**全屏**。分页纸张据此把**纵向**桌面留白收到 0（纸张铺满上下）——
   * 用户 2026-10-18 裁决 B："让纸张铺满上下（全屏时不露桌面）"。
   * 横向仍保留一个薄桌面，于是全屏时上下是纸色、左右是桌面色。
   */
  fullscreen?: boolean;
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
  fullscreen = false,
  onBodyClick,
  onPositionChange,
  t,
}: ReaderStageProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  /** 纸张（分页模式的**视口**，不参与平移）：位置探测的基准，见 `reportPosition`。 */
  const paperRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(0);
  /** 分页几何（栏宽 / 栏数 / 页数 / 步进）：一次测量、一处算术。 */
  const [pagination, setPagination] = useState<ReaderPagination>({
    columnWidth: 0,
    columnCount: 1,
    pageCount: 1,
    screenPitch: 1,
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

  /**
   * 阅读区可用空间（**已经扣掉桌面留白**，分页纸张按它算）；`ResizeObserver` 跟随面板尺寸。
   *
   * 取数口径是**内容区**而不是边框盒：`.br-stage` 带 `padding`（桌面留白），
   * 拿 `clientWidth`（含内边距）当"可用宽"会让纸张顶出留白、贴到面板边线上；
   * 而纸张自己是**居中**摆放在内容区里的，差一个留白就会偏。
   *
   * 桌面留白**纵向在窗口模式与全屏模式不同**（全屏纵向为 0 ⇒ 纸张铺满上下），
   * 而这里是 `getComputedStyle` 实测的——CSS 侧已按 `.br-stage-fullscreen` 类切换，
   * 因此测量无需再判一次全屏：读到多少就是多少。`fullscreen` 只用于**重测一次**
   * （类切换后 `clientHeight` 变了，而 ResizeObserver 未必触发）。
   */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setSize({
        width: Math.max(0, el.clientWidth - (Number.isFinite(padX) ? padX : 0)),
        height: Math.max(0, el.clientHeight - (Number.isFinite(padY) ? padY : 0)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // 全屏切换后补测一次：CSS 类变了、内边距随之变化。
  }, [fullscreen]);

  /**
   * 分页**纸张几何**：单页 = 一张纸；双页 = 一对相贴的纸（合成一张更宽的纸）。
   *
   * 全部算术在纯函数 `readerPagedLayout` 里，这里只消费结果：
   * 纸张宽 / 一张纸的绘制宽 / 纸内正文宽 / 栏间距（= 书脊缝）/ 页边距。
   */
  const pagedLayout = useMemo(
    () =>
      readerPagedLayout({
        availableWidth: size.width,
        availableHeight: size.height,
        pageWidthPercent: settings.pageWidth,
        // 「页边距」现在是**纸张内部**的正文外边距（不再是纸张外的桌面留白）。
        pageMargin: settings.pageMargin,
        columns,
      }),
    [columns, settings.pageMargin, settings.pageWidth, size.height, size.width],
  );

  /**
   * 分页几何重算：**内容流的总宽**（`scrollWidth`）决定栏数与页数。
   *
   * 依赖 `pages` / `size` / `columns` / `pageWidth` / `pageMargin`：取回新的一页、
   * 面板变宽、切换单双页、拖「页面宽度」或「页边距」滑条都要重算。
   * 用 `requestAnimationFrame` 等一次布局——多栏排版是同步发生的，
   * 但 React 提交后立刻读 `scrollWidth` 会读到**上一帧**的宽度。
   */
  useEffect(() => {
    if (!paged) {
      setPagination({ columnWidth: 0, columnCount: 1, pageCount: 1, screenPitch: 1 });
      setPage(0);
      return;
    }
    const el = flowRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const next = readerPagination(
        el.scrollWidth,
        pagedLayout.contentWidth,
        columns,
        pagedLayout.gap,
      );
      setPagination(next);
      setPage((current) => clampReaderPage(current, next.pageCount));
    });
    return () => cancelAnimationFrame(frame);
  }, [paged, pages, pagedLayout.contentWidth, pagedLayout.gap, columns]);

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
   * ## 探测点的基准确认（2026-10-17 实测修正）
   *
   * `.br-stage` 带 `padding: var(--br-page-margin)`，**上限 80px**。若以舞台左上角
   * 往里 40px 取探测点，页边距一旦超过 40px，这个点就落在**内边距**里：
   * `elementFromPoint` 返回舞台本身，`closest("[data-page-index]")` 得到 `null`，
   * `visibleIndex` 变成 `-1` → 章节数退回第 1 章（用户报过这个现象的一个触发路径）。
   *
   * 早期因此改用 `.br-flow`（内容框，位于内边距之内）——但那一版**漏了一件事**：
   * 分页的平移就挂在 `.br-flow` 自己身上（`translateX(-page · pitch)`），
   * 于是 `flowRect.left` 随翻页一直往左跑，第 1 屏起探测点就**跑出视口**
   * （实测 `-812px`，`elementFromPoint` 返回 `null`），`visibleIndex` 同样退成 `-1`。
   * 这条由 `tools/reader-probe-verify.mjs` 在真实 styles.css 上量出来（见文件头）。
   *
   * 正确基准是**纸张 `.br-paper`**：它是**视口**、不参与平移（平移后的内容被它的
   * `overflow: hidden` 裁掉），因此取点是"视口内一个固定位置"，三屏实测都稳定命中。
   * 纸张左缘再往里一个纸边（`--br-page-inset`）即正文可见区，且不受页边距影响
   * （页边距在纸张**之外**）。**滚动模式**没有平移，仍用内容框（它随滚动上移，语义正确）。
   */
  const reportPosition = useCallback(() => {
    if (!onPositionChange) return;
    const host = hostRef.current;
    const flow = flowRef.current;
    if (!host || !flow) return;

    const hostRect = host.getBoundingClientRect();
    const flowRect = flow.getBoundingClientRect();

    /*
     * 探测点：**分页模式必须以纸张（视口）为基准，不能以内容框 `.br-flow` 为基准**。
     *
     * 这是一处**实测出来的真实缺陷**（本轮改用 `tools/reader-probe-verify.mjs`
     * 在真实 styles.css + 真实多栏排版上量出来的，修复前它在翻页后每次都命中）：
     * 分页的平移挂**在 `.br-flow` 自己身上**（`translateX(-page · pitch)`），
     * 于是 `flowRect.left` 随翻页一直往左跑——实测第 1 屏起 `flowRect.left` 就到
     * `-812px`、第 2 屏 `-1664px`，`probeX` 直接落到**视口之外**：
     * `elementFromPoint` 返回 `null` → `closest("[data-page-index]")` 得到 `null`
     * → `visibleIndex = -1` → **章节数退回第 1 章 / 章节标题与目录高亮一起错位**
     * （正是用户此前报过的那类现象，只是触发路径是"翻页"而不是"页边距过大"）。
     *
     * 纸张 `.br-paper` **不参与平移**（它是视口，`overflow: hidden` 裁剪平移后的内容），
     * 因此以它取点是**视口内一个固定位置**：实测三屏都稳定命中同一项。
     * 纸张左缘再往里一个**页边距**（`--br-page-margin`）就落在正文可见区内；
     * 页边距在纸张**内部**（`padding`），因此这个点必然落在正文栏里。
     * 滚动模式没有平移，仍用内容框（它随滚动上移，语义正确）。
     */
    const basis = paged && paperRef.current ? paperRef.current.getBoundingClientRect() : flowRect;
    const probeX = paged
      ? basis.left + pagedLayout.margin + 4
      : basis.left + Math.min(basis.width / 2, 40);
    const rawY = Math.max(hostRect.top + 2, basis.top + 2);
    const probeY = Math.min(rawY, Math.min(hostRect.bottom, basis.bottom) - 2);

    const probe = document.elementFromPoint(probeX, probeY);
    const pageEl = probe?.closest?.("[data-page-index]") as HTMLElement | null;

    let visibleIndex = -1;
    let offsetInPage = 0;
    if (pageEl) {
      visibleIndex = Number(pageEl.dataset.pageIndex ?? "-1");
      const pageRect = pageEl.getBoundingClientRect();
      if (paged) {
        /*
         * 分页模式的**页内比例**：语义是"**这一项（`.br-page`）被读了多少**（0–1）"。
         *
         * 为什么分母必须是**这一项的宽度**（`pageRect.width`）：
         * 消费方 `readerPositionFromPage(index, offset, cursors)` 算的是
         * `item.start + offset × item.span`，而 `span` 是**这一项的字符总量**——
         * 两边都是"项的百分比"，才能相乘。
         *
         * `.br-page` 是内容流里的普通块：一项若长到跨栏，它的 `getBoundingClientRect()`
         * 并集盒就横跨**该项的全部栏**，因此 `pageRect.width` 正是"这一项的总内容宽"。
         * 分子 = 视口内容左缘相对该项左缘的位置 = 这一项已被读过的宽度。
         *
         * **反面口径（实测会错）**：把同一个差值按"屏内栏数 ÷ 屏宽"换算成
         * "读到屏内第几栏"。这在数项短于一屏时看着也对，但项一跨栏就**饱和**——
         * 实测三屏得到 0 / 2.078 / 4.156，`clamp01` 把它压成 1，
         * 于是**第一屏翻页后进度直接跳到项尾**（`tools/reader-probe-verify.mjs` 量出）。
         *
         * 视口内容左缘用 `paperRect.left + margin`（**纸张**的左缘 + 纸内页边距），
         * 而不是 `hostRect.left`：纸张在阅读区里**居中**，桌面留白在纸张之外，
         * 拿舞台的框当视口会差一个"居中留白"。
         */
        const viewportLeft =
          (paperRef.current?.getBoundingClientRect().left ?? 0) + pagedLayout.margin;
        offsetInPage =
          pageRect.width > 0 ? (viewportLeft - pageRect.left) / pageRect.width : 0;
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
  }, [onPositionChange, paged, pagedLayout.margin]);

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
  }, [pages, paged, page, pageCount, size.width, size.height, reportPosition]);

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

  /**
   * **正文语言档**（`cjk` / `latin`）：决定段落首行缩进等排印参数（见 `readerView`）。
   *
   * 不能只看当前页：章节开头常是一行短标题，判不出整本书的语言，而**同一本书的
   * 缩进必须一致**（否则会在章与章之间跳变）。因此扫**已载入的全部页**取一次判定。
   *
   * **必须把块渲染的正文也算进来**（`item.blocks`）：EPUB / Markdown 的正文是
   * **块模型**、`text` 恒为 `null`——只看 `text` 的话，一本中文 EPUB 永远判成
   * `latin`、首行缩进只有 1em（而中文书刊的口径是 2em）。
   * 这是本轮实测发现的一处疏漏（`txt` 走 `text`、`epub` 走 `blocks`）。
   *
   * 依赖 `pages`：加载更多页会让样本变多。判定是对**已载入文本**做的，
   * 而首行缩进是"每段都一样"的口径，样本变多只会让判定更稳、不会让页面跳变
   * （`readerBodyProfile` 有最短字符数门槛，短样本沿用上一档）。
   */
  const bodyProfile = useMemo<ReaderBodyProfile>(() => {
    let sample = "";
    for (const item of pages) {
      if (item.text) sample += item.text;
      if (item.blocks) sample += collectBlockText(item.blocks);
      // 收集到足够判定的量就停（扫描全量文本没有额外收益）。
      if (sample.length > 4000) break;
    }
    return readerBodyProfile(sample, "latin");
  }, [pages]);

  const style = useMemo(
    () =>
      ({
        "--br-font-size": `${settings.fontSize}px`,
        "--br-line-height": String(settings.lineHeight / 100),
        "--br-letter-spacing": `${settings.letterSpacing}px`,
        // 「段落间距」：**默认 0**（见 readerView 的排印口径）。滑块仍可加间距。
        "--br-paragraph-spacing": `${settings.paragraphSpacing}px`,
        // 「页边距」现在是**纸张内部**的正文外边距（不再是纸张外的桌面留白）。
        "--br-page-margin": `${pagedLayout.margin}px`,
        // 桌面留白：横向恒为固定小留白；纵向在全屏时为 0（纸张铺满上下，裁决 B）。
        "--br-desk-x": `${READER_DESK_PADDING}px`,
        "--br-desk-y": `${
          fullscreen ? READER_DESK_PADDING_FULLSCREEN_Y : READER_DESK_PADDING
        }px`,
        "--br-max-width": `${settings.pageWidth}%`,
        "--br-columns": String(columns),
        // 栏间距 = 书脊缝 = 2×页边距（见 `readerPagedLayout` 的推导）。
        "--br-column-gap": `${pagedLayout.gap}px`,
        "--br-spine": `${READER_SPINE_SHADOW_PX}px`,
        "--br-brightness": String(settings.brightness / 100),
        // 段落首行缩进：按语言档（中文 2em / 拉丁 1em，Readium CSS 口径）。
        "--br-para-indent": `${bodyProfile === "cjk" ? READER_PARA_INDENT_EM.cjk : READER_PARA_INDENT_EM.latin}em`,
        // 纸张宽高与"一张纸"的绘制宽：分页模式的三个几何量（见 `readerPagedLayout`）。
        ...(paged
          ? {
              "--br-paper-w": `${pagedLayout.paperWidth}px`,
              "--br-paper-h": `${pagedLayout.height}px`,
              "--br-face-w": `${pagedLayout.faceWidth}px`,
            }
          : {}),
      }) as CSSProperties,
    [bodyProfile, columns, fullscreen, paged, pagedLayout, settings],
  );

  const className = [
    "br-stage",
    `br-bg-${settings.bg}`,
    `br-text-${settings.text}`,
    `br-font-${settings.fontFamily}`,
    `br-align-${settings.textAlign}`,
    paged ? "br-stage-paged" : "br-stage-scroll",
    // 仿真背景（图书阴影）：**只对分页模式**生效（用户裁决 A）——滚动模式保持现状
    // （它的正文高度随内容增长，没有"一页纸"可言，给整段套一张纸只会让投影随滚动消失）。
    paged && settings.simulatedPageBackground ? "br-simulated" : "",
    // 双页的**书脊缝**只在这一档画（单页没有接缝）。
    paged && columns === 2 ? "br-spread" : "",
    // 全屏：纵向桌面留白收到 0（纸张铺满上下）。
    fullscreen ? "br-stage-fullscreen" : "",
  ]
    .filter(Boolean)
    .join(" ");

  /**
   * 正文流的内容（分页与滚动两种包装共用一份）。
   *
   * 每页包一层带 `data-page-index` 的容器：位置探测靠它认出"当前显示的是第几页"。
   *
   * 为什么必须逐页标记：绝对位置要由**页序号**精确给出（章节数与目录对得上
   * 全靠这一点），而不是靠"整段滚动了百分之多少"去猜——后者与章数不成比例。
   *
   * 抽取成变量是为了让两种包装（有纸张 / 无纸张）**共用同一份内容**：
   * 复制两份必然漂移（改一处的渲染、另一处还是旧的）。
   */
  const flowContent = (
    <>
      <div className="vr-content br-content">
        {pages.map((item, index) => (
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
    </>
  );

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
        /*
         * 分页模式套一层**纸张**（`.br-paper`，居中、跟随自适应大小）；
         * 滚动模式保持原样（正文直接铺在阅读区里，`.br-flow` 的 `max-width` 居中）。
         *
         * 纸张里的层次（自下而上）：**纸页层**（`.br-face-layer`，`N` 张相贴的纸）
         * → **正文多栏流**（`.br-flow`）。纸页层必须在正文之下，且 `pointer-events: none`
         * ——它是视觉层，不能拦住"点击正文收起两栏"与划词。
         */
        paged ? (
          <div className="br-paper" ref={paperRef}>
            {settings.simulatedPageBackground && (
              <div className="br-face-layer" aria-hidden="true">
                {Array.from({ length: columns }, (_, index) => (
                  <div key={index} className="br-face" />
                ))}
              </div>
            )}
            <div
              className="br-flow"
              ref={flowRef}
              // 平移**一张纸**（= `contentWidth + gap`，恒等于 `paperWidth`），不是"一栏"——
              // 双页模式下按一栏平移会让两屏**重叠一栏**（见 `readerPagination` 的推导）。
              // 关闭过渡：用户 2026-10-18 口径"**不是滑动切换正文，而是刷新切换**"——
              // 分页是"翻到下一页"，不是"把纸滑过去"；滑动会让人以为正文在连续滚动。
              style={{ transform: `translateX(-${page * pagination.screenPitch}px)` }}
            >
              {flowContent}
            </div>
          </div>
        ) : (
          <div className="br-flow" ref={flowRef}>
            {flowContent}
          </div>
        )
      )}
    </div>
  );
}
