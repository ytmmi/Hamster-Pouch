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

/** `file.query` 的过滤条件（契约里的 `filter` 对象）。 */
export interface FileQueryFilter {
  mediaType?: string;
  sourceId?: string;
  dirPrefix?: string;
}

/** `file.query` 的命令参数（游标分页，D78）。 */
export interface FileQueryArgs {
  repoId: string;
  filter?: FileQueryFilter;
  cursor?: string | null;
  limit?: number;
}

/** `file.query` 的响应体（排序键 `(relative_path, source_id, id)`）。 */
export interface FileQueryPage {
  items: FileItem[];
  nextCursor: string | null;
}
