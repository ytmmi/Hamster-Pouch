/**
 * 元数据面板的**纯解析**：把索引里缓存的两坨 JSON 变成可直接显示的事实。
 *
 * 两个来源（都不改后端，只读既有字段）：
 *
 * | 字段 | 谁写的 | 形状 |
 * | --- | --- | --- |
 * | `media_info_json` | `hp-scanner` 对**视频**调 `hp_media::probe`（D15）缓存的 **ffprobe 原始输出** | `{ streams: [{codec_type, width, height, codec_name, avg_frame_rate, …}], format: {duration, bit_rate, …} }` |
 * | `exif_json` | `file.metadata` 对**图像**调 `hp_media::extract_exif`（`exif.rs`） | `{ make, model, dateTime, orientation, width, height }`（**像素尺寸取自 EXIF 的 `PixelXDimension`，PNG 等常为 `null`**） |
 *
 * 键名与容差**逐条对齐 Rust 侧**（`crates/hp-media/src/probe.rs:63`-`97`）：`duration` /
 * `bit_rate` 在 ffprobe 里是**字符串**，`width` / `height` 是数字；这里对数字/数字字符串
 * **都收**（显示层不该因为一个字段的类型写法不同就整行空白）。
 *
 * 纯函数、不 import React：门禁可直接 import 本文件断言解析结果。
 */

/** 视频/容器级事实（`media_info_json` 的派生结果）。 */
export interface MediaInfoFacts {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** 视频流编码（无视频流时取首流）。 */
  codec: string | null;
  /** 码率 bit/s（优先容器，回落流）。 */
  bitRate: number | null;
  frameRate: number | null;
}

/** 图像 EXIF 摘要（`exif_json` 的派生结果）。 */
export interface ExifSummary {
  /** EXIF 像素宽（**常为 null**：PNG 等无 EXIF，需要前端解码兜底）。 */
  width: number | null;
  height: number | null;
  make: string | null;
  model: string | null;
  dateTime: string | null;
}

/** 数字或数字字符串 → 有限数值；其余返回 `null`。 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/** 非空字符串 → 字符串；其余返回 `null`。 */
function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * 解析 `num/den` 比率（ffprobe 的 `avg_frame_rate`，如 `30000/1001`）。
 *
 * 分母为 0、格式不符、非正值一律返回 `null`（与 Rust `probe.rs:12` 的 `parse_ratio` 同口径，
 * 但额外拒绝 0 —— 显示 `0 fps` 没有意义）。
 */
export function parseRatio(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const [numText, denText = "1"] = raw.split("/");
  const num = Number(numText);
  const den = Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const value = num / den;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseJsonObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * ffprobe 原始 JSON → 可显示事实；JSON 无法解析或不是对象时返回 `null`。
 *
 * 缺哪一项就那一项为 `null`（不是整块失败）：面板按"有就显示"渲染。
 */
export function parseMediaInfo(json: string | null | undefined): MediaInfoFacts | null {
  const root = parseJsonObject(json);
  if (!root) return null;
  const format = (root.format ?? {}) as Record<string, unknown>;
  const streams = Array.isArray(root.streams) ? (root.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s?.codec_type === "video") ?? null;
  const first = video ?? streams[0] ?? null;

  // 时长：容器优先（ffprobe 的 `format.duration`，秒），回落视频流、再回落首流。
  const seconds = toNumber(format.duration) ?? toNumber(video?.duration) ?? toNumber(first?.duration);

  return {
    width: toNumber(video?.width),
    height: toNumber(video?.height),
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    codec: toText(first?.codec_name),
    bitRate: toNumber(format.bit_rate) ?? toNumber(first?.bit_rate),
    frameRate: parseRatio(toText(video?.avg_frame_rate)) ?? parseRatio(toText(video?.r_frame_rate)),
  };
}

/** EXIF 摘要 JSON → 可显示事实；JSON 无法解析或不是对象时返回 `null`。 */
export function parseExifSummary(json: string | null | undefined): ExifSummary | null {
  const root = parseJsonObject(json);
  if (!root) return null;
  return {
    width: toNumber(root.width),
    height: toNumber(root.height),
    make: toText(root.make),
    model: toText(root.model),
    dateTime: toText(root.dateTime),
  };
}
