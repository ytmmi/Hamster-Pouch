/**
 * M4-6 / M4-8：媒体播放与面板级嵌入类型。
 */

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

/**
 * `media_pause` 参数。
 *
 * **不含 `sessionId`**：后端按"当前常驻媒体子进程"操作，`sessionId` 只是
 * `file_id` 的回显、并不参与定位；省略它才能让面板在**没有本地会话记录**时
 * 也直接控制播放（蓝图双击启动的情形，见 `MediaPlayerPanel`）。
 */
export interface MediaPauseArgs {
  paused?: boolean;
}

/**
 * `media_toggle_pause` 返回：单击画面 = 暂停/继续 的原子切换结果。
 *
 * `has_session = false` 表示当前没有活跃会话（无子进程，或已停止/已播完回到 idle）——
 * 前端据此转去「播放当前选中文件」；`has_session = true` 时 `paused` 是**切换后**的值。
 */
export interface MediaTogglePauseResult {
  has_session: boolean;
  paused: boolean;
}

/** `media_seek` 参数（同样不含 `sessionId`，理由见 `MediaPauseArgs`）。 */
export interface MediaSeekArgs {
  positionMs: number;
}

/** `media_stop` 参数：后端不接受参数。 */
export type MediaStopArgs = Record<string, never>;

/** media_embed_rect 命令参数（物理像素，主窗口客户区坐标） */
export interface MediaEmbedRectArgs {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * media_playback_state 返回：播放进度快照（进度条与暂停状态实时同步）。
 *
 * 单位均为毫秒；`null` 表示该属性当前取不到（未加载文件、时长仍在探测等）。
 */
export interface MediaPlaybackSnapshot {
  /** 媒体子进程是否存活。 */
  alive: boolean;
  position_ms: number | null;
  duration_ms: number | null;
  paused: boolean | null;
  /** 是否已回到 idle（播完或已停止）。 */
  ended: boolean;
}
