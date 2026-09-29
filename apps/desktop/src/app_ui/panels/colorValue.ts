/**
 * 色值的**显示格式**（纯函数；色彩参考面板专用）。
 *
 * 调色板在仓库里一律以 `#rrggbb` 存储（`crates/hp-media/src/palette.rs` 的量化结果），
 * 本文件只负责"把它渲染成给人看 / 供复制的文本"：
 *
 * | `format` | 输出 |
 * | --- | --- |
 * | `hex`（缺省） | `#ffffff` |
 * | `decimal` | `255, 255, 255` |
 *
 * 取值域必须与面板注册表的声明逐项一致（`packages/config/src/panels.ts` 的
 * `color.settings.valueFormat` 候选），一致性由 `pnpm check:panels` 断言——
 * 声明与实现的漂移表现为"设置里能选、面板认不出"。
 */

/** 两种显示格式：十六进制 / 十进制 RGB。 */
export const COLOR_VALUE_FORMATS = ["hex", "decimal"] as const;
export type ColorValueFormat = (typeof COLOR_VALUE_FORMATS)[number];

/** 缺省格式：十六进制（与存储口径同形，零认知成本）。 */
export const DEFAULT_COLOR_VALUE_FORMAT: ColorValueFormat = "hex";

export function isColorValueFormat(value: unknown): value is ColorValueFormat {
  return value === "hex" || value === "decimal";
}

/** 把（可能缺失/非法的）设置值收敛为合法格式，调用方不必再判。 */
export function resolveColorValueFormat(value: unknown): ColorValueFormat {
  return isColorValueFormat(value) ? value : DEFAULT_COLOR_VALUE_FORMAT;
}

/**
 * 解析 `#rgb` / `#rrggbb`（`#` 可省、大小写不限）；非法输入返回 `null`。
 *
 * **不猜颜色**：解析不出来就是 `null`，由调用方原样回显，而不是回落成黑色。
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const matched = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!matched) return null;
  const digits = matched[1];
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/**
 * 色值 → 显示文本（**也是复制进剪贴板的内容**，两处必须同源）。
 *
 * 无法解析的输入**原样返回**：面板上看到什么就复制什么，不静默改写。
 */
export function formatColorValue(color: string, format: ColorValueFormat): string {
  const rgb = parseHexColor(color);
  if (!rgb) return color;
  if (format === "decimal") return `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  const hex = [rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}
