/**
 * 播放器面板播放请求（蓝图双击视频 → 「显示播放器 + payload.play」）。
 *
 * 播放器面板已改为 DOM `<video>`（与查看器同构，见 `docs/rfc/0005-media-capabilities.md`
 * 2026-09 决策更新）：libmpv 原生窗口嵌入在真机上反复暴露两类问题（点击穿透不可靠、
 * 原生窗口漂浮在 DOM 浮层上方），不再使用。因此宿主侧的 `playFile` 不再启动 mpv 子进程，
 * 而是把「播放哪个文件」的请求投递给播放器面板。
 *
 * 模块级 store（同 `taskStore` 口径）：不进 React context；
 * 订阅者在挂载时先读当前值（可能面板后挂载、请求先到），再订阅后续请求。
 */

let current: { fileId: string; seq: number } | null = null;
const listeners = new Set<() => void>();

/** 请求播放器面板播放指定文件（每次调用递增序号，同文件重播也能触发）。 */
export function requestPlayerPlay(fileId: string): void {
  current = { fileId, seq: (current?.seq ?? 0) + 1 };
  for (const listener of [...listeners]) {
    listener();
  }
}

/** 最近一次播放请求（`null` = 从未请求过）。 */
export function getPlayerPlayRequest(): { fileId: string; seq: number } | null {
  return current;
}

/** 订阅播放请求；返回退订函数。 */
export function subscribePlayerPlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
