/**
 * 元数据面板的**纯格式化与行构造**（2026-11-08 / D145）：把 `metadataInfo.ts` 解析出的
 * 事实变成"看得懂的行"。全部纯函数、不 import React——门禁可直接 import 断言行为。
 *
 * 口径：
 * - 取不到值一律返回 `—` / 空数组（**行不静默消失**，与面板既有约定同款）；
 * - 日期/时间分量**按原值重排**、不经 `Date` 解析——EXIF 的 `YYYY:MM:DD HH:MM:SS` 没有
 *   时区，交给 `Date` 会按本地时区猜，猜错就是"拍摄时间差八小时"这类静默错误；
 * - ffprobe 的 `format_name` 是逗号分隔的别名列表（`mov,mp4,m4a,…`），显示首个别名；
 * - 声道数补中文习惯量词（2 声道 / 5.1 这类布局原文照显，不翻译）。
 */

import type { Translate, TranslationKey } from "../i18n";
import type { DateFormat } from "@hamster-pouch/config";
import {
  formatBitRate,
  formatDurationMs,
  formatFrameRate,
  formatPixelSize,
  formatSampleRate,
} from "../shared/format";
import type { ExifSummary, MediaInfoFacts, MediaStreamFacts } from "./metadataInfo";

/** 表格里的一行（标签 + 值）。 */
export interface MetaRow {
  label: string;
  value: string;
  /** 等宽（哈希这类定长十六进制串）。 */
  mono?: boolean;
}

const DASH = "—";

/**
 * EXIF 原文日期 → 按宿主日期格式重排。
 *
 * 只认 EXIF 规范的 `YYYY:MM:DD HH:MM:SS`（秒可缺）；**不匹配就原样返回**
 * （宁可显示原始值也不丢信息，与 `formatDateValue` 的容错同款）。
 */
export function formatExifDateTime(
  raw: string | null | undefined,
  format: DateFormat = "iso",
  showTime = false,
): string {
  if (!raw || !raw.trim()) return DASH;
  const match = /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw.trim());
  if (!match) return raw;
  const [, yyyy, mm, dd, hh, mi, ss] = match;
  const ymd =
    format === "us" ? `${mm}/${dd}/${yyyy}` : format === "eu" ? `${dd}/${mm}/${yyyy}` : `${yyyy}-${mm}-${dd}`;
  if (!showTime || !hh) return ymd;
  return `${ymd} ${hh}:${mi}:${ss ?? "00"}`;
}

/** EXIF 方向标签 1–8 → 翻译键；越界/缺失返回 null（调用方显示 `—`）。 */
export function exifOrientationKey(orientation: number | null | undefined): TranslationKey | null {
  if (orientation === null || orientation === undefined) return null;
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) return null;
  return `metadata.orientation.${orientation}` as TranslationKey;
}

/** 去掉小数尾部多余的 0（`2.80` → `2.8`、`50.0` → `50`），最多保留两位。 */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * 快门 → 摄影习惯写法；无值返回 null（调用方据此**不渲染该行**）。
 *
 * `exif.rs` 的 `d_exptime` 已把 `<1s` 给成 `1/200`（原样保留）、`≥1s` 给成小数秒
 * （`0.5` → `1/2`、`2` → `2 s`）。非数值原文兜底原样返回（宁可显示也不丢信息）。
 */
export function formatExposureTime(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const text = raw.trim();
  if (text.includes("/")) return text;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) return text;
  if (seconds >= 1) return `${trimNumber(seconds)} s`;
  return `1/${Math.round(1 / seconds)}`;
}

/** 光圈 F 值 → `f/2.8`；无值/非正返回 null。 */
export function formatAperture(fNumber: number | null | undefined): string | null {
  if (fNumber === null || fNumber === undefined || !Number.isFinite(fNumber) || fNumber <= 0) {
    return null;
  }
  return `f/${trimNumber(fNumber)}`;
}

/** ISO → `ISO 400`；无值/非正返回 null。 */
export function formatIso(iso: number | null | undefined): string | null {
  if (iso === null || iso === undefined || !Number.isFinite(iso) || iso <= 0) return null;
  return `ISO ${Math.round(iso)}`;
}

/** 焦距 → `50 mm`；无值/非正返回 null。 */
export function formatFocalLength(mm: number | null | undefined): string | null {
  if (mm === null || mm === undefined || !Number.isFinite(mm) || mm <= 0) return null;
  return `${trimNumber(mm)} mm`;
}

/**
 * 拍摄参数 → 顶部摘要的行列表（2026-11-08 / D145，**自动模式：有就显示、无就不显示**）。
 *
 * 与"缺值显示 `—`"的类型自适应行不同：这四项是**可选增强**，EXIF 里没有就不占行
 * （否则每张无 EXIF 的图都挂四行 `—`，正是本轮要消掉的噪声）。顺序按摄影习惯：
 * 焦距 → 光圈 → 快门 → ISO。
 */
export function buildShootingRows(t: Translate, facts: ExifSummary | null): MetaRow[] {
  if (!facts) return [];
  const rows: MetaRow[] = [];
  const focal = formatFocalLength(facts.focalLength);
  const aperture = formatAperture(facts.fNumber);
  const exposure = formatExposureTime(facts.exposureTime);
  const iso = formatIso(facts.iso);
  if (focal) rows.push({ label: t("metadata.focalLength"), value: focal });
  if (aperture) rows.push({ label: t("metadata.aperture"), value: aperture });
  if (exposure) rows.push({ label: t("metadata.exposureTime"), value: exposure });
  if (iso) rows.push({ label: t("metadata.iso"), value: iso });
  return rows;
}

/** 容器格式：`mov,mp4,m4a,3gp,3g2,mj2` → 取**首个**别名 `mov`（ffprobe 的排列即优先级）。 */
export function containerFormatLabel(formatName: string | null | undefined): string {
  if (!formatName || !formatName.trim()) return DASH;
  return formatName.split(",")[0].trim() || DASH;
}

/** 流类型 → 翻译键（未知类型原样显示，不猜）。 */
export function streamTypeKey(t: Translate, codecType: string): string {
  const known: Record<string, TranslationKey> = {
    video: "metadata.stream.video",
    audio: "metadata.stream.audio",
    subtitle: "metadata.stream.subtitle",
  };
  const key = known[codecType];
  return key ? t(key) : codecType;
}

/** 一条流 → 行列表（`#1 视频` 起头，随后只列**这条流有值**的字段）。 */
export function buildStreamRows(t: Translate, stream: MediaStreamFacts, index: number): MetaRow[] {
  const rows: MetaRow[] = [
    { label: `#${index + 1}`, value: streamTypeKey(t, stream.codecType) },
    { label: t("metadata.codec"), value: stream.codecName ?? DASH },
  ];
  if (stream.profile) rows.push({ label: t("metadata.profile"), value: stream.profile });
  if (stream.codecType === "video") {
    rows.push({ label: t("metadata.dimensions"), value: formatPixelSize(stream.width, stream.height) });
    rows.push({ label: t("metadata.frameRate"), value: formatFrameRate(stream.frameRate) });
    if (stream.pixFmt) rows.push({ label: t("metadata.pixFmt"), value: stream.pixFmt });
    if (stream.colorSpace) rows.push({ label: t("metadata.colorSpace"), value: stream.colorSpace });
  }
  if (stream.codecType === "audio") {
    rows.push({ label: t("metadata.sampleRate"), value: formatSampleRate(stream.sampleRate) });
    rows.push({
      label: t("metadata.channels"),
      value:
        stream.channels !== null && stream.channels > 0
          ? t("metadata.channelsValue", {
              count: stream.channels,
              layout: stream.channelLayout ? ` (${stream.channelLayout})` : "",
            })
          : DASH,
    });
  }
  if (stream.durationMs !== null) {
    rows.push({ label: t("metadata.duration"), value: formatDurationMs(stream.durationMs) });
  }
  if (stream.bitRate !== null && stream.bitRate > 0) {
    rows.push({ label: t("metadata.bitrate"), value: formatBitRate(stream.bitRate) });
  }
  if (stream.language && stream.language !== "und") {
    rows.push({ label: t("metadata.language"), value: stream.language });
  }
  return rows;
}

/** 媒体信息表：容器两行（格式 / 时长）+ 逐流事实；无缓存返回空数组（面板显示空态）。 */
export function buildMediaRows(t: Translate, facts: MediaInfoFacts | null): MetaRow[] {
  if (!facts) return [];
  const rows: MetaRow[] = [
    { label: t("metadata.container"), value: containerFormatLabel(facts.formatName) },
    { label: t("metadata.duration"), value: formatDurationMs(facts.durationMs) },
  ];
  facts.streams.forEach((stream, index) => {
    rows.push(...buildStreamRows(t, stream, index));
  });
  return rows;
}

/** EXIF 表：四个字段各占一行，**全 null 也照常渲染**（"没有 EXIF"与"面板坏了"必须可区分）。
 *  像素尺寸不在这里——顶部摘要的「尺寸」行已覆盖（解码优先、EXIF 兜底），不重复占行。 */
export function buildExifRows(
  t: Translate,
  facts: ExifSummary | null,
  dateFormat: DateFormat,
  dateShowTime: boolean,
): MetaRow[] {
  if (!facts) return [];
  const orientationKey = exifOrientationKey(facts.orientation);
  return [
    { label: t("metadata.cameraMake"), value: facts.make ?? DASH },
    { label: t("metadata.cameraModel"), value: facts.model ?? DASH },
    { label: t("metadata.dateTaken"), value: formatExifDateTime(facts.dateTime, dateFormat, dateShowTime) },
    { label: t("metadata.orientation"), value: orientationKey ? t(orientationKey) : DASH },
  ];
}