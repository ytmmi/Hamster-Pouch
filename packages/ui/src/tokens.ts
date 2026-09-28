/**
 * 设计 tokens：颜色、间距、圆角、字号（供 app_ui 与插件面板共享）。
 *
 * 与 `apps/desktop/src/app_ui/shared/styles.css` 的 CSS 变量保持同一语义。
 */

export const COLORS = {
  light: {
    bg: "#f5f6f8",
    panel: "#ffffff",
    border: "#d9dde3",
    text: "#1f2328",
    textDim: "#6b7280",
    accent: "#3b82f6",
    danger: "#dc2626",
    ok: "#16a34a",
  },
  dark: {
    bg: "#1e1f22",
    panel: "#26282c",
    border: "#3a3d42",
    text: "#e6e7e9",
    textDim: "#9aa0a6",
    accent: "#60a5fa",
    danger: "#f87171",
    ok: "#4ade80",
  },
} as const;

export const SPACE = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
} as const;

export const RADIUS = {
  sm: 2,
  md: 4,
  lg: 6,
} as const;

/**
 * 阴影档位（浮层容器外观，D50 / RFC 0007 浮层节点）。
 *
 * 只给**档位**，像素与不透明度集中在这里；`alpha` 分浅色/深色——同一档位在深色主题下
 * 需要更高的不透明度才有等效层次感，这与 `COLORS` 分主题是同一个理由。
 *
 * `md` 刻意等于宿主既有浮动窗口的观感（`apps/desktop/src/app_ui/shared/styles.css` 的
 * `--dv-floating-box-shadow`：浅色 `0 8px 32px rgba(0,0,0,.15)`、深色 `…,.4`），
 * 于是**蓝图未声明档位时视觉零变化**——这是浮层容器渲染的默认档位。
 */
export const SHADOW = {
  none: { y: 0, blur: 0, alpha: { light: 0, dark: 0 } },
  sm: { y: 2, blur: 8, alpha: { light: 0.12, dark: 0.3 } },
  md: { y: 8, blur: 32, alpha: { light: 0.15, dark: 0.4 } },
  lg: { y: 16, blur: 48, alpha: { light: 0.26, dark: 0.52 } },
} as const;

export const FONT_SIZE = {
  xs: 10,
  sm: 11,
  md: 12,
  lg: 14,
} as const;

/** 主题名。 */
export type ThemeName = keyof typeof COLORS;
