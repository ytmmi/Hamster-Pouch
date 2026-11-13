/**
 * 音乐播放器面板的**样式**（面板设置 `style`，纯逻辑、无 React / Tauri 依赖）。
 *
 * 用户 2026-11-13 口径：播放器有多种样式，在「全部设置 → 面板 → 音乐播放器」里切换。
 * 目前两种，参考图定稿：
 *
 * - `haze`（样式 1）：大方封面在左、歌词在右，背景是封面取色的**缓慢流动晕染**；
 * - `disc`（样式 2）：文字在左、**唱片**在右，播放中唱片匀速转动。
 *
 * 取值域与设置声明（`packages/config/src/panels.ts` 的 `music` 面板 `settings`）
 * **逐项一致**，门禁会拿两边对账；非法取值一律回落缺省（失败方向 = 画得出来，
 * 而不是空白面板）。
 */

/** 面板设置键的短名（落库键 = `panel.music.style`）。 */
export const MUSIC_STYLE_SETTING_KEY = "style";

/** 取值域（顺序即设置界面里的顺序）。 */
export const MUSIC_STYLES = ["haze", "disc"] as const;

/** 样式取值。 */
export type MusicStyle = (typeof MUSIC_STYLES)[number];

/** 缺省样式（与设置声明的 `default` 同源）。 */
export const DEFAULT_MUSIC_STYLE: MusicStyle = "haze";

/** 归一化：只认取值域内的字符串，其余回落缺省。 */
export function normalizeMusicStyle(raw: unknown): MusicStyle {
  return typeof raw === "string" && (MUSIC_STYLES as readonly string[]).includes(raw)
    ? (raw as MusicStyle)
    : DEFAULT_MUSIC_STYLE;
}

/** 样式 → i18n 键（设置项候选文案）。 */
export function musicStyleTitleKey(style: MusicStyle): string {
  return `music.settings.style.${style}`;
}
