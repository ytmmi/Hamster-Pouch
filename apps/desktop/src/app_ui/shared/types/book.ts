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
 * 正文的**块**（**不是 HTML**）。
 *
 * EPUB 的正文是 XHTML，渲染它要么走 `dangerouslySetInnerHTML`（本项目不接受），
 * 要么做一遍受控白名单——后端把白名单**做在解析侧**，前端只拿到这样的纯数据并
 * 渲染 React 元素，因此前端**没有**可注入 HTML 的入口。
 */
export interface BookBlockItem {
  /** `heading` / `paragraph` / `image`。 */
  kind: string;
  /** `heading` 的层级 1–6；其余块为 `null`。 */
  level: number | null;
  /** `heading` / `paragraph` 的文字；`image` 为 `null`。 */
  text: string | null;
  /** `image` 的已落盘绝对路径（供 `convertFileSrc`）；其余为 `null`。 */
  path: string | null;
}

/** `book.content` 返回体：查看器要显示的正文**一页**。 */
export interface BookContentResult {
  /** 书的格式：`text`（纯文本）或 `epub`；空串 = 不是可看的文本类。 */
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
