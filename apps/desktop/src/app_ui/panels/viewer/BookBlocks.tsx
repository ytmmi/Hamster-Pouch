/**
 * 查看器：**正文块的渲染**（EPUB 与 Markdown **共用**）。
 *
 * ## 这里没有（也不能有）HTML 注入
 *
 * 后端把 XHTML / Markdown 的**受控白名单**做在解析侧，交给前端的只有
 * `BookBlockItem` / `BookSpanItem` 这样的纯数据（见 `hp-book` 的 `block` 与
 * `markdown` 模块文档）。因此本文件用 `<h2>`–`<h4>` / `<p>` / `<img>` / `<code>`
 * 这些 **React 元素**渲染，**不存在** `dangerouslySetInnerHTML` 的入口——不是
 * "我们记得别用"，而是**没有 HTML 可注入**。
 *
 * 书自带的**颜色 / 底色 / 字号**（`color` / `bg` / `size_em`）同理：它们是后端
 * 白名单给出的 CSS **值**，这里写进 React 的 `style` 对象（见 `spanStyle`）。
 * `style={{ color }}` 与 `dangerouslySetInnerHTML` 的区别是结构性的：值只能是
 * **一个声明块里的一个属性值**，无法闭合声明块、无法引入选择器、无法携带标签——
 * 而解析侧已经先一步拒掉了 `url(...)`/`expression(...)` 这类畸形值。
 *
 * ## 为什么两种格式共用这一个渲染器
 *
 * EPUB 与 Markdown 产出的是**同一套块**（后端 `hp_book::block`），共用渲染器
 * 意味着"改一处样式"只会改一处，两种格式的观感不会各自漂移。EPUB 只用到其中
 * 一部分 `kind`（不产表格 / 任务列表 / 分隔线），未用到的分支自然不会命中。
 *
 * ## 行内样式的套用顺序
 *
 * `styles` 是**叠加的标记列表**（后端已归一化成固定次序，`***x***` = `strong` +
 * `emphasis`）。本文件按一条固定的顺序从内到外套元素，因此同一组样式永远得到
 * 同一棵元素树——不依赖数组顺序之外的任何东西。
 *
 * **顺序口径（2026-10-18 追加三种 EPUB 装饰后钉死）**：
 * `code` → `emphasis` → `strong` → `strikethrough` → `superscript` → `subscript`
 * → `highlight` → `underline` → `small_caps`
 * ——前六项是原表、顺序未动（既有语义不许漂移）；后三项按"标记强度递增"追加在
 * 外层：高亮（`<mark>`）是底色、下划线是线段、小型大写是字形，三者互不遮挡，
 * 谁在外层都不改变可见结果，但**固定住**才能让"同一组样式 → 同一棵树"成立。
 */

import { memo, useState, createElement, type JSX } from "react";
import type { ReactNode } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { BookBlockItem, BookSpanItem } from "../../shared/types";

/**
 * 一张正文插图。
 *
 * 失败态用 **React 状态**而不是 `onError` 里直接改 DOM：后者绕过了 React 的
 * 渲染，一旦父级重渲（例如面板变宽触发分栏重算）就会被还原成破图。
 */
function BookImage({ path, fallback }: { path: string; fallback: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="vr-image-fallback">{fallback}</span>;
  }
  return (
    <img
      className="vr-image"
      src={convertFileSrc(path)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// ==================== 行内内容 ====================

/**
 * 行内样式 → 元素标签 + 类名（**套用顺序即此表顺序**，从内到外）。
 *
 * 顺序取"语义嵌套的自然顺序"：`<strong><em>x</em></strong>` 是常见写法，
 * 反过来虽合法但更少见；固定一张表才能让"同一组样式 → 同一棵树"成立。
 *
 * 类名**不直接用 `vr-${style}`**：行内代码的类名会撞上代码块（`<pre class="vr-code">`），
 * 两者字号/边框/断栏规则完全不同。故这里显式给出类名。
 *
 * ## 2026-10-18 追加的三种 EPUB 装饰（需求 5：参考 koodo-reader）
 *
 * koodo-reader 的默认样式表（`src/assets/lib/kookit.min.js` 的
 * `StyleHelper.getDefaultCss`）里，书自带的标记只保留**原样**、由阅读器注入的规则
 * 一律带 `!important` 覆盖（例如 `isUnderline` 开关下推
 * `text-decoration: underline !important`）——它靠"用户设置是否开启"决定要不要
 * 压掉书自带的装饰。我们这里没有"覆盖装饰"的设置项，因此**原样保留**书里的装饰，
 * 再用下面三条类名给它一个稳定、可主题化的落点：
 *
 * - `highlight` → `<mark>`：**用语义标签而不是 `<span class="vr-highlight">` 加底色**。
 *   理由是它本来就是 `<mark>` 的语义（EPUB 的 `<mark>` 与 Gutenberg 的 `<mark>`），
 *   浏览器默认就有底色（不必依赖本项目的主题 token），且**可被无障碍工具识别**为
 *   "被标记的文字"。底色的最终值由 CSS 给（`.vr-highlight`），仍然可主题化。
 * - `underline` → `<u>`（下划线；`text-decoration` 的默认值就是 `underline`）。
 * - `small_caps` → `<span class="vr-small-caps">` + `font-variant: small-caps`
 *   （没有专有 HTML 标签，只能走 `<span>`）。
 */
const STYLE_ORDER = [
  { style: "code", tag: "code", className: "vr-code-inline" },
  { style: "emphasis", tag: "em", className: "vr-emphasis" },
  { style: "strong", tag: "strong", className: "vr-strong" },
  { style: "strikethrough", tag: "del", className: "vr-strikethrough" },
  { style: "superscript", tag: "sup", className: "vr-superscript" },
  { style: "subscript", tag: "sub", className: "vr-subscript" },
  { style: "highlight", tag: "mark", className: "vr-highlight" },
  { style: "underline", tag: "u", className: "vr-underline" },
  { style: "small_caps", tag: "span", className: "vr-small-caps" },
] as const;

/** 脚注引用渲染成上标编号（`[1]`）。 */
function isFootnote(span: BookSpanItem): boolean {
  return span.styles.includes("footnote");
}

/**
 * 书自带的**字号倍数**的安全区间。
 *
 * 为什么必须夹紧：`size_em` 来自书里写的 `font-size`（可能是 `3000%` 这种畸形值），
 * 而渲染侧的容器是**一栏**——放开了会让那一栏只剩一两个字，且 `column-count`
 * 下这类"超宽内容"会直接把栏宽顶破（正文溢出纸面）。夹紧是**渲染侧**的口径，
 * 后端如实上报书里写了什么（那边的值不动）。
 */
const SPAN_SIZE_MIN_EM = 0.5;
const SPAN_SIZE_MAX_EM = 4;

/**
 * 行内片段 → React `style` 对象。
 *
 * 只从 `BookSpanItem` 的**三个白名单字段**构造，**不做任何字符串拼接**：
 * - `color` / `bg` → `color` / `backgroundColor`；
 * - `size_em` → `fontSize: "1.5em"`（em 而不是 px：字号跟阅读器的字号设置缩放，
 *   书里写"比正文大 50%"就该在用户把正文字号调大后仍然大 50%）。
 *
 * 为什么不把颜色也写进类名：颜色是**书自己的数据**，数量无上界，类名会把样式表
 * 撑爆；写进 `style` 则天然按元素作用域。
 */
function spanStyle(span: BookSpanItem): {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
} {
  const style: { color?: string; backgroundColor?: string; fontSize?: string } = {};
  if (span.color) style.color = span.color;
  if (span.bg) style.backgroundColor = span.bg;
  if (span.size_em !== null && Number.isFinite(span.size_em)) {
    const em = Math.min(SPAN_SIZE_MAX_EM, Math.max(SPAN_SIZE_MIN_EM, span.size_em));
    // `em` 单位带在值里（不是 CSS 里的裸数字），因此这里只格式化数值。
    style.fontSize = `${em}em`;
  }
  return style;
}

/**
 * 渲染一段行内片段：样式 → 链接 → 图片，按固定顺序套元素。
 *
 * 图片的 alt 文本不重复渲染成文字（否则"图片 + 下面一行 alt"看着像重复内容），
 * 但**空 alt** 时保留一个可访问的说明（`fallback`）。
 */
function Span({
  span,
  fallback,
  keyBase,
}: {
  span: BookSpanItem;
  fallback: string;
  keyBase: string;
}): JSX.Element {
  if (span.image) {
    const image = <BookImage path={span.image} fallback={fallback} />;
    // `[![alt](img)](link)`：链接里的图片保留链接（真实语料里有这种写法）。
    return span.href ? (
      <a
        className="vr-link"
        href={span.href}
        target="_blank"
        rel="noreferrer noopener"
      >
        {image}
      </a>
    ) : (
      image
    );
  }

  // 脚注引用：渲染成上标编号，不把标签当正文。
  let node: JSX.Element = isFootnote(span) ? (
    <sup className="vr-footnote-ref">{span.text}</sup>
  ) : (
    <>{span.text}</>
  );

  // 从内到外套样式元素（顺序见 `STYLE_ORDER`）。
  for (const { style, tag, className } of STYLE_ORDER) {
    if (span.styles.includes(style)) {
      node = createElement(tag, { className }, node);
    }
  }
  // 数学（`$x$`）：按等宽字体渲染，不引入公式排版。
  if (span.styles.includes("math")) {
    node = <code className="vr-math">{node}</code>;
  }
  /*
   * 书自带的颜色 / 底色 / 字号：**套在最外层**。
   *
   * 为什么在样式元素**之外**、而不是最内层：`size_em` 要能真正改字号。若把它
   * 套在 `<strong>`/`<em>` 里面，后代继承与 `em` 的**相对性**会让"1.5em"以
   * 被包裹元素的字号为基准算（`<code>` 已经把字号压到 0.92em），同一个 `size_em`
   * 在不同标记组合下得到不同结果——违背"同一份数据 → 同一棵树"。
   */
  const inline = spanStyle(span);
  if (Object.keys(inline).length > 0) {
    node = <span style={inline}>{node}</span>;
  }
  if (span.href) {
    node = (
      <a className="vr-link" href={span.href} target="_blank" rel="noreferrer noopener">
        {node}
      </a>
    );
  }
  // 段落里的 `\n`（来自 `<br>` / Markdown 硬换行）由 CSS `white-space: pre-line` 保留。
  return <span key={keyBase}>{node}</span>;
}

/** 渲染一组行内片段。 */
function Spans({ spans, fallback }: { spans: BookSpanItem[]; fallback: string }): JSX.Element {
  return (
    <>
      {spans.map((span, index) => (
        <Span key={index} span={span} fallback={fallback} keyBase={String(index)} />
      ))}
    </>
  );
}

/** 表格的一个单元格。 */
function Cell({
  spans,
  fallback,
  tag,
  align,
}: {
  spans: BookSpanItem[];
  fallback: string;
  tag: "th" | "td";
  align: string | undefined;
}): JSX.Element {
  return createElement(
    tag,
    { className: "vr-cell", style: alignStyle(align) },
    <Spans spans={spans} fallback={fallback} />,
  );
}

/** 对齐字符串 → CSS `text-align`（未声明返回 `undefined`，交给 CSS 默认）。 */
function alignStyle(align: string | undefined): { textAlign?: string } {
  if (align === "left" || align === "center" || align === "right") {
    return { textAlign: align };
  }
  return {};
}

// ==================== 块 ====================

/** 单个块 → 元素（容器块递归渲染）。 */
function Block({
  block,
  fallback,
  depth,
}: {
  block: BookBlockItem;
  fallback: string;
  depth: number;
}): JSX.Element | null {
  // 递归深度护栏：后端数据理论上不会很深，但渲染器不该因为意外数据把栈打爆。
  if (depth > 12) return null;

  const children = block.blocks ? (
    <Blocks blocks={block.blocks} fallback={fallback} depth={depth + 1} />
  ) : null;

  switch (block.kind) {
    case "heading": {
      // 真标题元素（`h1`–`h6` 按 `level` 收敛到 h2–h4）：语义与观感都对，
      // 又不至于让章节标题比面板标题还大。
      const level = Math.min(4, Math.max(2, (block.level ?? 1) + 1));
      return createElement(
        `h${level}`,
        { className: "vr-heading" },
        <Spans spans={block.spans ?? []} fallback={fallback} />,
      );
    }
    case "paragraph":
      return (
        <p className="vr-paragraph">
          <Spans spans={block.spans ?? []} fallback={fallback} />
        </p>
      );
    case "image":
      // 单张图块也可能被解析侧标成"独占一页"（EPUB 的封面页就是这种）。
      return block.path ? (
        <FullPageWrap fullPage={block.full_page === true}>
          <BookImage path={block.path} fallback={fallback} />
        </FullPageWrap>
      ) : null;
    case "code_block":
      return (
        <pre className="vr-code">
          {block.lang ? <div className="vr-code-lang dim">{block.lang}</div> : null}
          <code>{block.text ?? ""}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote className="vr-quote">
          {block.quote_kind ? (
            <div className="vr-quote-kind dim">{block.quote_kind}</div>
          ) : null}
          {children}
        </blockquote>
      );
    case "list": {
      const items = block.list_items ?? [];
      const hasTasks = items.some((item) => item.checked !== null);
      return createElement(
        block.ordered ? "ol" : "ul",
        {
          className: `vr-list${hasTasks ? " vr-task-list" : ""}`,
          // 有序列表的起始序号（`3.` 开头的列表要从 3 数起）。
          start: block.ordered ? (block.start ?? undefined) : undefined,
        },
        items.map((item, index) => (
          <li className="vr-li" key={index}>
            {/* 任务列表的勾选态：只读展示（不是交互控件——查看器是阅读视图）。 */}
            {item.checked !== null ? (
              <span className="vr-checkbox" aria-label={item.checked ? "已勾选" : "未勾选"}>
                {item.checked ? "☑" : "☐"}
              </span>
            ) : null}
            <Blocks blocks={item.blocks} fallback={fallback} depth={depth + 1} />
          </li>
        )),
      );
    }
    case "rule":
      return <hr className="vr-rule" />;
    case "table": {
      const align = block.align ?? [];
      return (
        <table className="vr-table">
          {block.head && block.head.length > 0 ? (
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <Cell
                    key={index}
                    tag="th"
                    spans={cell}
                    fallback={fallback}
                    align={align[index]}
                  />
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {(block.rows ?? []).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.cells.map((cell, cellIndex) => (
                  <Cell
                    key={cellIndex}
                    tag="td"
                    spans={cell}
                    fallback={fallback}
                    align={align[cellIndex]}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "footnote":
      return (
        <div className="vr-footnote">
          <span className="vr-footnote-label dim">{block.label}</span>
          {children}
        </div>
      );
    case "definition_list":
      return (
        <dl className="vr-definitions">
          {(block.definitions ?? []).map((item, index) => (
            <div className="vr-definition" key={index}>
              <dt>
                <Spans spans={item.term} fallback={fallback} />
              </dt>
              {item.definitions.map((def, defIndex) => (
                <dd key={defIndex}>
                  <Blocks blocks={def} fallback={fallback} depth={depth + 1} />
                </dd>
              ))}
            </div>
          ))}
        </dl>
      );
    case "figure": {
      /*
       * 图组：`<figure>` + `<img>` + 可选 `<figcaption>`。
       *
       * **怎么读 koodo-reader 的图片排版**（需求 5，依据 koodit 内核
       * `src/utils/layoutUtil.ts`）：koodo 的 `handleImageSize()`（`:484-742`）
       * 给 `img,image` 写内联 `max-width:{maxWidth}px; max-height:{maxHeight}px;
       * margin:0 auto; min-width:0; min-height:0`，并在 `:667-675` 做一条关键处置——
       * 若按宽度算出来的 `maxHeight` **超过容器高**，就按**容器高**再缩一档。
       * 也就是说 koodo 的图片**宁可缩小，也不跨页/跨栏被切断**。
       *
       * 我们照这条口径实现（CSS 侧 `.br-content .vr-figure img` 按容器高封顶，
       * 见 `styles.css`），因此**不给普通图组加任何 `break-before`**——kookit 全仓
       * `break-before|break-after|page-break-before|page-break-after` **0 命中**，
       * 它的"图片翻到下一栏"是 `break-inside: avoid` + 满高封顶之后浏览器的
       * **自然结果**，不是分页符。加一条 koodo 没有的分页符会把"图片后面紧跟的
       * 正文"整段推到下一页，那不是它的行为。
       *
       * 唯一的例外是 `full_page === true`（见下面 `figureBody` 里的说明）。
       */
      const figureBody = (
        <figure className="vr-figure">
          {/* 图 + 图注是**一个整体**：`break-inside: avoid` 同时写在 `<figure>`
              和 `<img>` 上，浏览器就不会把图与图注拆到两栏/两页。 */}
          {block.figure?.path ? (
            <BookImage path={block.figure.path} fallback={fallback} />
          ) : null}
          {block.caption && block.caption.length > 0 ? (
            <figcaption className="vr-figcaption">
              <Spans spans={block.caption} fallback={fallback} />
            </figcaption>
          ) : null}
        </figure>
      );
      /*
       * `full_page`（**本仓库的扩展，koodo 无对应概念**）：后端只给
       * `epub:type="cover"` 这类**整页图**标 `true`。koodo 对封面页也正是
       * "按容器高缩放 + 居中"（`handleImageSize` 的满高封顶 + `margin: 0 auto`），
       * 并没有"断页"这一步；我们额外允许这一类**独占一页**，因为封面页在 koodo 里
       * 其实是**独立渲染的一章**——每次 `handleRenderChapter()` 都先
       * `doc.body.innerHTML=""` 再注入（`src/utils/navigationUtil.ts:319-465`），
       * 章首天然换页。在我们的"累积多页拼成一条流"结构下，那一步要显式写出来。
       *
       * 需求 3 与 koodo 冲突的部分以 koodo 为准 ⇒ 普通图组绝不套 `break-before`；
       * 只有这个后端显式标记的例外才套。
       *
       * **落点只有一处**：`FullPageWrap` 的包装层
       * （`.vr-figure-full-page`，`break-before: column` 写在它身上）。
       * `case "image"`（单张整页图，如 EPUB 封面页）走的是**同一个**包装层，
       * 因此"注释说的规则"与"代码的落点"是同一条路径——不留第二套写法。
       */
      return <FullPageWrap fullPage={block.full_page === true}>{figureBody}</FullPageWrap>;
    }
    case "comment":
      /*
       * 注释（作者/译者的旁注、EPUB 的 `aside[epub:type="note"]` 一类）。
       *
       * **与 koodo-reader 的取舍差别**（需求 5 的核查结论）：koodo 把
       * `aside[epub\:type="footnote"],aside[epub\:type="note"],…,.hide` 直接
       * `font-size: 0px !important` **在流内折叠隐藏**，读者点链接时才在
       * **弹层**里看注释（`src/helpers/styleHelper.ts:175-178` +
       * `src/utils/navigationUtil.ts:250-291`）。我们没有弹层，所以**不能**照抄
       * "隐藏"——那会让注释在这套界面里**彻底看不见**（koodo 有弹层兜底，我们没有）。
       *
       * 我们的取舍：**留在流内、但用从属样式把它和正文段落分开**（小字号 + 左侧
       * 双线 + 整块缩进，`.vr-comment`），而不是当正文段落平铺。这样"读到注释"
       * 与"读到正文"在视觉上一眼可分，又不会因为缺弹层而丢内容。
       *
       * 字段形状与 `blockquote` 同（`label` + `blocks`），差别只在样式与语义标签：
       * 这里用 `<aside>`——HTML 里"与正文相关但非正文主体"的就是 aside，
       * 与 koodo 的 `aside[type="sidebar"]` 同源（那条它反而是**显示**的：
       * `styleHelper.ts:179-181` 给浅蓝底 + `break-inside: avoid`）。
       */
      return (
        <aside className="vr-comment">
          {block.label ? <div className="vr-comment-label dim">{block.label}</div> : null}
          {children}
        </aside>
      );
    case "page_break":
      /*
       * 显式换页标记（后端给出）——**需求 4 的块级判据**。
       *
       * 注意它**不用于图片**：koodo 没有"图片单独一页"的机制（全仓
       * `break-before|page-break-before` 0 命中），图片靠"按容器高封顶 +
       * `break-inside: avoid`"自然进下一栏（见 `case "figure"`）。后端因此也
       * **不**给图片合成 `page_break`。
       *
       * 它渲染成一个**空的、`aria-hidden` 的标记元素**，不是可见的空行：
       * - `aria-hidden`：它对屏幕阅读器没有语义（"这里翻页了"不是内容），
       *   空元素本身也不会被读出来；
       * - 换页由 CSS 承担（`.vr-page-break`）：滚动模式画一条明显的分隔，
       *   分页模式给 `break-before: column`。**标记与表现分离**，因此两种排版
       *   共用同一份数据，不需要 JSX 里判断当前是哪种模式。
       * - 若它是流里的**第一个块**，CSS 会把它整条抑制掉（`display: none`）——
       *   否则会在章节开头多出一条分隔线、或（分页模式）多出一个空栏/空页。
       *   这里因此**必须**渲染成普通块级元素，让 `:first-child` 能命中它。
       */
      return <div className="vr-page-break" aria-hidden="true" />;
    default:
      return null;
  }
}

/**
 * 把一块内容包成"独占一页"（`full_page`）。
 *
 * **这是 `full_page` 唯一的落点**：`case "image"`（单张整页图）与
 * `case "figure"`（图组）都走它，因此"注释里写的规则"与"代码的落点"是同一条
 * 路径，不会出现两套写法各自漂移。
 *
 * 为什么包一层而不是给 `<img>` 自己加类：占一页的**不只是图**——图注、以及
 * 后续由解析侧给出的整块内容都要跟着走；类名只写在包装层
 * （`.vr-figure-full-page`，`break-before: column`），渲染器这边也就一处判断。
 */
function FullPageWrap({
  fullPage,
  children,
}: {
  fullPage: boolean;
  children: ReactNode;
}): JSX.Element {
  if (!fullPage) return <>{children}</>;
  return <div className="vr-figure-full-page">{children}</div>;
}

/** 渲染一组块（列表项 / 引用 / 脚注内部复用）。 */
function Blocks({
  blocks,
  fallback,
  depth = 0,
}: {
  blocks: BookBlockItem[];
  fallback: string;
  depth?: number;
}): JSX.Element {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} fallback={fallback} depth={depth} />
      ))}
    </>
  );
}

export interface BookBlocksProps {
  blocks: BookBlockItem[];
  /** 图片加载失败时的提示（避免出现一个没有说明的破图）。 */
  imageFallback: string;
}

export const BookBlocks = memo(function BookBlocks({
  blocks,
  imageFallback,
}: BookBlocksProps): JSX.Element {
  return <Blocks blocks={blocks} fallback={imageFallback} />;
});
