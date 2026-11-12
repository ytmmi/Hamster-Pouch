/**
 * 音乐播放器的**配色**（纯逻辑，无 React / Tauri 依赖）。
 *
 * 颜色**只能来自后端**：封面经 `convertFileSrc` 是跨源资源，前端 canvas 读像素
 * 会被 taint（`getImageData` 抛安全错误）。因此 `player.media` 直接回一组主色
 * （`haze_colors`，`hp_media::extract_palette` 算的，与色彩参考面板同一份算法），
 * 这里只负责把这些颜色换算成两套样式要用的 CSS 变量。
 *
 * 没有封面（或取色失败）时用 [`HAZE_FALLBACK_COLORS`]：**兜底晕染必须有**——
 * 用户口径是"无封面则用兜底的默认颜色晕"，而不是"没封面就没背景"。
 *
 * 两种样式对颜色的用法不同，但**同一份主色**：
 *
 * - 样式 1（色晕）是深底浅字：主色直接当三层光斑，盖在封面的高斯模糊底上。
 * - 样式 2（唱片）是浅底深字：主色被提亮成"天空"，再压暗成墨色文字；唱片本体
 *   也是主色调出来的（**不是黑胶的黑色**——用户口径），外圈还有两道细环。
 */

/** 兜底色晕（冷紫 → 洋红 → 天蓝，与播放器面板的选中色系同族）。 */
export const HAZE_FALLBACK_COLORS = ["#7b5cff", "#ff6f9c", "#4aa3ff"] as const;

/** 色晕层数（三层足够叠出"流动"的层次，再多只会糊成一团）。 */
export const HAZE_LAYER_COUNT = 3;

/** `#rrggbb` / `#rgb`：后端只会回这一种形态，非法值当作没有（不把脏值塞进 style）。 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 样式 2 的墨色基（浅底深字，主色压暗后与它混合，避免纯黑发脏）。 */
const INK_BASE = "#151a2e";

/** 样式 2 的强调色基（浅底需要一个稳定的冷色，主色与它混合后仍保留封面倾向）。 */
const ACCENT_BASE = "#6f6ff2";

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

/** `#rgb` / `#rrggbb` → 0–255 三元组；非法返回 `null`。 */
function toRgb(hex: string): [number, number, number] | null {
  if (!HEX_COLOR.test(hex)) return null;
  const raw = hex.slice(1);
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : raw;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: readonly [number, number, number]): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${rgb.map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 线性混色：`weight` 是 **`b` 的占比**（0 = 全是 `a`，1 = 全是 `b`）。
 *
 * 任一侧非法就退化成另一侧；两侧都非法返回兜底色——调用方不必先校验。
 */
export function mixHex(a: string, b: string, weight: number): string {
  const left = toRgb(a);
  const right = toRgb(b);
  if (!left && !right) return HAZE_FALLBACK_COLORS[0];
  if (!left) return right ? toHex(right) : HAZE_FALLBACK_COLORS[0];
  if (!right) return toHex(left);
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0;
  return toHex([
    left[0] + (right[0] - left[0]) * w,
    left[1] + (right[1] - left[1]) * w,
    left[2] + (right[2] - left[2]) * w,
  ]);
}

/** 提亮（与白混合）：`amount` 越大越接近白。 */
export function lighten(hex: string, amount: number): string {
  return mixHex(hex, "#ffffff", amount);
}

/** 压暗（与墨色基混合）：`amount` 越大越接近深色。 */
export function darken(hex: string, amount: number): string {
  return mixHex(hex, INK_BASE, amount);
}

/** 带透明度的 `rgba()` 字符串（CSS 变量里存整串，样式表不必再拆色值）。 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = toRgb(hex);
  if (!rgb) return `rgba(123, 92, 255, ${alpha})`;
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/**
 * 三色里**最鲜艳**的一个（`max - min` 最大的通道差）。
 *
 * 样式 2 的墨色/强调色都从它推：封面主色常常先是"大片浅底"，直接拿第一个色
 * 会得到一片灰白，整个界面就没有性格了。
 */
function pickAccent(colors: readonly string[]): string {
  let best = colors[0];
  let bestScore = -1;
  for (const color of colors) {
    const rgb = toRgb(color);
    if (!rgb) continue;
    const score = Math.max(...rgb) - Math.min(...rgb);
    if (score > bestScore) {
      bestScore = score;
      best = color;
    }
  }
  return best;
}

/**
 * 两套样式要用的全套 CSS 变量。
 *
 * `hazeVars` 的三个键保持原样（门禁按名字钉住），这里在其之上补：
 *
 * - `--player-ink` / `--player-ink-dim`：样式 2 的字色（浅底深字）。
 * - `--player-accent` / `--player-accent-soft`：样式 2 的强调色（播放键底、进度已播段）。
 * - `--player-sky-1` / `--player-sky-2`：样式 2 的浅色底（提亮后的主色）。
 * - `--player-disc-1` / `--player-disc-2`：唱片本体（主色提亮两档，**不是黑色**）。
 * - `--player-disc-ring`：唱片外那两道细环。
 */
export function stageVars(colors: readonly string[]): Record<string, string> {
  const [a, b, c] = hazeColorsOf(colors);
  const accentBase = pickAccent([a, b, c]);
  const accent = mixHex(accentBase, ACCENT_BASE, 0.45);
  return {
    ...hazeVars(colors),
    "--player-ink": darken(accentBase, 0.78),
    "--player-ink-dim": withAlpha(darken(accentBase, 0.62), 0.62),
    "--player-accent": accent,
    "--player-accent-soft": withAlpha(accent, 0.24),
    "--player-sky-1": lighten(mixHex(accentBase, a, 0.35), 0.86),
    "--player-sky-2": lighten(mixHex(b, c, 0.5), 0.74),
    "--player-disc-1": lighten(mixHex(accentBase, a, 0.3), 0.58),
    "--player-disc-2": lighten(mixHex(accentBase, a, 0.5), 0.3),
    "--player-disc-ring": withAlpha(mixHex(accent, INK_BASE, 0.35), 0.45),
  };
}
