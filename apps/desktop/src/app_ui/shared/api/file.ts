/**
 * M4：文件元数据 / 查询 / 路径 / 缩略图 / 重命名 / 回收站 / 重分析命令封装。
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
    dirPrefix: args.dirPrefix,
    limit: args.limit,
    offset: args.offset,
  });
}

/** 获取文件缩略图绝对路径（后端按需生成并缓存；null=不可用） */
export function thumbGet(args: ThumbGetArgs): Promise<string | null> {
  return invoke<string | null>("thumb_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 重命名文件（磁盘重命名 + 更新索引） */
export function fileRename(args: FileRenameArgs): Promise<FileItem> {
  return invoke<FileItem>("file_rename", {
    repoId: args.repoId,
    fileId: args.fileId,
    newName: args.newName,
  });
}

/** 将文件批量移入系统回收站 */
export function fileTrash(args: FileTrashArgs): Promise<number> {
  return invoke<number>("file_trash", {
    repoId: args.repoId,
    fileIds: args.fileIds,
  });
}

/** 重新分析单个文件（重算哈希 / 缩略图 / 媒体信息） */
export function fileReanalyze(args: FileReanalyzeArgs): Promise<FileItem> {
  return invoke<FileItem>("file_reanalyze", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}
