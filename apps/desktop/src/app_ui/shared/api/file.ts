/**
 * M4：文件元数据 / 查询 / 路径 / 缩略图 / 重命名 / 回收站 / 重分析命令封装。
 *
 * **D76 迁移状态：已包装**（批次 `file`，2026-09）。全部命令返回
 * `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包：调用方拿到的仍是原来的领域值，
 * 失败时抛带 `code` 的 [`HpApiFailure`]，界面按 `code` 走 i18n（D27）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  FileItem,
  FileMetadataArgs,
  FileMetadataResult,
  FilePathArgs,
  FileQueryArgs,
  FileQueryPage,
  FileReanalyzeArgs,
  FileRenameArgs,
  FileSetMarksArgs,
  FileTrashArgs,
  PreviewGetArgs,
  ThumbGetArgs,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 读取文件元数据 */
export function fileMetadata(args: FileMetadataArgs): Promise<FileMetadataResult> {
  return invoke<ApiResponse<FileMetadataResult>>("file_metadata", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/** 获取文件绝对路径（供 convertFileSrc 预览） */
export function filePath(args: FilePathArgs): Promise<string> {
  return invoke<ApiResponse<string>>("file_path", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/**
 * 按仓库**游标分页**查询文件索引（D78）。
 *
 * 请求 `{ repoId, filter?, cursor?, limit? }`（`limit` 只是页大小）；
 * 响应 `{ items, nextCursor }`——把 `nextCursor` 原样回传即可续页，`null` 表示末页。
 * 排序键 `(relative_path, source_id, id)`。
 */
export function fileQuery(args: FileQueryArgs): Promise<FileQueryPage> {
  return invoke<ApiResponse<FileQueryPage>>("file_query", {
    repoId: args.repoId,
    filter: args.filter ?? null,
    cursor: args.cursor ?? null,
    limit: args.limit ?? null,
  }).then(unwrapApi);
}

/** 获取文件缩略图绝对路径（后端按需生成并缓存；null=不可用） */
export function thumbGet(args: ThumbGetArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("thumb_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/**
 * 获取文件**有界预览**绝对路径（后端按需生成并缓存；null=不可用）。
 *
 * 长边 ≤ 2048 的 JPEG；供 Chromium 无法原生解码的图片（HEIC/HEIF）查看器使用，
 * 见 `shared/previewUrl.ts` 的调用策略。
 */
export function previewGet(args: PreviewGetArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("preview_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/** 重命名文件（磁盘重命名 + 更新索引） */
export function fileRename(args: FileRenameArgs): Promise<FileItem> {
  return invoke<ApiResponse<FileItem>>("file_rename", {
    repoId: args.repoId,
    fileId: args.fileId,
    newName: args.newName,
  }).then(unwrapApi);
}

/** 将文件批量移入系统回收站 */
export function fileTrash(args: FileTrashArgs): Promise<number> {
  return invoke<ApiResponse<number>>("file_trash", {
    repoId: args.repoId,
    fileIds: args.fileIds,
  }).then(unwrapApi);
}

/**
 * **增删**一组文件的标记（返回实际改动的文件数）。
 *
 * 标记是**可多值**、**与类目正交**的一维（D102 用户口径："book 为标记，标记可以交叉"）：
 * 一个文件可以同时带 `book` 与 `manga`，因此是"加哪些 / 减哪些"而不是"设成什么"。
 */
export function fileSetMarks(args: FileSetMarksArgs): Promise<number> {
  return invoke<ApiResponse<number>>("file_set_marks", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    add: args.add ?? [],
    remove: args.remove ?? [],
  }).then(unwrapApi);
}

/**
 * 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息 / **调色板**）。
 *
 * **后台任务**（与 `sourceScan` 同款）：立即返回 `taskId`，进度浮窗、取消按钮、完成后的
 * 状态与刷新全部由 `scan.progress` / `scan.completed` / `scan.error` 事件驱动
 * （`core/taskStore.ts` 只认事件、不认命令）。因此调用方**不要**再自己弹状态或刷新 ——
 * 任务结束时 `scan.completed` 的处理器会 `refresh()`。
 */
export function fileReanalyze(args: FileReanalyzeArgs): Promise<string> {
  return invoke<ApiResponse<string>>("file_reanalyze", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}
