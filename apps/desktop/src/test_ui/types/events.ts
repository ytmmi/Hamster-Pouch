/**
 * test_ui 事件负载类型。
 *
 * **2026-09（缺陷 0009 / D77）**：全部事件 DTO 已改为 `rename_all = "camelCase"`，
 * 这些声明原先写的蛇形字段与线上负载不符（本 harness 从不读这些字段，故一直没暴露）。
 * 这里按线上形状改为驼峰；本文件不是主界面回归面，改动只为与桥接层同源。
 */

/** scan.progress 事件 */
export interface ScanProgressPayload {
  taskId: string;
  sourceId: string;
  processed: number;
  total: number;
  phase: string;
}

/** scan.completed 事件 */
export interface ScanCompletedPayload {
  taskId: string;
  sourceId: string;
  indexed: number;
  changed: number;
  missing: number;
  skipped: number;
}

/** scan.error 事件 */
export interface ScanErrorPayload {
  taskId: string;
  sourceId: string;
  error: string;
}

/** album.sync.progress 事件 */
export interface AlbumSyncProgressPayload {
  taskId: string;
  albumId: string;
  added: number;
  removed: number;
  pinned: number;
}

/** album.sync.conflict 事件（逐文件，缺陷 0004：`fileId` 是真实成员 ID） */
export interface AlbumSyncConflictPayload {
  taskId: string;
  albumId: string;
  fileId: string;
  reason: string;
}

/** album.sync.failed 事件（整体失败，缺陷 0004） */
export interface AlbumSyncFailedPayload {
  taskId: string;
  albumId: string;
  error: string;
}

/** color.extracted 事件 */
export interface ColorExtractedPayload {
  taskId: string;
  fileId: string;
  palette: string[];
}
