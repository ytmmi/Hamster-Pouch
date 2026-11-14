/**
 * 播放器音量的夹紧（纯函数，无 React / Tauri 依赖）。
 *
 * 视频面板与音乐面板各有一份时，落库值的兜底默认值不同（视频 100、音乐 60），
 * 但**夹紧规则必须一致**：非有限值 → 各自默认，其余取整并夹到 0–100。
 * 设置声明里没有 min/max（见 `docs/spec/panel-standard.md` 第 5.3 节），
 * 范围由面板自己保证：落库值可能来自旧版本、手改的 `app_settings` 或宿主控件的边界。
 */
export function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
