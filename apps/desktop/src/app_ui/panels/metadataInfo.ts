/**
 * 元数据面板的**纯解析**：把索引里缓存的两坨 JSON 变成可直接显示的事实。
 *
 * 两个来源（只读字段，不改其产出契约）：
 *
 * | 字段 | 谁写的 | 形状 |
 * | --- | --- | --- |
 * | `media_info_json` | `hp-scanner` 对**视频/音频**调 `hp_media::probe`（D15 / D115）缓存的 **ffprobe 原始输出** | `{ streams: [{codec_type, width, height, codec_name, avg_frame_rate, …}], format: {duration, bit_rate, format_name, …} }` |
 * | `exif_json` | `file.metadata` 对**图像**调 `hp_media::extract_exif`（`exif.rs`） | `{ make, model, dateTime, orientation, width, height, exposureTime, fNumber, iso, focalLength }`（**十个键**；像素尺寸取自 EXIF 的 `PixelXDimension`，PNG 等常为 `null`；拍摄参数四项 2026-11-08 / D145 起由后端提取，缺哪项哪项为 `null`） |
 *
 * 键名与容差**逐条对齐 Rust 侧**（`crates/hp-media/src/probe.rs` / `exif.rs`）：`duration` /
 * `bit_rate` / `sample_rate` 在 ffprobe 里是**字符串**，`width` / `height` 是数字；这里对数字/
 * 数字字符串**都收**（显示层不该因为一个字段的类型写法不同就整行空白）。**不解析来源里
 * 不存在的键**——那会得到永远为 null 的字段，看起来像"面板坏了"（2026-11-08 / D145）。
 *
 * 纯函数、不 import React：门禁可直接 import 本文件断言解析结果。
 */

/** 一条流的可显示事实（视频流 / 音频流 / 字幕等附件流共用一个形状）。 */
export interface MediaStreamFacts {
  /** `codec_type` 原值（video / audio / subtitle / data / attachment…）。 */
  codecType: string;
  codecName: string | null;
  /** 编码档次（ffprobe `profile`，如 High / LC）。 */
  profile: string | null;
  width: number | null;
  height: number | null;
  /** 流级时长（毫秒；`format.duration` 缺失时的兜底来源）。 */
  durationMs: number | null;
  frameRate: number | null;
  /** 像素格式（`pix_fmt`，如 yuv420p）。 */
  pixFmt: string | null;
  /** 色彩空间（`color_space`，如 bt709）。 */
  colorSpace: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** 声道布局原文（`channel_layout`，如 stereo；ffprobe 不翻译，显示层也不翻译）。 */
  channelLayout: string | null;
  /** 流级码率 bit/s（容器码率在 `MediaInfoFacts.bitRate`）。 */
  bitRate: number | null;
  /** 语言标签（`tags.language`，如 eng / jpn）。 */
  language: string | null;
}

/** 视频/音频容器级事实（`media_info_json` 的派生结果）。 */
export interface MediaInfoFacts {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** 视频流编码（无视频流时取首流）——顶部摘要行沿用 D15 以来的口径。 */
  codec: string | null;
  /** 码率 bit/s（优先容器，回落流）。 */
  bitRate: number | null;
  frameRate: number | null;
  /**
   * 音频采样率 Hz（2026-10-17 / D115）。
   *
   * 取自**音频流**的 `sample_rate`（ffprobe 用字符串给出，见下）；没有音频流时为 `null`。
   * 它与 `codec` 不同——`codec` 是"首流"的编码，而采样率只有音频流才有。
   */
  sampleRate: number | null;
  /** 容器格式（`format.format_name`，如 `mov,mp4,m4a,3gp,3g2,mj2`；显示层取首个别名）。 */
  formatName: string | null;
  /** 全部流（保持 ffprobe 的原顺序；媒体信息表逐流渲染）。 */
  streams: MediaStreamFacts[];
}

/** 图像 EXIF 摘要（`exif_json` 的派生结果；键集合与 `exif.rs` 的产出逐一对应）。 */
export interface ExifSummary {
  /** EXIF 像素宽（**常为 null**：PNG 等无 EXIF，需要前端解码兜底）。 */
  width: number | null;
  height: number | null;
  make: string | null;
  model: string | null;
  /** EXIF 原文日期（`YYYY:MM:DD HH:MM:SS`，冒号分隔是 EXIF 规范写法，显示层负责转换）。 */
  dateTime: string | null;
  /** EXIF 方向标签原始值 1–8（显示层负责翻译成人话）。 */
  orientation: number | null;
  /** 快门（`exif.rs` 的 `d_exptime` 已渲染成人话：`1/200` 或小数秒；显示层负责规范化）。 */
  exposureTime: string | null;
  /** 光圈 F 值（`exif.rs` 取 RATIONAL 的 num/denom 算成 f64，如 2.8）。 */
  fNumber: number | null;
  /** ISO 感光度（整数）。 */
  iso: number | null;
  /** 焦距 mm（`exif.rs` 取 RATIONAL 算成 f64，如 50）。 */
  focalLength: number | null;
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

/** 单条 ffprobe 流 → 可显示事实（缺哪项哪项为 null，不整行失败）。 */
function parseStream(stream: Record<string, unknown>): MediaStreamFacts {
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  const seconds = toNumber(stream.duration);
  return {
    codecType: toText(stream.codec_type) ?? "unknown",
    codecName: toText(stream.codec_name),
    profile: toText(stream.profile),
    width: toNumber(stream.width),
    height: toNumber(stream.height),
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    frameRate: parseRatio(toText(stream.avg_frame_rate)) ?? parseRatio(toText(stream.r_frame_rate)),
    pixFmt: toText(stream.pix_fmt),
    colorSpace: toText(stream.color_space),
    sampleRate: toNumber(stream.sample_rate),
    channels: toNumber(stream.channels),
    channelLayout: toText(stream.channel_layout),
    bitRate: toNumber(stream.bit_rate),
    language: toText(tags.language),
  };
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
  const rawStreams = Array.isArray(root.streams) ? (root.streams as unknown[]) : [];
  const streams = rawStreams
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map(parseStream);
  const video = streams.find((s) => s.codecType === "video") ?? null;
  const first = video ?? streams[0] ?? null;
  // 采样率只在**音频流**上有意义（2026-10-17 / D115）：纯视频文件没有音频流，
  // 取"首流"会把视频流的字段误读成采样率。
  const audio = streams.find((s) => s.codecType === "audio") ?? null;

  // 时长：容器优先（ffprobe 的 `format.duration`，秒），回落视频流、再回落首流。
  const formatSeconds = toNumber(format.duration);
  const durationMs =
    formatSeconds === null
      ? (video?.durationMs ?? first?.durationMs ?? null)
      : Math.round(formatSeconds * 1000);

  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs,
    codec: first?.codecName ?? null,
    bitRate: toNumber(format.bit_rate) ?? first?.bitRate ?? null,
    frameRate: video?.frameRate ?? null,
    sampleRate: audio?.sampleRate ?? null,
    formatName: toText(format.format_name),
    streams,
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
    orientation: toNumber(root.orientation),
    exposureTime: toText(root.exposureTime),
    fNumber: toNumber(root.fNumber),
    iso: toNumber(root.iso),
    focalLength: toNumber(root.focalLength),
  };
}

/**
 * 相对路径 → **文件后缀**显示文本（小写、带前导点，如 `.png` / `.jpeg`）；没有后缀返回空串。
 *
 * 只读索引里既有的 `relative_path`（**不改后端**）。口径是"**最后一个点之后**的非空片段"：
 * 目录名里的点不参与（`dir.v2/cover` 无后缀）、隐藏文件（`.gitignore`，点在首位）不算后缀、
 * 结尾的点（`trailing.`）也不算。大小写归一化到小写（`IMG.JPG` → `.jpg`）。
 *
 * 面板把空串渲染成 `—`——"索引里没数据"与"面板坏了"必须看起来不一样（与其它行同款）。
 */
export function fileSuffix(relativePath: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}