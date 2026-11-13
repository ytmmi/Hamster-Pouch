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
 * - 样式 1（色晕）是深底浅字：主色板里的**一两个**颜色直接当光斑（不用封面糊图）。
 * - 样式 2（唱片）是浅底深字：主色被提亮成"天空"，再压暗成墨色文字；唱片本体
 *   也是主色调出来的（**不是黑胶的黑色**——用户口径），外圈还有两道细环。
 */

/**
 * 兜底色晕（**浅色系**：薰衣草 → 樱粉 → 天青）。
 *
 * 用户 2026-11-13：「默认的颜色晕不要暗色」。兜底色**不经** [`vivid`] 的压暗
 * （那只为"封面主色常常是白底、当光斑会把背景洗白"而设，兜底色本来就是给
 * "没有封面的歌"看的氛围），所以这里直接给一组亮的，压上去仍读得出白字。
 */
export const HAZE_FALLBACK_COLORS = ["#b9a4ff", "#ffb3cd", "#9fc6ff"] as const;

/**
 * 色晕光斑层数（**两盏**）。
 *
 * 用户 2026-11-13 口径：「在封面的颜色板上选 1-2 个颜色进行颜色晕的渲染」——
 * 因此光斑只用主色板的前两个颜色，不再铺第三盏，也不再垫封面的高斯模糊图。
 */
export const HAZE_LAYER_COUNT = 2;

/** `#rrggbb` / `#rgb`：后端只会回这一种形态，非法值当作没有（不把脏值塞进 style）。 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 样式 2 的墨色基（浅底深字，主色压暗后与它混合，避免纯黑发脏）。 */
const INK_BASE = "#151a2e";

/** 样式 2 的强调色基（浅底需要一个稳定的冷色，主色与它混合后仍保留封面倾向）。 */
const ACCENT_BASE = "#6f6ff2";

/**
 * 把后端主色裁成两盏光斑要用的颜色。
 *
 * 只有一个合法色时**循环取色**（两盏同色，靠不同位置/尺寸仍能叠出层次）；
 * 一个合法色都没有 → 兜底两色。非法值逐个剔除，不整体放弃。
 */
export function hazeColorsOf(colors: readonly string[]): string[] {
  const valid = colors.filter((c) => typeof c === "string" && HEX_COLOR.test(c));
  if (valid.length === 0) return [...HAZE_FALLBACK_COLORS].slice(0, HAZE_LAYER_COUNT);
  return Array.from({ length: HAZE_LAYER_COUNT }, (_, i) => valid[i % valid.length]);
}

/**
 * 把主色拉到"能当光斑用"的区间：**饱和度至少 0.42、亮度落在 0.30–0.58**。
 *
 * 主色是"封面里出现最多的颜色"，浅色封面（白底插画、和纸封面）的主色常常接近
 * `#eeeeee`——直接拿去当光斑并 `mix-blend-mode: screen`，整块背景会发白，
 * 白字压在上面根本读不出来。这里统一压回深色高饱和，封面只决定**色相**。
 * 近乎无彩（通道差 < 24）的颜色按强调基色混一次，避免"灰盘配灰晕"。
 */
export function vivid(hex: string): string {
  const rgb = toRgb(hex);
  if (!rgb) return HAZE_FALLBACK_COLORS[0];
  const [h, s, l] = rgbToHsl(rgb);
  const safeHue = Math.max(...rgb) - Math.min(...rgb) < 24 ? hueOf(ACCENT_BASE) : h;
  const saturation = Math.max(0.42, Math.min(1, s));
  const lightness = Math.max(0.3, Math.min(0.58, l));
  return toHex(hslToRgb(safeHue, saturation, lightness));
}

/** 旋转色相（保持 s/l）。 */
export function shiftHue(hex: string, degrees: number): string {
  const rgb = toRgb(hex);
  if (!rgb) return hex;
  const [h, s, l] = rgbToHsl(rgb);
  return toHex(hslToRgb(h + degrees, s, l));
}

/**
 * 拉开色相距离：相邻两层至少差 `MIN_HUE_GAP` 度。
 *
 * 封面常常只有一个色系（一张紫发插画 → 三个紫），三层光斑叠起来就是一块单色，
 * "流动"完全看不出来。这里只动色相（亮度/饱和度保留封面倾向），把第二、三层
 * 各推开一档，晕染才有参考图那种"粉 → 紫 → 蓝"的过渡。
 */
const MIN_HUE_GAP = 26;

function spreadHues(colors: readonly string[]): string[] {
  const out: string[] = [];
  for (const color of colors) {
    let hue = hueOf(color);
    let candidate = color;
    for (let guard = 0; guard < 4; guard += 1) {
      const clash = out.some((prev) => {
        const gap = Math.abs(((hue - hueOf(prev) + 540) % 360) - 180);
        return gap < MIN_HUE_GAP;
      });
      if (!clash) break;
      hue = (hue + 34) % 360;
      candidate = shiftHue(color, 34 * (guard + 1));
    }
    out.push(candidate);
  }
  return out;
}

/**
 * 两盏色晕的 CSS 变量（直接摊到容器的 `style` 上）。
 *
 * 变量名固定为 `--player-haze-a/b`，样式表只消费这两个——颜色在组件里算，
 * 样式表里不出现任何具体色值（换封面不会让样式表失去意义）。
 */
export function hazeVars(colors: readonly string[]): Record<string, string> {
  const [a, b] = stagePalette(colors);
  return {
    "--player-haze-a": a,
    "--player-haze-b": b,
  };
}

/**
 * 两盏光斑的最终色：**有封面就走 [`vivid`] + [`spreadHues`]，没有封面就用兜底色原样**。
 *
 * 兜底色的用途是"没有封面时的氛围"，本来就该是亮的（用户口径「默认的颜色晕不要
 * 暗色」）；把它也过一遍 `vivid`（亮度上限 0.58）会得出两组发暗的紫，正好与
 * "兜底应该更淡"相反。
 */
function stagePalette(colors: readonly string[]): string[] {
  const hasCoverColors = colors.some(
    (c) => typeof c === "string" && HEX_COLOR.test(c),
  );
  const base = hazeColorsOf(colors);
  return hasCoverColors ? spreadHues(base.map(vivid)) : base;
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

/** `#rrggbb` → HSL（h 度数 0–360，s/l 0–1）。 */
function rgbToHsl([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [((h * 60) % 360 + 360) % 360, s, l];
}

/** 只取色相（度数）。 */
function hueOf(hex: string): number {
  const rgb = toRgb(hex);
  return rgb ? rgbToHsl(rgb)[0] : 0;
}

/** HSL → `#rrggbb`。 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const pick = table[Math.min(5, Math.floor(hp))];
  return [
    (pick[0] + m) * 255,
    (pick[1] + m) * 255,
    (pick[2] + m) * 255,
  ];
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
 * - `--player-sky-1` / `--player-sky-2`：样式 2 的浅色底（提亮后的两个主色）。
 * - `--player-disc-1` / `--player-disc-2`：唱片本体（主色**先往冷紫压一档再提亮**，
 *   不是黑色，也不会因为封面本身很白而淡成"看不见的盘"）。
 * - `--player-disc-ring`：唱片外那两道细环。
 */
export function stageVars(colors: readonly string[]): Record<string, string> {
  const [a, b] = stagePalette(colors);
  const accentBase = pickAccent([a, b]);
  const accent = mixHex(accentBase, ACCENT_BASE, 0.45);
  return {
    ...hazeVars(colors),
    "--player-ink": darken(accentBase, 0.78),
    "--player-ink-dim": withAlpha(darken(accentBase, 0.62), 0.62),
    "--player-accent": accent,
    "--player-accent-soft": withAlpha(accent, 0.24),
    "--player-sky-1": lighten(mixHex(accentBase, a, 0.35), 0.9),
    "--player-sky-2": lighten(b, 0.8),
    // 只"提亮主色"在浅色封面上会得到一张几乎看不见的盘（主色本身接近白）。
    // 先混入强调基色把饱和度拉回来，再提亮——盘始终是"带封面倾向的淡紫"。
    "--player-disc-1": lighten(mixHex(a, ACCENT_BASE, 0.42), 0.5),
    "--player-disc-2": lighten(mixHex(a, ACCENT_BASE, 0.62), 0.26),
    "--player-disc-ring": withAlpha(mixHex(accent, INK_BASE, 0.35), 0.45),
  };
}
