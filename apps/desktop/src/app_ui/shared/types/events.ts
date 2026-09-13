/**
 * Tauri 事件负载类型。
 */

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
