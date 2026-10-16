/**
 * 图书命令封装（`book.meta` 元数据 / `book.content` 查看器正文）。
 *
 * **D76 迁移状态：已包装**：命令返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包。
 *
 * - `bookMeta` 的调用方是**图书预览面板**（`panels/bookpreview/`）。只有带 **book 标记**
 *   的条目需要调用它——`epub` 取内嵌封面、**`pdf` 取第一页栅格化**；
 *   `txt` / `md` 没有元数据，面板直接用文件名渲染文字封面（省一次后端往返）；
 * - `bookContent` 的调用方是**查看器面板**（`panels/ViewerPanel.tsx`）与
 *   **图书阅读器面板**（`panels/bookreader/`），按游标分页取正文；
 * - `bookToc` 的调用方是**图书阅读器面板**，取章节清单（游标与 `bookContent` 同语义）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  BookContentArgs,
  BookContentResult,
  BookCoverItem,
  BookCoverResult,
  BookMetaArgs,
  BookMetaResult,
  BookSetCoverArgs,
  BookTocArgs,
  BookTocResult,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/**
 * 读取一本书的作者 / 简介 / 封面路径（后端带磁盘缓存，按内容哈希失效）。
 *
 * **PDF 也走这里**：它的封面是第一页栅格化出来的（后端 `hp-pdf`，实测 20–122 ms），
 * 因此这条缓存不是可选项——没有它，卡片网格每滚动一次就要重画一遍。
 */
export function bookMeta(args: BookMetaArgs): Promise<BookMetaResult> {
  return invoke<ApiResponse<BookMetaResult>>("book_meta", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/**
 * 读取查看器要显示的**一页正文**（`txt` / `md` / `epub` / `pdf`）。
 *
 * 用户口径（2026-10-09）：查看器显示书的**开头内容**，"固定上限 + 面板内滚动看更多、
 * 滚动时按需缓存"，因此这里是**分页**接口：`cursor` 缺省取第一页，返回值里的
 * `next_cursor` 为 `null` 即到底（**到末尾不是错误**）。
 *
 * **PDF 的一页 = 一张整页位图**（后端栅格化），`section` 就是页码——
 * 与 epub 的章节序号同形，因此前端的分页与进度提示只有一套。
 */
export function bookContent(args: BookContentArgs): Promise<BookContentResult> {
  return invoke<ApiResponse<BookContentResult>>("book_content", {
    repoId: args.repoId,
    fileId: args.fileId,
    cursor: args.cursor ?? null,
  }).then(unwrapApi);
}

/**
 * 读取一本书的**目录**（图书阅读器的章节栏）。
 *
 * 各格式的来源：`epub` 取 nav（EPUB3）→ NCX（EPUB2）→ 各章 `<title>` 兜底；
 * `txt` 按**内置小说章节规则**识别标题行；`md` 取顶层标题块；`pdf` **没有目录**。
 *
 * 返回项里的 `cursor` **与 `bookContent` 的 cursor 同语义**，"目录跳转"就是把它
 * 原样传回去——前端不做换算（这是两处游标不漂移的唯一保证）。
 *
 * 空目录**不是错误**（PDF / 损坏的书）：调用方给空态即可。
 */
export function bookToc(args: BookTocArgs): Promise<BookTocResult> {
  return invoke<ApiResponse<BookTocResult>>("book_toc", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/**
 * **批量**读取一组文件的封面覆盖（用户自设的颜色 / 图片）。
 *
 * 只返回**真有覆盖**的文件；没有覆盖的书不在结果里（面板按默认封面渲染）。
 * 面板按一页传 id，因此不会退化成"每本书一次 IPC"。
 */
export function bookCovers(repoId: string, fileIds: string[]): Promise<BookCoverItem[]> {
  return invoke<ApiResponse<BookCoverItem[]>>("book_covers", {
    repoId,
    fileIds,
  }).then(unwrapApi);
}

/** 读取**单个**文件的封面覆盖（两个字段为 `null` = 没有覆盖）。 */
export function bookCover(repoId: string, fileId: string): Promise<BookCoverResult> {
  return invoke<ApiResponse<BookCoverResult>>("book_cover", { repoId, fileId }).then(unwrapApi);
}

/**
 * 设置封面覆盖。
 *
 * `kind: "color"` 时 `value` 是 `#rrggbb`；`kind: "image"` 时 `value` 是**源图片的
 * 绝对路径**（用户在系统对话框里挑的那张），桥接层会把它拷进 `data\user\covers\`。
 */
export function bookSetCover(args: BookSetCoverArgs): Promise<BookCoverResult> {
  return invoke<ApiResponse<BookCoverResult>>("book_set_cover", {
    repoId: args.repoId,
    fileId: args.fileId,
    kind: args.kind,
    value: args.value,
  }).then(unwrapApi);
}

/** 清除封面覆盖，回到默认封面（内嵌封面或文字封面）。 */
export function bookClearCover(repoId: string, fileId: string): Promise<BookCoverResult> {
  return invoke<ApiResponse<BookCoverResult>>("book_clear_cover", { repoId, fileId }).then(
    unwrapApi,
  );
}
