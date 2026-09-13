/**
 * test_ui M3：虚拟相册类型。
 */

/** album_list 返回元素 */
export interface AlbumItem {
  id: string;
  repo_id: string;
  parent_album_id: string | null;
  name: string;
  kind: string;
  media_type: string | null;
  created_at: string;
  updated_at: string;
}

/** album_create 返回 */
export interface AlbumCreateResult {
  album_id: string;
}

/** album_set_media_type 返回 */
export interface AlbumSetMediaTypeResult {
  removed_count: number;
  op_record_id: string | null;
}

/** album_add_member 返回 */
export interface AlbumMemberResult {
  added: number;
}

/** album_remove_member 返回 */
export interface AlbumRemoveResult {
  removed: number;
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

export interface AlbumSetMediaTypeArgs {
  repoId: string;
  albumId: string;
  mediaType?: string;
}

export interface AlbumAddMemberArgs {
  repoId: string;
  albumId: string;
  fileIds: string[];
}

export interface AlbumRemoveMemberArgs {
  repoId: string;
  albumId: string;
  fileIds: string[];
}

export interface AlbumListArgs {
  repoId: string;
}

export interface AlbumMembersArgs {
  repoId: string;
  albumId: string;
}

export interface AlbumSyncArgs {
  repoId: string;
  albumId: string;
}
