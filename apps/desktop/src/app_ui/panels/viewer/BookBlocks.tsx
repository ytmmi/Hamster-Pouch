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
 */

import { memo, useState } from "react";
import { createElement } from "react";

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
 */
const STYLE_ORDER = [
  { style: "code", tag: "code", className: "vr-code-inline" },
  { style: "emphasis", tag: "em", className: "vr-emphasis" },
  { style: "strong", tag: "strong", className: "vr-strong" },
  { style: "strikethrough", tag: "del", className: "vr-strikethrough" },
  { style: "superscript", tag: "sup", className: "vr-superscript" },
  { style: "subscript", tag: "sub", className: "vr-subscript" },
] as const;

/** 脚注引用渲染成上标编号（`[1]`）。 */
function isFootnote(span: BookSpanItem): boolean {
  return span.styles.includes("footnote");
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

  // 从内到外套样式元素。
  for (const { style, tag, className } of STYLE_ORDER) {
    if (span.styles.includes(style)) {
      node = createElement(tag, { className }, node);
    }
  }
  // 数学（`$x$`）：按等宽字体渲染，不引入公式排版。
  if (span.styles.includes("math")) {
    node = <code className="vr-math">{node}</code>;
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
      return block.path ? <BookImage path={block.path} fallback={fallback} /> : null;
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
    default:
      return null;
  }
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
