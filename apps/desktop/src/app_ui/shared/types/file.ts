/**
 * M4：文件索引与元数据类型。
 */

/** album_members / file_query 返回元素 */
export interface FileItem {
  id: string;
  source_id: string;
  relative_path: string;
  media_type: string;
  /**
   * 媒体类型之下的**子类型**（当前只有文本类有值：`book` / `document`）。
   *
   * 它是**可编辑标记**（与 `media_type` 的扫描判定不同），因此可能是 `null`
   * ——旧索引行在重扫补齐前就是这个状态。消费方不得把它当"必有"。
   */
  subtype: string | null;
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
  /** 见 {@link FileItem.subtype}。 */
  subtype: string | null;
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
  /**
   * 只返回这些媒体类型（`image` / `video` / `audio` / `text`）；**缺省或空数组 = 不筛**。
   *
   * 是**集合**而不是单个取值（D95）：面板的类型域本来就是一组——媒体预览的「全部」
   * 指的是图片 / 视频 / 音频这三个（不是"索引里的一切"），图书预览指的是文本这一个。
   * 未知取值由后端拒为 `validation`（不静默丢掉那一项）。
   */
  mediaTypes?: string[];
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

/** preview_get 命令参数（有界预览，供 Chromium 无法解码的 HEIC/HEIF 查看，缺陷 0019） */
export interface PreviewGetArgs {
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
