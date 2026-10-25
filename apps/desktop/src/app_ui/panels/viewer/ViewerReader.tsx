/**
 * 查看器：**正文阅读区**（`txt` / `md` / `epub` / `pdf`）。
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
 * ## PDF：不分栏（2026-10-11）
 *
 * PDF 的每一"页"是一张**整页位图**（后端栅格化，见 `commands/book.rs` 的
 * `read_pdf_page`），不是文本流。把它塞进 `column-count` 只会让一页被拦腰断成两栏，
 * 读起来既不是原貌也不是连续文本。因此 PDF **恒单栏**（`--vr-columns: 1`，
 * 由 `.vr-content.vr-pdf` 在 CSS 侧钉死），逐页纵向堆叠、滚动看后续页
 * （用户口径："逐页栅格化为图片，滚动看后续页"）。
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

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
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

  const first = pages[0];
  const isText = first?.format === "text";
  const isEpub = first?.format === "epub";
  /** Markdown 与 epub 一样走**块渲染**（后端产出的是同一套块）。 */
  const isBlocked = isEpub || first?.format === "markdown";
  /**
   * PDF 也走**块渲染**（后端把一页栅格化成一张 `image` 块，与 EPUB 的章节插图
   * 是同一个块种类），因此渲染器一行都不用改。差别只在**布局**：
   * PDF 不分栏、页面图按整宽显示（见文件头）。
   */
  const isPdf = first?.format === "pdf";

  /**
   * 分栏数：PDF **恒单栏**（整页位图不该被断成两栏）。
   *
   * 字号仍随宽度给一档——它不影响图片，但下面 `.vr-meta` 的进度提示要用。
   */
  const columns = isPdf ? 1 : readerColumns(width);
  const fontSize = readerFontSize(width);

  /**
   * 阅读区**实测高度**（px）——图片"按容器高封顶"要用它，见下面的 `--vr-page-h`。
   *
   * ## 为什么需要它（需求 3 + 需求 5 的交叉点）
   *
   * koodo-reader 的图片排版只有一条硬规则（内核 `koodit` 的
   * `src/utils/layoutUtil.ts` 的 `handleImageSize()`）：图片按可用父容器等比缩放，
   * 且**当按宽度算出的最大高超过容器高时，改按容器高再缩一档**——它的图片
   * **宁可缩小，也不跨页/跨栏被切断**。全仓 `break-before|page-break-before`
   * **0 命中**：koodo 没有任何"图片独占一页"的分页符机制（"单独看大图"是点击后的
   * 弹层 UI，不是排版）。
   *
   * 我们照这条口径复刻，就能让"图片放不下当前栏 ⇒ 整张图连同图注被推到下一栏"成为
   * **自然结果**（`break-inside: avoid` + 高度封顶），而**不引入** koodo 没有的
   * 分页符。封顶用的"容器高"就是本阅读区的内容高：查看器的滚动区没有固定纸张高，
   * 因此用它自己的可视高（去掉上下内边距）。
   *
   * 取数用 `ResizeObserver` 实测（与上面分栏同一条路径，不另立第二个 observer）：
   * 面板一改尺寸，`width` 与高度一起重测；改字号也会改变内容高，所以 `fontSize`
   * 变化时补测一次。
   */
  const [viewHeight, setViewHeight] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const computed = getComputedStyle(el);
      const padY =
        (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
      setViewHeight(Math.max(0, el.clientHeight - padY));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // 字号变化会让内容高变化；`ResizeObserver` 只跟盒子，因此显式补一次。
  }, [fontSize]);

  const style = useMemo(
    () =>
      ({
        "--vr-columns": String(columns),
        "--vr-font-size": `${fontSize}px`,
        // 图片"按容器高封顶"的两个量（见上面 `viewHeight` 的说明）。
        // 未测量时给 `100vh` / 12px 兜底：宁可封得松一点，也不要算出 0 高把图压没。
        "--vr-page-h": `${viewHeight > 0 ? viewHeight : "100vh"}`,
        "--vr-page-margin": "12px",
      }) as CSSProperties,
    [columns, fontSize, viewHeight],
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

  const imageOnly = (isBlocked || isPdf) && first?.blocks ? isImageOnly(first.blocks) : false;

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
      {/* 非"书" / 无内容哈希 / 打不开的 PDF：空结果（不是错误），给出明确占位。 */}
      {!error && !first && !loading && (
        <span className="placeholder">{app.t("viewer.noContent")}</span>
      )}

      {first && (
        <>
          {/* 章节进度（epub）/ **页进度**（pdf）：让"只显示开头"这件事对用户可见。 */}
          {isEpub && first.section_count !== null && (
            <div className="vr-meta dim">
              {app.t("viewer.sectionOf", {
                n: first.section + 1,
                total: first.section_count,
              })}
              {first.title ? ` · ${first.title}` : ""}
            </div>
          )}
          {isPdf && first.section_count !== null && (
            <div className="vr-meta dim">
              {app.t("viewer.pageOf", {
                n: first.section + 1,
                total: first.section_count,
              })}
            </div>
          )}
          {/* 纯文本 / Markdown 的编码提示：让"读出来是乱码"这件事可被用户判断。 */}
          {(isText || isBlocked) && first.encoding && first.encoding !== "UTF-8" && (
            <div className="vr-meta dim">
              {app.t("viewer.encoding", { enc: first.encoding })}
            </div>
          )}

          {/* 每一"页"（epub 的一章 / md 的一批顶层块 / pdf 的一页）各包一层
              `.vr-page`：一是给"每章另起一页"的反面判据一个可命中的边界，
              二是让 `data-page-index` 与阅读器的 `.br-page` 同形，门禁与
              `tools/reader-layout-verify.mjs` 可以按同一口径量两处。

              `data-page-break-before` = "本页不是第一页"（`index > 0`）：换页判据
              因此落在**页容器**上，而不是"往块列表里塞一个换页标记块"。两者相比，
              前者不占内容位置（不会让 `:first-child` / `:last-child` 语义错位，
              也不会在页首留下一个空块），且对每一种格式（epub / md / pdf）都成立。
              EPUB 的章节序号语义与之同源：后端在 `book.content` 里给出 `section`，
              页序号就是它。

              为什么不是把页之间拼成一条连续的流：后端每页的 `blocks` 是**独立**
              的一段（章节 / 块批次），拼接后"这一章在哪儿结束"在 DOM 里就没有
              任何标记，CSS 无法在章间换页——这正是需求 4 要修的东西。

              `vr-multicolumn`（2026-10-18 修的一处真实缺陷）：单栏还是双栏由
              `columns >= 2` 决定，作为**类名**下发。此前 CSS 侧靠
              `.vr-content[style*="--vr-columns: 1"]` 去匹配**内联样式的字符串**，
              而 React 序列化后的实际文本是 `--vr-columns:1`（**冒号后没有空格**），
              于是"单栏"那条永远匹配不上、多栏那条反而命中——单栏模式下每一页都
              被 `break-before: column` 推到下一栏，正文整页移出可视区。
              真机探针（`archive/…/css-pagebreak-probe.mjs`）把这条量了出来。
              类名判据与"变量怎么写"无关，结构性地消除了这类依赖。 */}
          <div
            className={`vr-content${imageOnly ? " vr-image-only" : ""}${isPdf ? " vr-pdf" : ""}${
              columns >= 2 ? " vr-multicolumn" : ""
            }`}
          >
            {pages.map((page, index) => (
              <div
                className="vr-page"
                key={index}
                data-page-index={index}
                data-page-break-before={index > 0 ? "" : undefined}
              >
                {page.format === "text" ? (
                  <p className="vr-text">{page.text}</p>
                ) : (
                  <BookBlocks
                    blocks={page.blocks ?? []}
                    imageFallback={app.t("viewer.imageUnavailable")}
                  />
                )}
              </div>
            ))}
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
