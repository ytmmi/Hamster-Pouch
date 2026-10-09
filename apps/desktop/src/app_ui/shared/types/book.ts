/**
 * 图书（文本类文件）类型：`book.meta` 与 `book.content` 的参数与返回体。
 *
 * `book.meta` 服务**图书预览面板**（EPUB 的作者 / 简介 / 内嵌封面），
 * `book.content` 服务**查看器**（txt / epub 的正文开头）。
 * 两者都**不进索引**——封面是二进制、简介与正文是长文本，塞进 `files` 行会让
 * 每次文件查询都背上几十 KB 的负载，而列表只用得到"有没有封面"。
 */

/** `book.meta` 命令参数。 */
export interface BookMetaArgs {
  repoId: string;
  fileId: string;
}

/** `book.meta` 返回体（三项都可为 `null`）。 */
export interface BookMetaResult {
  /** EPUB `<dc:creator>`；无则 `null`。 */
  author: string | null;
  /** EPUB `<dc:description>`；无则 `null`。 */
  description: string | null;
  /**
   * **已落盘**的封面绝对路径（供 `convertFileSrc`）；无封面则 `null`。
   *
   * `null` 不是错误：`txt` / `md` 本来就没有封面，面板用文件名渲染文字封面。
   */
  cover_path: string | null;
}

/** `book.content` 命令参数（`cursor` 缺省 = 第一页）。 */
export interface BookContentArgs {
  repoId: string;
  fileId: string;
  /** 游标：纯文本是**字符偏移**、epub 是**章节序号**；缺省 `undefined` = 从头。 */
  cursor?: string | null;
}

/**
 * 一段**行内内容**（**不是 HTML**）。
 *
 * EPUB 的正文是 XHTML、Markdown 可以内嵌 HTML，渲染它们要么走
 * `dangerouslySetInnerHTML`（本项目不接受），要么做一遍受控白名单——后端把白名单
 * **做在解析侧**，前端只拿到这样的纯数据并渲染 React 元素，
 * 因此前端**没有**可注入 HTML 的入口。
 */
export interface BookSpanItem {
  /** 文字内容（图片片段里是 **alt 文本**）。 */
  text: string;
  /** 叠加的行内样式（`emphasis` / `strong` / `strikethrough` / `code` …）。 */
  styles: string[];
  /** 链接目标；`null` = 不是链接。 */
  href: string | null;
  /** 图片的**已落盘绝对路径**（供 `convertFileSrc`）；`null` = 不是图片。 */
  image: string | null;
}

/** 一个列表项（GFM 任务列表的勾选态 + 项内的块）。 */
export interface BookListItem {
  /** `true` / `false` = 已勾选 / 未勾选；`null` = 不是任务项。 */
  checked: boolean | null;
  /** 项内的块（列表项可以含多段、嵌套列表、代码块）。 */
  blocks: BookBlockItem[];
}

/** 表格的一行。 */
export interface BookTableRowItem {
  /** 各单元格（每个单元格是一组行内片段）。 */
  cells: BookSpanItem[][];
}

/** 定义列表的一项（术语 + 若干条释义）。 */
export interface BookDefinitionItem {
  /** 术语（行内内容）。 */
  term: BookSpanItem[];
  /** 释义（每条释义是一组块）。 */
  definitions: BookBlockItem[][];
}

/**
 * 正文的**块**（**不是 HTML**）。
 *
 * EPUB 与 Markdown 产出的是**同一套块**（后端 `hp_book::block`），
 * 因此前端**只有一份渲染器**，两种格式的观感不会各自漂移。
 */
export interface BookBlockItem {
  /**
   * `heading` / `paragraph` / `image` / `code_block` / `blockquote` /
   * `list` / `rule` / `table` / `footnote` / `definition_list`。
   */
  kind: string;
  /** `heading` 的层级 1–6；其余块为 `null`。 */
  level: number | null;
  /** 行内内容（`heading` / `paragraph`）；其余块为 `null`。 */
  spans: BookSpanItem[] | null;
  /** `image` 的已落盘绝对路径（供 `convertFileSrc`）；其余为 `null`。 */
  path: string | null;
  /** `code_block` 的语言标记；其余为 `null`。 */
  lang: string | null;
  /** `code_block` 的代码原文（**保留缩进**）；其余为 `null`。 */
  text: string | null;
  /** `blockquote` / `footnote` 内的块；其余为 `null`。 */
  blocks: BookBlockItem[] | null;
  /** GFM 告示种类（`note` / `tip` …）；其余为 `null`。 */
  quote_kind: string | null;
  /** `list` 是否有序；其余为 `null`。 */
  ordered: boolean | null;
  /** `list` 的起始序号；其余为 `null`。 */
  start: number | null;
  /** `list` 的项；其余为 `null`。 */
  list_items: BookListItem[] | null;
  /** `table` 的每列对齐（`none` / `left` / `center` / `right`）；其余为 `null`。 */
  align: string[] | null;
  /** `table` 的表头单元格；其余为 `null`。 */
  head: BookSpanItem[][] | null;
  /** `table` 的表体行；其余为 `null`。 */
  rows: BookTableRowItem[] | null;
  /** `footnote` 的标签；其余为 `null`。 */
  label: string | null;
  /** `definition_list` 的各项；其余为 `null`。 */
  definitions: BookDefinitionItem[] | null;
}

/** `book.content` 返回体：查看器要显示的正文**一页**。 */
export interface BookContentResult {
  /**
   * 书的格式：`text`（纯文本）/ `markdown`（渲染后的 md）/ `epub`；
   * 空串 = 不是可看的文本类。
   */
  format: string;
  /** 纯文本的**编码名**（`UTF-8` / `GBK` / …）；epub 为 `null`。 */
  encoding: string | null;
  /** 纯文本页的内容；epub 为 `null`。 */
  text: string | null;
  /** epub 章节的块；纯文本为 `null`。 */
  blocks: BookBlockItem[] | null;
  /** 下一页游标；`null` = 没有更多（**到末尾不是错误**）。 */
  next_cursor: string | null;
  /** 本页序号（0 起；纯文本恒为 0，epub 是章节序号）。 */
  section: number;
  /** epub 的章节总数；纯文本为 `null`。 */
  section_count: number | null;
  /** 本页标题（epub 的章节标题；纯文本为 `null`）。 */
  title: string | null;
  /** 内容是否因**上限**被截断（面板据此提示"仅显示开头"）。 */
  capped: boolean;
}

/** `book.cover` / `book.setCover` / `book.clearCover` 返回体。 */
export interface BookCoverResult {
  /** `color` / `image`；`null` = 没有覆盖（按默认封面渲染）。 */
  kind: string | null;
  /** `color` 为 `#rrggbb`；`image` 为**已落盘**的绝对路径；无覆盖为 `null`。 */
  value: string | null;
}

/** `book.setCover` 命令参数。 */
export interface BookSetCoverArgs {
  repoId: string;
  fileId: string;
  /** `color`（`value` = `#rrggbb`）或 `image`（`value` = 源图片绝对路径）。 */
  kind: "color" | "image";
  value: string;
}

/**
 * `book.covers` 批量查询的返回元素（`file_id` → 覆盖）。
 *
 * **批量而不是逐个查**：图书预览一页可能有几百本，逐本一次 IPC 就是几百次往返。
 */
export interface BookCoverItem {
  file_id: string;
  /** `color` / `image`。 */
  kind: string;
  /** `color` 为 `#rrggbb`；`image` 为**已落盘**的绝对路径。 */
  value: string;
}
