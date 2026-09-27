/**
 * test_ui M4：文件元数据 / 查询 / 路径命令封装。
 *
 * **D76/D78**：命令已改返回 `{ ok, data?, error? }`（批次 `file`），`file.query` 另改为
 * **游标分页**。这里复用 `app_ui` 的统一解包层，口径与主界面一致。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "../../app_ui/shared/api/response";

import type {
  FileItem,
  FileMetadataArgs,
  FileMetadataResult,
  FilePathArgs,
  FileQueryArgs,
  FileQueryPage,
} from "../types";

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

/** 按仓库游标分页查询文件索引（D78） */
export function fileQuery(args: FileQueryArgs): Promise<FileQueryPage> {
  return invoke<ApiResponse<FileQueryPage>>("file_query", {
    repoId: args.repoId,
    filter: args.filter ?? null,
    cursor: args.cursor ?? null,
    limit: args.limit ?? null,
  }).then(unwrapApi);
}
