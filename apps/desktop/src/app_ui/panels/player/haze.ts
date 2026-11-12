/**
 * 音乐播放器的**色晕**（纯逻辑，无 React / Tauri 依赖）。
 *
 * 色晕的颜色**只能来自后端**：封面经 `convertFileSrc` 是跨源资源，前端 canvas
 * 读像素会被 taint（`getImageData` 抛安全错误）。因此 `player.media` 直接回一组
 * 主色（`haze_colors`，`hp_media::extract_palette` 算的，与色彩参考面板同一份
 * 算法），这里只负责把颜色铺成三层 CSS 变量。
 *
 * 没有封面（或取色失败）时用 [`HAZE_FALLBACK_COLORS`]：**兜底晕染必须有**——
 * 用户口径是"无封面则用兜底的默认颜色晕"，而不是"没封面就没背景"。
 */

/** 兜底色晕（冷紫 → 洋红 → 天蓝，与播放器面板的选中色系同族）。 */
export const HAZE_FALLBACK_COLORS = ["#7b5cff", "#ff6f9c", "#4aa3ff"] as const;

/** 色晕层数（三层足够叠出"流动"的层次，再多只会糊成一团）。 */
export const HAZE_LAYER_COUNT = 3;

/** `#rrggbb` / `#rgb`：后端只会回这一种形态，非法值当作没有（不把脏值塞进 style）。 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 把后端主色裁成三层。
 *
 * 少于三层时**循环取色**（只有一两个主色的封面也能铺满三层，不至于整片同色）；
 * 一个合法色都没有 → 兜底三色。非法值逐个剔除，不整体放弃。
 */
export function hazeColorsOf(colors: readonly string[]): string[] {
  const valid = colors.filter((c) => typeof c === "string" && HEX_COLOR.test(c));
  if (valid.length === 0) return [...HAZE_FALLBACK_COLORS];
  return Array.from({ length: HAZE_LAYER_COUNT }, (_, i) => valid[i % valid.length]);
}

/**
 * 三层色晕的 CSS 变量（直接摊到容器的 `style` 上）。
 *
 * 变量名固定为 `--player-haze-a/b/c`，样式表只消费这三个——颜色在组件里算，
 * 样式表里不出现任何具体色值（换封面不会让样式表失去意义）。
 */
export function hazeVars(colors: readonly string[]): Record<string, string> {
  const [a, b, c] = hazeColorsOf(colors);
  return {
    "--player-haze-a": a,
    "--player-haze-b": b,
    "--player-haze-c": c,
  };
}
