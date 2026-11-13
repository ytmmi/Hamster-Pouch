/**
 * 音乐播放器面板的队列（`kind = "audio"`）。
 *
 * 队列实现与媒体播放器（`kind = "video"`）共用一份：`panels/playableQueue.ts`。
 * 这里只把类型与"只收音频"这一档固定下来，面板侧不必再传 `kind`。
 */

import type { AppContextValue } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import { usePlayableQueue, type PlayableQueue } from "../playableQueue";

/** 单页条数（`file.query` / `album.members` 的后端上限同样是 1000）。 */
export const QUEUE_PAGE_LIMIT = 1000;

/** 音乐面板的队列：当前范围里的**音频** + 当前位置。 */
export type MusicQueue = PlayableQueue;

/** 加载并跟踪音频队列（仓库 / 相册 / 源 / 子目录 / 刷新计数变化即重载）。 */
export function useMusicQueue(
  app: AppContextValue,
  panelApi?: PanelRenderCtx["api"],
): MusicQueue {
  return usePlayableQueue(app, panelApi, "audio");
}
