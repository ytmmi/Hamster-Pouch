/**
 * M4-6 / M4-8：媒体播放与面板级嵌入命令封装（libmpv 子进程）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  MediaEmbedRectArgs,
  MediaPauseArgs,
  MediaPlayArgs,
  MediaPlayResult,
  MediaSeekArgs,
  MediaStatus,
  MediaStopArgs,
} from "../types";

/** 启动/复用常驻 mpv 子进程并加载文件，返回会话 ID */
export function mediaPlay(args: MediaPlayArgs): Promise<MediaPlayResult> {
  return invoke<MediaPlayResult>("media_play", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 暂停 / 继续（paused 缺省=切换为暂停） */
export function mediaPause(args: MediaPauseArgs): Promise<void> {
  return invoke<void>("media_pause", {
    sessionId: args.sessionId,
    paused: args.paused,
  });
}

/** 绝对定位到指定毫秒位置 */
export function mediaSeek(args: MediaSeekArgs): Promise<void> {
  return invoke<void>("media_seek", {
    sessionId: args.sessionId,
    positionMs: args.positionMs,
  });
}

/** 停止播放（保留常驻进程） */
export function mediaStop(args: MediaStopArgs): Promise<void> {
  return invoke<void>("media_stop", {
    sessionId: args.sessionId,
  });
}

/** 查询媒体子进程状态（alive / pipe） */
export function mediaProcessStatus(): Promise<MediaStatus> {
  return invoke<MediaStatus>("media_process_status");
}

/** 创建/更新面板级原生渲染子窗口（物理像素）；返回是否嵌入就绪 */
export function mediaEmbedRect(args: MediaEmbedRectArgs): Promise<boolean> {
  return invoke<boolean>("media_embed_rect", {
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
  });
}

/** 销毁面板级渲染子窗口（面板关闭时调用） */
export function mediaEmbedRelease(): Promise<void> {
  return invoke<void>("media_embed_release");
}
