/**
 * test_ui M3：虚拟相册命令封装。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。写成裸 `invoke<T>` 会把信封当数据用，靠 `unwrapApi` 的守卫
 * 才不至于静默出错。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "../../app_ui/shared/api/response";

import type {
  AlbumAddMemberArgs,
  AlbumCreateArgs,
  AlbumCreateResult,
  AlbumItem,
  AlbumListArgs,
  AlbumMemberResult,
  AlbumMembersArgs,
  AlbumRemoveMemberArgs,
  AlbumRemoveResult,
  AlbumSetMediaTypeArgs,
  AlbumSetMediaTypeResult,
  AlbumSyncArgs,
  FileItem,
} from "../types";

/** 创建相册 */
export function albumCreate(args: AlbumCreateArgs): Promise<AlbumCreateResult> {
  return invoke<ApiResponse<AlbumCreateResult>>("album_create", {
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
  }).then(unwrapApi);
}

/** 设置相册媒体属性 */
export function albumSetMediaType(
  args: AlbumSetMediaTypeArgs,
): Promise<AlbumSetMediaTypeResult> {
  return invoke<ApiResponse<AlbumSetMediaTypeResult>>("album_set_media_type", {
    repoId: args.repoId,
    albumId: args.albumId,
    mediaType: args.mediaType,
  }).then(unwrapApi);
}

/** 添加相册成员 */
export function albumAddMember(args: AlbumAddMemberArgs): Promise<AlbumMemberResult> {
  return invoke<ApiResponse<AlbumMemberResult>>("album_add_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  }).then(unwrapApi);
}

/** 移除相册成员 */
export function albumRemoveMember(
  args: AlbumRemoveMemberArgs,
): Promise<AlbumRemoveResult> {
  return invoke<ApiResponse<AlbumRemoveResult>>("album_remove_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  }).then(unwrapApi);
}

/** 列出仓库下全部相册 */
export function albumList(args: AlbumListArgs): Promise<AlbumItem[]> {
  return invoke<ApiResponse<AlbumItem[]>>("album_list", { repoId: args.repoId }).then(unwrapApi);
}

/** 列出相册可见成员 */
export function albumMembers(args: AlbumMembersArgs): Promise<FileItem[]> {
  return invoke<ApiResponse<FileItem[]>>("album_members", {
    repoId: args.repoId,
    albumId: args.albumId,
  }).then(unwrapApi);
}

/** 执行相册同步（后台执行，返回 taskId） */
export function albumSync(args: AlbumSyncArgs): Promise<string> {
  return invoke<ApiResponse<string>>("album_sync", {
    repoId: args.repoId,
    albumId: args.albumId,
  }).then(unwrapApi);
}
