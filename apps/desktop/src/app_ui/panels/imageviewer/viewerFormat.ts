/**
 * 图像查看器信息栏**专属**的纯格式化（宽高比 / 百万像素 / 缩放百分比 / 文件名）。
 *
 * 体积、日期与像素尺寸**不在这里**：它们按**宿主设置**出字（`ui.sizeUnit` /
 * `ui.dateFormat` / `ui.dateShowTime`），统一走 `apps/desktop/src/app_ui/shared/format.ts`。
 * 2026-09 起信息栏与元数据面板同口径——此前信息栏用 1024 进制却把标签写成 `KB`、
 * 日期固定 `YYYY/MM/DD HH:MM:SS`，同一份数据在两个面板里长得不一样。
 *
 * 输出都是**数值/文本数据**（不是界面文案），因此不走 i18n；真正需要翻译的只有包在
 * 它们外面的模板（`imageviewer.info.*`，D27）。
 */

/** 宽高比（宽 ÷ 高，两位小数）：`1080×1528` → `0.71`。 */
export function formatAspectRatio(width: number | null, height: number | null): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  return (width / height).toFixed(2);
}

/** 像素数（百万像素，一位小数）：`1080×1528` → `1.7`。 */
export function formatMegapixels(width: number | null, height: number | null): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  return ((width * height) / 1_000_000).toFixed(1);
}

/** 缩放比例 → 百分比整数（`1.84` → `184`；`1` → `100`）。 */
export function formatZoomPercent(zoom: number | null | undefined): string {
  if (zoom === null || zoom === undefined || !Number.isFinite(zoom) || zoom <= 0) return "—";
  return String(Math.round(zoom * 100));
}

/** 取路径最后一段（文件名）。 */
export function fileNameOf(path: string | null | undefined): string {
  if (!path) return "—";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
