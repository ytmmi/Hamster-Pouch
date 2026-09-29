/**
 * **显示格式的纯函数**（体积 / 日期 / 时长 / 码率 / 帧率 / 像素尺寸）。
 *
 * 使用者：元数据面板（尺寸/时长/编码/码率/帧率 + 体积 + 日期）与图像查看器底部信息栏
 * （体积 + 日期；宽高比/百万像素/缩放仍是它自己的 `viewerFormat.ts`）。2026-09 起两者同口径
 * ——此前信息栏用 1024 进制却把标签写成 `KB`、日期固定 `YYYY/MM/DD HH:MM:SS`。
 *
 * 全部是纯函数、不 import React / Tauri：门禁可以直接 import 本文件断言行为。
 */

import type { DateFormat, SizeUnit } from "@hamster-pouch/config";

/** 自动换单位的进位（二进制 1024 / 十进制 1000）。 */
const BASE: Record<SizeUnit, number> = { binary: 1024, decimal: 1000 };

/** 二进制单位（1024 进制）。 */
const BINARY_UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;
/** 十进制单位（1000 进制）。 */
const DECIMAL_UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;

/** 分隔数字千分位（`1814` → `1,814`）。 */
function groupThousands(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * 字节数 → **按体积自适应**的人类可读文本。
 *
 * - `binary`（缺省）= 1024 进制，标签 `KiB / MiB / GiB / TiB / PiB`；
 * - `decimal` = 1000 进制，标签 `KB / MB / GB / TB / PB`；
 * - 两者都**在量级上升时自动换单位**（没有"固定 KiB"模式）；不足一个进位时显示 `B`；
 * - 精度按量级收敛到 0–2 位小数（≥100 取整、≥10 一位、其余两位），避免面板抖动；
 * - 非法值（`null` / `NaN` / 负数）返回 `—`。
 */
export function formatByteSize(
  bytes: number | null | undefined,
  unit: SizeUnit = "binary",
): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  const base = BASE[unit];
  const units = unit === "decimal" ? DECIMAL_UNITS : BINARY_UNITS;
  if (bytes < base) return `${groupThousands(bytes)} B`;
  let value = bytes / base;
  let index = 0;
  while (value >= base && index < units.length - 1) {
    value /= base;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/**
 * 解析索引里的时间戳 → `Date`；无法解析返回 `null`。
 *
 * 索引里的 `mtime` 是 **epoch 纳秒十进制字符串**（`hp-scanner` 的 `file_stat`）；
 * 也接受 ISO 等 `Date.parse` 认得的字符串（`file.metadata` 的其它来源）。
 */
export function parseTimestamp(raw: string | number | null | undefined): Date | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const ms = /^\d+$/.test(text) ? Number(text) / 1e6 : Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/**
 * 时间戳 → 按设置格式化的日期文本。
 *
 * `iso` = `YYYY-MM-DD`（缺省）、`us` = `MM/DD/YYYY`、`eu` = `DD/MM/YYYY`；
 * `showTime` 为真时在后面接 ` HH:MM:SS`（24 小时制、本地时区）。
 * 无法解析时**原样返回**原始值（宁可显示原始值也不丢信息）；空值返回 `—`。
 */
export function formatDateValue(
  raw: string | number | null | undefined,
  format: DateFormat = "iso",
  showTime = false,
): string {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "—";
  const date = parseTimestamp(raw);
  if (!date) return String(raw);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const ymd =
    format === "us" ? `${mm}/${dd}/${yyyy}` : format === "eu" ? `${dd}/${mm}/${yyyy}` : `${yyyy}-${mm}-${dd}`;
  if (!showTime) return ymd;
  return `${ymd} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 毫秒 → `M:SS`（不足一小时）或 `H:MM:SS`；非法值返回 `—`。 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 秒（ffprobe 的 `format.duration` 单位）→ 与 [`formatDurationMs`] 同款文本。 */
export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  return formatDurationMs(seconds * 1000);
}

/** 像素尺寸文本 `1920 × 1080`（乘号，不是字母 x）；缺一项即 `—`。 */
export function formatPixelSize(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!width || !height || width <= 0 || height <= 0) return "—";
  return `${width} × ${height}`;
}

/**
 * 码率（bit/s）→ `320 kbps` / `1.45 Mbps`。
 *
 * 码率按**十进制**（1000）进位——这是行业惯例，与体积的二进制/十进制设置无关。
 */
export function formatBitRate(bitsPerSecond: number | null | undefined): string {
  if (
    bitsPerSecond === null ||
    bitsPerSecond === undefined ||
    !Number.isFinite(bitsPerSecond) ||
    bitsPerSecond <= 0
  ) {
    return "—";
  }
  if (bitsPerSecond < 1000) return `${Math.round(bitsPerSecond)} bps`;
  const units = ["kbps", "Mbps", "Gbps"] as const;
  let value = bitsPerSecond / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/** 帧率 → `29.97 fps`（最多两位小数，整数不带小数点）；非法值返回 `—`。 */
export function formatFrameRate(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || !Number.isFinite(fps) || fps <= 0) return "—";
  return `${Number(fps.toFixed(2))} fps`;
}
