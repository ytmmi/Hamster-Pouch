/**
 * test_ui M4：文件元数据 / 查询 / 路径命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  FileItem,
  FileMetadataArgs,
  FileMetadataResult,
  FilePathArgs,
  FileQueryArgs,
} from "../types";

/** 读取文件元数据 */
export function fileMetadata(args: FileMetadataArgs): Promise<FileMetadataResult> {
  return invoke<FileMetadataResult>("file_metadata", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 获取文件绝对路径（供 convertFileSrc 预览） */
export function filePath(args: FilePathArgs): Promise<string> {
  return invoke<string>("file_path", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 按仓库分页查询文件索引 */
export function fileQuery(args: FileQueryArgs): Promise<FileItem[]> {
  return invoke<FileItem[]>("file_query", {
    repoId: args.repoId,
    mediaType: args.mediaType,
    sourceId: args.sourceId,
    limit: args.limit,
    offset: args.offset,
  });
}
