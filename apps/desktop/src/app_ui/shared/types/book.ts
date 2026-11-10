/**
 * 图书（"书"类文件）类型：`book.meta` 与 `book.content` 的参数与返回体。
 *
 * `book.meta` 服务**图书预览面板**（EPUB 的作者 / 简介 / 内嵌封面；
 * **PDF 的作者 / 主题 / 第一页封面**），`book.content` 服务**查看器**
 * （txt / md / epub 的正文开头；PDF 的**逐页栅格化**）。
 * 两者都**不进索引**——封面是二进制、简介与正文是长文本，塞进 `files` 行会让
 * 每次文件查询都背上几十 KB 的负载，而列表只用得到"有没有封面"。
 */

export type { BookSpanItem, BookListItem, BookTableRowItem, BookDefinitionItem, BookBlockItem, BookContentResult, BookCoverResult, BookCoverItem, BookTocItem, BookTocResult } from "@hamster-pouch/shared-types";

/** `book.meta` 命令参数。 */
export interface BookMetaArgs {
  repoId: string;
  fileId: string;
}

/** `book.meta` 返回体（三项都可为 `null`）。 */
export interface BookMetaResult {
  /** EPUB `<dc:creator>` / PDF `/Author`；无则 `null`。 */
  author: string | null;
  /** EPUB `<dc:description>` / PDF `/Subject`；无则 `null`。 */
  description: string | null;
  /**
   * **已落盘**的封面绝对路径（供 `convertFileSrc`）；无封面则 `null`。
   *
   * - EPUB：内嵌封面，**原格式不转码**；
   * - **PDF：第一页栅格化后的 JPEG**（`hp-pdf`，`ext` 恒为 `jpg`）——
   *   两者落到**同一个**缓存路径，因此前端只有一条渲染路径。
   *
   * `null` 不是错误：`txt` / `md` 本来就没有封面，打不开的 PDF 也没有，
   * 面板用文件名渲染文字封面。
   */
  cover_path: string | null;
}

/** `book.content` 命令参数（`cursor` 缺省 = 第一页）。 */
export interface BookContentArgs {
  repoId: string;
  fileId: string;
  /** 游标：纯文本是**字符偏移**、epub / pdf 是**序号**（章节 / 页码）；缺省 `undefined` = 从头。 */
  cursor?: string | null;
}

/** `book.setCover` 命令参数。 */
export interface BookSetCoverArgs {
  repoId: string;
  fileId: string;
  /** `color`（`value` = `#rrggbb`）或 `image`（`value` = 源图片绝对路径）。 */
  kind: "color" | "image";
  value: string;
}

/** `book.toc` 命令参数。 */
export interface BookTocArgs {
  repoId: string;
  fileId: string;
}

/** 批注种类（书签 / 笔记 / 高亮；三者是同一件事的三种形态）。 */
export type ReaderAnnotationKind = "bookmark" | "note" | "highlight";

/**
 * 一条**阅读批注**（`reader.annotations` 返回元素）。
 *
 * `cursor` 与 `book.content` 的游标**同语义**（epub = 章节序号、纯文本 = 字符偏移、
 * md = 顶层块序号），因此"点批注跳回去"就是把它原样交给 `bookContent`——
 * 前端不做换算（与 `book.toc` 的目录项同一条口径）。
 */
export interface ReaderAnnotationItem {
  /** 主键（UUID；删除时用它）。 */
  id: string;
  kind: ReaderAnnotationKind;
  /** 位置游标（与 `book.content` 同语义）。 */
  cursor: string;
  /** 保存时的阅读进度（0–10000，两位小数百分比）；仅供列表展示。 */
  progress: number;
  /** 位置标题（章节名 / 目录项）；空串 = 取不到标题。 */
  title: string;
  /** 高亮的选中原文**快照**；空串 = 没有（书签 / 笔记）。 */
  excerpt: string;
  /** 读者写的备注 / 笔记正文；空串 = 没有。 */
  note: string;
  /** 创建时间（ISO 8601）。 */
  created_at: string;
}

/** `reader.addAnnotation` 命令参数。 */
export interface ReaderAddAnnotationArgs {
  repoId: string;
  fileId: string;
  kind: ReaderAnnotationKind;
  cursor: string;
  /** 保存时的阅读进度（0–10000）。 */
  progress: number;
  title: string;
  excerpt: string;
  note: string;
}
