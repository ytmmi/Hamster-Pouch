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
import type { CSSProperties, KeyboardEvent, UIEvent, WheelEvent } from "react";

import type { Translate } from "../../i18n";
import type { BookContentResult } from "../../shared/types";
import { BookBlocks } from "../viewer/BookBlocks";
import {
  clampReaderPage,
  readerColumnsPerScreen,
  readerPageCount,
  readerPageWidth,
  shouldLoadMorePages,
  READER_COLUMN_GAP,
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
  t,
}: ReaderStageProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const columns = readerColumnsPerScreen(settings.viewMode);
  const paged = settings.viewMode !== "scroll";

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

  const pageWidth = readerPageWidth(width, columns, READER_COLUMN_GAP);

  /**
   * 分页模式的页数：**内容流的总宽**决定。
   *
   * 依赖 `pages` 与 `pageWidth`：取回新的一页、或面板变宽（栏宽变化）都要重算。
   * 用 `requestAnimationFrame` 等一次布局——多栏排版是同步发生的，
   * 但 React 提交后立刻读 `scrollWidth` 会读到**上一帧**的宽度。
   */
  useEffect(() => {
    if (!paged) {
      setPageCount(1);
      setPage(0);
      return;
    }
    const el = flowRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const next = readerPageCount(el.scrollWidth, pageWidth, READER_COLUMN_GAP);
      setPageCount(next);
      setPage((current) => clampReaderPage(current, next));
    });
    return () => cancelAnimationFrame(frame);
  }, [paged, pages, pageWidth]);

  /** 滚动模式：滚到接近底部 → 取下一页。 */
  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
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
    [hasMore, onNeedMore, settings.viewMode],
  );

  /** 分页模式：滚轮 / 方向键 / PageUp·PageDown 翻页；翻到最后一页继续取下一页。 */
  const flipTo = useCallback(
    (target: number) => {
      const next = clampReaderPage(target, pageCount);
      setPage(next);
      if (next >= pageCount - 1) onNeedMore();
    },
    [onNeedMore, pageCount],
  );

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      if (!paged) return;
      // 只认主要方向（触控板横滑与竖滚都可能出现；取绝对值大的那个）。
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      flipTo(delta > 0 ? page + 1 : page - 1);
    },
    [flipTo, page, paged],
  );

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
        "--br-page-width": `${pageWidth}px`,
        "--br-brightness": String(settings.brightness / 100),
      }) as CSSProperties,
    [columns, pageWidth, settings],
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
      onScroll={paged ? undefined : handleScroll}
      onWheel={paged ? handleWheel : undefined}
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
          style={paged ? { transform: `translateX(-${page * (pageWidth + READER_COLUMN_GAP)}px)` } : undefined}
        >
          <div className="vr-content br-content">
            {pages.map((item, index) =>
              item.format === "text" ? (
                <p key={index} className="vr-text">
                  {item.text}
                </p>
              ) : (
                <BookBlocks
                  key={index}
                  blocks={item.blocks ?? []}
                  imageFallback={t("viewer.imageUnavailable")}
                />
              ),
            )}
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
