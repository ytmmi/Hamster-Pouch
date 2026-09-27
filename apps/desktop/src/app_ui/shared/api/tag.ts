/**
 * M4/M5：tag 命令封装。
 *
 * **D76 迁移状态**：本域**尚未迁移**（批次 `tag`），下列命令仍裸返回。
 * 关系命令的**前端封装缺口**已按 D79 补齐（2026-09）；它们跟随本域一起迁移。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  FileTagsResult,
  TagAddArgs,
  TagDetachArgs,
  TagForFileArgs,
  TagItem,
  TagListArgs,
  TagRelationAddArgs,
  TagRelationItem,
  TagRelationListArgs,
  TagRelationNeighborsArgs,
  TagRelationRemoveArgs,
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

// ===== tag 关系（多父级 DAG，D22/D24）=====
//
// D79 决定「保留契约 + 补前端封装」：这 6 条后端都已实现，缺的只是封装。
// 其中 `tag.relation.add` **不在 D79 明列的五条里**（对账把它归到「名称或载荷不一致」），
// 但它的前端封装同样缺席（`docs/architecture/command-event-drift.md:141` 已注意到），
// 而**没有 add 就只能删不能建**——其余五条因此不可用。故一并补齐，理由记录于此。

/** 建立 tag 关系（`parent` = 层级，`related` = 关联） */
export function tagRelationAdd(args: TagRelationAddArgs): Promise<TagRelationItem> {
  return invoke<TagRelationItem>("tag_relation_add", {
    repoId: args.repoId,
    fromTagId: args.fromTagId,
    toTagId: args.toTagId,
    relationKind: args.relationKind,
  });
}

/** 按关系 ID 删除 tag 关系 */
export function tagRelationRemove(args: TagRelationRemoveArgs): Promise<void> {
  return invoke<void>("tag_relation_remove", { relationId: args.relationId });
}

/** 列出仓库全部 tag 关系（关系图谱数据源） */
export function tagRelationList(args: TagRelationListArgs): Promise<TagRelationItem[]> {
  return invoke<TagRelationItem[]>("tag_relation_list", { repoId: args.repoId });
}

/** 列出某 tag 的直接上级（层级） */
export function tagRelationParents(args: TagRelationNeighborsArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_relation_parents", { tagId: args.tagId });
}

/** 列出某 tag 的直接下级（层级） */
export function tagRelationChildren(args: TagRelationNeighborsArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_relation_children", { tagId: args.tagId });
}

/** 摘挂 tag（脱离层级；tag 实体与文件关联保留） */
export function tagDetach(args: TagDetachArgs): Promise<void> {
  return invoke<void>("tag_detach", { tagId: args.tagId });
}
