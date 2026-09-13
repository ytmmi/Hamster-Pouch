/**
 * test_ui M4-6：媒体播放类型（libmpv 子进程）。
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
