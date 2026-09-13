/**
 * test_ui M4：tag 命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  TagAddArgs,
  TagForFileArgs,
  TagItem,
  TagListArgs,
  TagRemoveArgs,
} from "../types";

/** 给文件批量添加 tag */
export function tagAdd(args: TagAddArgs): Promise<void> {
  return invoke<void>("tag_add", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  });
}

/** 从文件批量移除 tag */
export function tagRemove(args: TagRemoveArgs): Promise<void> {
  return invoke<void>("tag_remove", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  });
}

/** 列出仓库内全部 tag */
export function tagList(args: TagListArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_list", { repoId: args.repoId });
}

/** 列出文件已关联的 tag */
export function tagForFile(args: TagForFileArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_for_file", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}
