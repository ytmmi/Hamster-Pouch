/**
 * M4：文件索引与元数据类型。
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

export interface FileMetadataArgs {
  repoId: string;
  fileId: string;
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

export interface FilePathArgs {
  repoId: string;
  fileId: string;
}

/**
 * `file.query` 的过滤条件（契约里的 `filter` 对象）。
 *
 * 三者都是**可选**：不传即不按该维度过滤。
 */
export interface FileQueryFilter {
  /** `image` / `video` / `audio` / `multimedia`（缺省不过滤）。 */
  mediaType?: string;
  sourceId?: string;
  /** 只返回相对路径以 `<dirPrefix>/` 开头的文件（含更深子目录）。 */
  dirPrefix?: string;
}

/**
 * `file.query` 的命令参数（**游标分页**，D78）。
 *
 * `limit` 只是**页大小**；`cursor` 是上次响应里的 `nextCursor`（不透明字符串，
 * 原样回传即可续页，调用方不得解析其内容）。
 */
export interface FileQueryArgs {
  repoId: string;
  filter?: FileQueryFilter;
  cursor?: string | null;
  limit?: number;
}

/**
 * `file.query` 的响应体。
 *
 * **排序键**：`(relative_path, source_id, id)` 升序——分页顺序由它决定，
 * 且翻页途中库内容变动不会漏项/重复（键集游标，不是 `OFFSET`）。
 */
export interface FileQueryPage {
  items: FileItem[];
  /** `null` = 已到末页。 */
  nextCursor: string | null;
}

/** thumb_get 命令参数 */
export interface ThumbGetArgs {
  repoId: string;
  fileId: string;
}

/** file_rename 命令参数 */
export interface FileRenameArgs {
  repoId: string;
  fileId: string;
  newName: string;
}

/** file_trash 命令参数 */
export interface FileTrashArgs {
  repoId: string;
  fileIds: string[];
}

/** file_reanalyze 命令参数 */
export interface FileReanalyzeArgs {
  repoId: string;
  fileId: string;
}
