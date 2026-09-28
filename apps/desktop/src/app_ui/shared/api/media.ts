/**
 * M4-6 / M4-8：媒体播放与面板级嵌入命令封装（libmpv 子进程）。
 *
 * **D76 迁移状态：已包装**（批次 `media`，2026-09）。全部命令是**异步命令**，
 * 后端返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包。
 *
 * **注意**：自 2026-09 起播放器面板改用 DOM `<video>`（与查看器同构），libmpv 原生
 * 窗口路径**退役休眠**——本文件当前**没有调用方**；保留封装是为了不改动休眠代码的
 * 形状，将来若复活只需按既有调用习惯使用。
 *
 * **休眠标注是系统性的**（同一批）：桥接层 `commands/media.rs`（命令实现）、
 * `embed_window.rs`（原生子窗口）、`main.rs` 的 `media.*` 注册段（含 `===== 休眠段 =====`
 * 分隔）与 `AppState.media` / `media_embed` 字段、`crates/hp-media` 的 `player` 模块，
 * 以及契约 §4 的 `media.surface.click`。判定依据见缺陷 `docs/issues/0001` / `0010`。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  MediaEmbedRectArgs,
  MediaPauseArgs,
  MediaPlayArgs,
  MediaPlayResult,
  MediaPlaybackSnapshot,
  MediaSeekArgs,
  MediaStatus,
  MediaStopArgs,
  MediaTogglePauseResult,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 启动/复用常驻 mpv 子进程并加载文件，返回会话 ID */
export function mediaPlay(args: MediaPlayArgs): Promise<MediaPlayResult> {
  return invoke<ApiResponse<MediaPlayResult>>("media_play", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}

/**
 * 暂停 / 继续（paused 缺省=切换为暂停）。
 *
 * 后端按"当前常驻媒体子进程"操作、**不使用** `sessionId`（它只是 `file_id` 的回显），
 * 因此这里不再传——面板也就能在没有本地会话记录时直接控制播放（蓝图双击的情形）。
 */
export function mediaPause(args: MediaPauseArgs): Promise<void> {
  return invoke<ApiResponse<void>>("media_pause", { paused: args.paused }).then(unwrapApi);
}

/** 绝对定位到指定毫秒位置（同样不依赖 `sessionId`）。 */
export function mediaSeek(args: MediaSeekArgs): Promise<void> {
  return invoke<ApiResponse<void>>("media_seek", { positionMs: args.positionMs }).then(unwrapApi);
}

/**
 * 原子切换暂停 / 继续（单击画面 = 暂停/继续 的处理入口）。
 *
 * 后端在一次锁内完成「读 pause → 取反写入」，返回 `{ has_session, paused }`：
 * 并发点击（双击）各自只翻转一次，不会因读到相同的旧快照而发出两次相同的暂停
 * （旧路径表现为"暂停后再单击无法继续"）。
 */
export function mediaTogglePause(): Promise<MediaTogglePauseResult> {
  return invoke<ApiResponse<MediaTogglePauseResult>>("media_toggle_pause").then(unwrapApi);
}

/** 停止播放（保留常驻进程）。 */
export function mediaStop(): Promise<void> {
  return invoke<ApiResponse<void>>("media_stop").then(unwrapApi);
}

/** 查询媒体子进程状态（alive / pipe） */
export function mediaProcessStatus(): Promise<MediaStatus> {
  return invoke<ApiResponse<MediaStatus>>("media_process_status").then(unwrapApi);
}

/** 创建/更新面板级原生渲染子窗口（物理像素）；返回是否嵌入就绪 */
export function mediaEmbedRect(args: MediaEmbedRectArgs): Promise<boolean> {
  return invoke<ApiResponse<boolean>>("media_embed_rect", {
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
  }).then(unwrapApi);
}

/** 销毁面板级渲染子窗口（面板关闭时调用） */
export function mediaEmbedRelease(): Promise<void> {
  return invoke<ApiResponse<void>>("media_embed_release").then(unwrapApi);
}

/**
 * 显示/隐藏面板级渲染子窗口（面板切到后台标签时必须隐藏）。
 *
 * 原生子窗口不受 DOM/CSS 约束，不会随面板卸载自动消失；返回 `false` 表示窗口
 * 尚未创建（隐藏是空操作，不算错误）。
 */
export function mediaEmbedVisible(visible: boolean): Promise<boolean> {
  return invoke<ApiResponse<boolean>>("media_embed_visible", { visible }).then(unwrapApi);
}

/**
 * 设置渲染子窗口是否把鼠标事件穿透给下层 WebView（默认穿透）。
 *
 * 穿透开启时「单击视频暂停/继续」与进度条拖动才能收到事件。
 */
export function mediaEmbedClickThrough(enabled: boolean): Promise<boolean> {
  return invoke<ApiResponse<boolean>>("media_embed_click_through", { enabled }).then(unwrapApi);
}

/** 读取播放进度快照（进度条与暂停状态实时同步）。 */
export function mediaPlaybackState(): Promise<MediaPlaybackSnapshot> {
  return invoke<ApiResponse<MediaPlaybackSnapshot>>("media_playback_state").then(unwrapApi);
}
