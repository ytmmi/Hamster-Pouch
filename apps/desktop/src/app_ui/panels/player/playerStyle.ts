/**
 * 音乐播放器的**样式**（面板设置 `style`，纯逻辑、无 React / Tauri 依赖）。
 *
 * 用户 2026-11-13 口径：播放器有多种样式，在「全部设置 → 面板 → 媒体播放器」里切换。
 * 目前两种，参考图定稿：
 *
 * - `haze`（样式 1）：大方封面在左、歌词在右，背景是封面取色的**缓慢流动晕染**；
 * - `disc`（样式 2）：文字在左、**唱片**在右，播放中唱片匀速转动。
 *
 * 取值域与设置声明（`packages/config/src/panels.ts` 的 `player.settings`）**逐项一致**，
 * 门禁会拿两边对账；非法取值一律回落缺省（失败方向 = 画得出来，而不是空白面板）。
 */

/** 面板设置键的短名（落库键 = `panel.player.style`）。 */
export const PLAYER_STYLE_SETTING_KEY = "style";

/** 取值域（顺序即设置界面里的顺序）。 */
export const PLAYER_STYLES = ["haze", "disc"] as const;

/** 样式取值。 */
export type PlayerStyle = (typeof PLAYER_STYLES)[number];

/** 缺省样式（与设置声明的 `default` 同源）。 */
export const DEFAULT_PLAYER_STYLE: PlayerStyle = "haze";

/** 归一化：只认取值域内的字符串，其余回落缺省。 */
export function normalizePlayerStyle(raw: unknown): PlayerStyle {
  return typeof raw === "string" && (PLAYER_STYLES as readonly string[]).includes(raw)
    ? (raw as PlayerStyle)
    : DEFAULT_PLAYER_STYLE;
}

/** 样式 → i18n 键（设置项候选文案）。 */
export function playerStyleTitleKey(style: PlayerStyle): string {
  return `player.settings.style.${style}`;
}
