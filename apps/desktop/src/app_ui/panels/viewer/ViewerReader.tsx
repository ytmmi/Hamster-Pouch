/**
 * 查看器：**正文阅读区**（`txt` / `md` / `epub`）。
 *
 * ## 布局与自适应（用户 2026-10-09 口径）
 *
 * "显示范围为查看器面板大小"、"根据查看器自适应展示单栏或双栏，默认为单栏"，
 * 追问后裁定**纯自动、不做设置项**——因此：
 * - 分栏数由**面板宽度**决定（`readerColumns`，阈值 900px 可用宽）；
 * - 字号也随宽度给一档（`readerFontSize`）；
 * - 分栏用 CSS `column-count`：内容是**文本流**，交给浏览器断栏最省事，
 *   也天然支持"一栏读满再读下一栏"。
 *
 * ## 滚动与按需取数
 *
 * 阅读区自己滚（面板其余部分不动）。滚到接近底部时取下一页（`shouldLoadMore`），
 * 这就是用户要的"面板内滚动看更多、滚动时按需缓存"。
 *
 * 双栏下 `column-count` 会把内容按**高度**分栏，因此"读到第一栏底部"时滚动位置
 * 只到一半——此时**先取下一页**（`firstColumnEnd` 之前就触发），否则用户读到
 * 第一栏末尾会发现没有后续内容。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, UIEvent } from "react";

import { useApp } from "../../core/AppContext";
import { BookBlocks } from "./BookBlocks";
import {
  firstColumnEnd,
  isImageOnly,
  readerColumns,
  readerFontSize,
  shouldLoadMore,
} from "./viewerReaderView";
import { useViewerBookContent } from "./useViewerBookContent";

export function ViewerReader(): JSX.Element {
  const app = useApp();
  const { pages, loading, error, hasMore, loadMore } = useViewerBookContent();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  /** 面板宽度（分栏与字号都按它自适应）；`ResizeObserver` 跟随面板尺寸变化。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = readerColumns(width);
  const fontSize = readerFontSize(width);

  const style = useMemo(
    () =>
      ({
        "--vr-columns": String(columns),
        "--vr-font-size": `${fontSize}px`,
      }) as CSSProperties,
    [columns, fontSize],
  );

  /** 滚动到底部附近 → 取下一页（"面板内滚动看更多、滚动时按需缓存"）。 */
  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (shouldLoadMore(el.scrollTop, el.scrollHeight, el.clientHeight, hasMore)) {
        loadMore();
      }
    },
    [hasMore, loadMore],
  );

  /**
   * 首屏内容不足一屏时也要继续取：`scroll` 事件不会因为"内容变多"而自动触发，
   * 用户看到的会是一小段正文加一大片空白，且没有任何方式触发下一页。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || loading) return;
    // 双栏下"第一栏读完"的位置比底部早，因此用 `firstColumnEnd` 作为下界。
    const trigger = firstColumnEnd(el.scrollHeight, el.clientHeight, columns);
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollTop >= trigger) {
      loadMore();
    }
  }, [pages, hasMore, loading, columns, loadMore]);

  const first = pages[0];
  const isText = first?.format === "text";
  const isEpub = first?.format === "epub";
  /** Markdown 与 epub 一样走**块渲染**（后端产出的是同一套块）。 */
  const isBlocked = isEpub || first?.format === "markdown";
  const imageOnly = isBlocked && first.blocks ? isImageOnly(first.blocks) : false;

  return (
    <div
      className="vr-scroll"
      ref={scrollRef}
      style={style}
      onScroll={handleScroll}
      tabIndex={0}
    >
      {error && <span className="placeholder">{error}</span>}
      {!error && !first && loading && (
        <span className="placeholder">{app.t("common.loading")}</span>
      )}
      {/* 非文本类 / 无内容哈希：空结果（不是错误），给出明确占位。 */}
      {!error && !first && !loading && (
        <span className="placeholder">{app.t("viewer.noContent")}</span>
      )}

      {first && (
        <>
          {/* 章节进度（epub）：让"只显示开头"这件事对用户可见。 */}
          {isEpub && first.section_count !== null && (
            <div className="vr-meta dim">
              {app.t("viewer.sectionOf", {
                n: first.section + 1,
                total: first.section_count,
              })}
              {first.title ? ` · ${first.title}` : ""}
            </div>
          )}
          {/* 纯文本 / Markdown 的编码提示：让"读出来是乱码"这件事可被用户判断。 */}
          {(isText || isBlocked) && first.encoding && first.encoding !== "UTF-8" && (
            <div className="vr-meta dim">
              {app.t("viewer.encoding", { enc: first.encoding })}
            </div>
          )}

          <div className={`vr-content${imageOnly ? " vr-image-only" : ""}`}>
            {pages.map((page, index) =>
              page.format === "text" ? (
                <p key={index} className="vr-text">
                  {page.text}
                </p>
              ) : (
                <BookBlocks
                  key={index}
                  blocks={page.blocks ?? []}
                  imageFallback={app.t("viewer.imageUnavailable")}
                />
              ),
            )}
          </div>

          {loading && <div className="vr-more dim">{app.t("common.loading")}</div>}
          {!loading && !hasMore && (
            <div className="vr-more dim">{app.t("viewer.endOfPreview")}</div>
          )}
        </>
      )}
    </div>
  );
}
