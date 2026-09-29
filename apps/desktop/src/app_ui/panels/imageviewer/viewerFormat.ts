/**
 * 图像查看器：底部基础信息栏用到的**纯格式化**。
 *
 * 全部输出都是**数值/日期等数据**（不是界面文案），因此不走 i18n；真正需要
 * 翻译的只有包在它们外面的模板（`imageviewer.info.*`，D27）。
 */

/** 分隔数字千分位（`1814` → `1,814`）。 */
function groupThousands(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * 字节数 → 人类可读（`270 KB` / `6.77 GB`）。
 *
 * 用 1024 进制（与资源管理器一致）；单位不加空格（`270 KB`），
 * 精度按量级收敛到 0–2 位小数，避免信息栏抖动。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${groupThousands(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * 文件修改时间 → `YYYY/MM/DD HH:MM:SS`（本地时区）。
 *
 * 索引里的 `mtime` 是 **epoch 纳秒十进制字符串**（`hp-scanner` 的 `file_stat`）；
 * 也接受 ISO 字符串（`file.metadata` 的其它来源）。无法解析时**原样返回**，
 * 不静默显示空白（信息栏宁可显示原始值也不丢信息）。
 */
export function formatDateTime(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "—";
  const text = String(raw).trim();
  if (!text) return "—";
  const ms = /^\d+$/.test(text) ? Number(text) / 1e6 : Date.parse(text);
  if (!Number.isFinite(ms)) return text;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

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

/** 图像尺寸文本 `1080 × 1528`（用乘号，不是字母 x）。 */
export function formatDimensions(width: number | null, height: number | null): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  return `${width} × ${height}`;
}

/** 取路径最后一段（文件名）。 */
export function fileNameOf(path: string | null | undefined): string {
  if (!path) return "—";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
