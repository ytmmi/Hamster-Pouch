/**
 * 播放器命令封装（`player.media`）。
 *
 * **D76 迁移状态：已包装**：命令返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包。
 *
 * 调用方是**播放器面板**（`panels/MediaPlayerPanel.tsx`）的音乐模式：切歌时取一次
 * 封面与歌词。播放/暂停/切歌本身**不经过后端**（DOM `<video>`，D163），因此这个域
 * 只有一条命令——它只负责"取料"，不碰播放状态。
 */

import { invoke } from "@tauri-apps/api/core";

import type { PlayerMediaArgs, PlayerMediaResult } from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/**
 * 读取一首音频要显示的**封面路径**与**歌词正文**。
 *
 * 后端带磁盘缓存（按内容哈希失效）：内嵌封面解一次、`<hash>.audio-cover.jpg`；
 * "确定没有内嵌封面"也落标记（`<hash>.audio-cover.none`），不会有"每次切歌都起
 * 一次 ffmpeg"的开销。无封面 / 无歌词都返回 `null`，**不是错误**。
 */
export function playerMedia(args: PlayerMediaArgs): Promise<PlayerMediaResult> {
  return invoke<ApiResponse<PlayerMediaResult>>("player_media", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}
