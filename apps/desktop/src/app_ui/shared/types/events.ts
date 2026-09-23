/**
 * Tauri 事件负载类型。
 */

/** scan.progress 事件 */
export interface ScanProgressPayload {
  task_id: string;
  source_id: string;
  processed: number;
  total: number;
  /** `walking`（遍历目录，total 未知记 0）| `indexing`（逐文件索引）。 */
  phase: string;
  /** 正在处理的条目（相对路径或目录）；代表该文件正在被哈希/抽帧。 */
  current?: string | null;
}

/** scan.completed 事件 */
export interface ScanCompletedPayload {
  task_id: string;
  source_id: string;
  indexed: number;
  changed: number;
  missing: number;
  skipped: number;
  /** 是否被用户取消（取消不是错误，统计为已完成部分）。 */
  cancelled: boolean;
}

/** scan.error 事件 */
export interface ScanErrorPayload {
  task_id: string;
  source_id: string;
  error: string;
}

/** source.unmount.progress 事件（完全卸载的分阶段进度） */
export interface SourceUnmountProgressPayload {
  task_id: string;
  source_id: string;
  /** `counting` / `syncRules` / `children` / `derived` / `files` / `source` */
  phase: string;
  processed: number;
  /** 0 = 该阶段总数未知（界面按不定进度显示） */
  total: number;
}

/** source.unmount.completed 事件（完全卸载结果） */
export interface SourceUnmountCompletedPayload {
  task_id: string;
  source_id: string;
  /** 是否被用户取消（取消时整个事务回滚，什么都没删）。 */
  cancelled: boolean;
  files: number;
  tags: number;
  ratings: number;
  colors: number;
  members: number;
  /** 降级为普通相册的跟随相册数。 */
  sync_albums: number;
  /** 摘挂为顶层源的子源数。 */
  child_sources: number;
}

/** source.unmount.error 事件 */
export interface SourceUnmountErrorPayload {
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
