/**
 * test_ui M3：虚拟相册命令封装。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。调用统一走 `invokeApi`（`app_ui/shared/api/call.ts`），
 * 裸 `invoke<T>` 会把信封当数据用。
 */

import { invokeApi } from "../../app_ui/shared/api/call";

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
  return invokeApi<AlbumCreateResult>("album_create", {
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
  return invokeApi<AlbumSetMediaTypeResult>("album_set_media_type", {
    repoId: args.repoId,
    albumId: args.albumId,
    mediaType: args.mediaType,
  });
}

/** 添加相册成员 */
export function albumAddMember(args: AlbumAddMemberArgs): Promise<AlbumMemberResult> {
  return invokeApi<AlbumMemberResult>("album_add_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  });
}

/** 移除相册成员 */
export function albumRemoveMember(
  args: AlbumRemoveMemberArgs,
): Promise<AlbumRemoveResult> {
  return invokeApi<AlbumRemoveResult>("album_remove_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  });
}

/** 列出仓库下全部相册 */
export function albumList(args: AlbumListArgs): Promise<AlbumItem[]> {
  return invokeApi<AlbumItem[]>("album_list", { repoId: args.repoId });
}

/** 列出相册可见成员 */
export function albumMembers(args: AlbumMembersArgs): Promise<FileItem[]> {
  return invokeApi<FileItem[]>("album_members", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}

/** 执行相册同步（后台执行，返回 taskId） */
export function albumSync(args: AlbumSyncArgs): Promise<string> {
  return invokeApi<string>("album_sync", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}
