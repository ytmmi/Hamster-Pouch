/**
 * 控件渲染的**外观映射**：控件 schema 的档位字段 → 宿主设计 token（`docs/spec/control-standard.md` 第 8 节）。
 *
 * 约束：只允许取 token 档位，**不写死像素、不引入自定义配色**（浅色/深色由主题适配）。
 * 纯函数 + 常量，不含 React。
 */

import { COLORS, FONT_SIZE, RADIUS, SPACE, type ThemeName } from "@hamster-pouch/ui";

/** 间距档位 → 像素（取自 `packages/ui` 的 SPACE token）。 */
export function gapToken(value: unknown): number {
  switch (value) {
    case "none":
      return 0;
    case "sm":
      return SPACE.sm;
    case "lg":
      return SPACE.lg;
    case "md":
    default:
      return SPACE.md;
  }
}

/** 对齐档位 → flex 对齐值。 */
export function alignToken(value: unknown): "flex-start" | "center" | "flex-end" | "stretch" {
  switch (value) {
    case "start":
      return "flex-start";
    case "end":
      return "flex-end";
    case "stretch":
      return "stretch";
    case "center":
    default:
      return "center";
  }
}

/** 语义档位 → 取色（状态条/提示/空态共用）。 */
export function variantColor(variant: unknown, theme: ThemeName): string {
  const palette = COLORS[theme];
  switch (variant) {
    case "ok":
      return palette.ok;
    case "warn":
      return palette.accent;
    case "error":
      return palette.danger;
    case "info":
    default:
      return palette.textDim;
  }
}

/** 文本档位 → 字号/颜色/字重。 */
export function textVariantStyle(
  variant: unknown,
  theme: ThemeName,
): { fontSize: number; color: string; fontWeight?: number; fontFamily?: string } {
  const palette = COLORS[theme];
  switch (variant) {
    case "dim":
      return { fontSize: FONT_SIZE.sm, color: palette.textDim };
    case "heading":
      return { fontSize: FONT_SIZE.lg, color: palette.text, fontWeight: 600 };
    case "code":
      return { fontSize: FONT_SIZE.sm, color: palette.text, fontFamily: "monospace" };
    case "body":
    default:
      return { fontSize: FONT_SIZE.md, color: palette.text };
  }
}

/** 按钮档位 → 背景/边框/前景。 */
export function buttonVariantStyle(
  variant: unknown,
  theme: ThemeName,
): { background: string; color: string; border: string } {
  const palette = COLORS[theme];
  switch (variant) {
    case "primary":
      return { background: palette.accent, color: "#ffffff", border: palette.accent };
    case "danger":
      return { background: palette.danger, color: "#ffffff", border: palette.danger };
    case "default":
    default:
      return { background: palette.panel, color: palette.text, border: palette.border };
  }
}

/** 统一的基础排版（所有控件默认继承）。 */
export function baseTextStyle(theme: ThemeName): { color: string; fontSize: number } {
  return { color: COLORS[theme].text, fontSize: FONT_SIZE.md };
}

/** 统一的容器边框样式（区块/提示共用）。 */
export function boxStyle(theme: ThemeName): {
  border: string;
  borderRadius: number;
  padding: number;
} {
  const palette = COLORS[theme];
  return {
    border: `1px solid ${palette.border}`,
    borderRadius: RADIUS.md,
    padding: SPACE.md,
  };
}
