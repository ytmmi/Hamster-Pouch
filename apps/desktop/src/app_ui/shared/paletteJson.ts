/**
 * 调色板缓存的**格式与解析**（纯函数，无 Tauri 依赖 ⇒ 门禁可直接 import 断言行为）。
 *
 * 缓存落在 `color_refs.color_json`，形态：
 *
 * ```jsonc
 * { "version": 2, "colors": ["#ffffff", …], "locked": false }
 * ```
 *
 * ## 为什么要 `version`（缓存自愈）
 *
 * 调色板是**派生缓存**：色板规模/算法一变，旧结果就不再对。面板里没有手动重提按钮，
 * 因此必须由这里判断"这份缓存还是不是当前格式"，旧的一律按「未提取」返回空数组，
 * 由调用方（`shared/colorPalette.ts`）重新提取。否则改一次色板规模（6 → 8），
 * 已经看过的图片会永远显示旧结果。
 *
 * `locked: true`（手动锁定）**不受版本影响**：那是用户结果，不因版本变化被重算或改写。
 * `version` 必须与 Rust `hp_media::PALETTE_FORMAT_VERSION` 相等（`pnpm check:panels` 断言）。
 */

/** 调色板缓存格式版本；与 Rust `hp_media::PALETTE_FORMAT_VERSION` 必须相等。 */
export const PALETTE_FORMAT_VERSION = 2;

/** 色彩参考 JSON（`color_refs.color_json` 的形态）。 */
export interface PaletteJson {
  /** 缓存格式版本；旧缓存没有该字段。 */
  version?: number;
  colors?: string[];
  /** 手动锁定（`color.set` 写入）：色彩参考面板不再提供入口，但数据与语义保留。 */
  locked?: boolean;
}

/**
 * 解析色彩参考 JSON；**需要重算/非法/缺省一律空数组**（失败关闭，不猜色值）。
 *
 * 返回空数组意味着"当前没有可用调色板"——调用方据此决定是否重新提取。
 */
export function parsePaletteJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as PaletteJson;
    const colors = Array.isArray(parsed.colors)
      ? parsed.colors.filter((color): color is string => typeof color === "string")
      : [];
    // 手动锁定的色值一律尊重：不因版本变化重算，也不替用户改写结果。
    if (parsed.locked) return colors;
    // 旧版本（含没有 `version` 的历史缓存）视为「未提取」→ 调用方会重新提取。
    if (parsed.version !== PALETTE_FORMAT_VERSION) return [];
    return colors;
  } catch {
    return [];
  }
}
