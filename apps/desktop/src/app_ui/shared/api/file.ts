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
  FileReanalyzeArgs,
  FileRenameArgs,
  FileTrashArgs,
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

/** 按仓库分页查询文件索引 */
export function fileQuery(args: FileQueryArgs): Promise<FileItem[]> {
  return invoke<ApiResponse<FileItem[]>>("file_query", {
    repoId: args.repoId,
    mediaType: args.mediaType,
    sourceId: args.sourceId,
    dirPrefix: args.dirPrefix,
    limit: args.limit,
    offset: args.offset,
  }).then(unwrapApi);
}

/** 获取文件缩略图绝对路径（后端按需生成并缓存；null=不可用） */
export function thumbGet(args: ThumbGetArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("thumb_get", {
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

/** 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息） */
export function fileReanalyze(args: FileReanalyzeArgs): Promise<FileItem> {
  return invoke<ApiResponse<FileItem>>("file_reanalyze", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}
