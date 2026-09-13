/**
 * M4/M5：tag 命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  FileTagsResult,
  TagAddArgs,
  TagForFileArgs,
  TagItem,
  TagListArgs,
  TagRemoveArgs,
} from "../types";

/** 给文件批量添加人工 tag */
export function tagAdd(args: TagAddArgs): Promise<void> {
  return invoke<void>("tag_add", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  });
}

/** 从文件批量移除人工 tag */
export function tagRemove(args: TagRemoveArgs): Promise<void> {
  return invoke<void>("tag_remove", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  });
}

/** 列出仓库内全部 tag 实体 */
export function tagList(args: TagListArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_list", { repoId: args.repoId });
}

/** 列出文件的人工 tag 与自动 tag 两组 */
export function tagForFile(args: TagForFileArgs): Promise<FileTagsResult> {
  return invoke<FileTagsResult>("tag_for_file", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}
