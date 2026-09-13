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
  TagTreeNode,
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

/** 读取仓库 tag 层级树（交叉 tag 标记 is_cross） */
export function tagTree(repoId: string): Promise<TagTreeNode[]> {
  return invoke<TagTreeNode[]>("tag_tree", { repoId });
}

/** 重命名 tag */
export function tagRename(tagId: string, name: string): Promise<void> {
  return invoke<void>("tag_rename", { tagId, name });
}

/** 新建根 tag */
export function tagCreateRoot(repoId: string, name: string): Promise<TagItem> {
  return invoke<TagItem>("tag_create_root", { repoId, name });
}

/** 在父 tag 下新建子 tag */
export function tagCreateChild(
  repoId: string,
  parentTagId: string,
  name: string,
): Promise<TagItem> {
  return invoke<TagItem>("tag_create_child", { repoId, parentTagId, name });
}

/** 新建与参照 tag 同级的 tag（共享其全部上级） */
export function tagCreateSibling(
  repoId: string,
  refTagId: string,
  name: string,
): Promise<TagItem> {
  return invoke<TagItem>("tag_create_sibling", { repoId, refTagId, name });
}

/** 移动 tag（拖拽 = 移动）；newParentId 为空表示移到根。 */
export function tagMove(tagId: string, newParentId: string | null): Promise<void> {
  return invoke<void>("tag_move", { tagId, newParentId });
}
