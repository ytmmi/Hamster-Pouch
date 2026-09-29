/**
 * Tauri 事件负载类型。
 *
 * **D77（2026-09）**：全部事件 DTO 统一加 `#[serde(rename_all = "camelCase")]`，
 * 因此这里一律用**驼峰**声明（此前按 Rust 字段名逐字序列化成蛇形）。
 * 载荷字段名与后端 DTO 必须逐字一致；`apps/desktop/src-tauri/src/commands/*.rs`
 * 里的 `*Event` 结构体是权威定义。
 *
 * 注：`repo.changed` / `panel.restore` 是**前端自己 emit** 的事件（不经 Rust DTO），
 * 一直是驼峰；`media.surface.click` 是空载荷。
 */

/** scan.progress 事件 */
export interface ScanProgressPayload {
  taskId: string;
  sourceId: string;
  processed: number;
  total: number;
  /** `walking`（遍历目录，total 未知记 0）| `indexing`（逐文件索引）。 */
  phase: string;
  /** 正在处理的条目（相对路径或目录）；代表该文件正在被哈希/抽帧。 */
  current?: string | null;
  /**
   * 该任务是否支持暂停/恢复。
   *
   * 整源扫描为 `true`；**单文件「重新分析」为 `false`**（一个文件的哈希/抽帧/调色板
   * 一口气做完，没有暂停点）——浮窗据此**不显示**暂停按钮，免得留一个按不动的键。
   */
  pausable: boolean;
}

/** scan.completed 事件 */
export interface ScanCompletedPayload {
  taskId: string;
  sourceId: string;
  indexed: number;
  changed: number;
  missing: number;
  skipped: number;
  /** 是否被用户取消（取消不是错误，统计为已完成部分）。 */
  cancelled: boolean;
}

/** scan.error 事件 */
export interface ScanErrorPayload {
  taskId: string;
  sourceId: string;
  error: string;
}

/** source.unmount.progress 事件（完全卸载的分阶段进度） */
export interface SourceUnmountProgressPayload {
  taskId: string;
  sourceId: string;
  /** `counting` / `syncRules` / `children` / `derived` / `files` / `source` */
  phase: string;
  processed: number;
  /** 0 = 该阶段总数未知（界面按不定进度显示） */
  total: number;
}

/** source.unmount.completed 事件（完全卸载结果） */
export interface SourceUnmountCompletedPayload {
  taskId: string;
  sourceId: string;
  /** 是否被用户取消（取消时整个事务回滚，什么都没删）。 */
  cancelled: boolean;
  files: number;
  tags: number;
  ratings: number;
  colors: number;
  members: number;
  /** 降级为普通相册的跟随相册数。 */
  syncAlbums: number;
  /** 摘挂为顶层源的子源数。 */
  childSources: number;
}

/** source.unmount.error 事件 */
export interface SourceUnmountErrorPayload {
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

/**
 * album.sync.conflict 事件（**逐文件**，缺陷 0004）。
 *
 * 一个冲突成员一条事件：`fileId` 是**真实**成员 ID，`reason` 是稳定原因码
 * （当前只有 `pinned_kept`：成员已被用户固定，`mirror` 本应移除却保留）。
 * 整体失败不再是本事件，见 [`AlbumSyncFailedPayload`]。
 */
export interface AlbumSyncConflictPayload {
  taskId: string;
  albumId: string;
  fileId: string;
  reason: string;
}

/** album.sync.failed 事件（**整体失败**，缺陷 0004）：与逐文件冲突分开。 */
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

/**
 * plugin.loaded 事件（**2026-09 补发射点**，契约 §4）。
 *
 * 语义：校验通过、`LoadOutcome` 已产出即算"加载完成"（**生命周期骨架**）——
 * **不代表**常驻进程已拉起，那属 `external-process` 监督（仍未实现）。
 */
export interface PluginLoadedPayload {
  pluginId: string;
  repoId: string;
}
