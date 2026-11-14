/**
 * 播放器的时间显示（纯函数，无 React / Tauri 依赖）。
 *
 * 视频模式的进度条与音乐模式的播放卡共用同一套格式，所以从这里出一份——
 * 两处各写一遍迟早会出现「一处显示 `0:05`、另一处 `00:05`」。
 */

/** `m:ss` / `h:mm:ss`；未知或非正数一律 `--:--`（不猜"还没开始"与"没有时长"的区别）。 */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return "--:--";
  }
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 允许 0 的时钟（`0:00`）。
 *
 * 进度条的**起点**是合法的 0，不能像 [`formatMs`] 那样把它当成"没有时长"；
 * 参考图样式 1 的左端就写着 `0:00`。
 */
export function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "--:--";
  }
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 剩余时长（播放器样式 1 的进度条右端是 `-3:24` 这种**倒计时**，不是总时长）。
 *
 * 两端都已知时返回带减号的剩余；否则退回 `--:--`。
 */
export function formatRemaining(
  positionMs: number | null | undefined,
  durationMs: number | null | undefined,
): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return "--:--";
  }
  if (durationMs <= 0) return "--:--";
  const pos =
    positionMs === null || positionMs === undefined || !Number.isFinite(positionMs)
      ? 0
      : Math.min(Math.max(0, positionMs), durationMs);
  const left = durationMs - pos;
  const text = formatMs(left);
  return text === "--:--" ? text : `-${text}`;
}
