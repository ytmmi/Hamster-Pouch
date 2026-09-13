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

export const FONT_SIZE = {
  xs: 10,
  sm: 11,
  md: 12,
  lg: 14,
} as const;

/** 主题名。 */
export type ThemeName = keyof typeof COLORS;
