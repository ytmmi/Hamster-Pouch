/**
 * 图书元数据命令封装（`book.meta`）。
 *
 * **D76 迁移状态：已包装**：命令返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包。
 *
 * 调用方是**图书预览面板**（`panels/bookpreview/`）。只有 EPUB 需要调用它——
 * `txt` / `md` 没有元数据，面板直接用文件名渲染文字封面（省掉一次后端往返）。
 */

import { invoke } from "@tauri-apps/api/core";

import type { BookMetaArgs, BookMetaResult } from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 读取一本书的作者 / 简介 / 封面路径（后端带磁盘缓存，按内容哈希失效）。 */
export function bookMeta(args: BookMetaArgs): Promise<BookMetaResult> {
  return invoke<ApiResponse<BookMetaResult>>("book_meta", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}
