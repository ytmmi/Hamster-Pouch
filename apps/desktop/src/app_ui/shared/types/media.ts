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

/** media_embed_rect 命令参数（物理像素，主窗口客户区坐标） */
export interface MediaEmbedRectArgs {
  x: number;
  y: number;
  width: number;
  height: number;
}
