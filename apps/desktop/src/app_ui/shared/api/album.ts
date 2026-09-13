/**
 * M3：虚拟相册命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  AlbumAddMemberArgs,
  AlbumCreateArgs,
  AlbumCreateResult,
  AlbumDeleteArgs,
  AlbumItem,
  AlbumListArgs,
  AlbumMemberResult,
  AlbumMembersArgs,
  AlbumRemoveMemberArgs,
  AlbumRemoveResult,
  AlbumRenameArgs,
  AlbumSetMediaTypeArgs,
  AlbumSetMediaTypeResult,
  AlbumSyncArgs,
  FileItem,
} from "../types";

/** 创建相册 */
export function albumCreate(args: AlbumCreateArgs): Promise<AlbumCreateResult> {
  return invoke<AlbumCreateResult>("album_create", {
    repoId: args.repoId,
    name: args.name,
    kind: args.kind,
    mediaType: args.mediaType,
    parentAlbumId: args.parentAlbumId,
    sourceId: args.sourceId,
    syncMode: args.syncMode,
    includeSubsources: args.includeSubsources,
    filterJson: args.filterJson,
    fileIds: args.fileIds,
  });
}

/** 设置相册媒体属性 */
export function albumSetMediaType(
  args: AlbumSetMediaTypeArgs,
): Promise<AlbumSetMediaTypeResult> {
  return invoke<AlbumSetMediaTypeResult>("album_set_media_type", {
    repoId: args.repoId,
    albumId: args.albumId,
    mediaType: args.mediaType,
  });
}

/** 添加相册成员 */
export function albumAddMember(args: AlbumAddMemberArgs): Promise<AlbumMemberResult> {
  return invoke<AlbumMemberResult>("album_add_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  });
}

/** 移除相册成员 */
export function albumRemoveMember(
  args: AlbumRemoveMemberArgs,
): Promise<AlbumRemoveResult> {
  return invoke<AlbumRemoveResult>("album_remove_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  });
}

/** 列出仓库下全部相册 */
export function albumList(args: AlbumListArgs): Promise<AlbumItem[]> {
  return invoke<AlbumItem[]>("album_list", { repoId: args.repoId });
}

/** 列出相册可见成员 */
export function albumMembers(args: AlbumMembersArgs): Promise<FileItem[]> {
  return invoke<FileItem[]>("album_members", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}

/** 执行相册同步（后台执行，返回 taskId） */
export function albumSync(args: AlbumSyncArgs): Promise<string> {
  return invoke<string>("album_sync", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}

/** 重命名相册 */
export function albumRename(args: AlbumRenameArgs): Promise<void> {
  return invoke<void>("album_rename", {
    repoId: args.repoId,
    albumId: args.albumId,
    name: args.name,
  });
}

/** 删除相册 */
export function albumDelete(args: AlbumDeleteArgs): Promise<void> {
  return invoke<void>("album_delete", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}
