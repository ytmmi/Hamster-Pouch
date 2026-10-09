/**
 * 查看器：**EPUB 正文块的渲染**。
 *
 * ## 这里没有（也不能有）HTML 注入
 *
 * 后端把 XHTML 的**受控白名单**做在解析侧，交给前端的只有 `BookBlockItem`
 * 这样的纯数据（见 `hp-book` 的 `epub_text` 模块文档）。因此本文件用
 * `<h1>`–`<h6>` / `<p>` / `<img>` 这些 **React 元素**渲染，
 * **不存在** `dangerouslySetInnerHTML` 的入口——不是"我们记得别用"，
 * 而是**没有 HTML 可注入**。
 *
 * 段落里的 `\n`（来自 `<br>`）用 `white-space: pre-line` 保留：
 * 诗句与对话的行结构是正文的一部分。
 */

import { memo, useState } from "react";
import { createElement } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import type { BookBlockItem } from "../../shared/types";

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

export interface BookBlocksProps {
  blocks: BookBlockItem[];
  /** 图片加载失败时的提示（避免出现一个没有说明的破图）。 */
  imageFallback: string;
}

export const BookBlocks = memo(function BookBlocks({
  blocks,
  imageFallback,
}: BookBlocksProps): JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "image") {
          if (!block.path) return null;
          return <BookImage key={index} path={block.path} fallback={imageFallback} />;
        }
        if (block.kind === "heading") {
          // 真标题元素（`h1`–`h6` 按 `level` 收敛到 h2–h4）：语义与观感都对，
          // 又不至于让章节标题比面板标题还大。
          const level = Math.min(4, Math.max(2, (block.level ?? 1) + 1));
          return createElement(
            `h${level}`,
            { key: index, className: "vr-heading" },
            block.text,
          );
        }
        return (
          <p key={index} className="vr-paragraph">
            {block.text}
          </p>
        );
      })}
    </>
  );
});
