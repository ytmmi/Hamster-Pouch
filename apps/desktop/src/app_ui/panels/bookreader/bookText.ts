/**
 * 正文**块模型的文本遍历**（读 EPUB / Markdown 的块、拼出纯文本）。
 *
 * ## 为什么单独立一个文件
 *
 * 这个遍历有**两个消费方**，而它们分属不同的组件：
 * - `BookReaderPanel`：新建高亮时取"当前页开头一小段"作为兜底原文；
 * - `ReaderStage`：判**正文语言档**（`cjk` / `latin` ⇒ 首行缩进 2em / 1em）。
 *
 * 放在任何一个组件里都会引出**循环依赖**（`BookReaderPanel` 已经 import
 * `ReaderStage`），复制一份又必然漂移——而两处口径不一致时，同一本书的
 * 首行缩进会时而 2em、时而 1em。因此抽到这个两边都能引的叶子里。
 *
 * ## 为什么要递归
 *
 * 块模型的容器种类多（列表项 / 引用 / 脚注 / 定义列表 / 表格），只取顶层
 * `spans` 会漏掉列表与引用里的正文——那正是小说里最常出现的部分。
 * 遍历口径与 `countBlockChars`（面板侧的字符计数）保持一致。
 *
 * **零依赖**（只依赖共享类型）：门禁可以直接 import 驱动它。
 */

import type { BookBlockItem } from "../../shared/types";

/** 把一组块拼成纯文本（块之间用换行分隔）。 */
export function collectBlockText(blocks: BookBlockItem[]): string {
  const parts: string[] = [];
  const walk = (list: BookBlockItem[]): void => {
    for (const block of list) {
      if (block.text) parts.push(block.text);
      if (block.spans) for (const span of block.spans) parts.push(span.text);
      if (block.head) for (const cell of block.head) for (const span of cell) parts.push(span.text);
      if (block.rows) {
        for (const row of block.rows) {
          for (const cell of row.cells) for (const span of cell) parts.push(span.text);
        }
      }
      if (block.list_items) for (const item of block.list_items) walk(item.blocks);
      if (block.blocks) walk(block.blocks);
      if (block.definitions) {
        for (const definition of block.definitions) {
          for (const span of definition.term) parts.push(span.text);
          for (const group of definition.definitions) walk(group);
        }
      }
    }
  };
  walk(blocks);
  return parts.join("\n");
}
