/**
 * 音乐播放器面板播放请求（蓝图双击音频 → 「显示音乐播放器 + payload.play」）。
 *
 * 与 `playerPlayStore`（视频）同构、但**分开**：两个面板各有各的可见性、各有各的
 * 静音状态，共用一条 store 会让"双击视频"把音乐面板也吵醒（D166：音乐是独立面板）。
 *
 * 模块级 store（同 `taskStore` 口径）：不进 React context；
 * 订阅者在挂载时先读当前值（可能面板后挂载、请求先到），再订阅后续请求。
 */

let current: { fileId: string; seq: number } | null = null;
const listeners = new Set<() => void>();

/** 请求音乐播放器面板播放指定文件（每次调用递增序号，同文件重播也能触发）。 */
export function requestMusicPlay(fileId: string): void {
  current = { fileId, seq: (current?.seq ?? 0) + 1 };
  for (const listener of [...listeners]) {
    listener();
  }
}

/** 最近一次播放请求（`null` = 从未请求过）。 */
export function getMusicPlayRequest(): { fileId: string; seq: number } | null {
  return current;
}

/** 订阅播放请求；返回退订函数。 */
export function subscribeMusicPlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
