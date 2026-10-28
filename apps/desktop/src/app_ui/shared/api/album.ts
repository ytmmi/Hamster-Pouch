/**
 * M3：虚拟相册命令封装。
 *
 * **D76 迁移状态：已包装**（批次 `album`，2026-09）。全部命令返回
 * `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包：调用方拿到的仍是原来的领域值，
 * 失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  AlbumAddMemberArgs,
  AlbumCreateArgs,
  AlbumCreateResult,
  AlbumCreateSnapshotArgs,
  AlbumCreateSyncArgs,
  AlbumDeleteArgs,
  AlbumItem,
  AlbumListArgs,
  AlbumMemberResult,
  AlbumMembersArgs,
  AlbumMembersPage,
  AlbumMoveArgs,
  AlbumMoveResult,
  AlbumRemoveMemberArgs,
  AlbumRemoveResult,
  AlbumRenameArgs,
  AlbumSetMediaTypeArgs,
  AlbumSetMediaTypeResult,
  AlbumSyncArgs,
  AlbumUnsyncArgs,
  AlbumUnsyncResult,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

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

/**
 * 「创建为相册（仅当前对象）」：把源/目录当前的对象一次性复制成固定型相册（D128）。
 *
 * 快照语义——创建之后不再跟随源；与 [`albumCreateSync`] 的唯一区别是"是否持续同步"。
 */
export function albumCreateSnapshot(
  args: AlbumCreateSnapshotArgs,
): Promise<AlbumCreateResult> {
  return invoke<ApiResponse<AlbumCreateResult>>("album_create_snapshot", {
    repoId: args.repoId,
    name: args.name,
    mediaType: args.mediaType,
    parentAlbumId: args.parentAlbumId,
    sourceId: args.sourceId,
    relativePath: args.relativePath ?? null,
    includeSubsources: args.includeSubsources,
  }).then(unwrapApi);
}

/**
 * 「创建为同步相册」：建立持续同步的相册，并按源目录层级自动维护镜像子相册（D128）。
 *
 * 只增不删：源里新出现的对象自动加入，用户手动移除的对象记入排除表不再被加回。
 */
export function albumCreateSync(args: AlbumCreateSyncArgs): Promise<AlbumCreateResult> {
  return invoke<ApiResponse<AlbumCreateResult>>("album_create_sync", {
    repoId: args.repoId,
    name: args.name,
    mediaType: args.mediaType,
    parentAlbumId: args.parentAlbumId,
    sourceId: args.sourceId,
    relativePath: args.relativePath ?? null,
  }).then(unwrapApi);
}

/**
 * 移动相册到新的父相册（`parentAlbumId` 为 `null` = 移到顶层）（D128）。
 *
 * 自包含与互相包含会被后端拒绝（`validation` 错误）。
 */
export function albumMove(args: AlbumMoveArgs): Promise<AlbumMoveResult> {
  return invoke<ApiResponse<AlbumMoveResult>>("album_move", {
    repoId: args.repoId,
    albumId: args.albumId,
    parentAlbumId: args.parentAlbumId ?? null,
    beforeAlbumId: args.beforeAlbumId ?? null,
  }).then(unwrapApi);
}

/** 取消同步：同步相册退化为一般（固定型）相册，成员全部保留（D128）。 */
export function albumUnsync(args: AlbumUnsyncArgs): Promise<AlbumUnsyncResult> {
  return invoke<ApiResponse<AlbumUnsyncResult>>("album_unsync", {
    repoId: args.repoId,
    albumId: args.albumId,
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
  return invoke<ApiResponse<AlbumItem[]>>("album_list", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/**
 * 列出相册可见成员（**游标分页**，缺陷 0018）。
 *
 * 请求 `{ repoId, albumId, cursor?, limit? }`（`limit` 只是页大小）；
 * 响应 `{ items, nextCursor }`——把 `nextCursor` 原样回传即可续页，`null` 表示末页。
 * 排序键 `(added_at, file_id)`。
 *
 * **必须翻页取完**：旧实现一次性返回全部成员，5 万成员的相册会把全部行读进内存。
 */
export function albumMembers(args: AlbumMembersArgs): Promise<AlbumMembersPage> {
  return invoke<ApiResponse<AlbumMembersPage>>("album_members", {
    repoId: args.repoId,
    albumId: args.albumId,
    cursor: args.cursor ?? null,
    limit: args.limit ?? null,
  }).then(unwrapApi);
}

/** 执行相册同步（后台执行，返回 taskId） */
export function albumSync(args: AlbumSyncArgs): Promise<string> {
  return invoke<ApiResponse<string>>("album_sync", {
    repoId: args.repoId,
    albumId: args.albumId,
  }).then(unwrapApi);
}

/** 重命名相册 */
export function albumRename(args: AlbumRenameArgs): Promise<void> {
  return invoke<ApiResponse<void>>("album_rename", {
    repoId: args.repoId,
    albumId: args.albumId,
    name: args.name,
  }).then(unwrapApi);
}

/** 删除相册 */
export function albumDelete(args: AlbumDeleteArgs): Promise<void> {
  return invoke<ApiResponse<void>>("album_delete", {
    repoId: args.repoId,
    albumId: args.albumId,
  }).then(unwrapApi);
}
