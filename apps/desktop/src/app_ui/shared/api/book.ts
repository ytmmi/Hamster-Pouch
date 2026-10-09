/**
 * 图书命令封装（`book.meta` 元数据 / `book.content` 查看器正文）。
 *
 * **D76 迁移状态：已包装**：命令返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包。
 *
 * - `bookMeta` 的调用方是**图书预览面板**（`panels/bookpreview/`）。只有 EPUB 需要
 *   调用它——`txt` / `md` 没有元数据，面板直接用文件名渲染文字封面（省一次后端往返）；
 * - `bookContent` 的调用方是**查看器面板**（`panels/ViewerPanel.tsx`），按游标分页取正文。
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
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 读取一本书的作者 / 简介 / 封面路径（后端带磁盘缓存，按内容哈希失效）。 */
export function bookMeta(args: BookMetaArgs): Promise<BookMetaResult> {
  return invoke<ApiResponse<BookMetaResult>>("book_meta", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/**
 * 读取查看器要显示的**一页正文**（`txt` / `md` / `epub`）。
 *
 * 用户口径（2026-10-09）：查看器显示书的**开头内容**，"固定上限 + 面板内滚动看更多、
 * 滚动时按需缓存"，因此这里是**分页**接口：`cursor` 缺省取第一页，返回值里的
 * `next_cursor` 为 `null` 即到底（**到末尾不是错误**）。
 */
export function bookContent(args: BookContentArgs): Promise<BookContentResult> {
  return invoke<ApiResponse<BookContentResult>>("book_content", {
    repoId: args.repoId,
    fileId: args.fileId,
    cursor: args.cursor ?? null,
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
