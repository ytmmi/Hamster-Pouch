/**
 * M3：虚拟相册类型。
 */

import type { FileItem } from "./file";

/** album_list 返回元素 */
export interface AlbumItem {
  id: string;
  repo_id: string;
  parent_album_id: string | null;
  name: string;
  kind: string;
  media_type: string | null;
  /** 成员数量 */
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface AlbumCreateArgs {
  repoId: string;
  name: string;
  kind: string;
  mediaType?: string;
  parentAlbumId?: string;
  sourceId?: string;
  syncMode?: string;
  includeSubsources?: boolean;
  filterJson?: string;
  fileIds?: string[];
}

/** album_create 返回 */
export interface AlbumCreateResult {
  album_id: string;
}

export interface AlbumSetMediaTypeArgs {
  repoId: string;
  albumId: string;
  mediaType?: string;
}

/** album_set_media_type 返回 */
export interface AlbumSetMediaTypeResult {
  removed_count: number;
  op_record_id: string | null;
}

export interface AlbumAddMemberArgs {
  repoId: string;
  albumId: string;
  fileIds: string[];
}

/** album_add_member 返回 */
export interface AlbumMemberResult {
  added: number;
}

export interface AlbumRemoveMemberArgs {
  repoId: string;
  albumId: string;
  fileIds: string[];
}

/** album_remove_member 返回 */
export interface AlbumRemoveResult {
  removed: number;
}

export interface AlbumListArgs {
  repoId: string;
}

export interface AlbumMembersArgs {
  repoId: string;
  albumId: string;
  /** 续页游标：把上次响应的 `nextCursor` 原样回传；不传 = 第一页。 */
  cursor?: string | null;
  /** 页大小（后端默认 500、上限 1000）。 */
  limit?: number | null;
}

/**
 * `album.members` 的返回体：本页 + 下一页游标（`null` = 已到末页）。
 *
 * 与 `file.query` 的 `FileQueryPage` **同形**（D78 先例）：界面按同一套
 * "回传 nextCursor" 的写法消费两种分页。
 */
export interface AlbumMembersPage {
  items: FileItem[];
  nextCursor: string | null;
}

export interface AlbumSyncArgs {
  repoId: string;
  albumId: string;
}

/** album_rename 命令参数 */
export interface AlbumRenameArgs {
  repoId: string;
  albumId: string;
  name: string;
}

/** album_delete 命令参数 */
export interface AlbumDeleteArgs {
  repoId: string;
  albumId: string;
}
