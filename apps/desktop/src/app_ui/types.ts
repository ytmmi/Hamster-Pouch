/**
 * test_ui 类型定义 — 对应 src-tauri/src/main.rs 中所有命令返回值与事件负载。
 *
 * 规则：
 * - 命令参数键使用 camelCase（Tauri v2 自动映射 snake_case）。
 * - 返回值 / 事件负载字段使用 snake_case（serde 默认序列化，无 rename_all）。
 */

// ===== M1：仓库与设置 =====

/** repo_create / repo_open 返回 */
export interface RepoSummary {
  id: string;
  name: string;
  schema_version: number;
}

/** repo_list 返回元素 */
export interface RepoListItem {
  id: string;
  name: string;
  repo_db_path: string;
  created_at: string;
  last_opened_at: string | null;
}

// ===== M2：图像源 =====

/** source_mount / source_list 返回元素 */
export interface SourceItem {
  id: string;
  repo_id: string;
  local_path: string;
  alias: string | null;
  parent_source_id: string | null;
  mounted: boolean;
  mounted_at: string;
}

// ===== M3：虚拟相册 =====

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

/** album_members / file_query 返回元素 */
export interface FileItem {
  id: string;
  source_id: string;
  relative_path: string;
  media_type: string;
  size: number;
  mtime: string;
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

// ===== M4：标签 / 评分 / 元数据 / 色彩 =====

/** tag_list / tag_for_file 返回元素 */
export interface TagItem {
  id: string;
  repo_id: string;
  name: string;
  color: string | null;
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

// ===== 事件负载 =====

/** scan.progress 事件 */
export interface ScanProgressPayload {
  task_id: string;
  source_id: string;
  processed: number;
  total: number;
  phase: string;
}

/** scan.completed 事件 */
export interface ScanCompletedPayload {
  task_id: string;
  source_id: string;
  indexed: number;
  changed: number;
  missing: number;
  skipped: number;
}

/** scan.error 事件 */
export interface ScanErrorPayload {
  task_id: string;
  source_id: string;
  error: string;
}

/** album.sync.progress 事件 */
export interface AlbumSyncProgressPayload {
  task_id: string;
  album_id: string;
  added: number;
  removed: number;
  pinned: number;
}

/** album.sync.conflict 事件 */
export interface AlbumSyncConflictPayload {
  task_id: string;
  album_id: string;
  file_id: string;
  reason: string;
}

/** color.extracted 事件 */
export interface ColorExtractedPayload {
  task_id: string;
  file_id: string;
  palette: string[];
}

// ===== 共享 UI 类型 =====

export type StatusType = "error" | "ok" | "info";

/** 状态栏消息回调 */
export type StatusHandler = (message: string, type?: StatusType) => void;

// ===== 命令参数类型（camelCase 键） =====

export interface RepoCreateArgs {
  name: string;
  dbPath?: string;
}

export interface RepoOpenArgs {
  repoId: string;
}

export interface SettingGetArgs {
  key: string;
}

export interface SettingSetArgs {
  key: string;
  value: string;
}

export interface SourceMountArgs {
  repoId: string;
  localPath: string;
  alias?: string;
  parentSourceId?: string;
}

export interface SourceUnmountArgs {
  repoId: string;
  sourceId: string;
}

export interface SourceRenameArgs {
  repoId: string;
  sourceId: string;
  alias: string;
}

export interface SourceListArgs {
  repoId: string;
}

export interface SourceScanArgs {
  repoId: string;
  sourceId: string;
  full?: boolean;
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

export interface TagAddArgs {
  repoId: string;
  fileIds: string[];
  tagName: string;
}

export interface TagRemoveArgs {
  repoId: string;
  fileIds: string[];
  tagName: string;
}

export interface TagListArgs {
  repoId: string;
}

export interface TagForFileArgs {
  repoId: string;
  fileId: string;
}

export interface RatingSetArgs {
  repoId: string;
  fileId: string;
  rating: number;
}

export interface RatingGetArgs {
  repoId: string;
  fileId: string;
}

export interface ColorGetArgs {
  repoId: string;
  fileId: string;
}

export interface ColorSetArgs {
  repoId: string;
  fileId: string;
  colorJson: string;
}

export interface ColorExtractArgs {
  repoId: string;
  fileId: string;
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

// ===== M4-6：媒体播放（libmpv 子进程） =====

/** media_play 返回 */
export interface MediaPlayResult {
  session_id: string;
}

/** media_process_status 返回 */
export interface MediaStatus {
  alive: boolean;
  pipe: string;
}

export interface MediaPlayArgs {
  repoId: string;
  fileId: string;
}

export interface MediaPauseArgs {
  sessionId: string;
  paused?: boolean;
}

export interface MediaSeekArgs {
  sessionId: string;
  positionMs: number;
}

export interface MediaStopArgs {
  sessionId: string;
}
