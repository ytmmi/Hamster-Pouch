/**
 * test_ui M4：文件索引与元数据类型。
 */

/** album_members / file_query 返回元素 */
export interface FileItem {
  id: string;
  source_id: string;
  relative_path: string;
  media_type: string;
  size: number;
  mtime: string;
}

/** file_metadata 返回 */
export interface FileMetadataResult {
  id: string;
  source_id: string;
  relative_path: string;
  media_type: string;
  content_hash: string | null;
  size: number;
  mtime: string;
  verify_status: string;
  media_info_json: string | null;
  exif_json: string | null;
}

export interface FileMetadataArgs {
  repoId: string;
  fileId: string;
}

export interface FilePathArgs {
  repoId: string;
  fileId: string;
}

export interface FileQueryArgs {
  repoId: string;
  mediaType?: string;
  sourceId?: string;
  limit?: number;
  offset?: number;
}
