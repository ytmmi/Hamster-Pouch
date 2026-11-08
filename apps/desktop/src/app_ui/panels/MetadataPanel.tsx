/**
 * 元数据面板 — 文件元数据（索引字段 + EXIF / ffprobe 媒体信息）。
 *
 * **显示口径全部来自宿主设置**（「全部设置 → 界面 → 其他设置」，跨仓库共用的通用口径，
 * 见 `packages/config/src/settings.ts`）：
 *
 * | 设置 | 作用 |
 * | --- | --- |
 * | `ui.sizeUnit` | 体积：二进制 `KiB/MiB/GiB`（缺省）或十进制 `KB/MB/GB`；**永远按体积自适应**换单位 |
 * | `ui.dateFormat` | 日期：`YYYY-MM-DD`（缺省）/ `MM/DD/YYYY` / `DD/MM/YYYY` |
 * | `ui.dateShowTime` | 日期后是否再显示 ` HH:MM:SS`（缺省关）；EXIF 拍摄时间同受此开关约束 |
 *
 * **按类型自适应显示**（每项各占一行；**取不到值就显示 `—`，不静默消失**——否则"索引里没数据"
 * 与"面板坏了"看起来一模一样）：
 *
 * | 类型 | 显示 | 数据来源 |
 * | --- | --- | --- |
 * | 图像 | 尺寸 | 前端解码取真实像素（EXIF 的 `PixelXDimension` 对 PNG 等为 null，仅作兜底） |
 * | 视频 | 尺寸 / 时长 / 编码 / 码率 / 帧率 | 优先 `media_info_json`（ffprobe 原始 JSON）；索引里没有缓存时用前端 `<video>` 探测**兜底尺寸与时长**（编码 / 码率 / 帧率 DOM 拿不到，如实显示 `—`） |
 * | 音频 | 时长 / 编码 / 采样率 | 优先索引里的 ffprobe 缓存（D115）；旧库未升级时前端 `preload="metadata"` 兜底时长 |
 *
 * 「类型」下面是**文件后缀**（`.png`，小写带点；取索引里既有的 `relative_path`，**不改后端**）：
 * 两者一起回答"这是什么文件"。无后缀（目录名里的点不算、隐藏文件不算）显示 `—`，与其它行同款。
 *
 * **三段式布局（2026-11-08 / D145）**：顶部摘要是"看得懂的速览"；EXIF / 媒体信息各自先是
 * **结构化明细表**（字段翻译成人话、逐流分组、缺值显示 `—`），原始 JSON 收进**默认折叠**的
 * 「原始 JSON」——底账不丢信息，但不再用两堵 220px 的 JSON 墙把面板撑满。
 */

import { Fragment, useEffect, useMemo, useState, type JSX } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import {
  resolveDateFormat,
  resolveDateShowTime,
  resolveSizeUnit,
  SETTING_KEYS,
} from "@hamster-pouch/config";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import type { Translate } from "../i18n";
import {
  formatBitRate,
  formatByteSize,
  formatDateValue,
  formatDurationMs,
  formatFrameRate,
  formatPixelSize,
  formatSampleRate,
} from "../shared/format";
import { useHostSettingValue } from "../shared/settingValue";
import type { FileMetadataResult } from "../shared/types";
import {
  buildExifRows,
  buildMediaRows,
  buildShootingRows,
  type MetaRow,
} from "./metadataFormat";
import { fileSuffix, parseExifSummary, parseMediaInfo } from "./metadataInfo";

function pretty(json: string | null): string {
  if (!json) return "—";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** 前端探测到的补充事实（索引里没有的那些）。 */
interface ProbedFacts {
  /** 图像解码 / 视频容器的真实像素（EXIF 常缺、视频可能没有 ffprobe 缓存）。 */
  width: number | null;
  height: number | null;
  /** 视频 / 音频时长（旧库音频可能没有 ffprobe 缓存；视频可能没探过）。 */
  durationMs: number | null;
}

const NO_FACTS: ProbedFacts = { width: null, height: null, durationMs: null };

/** 键值行列表（摘要与明细表共用；标签列样式由外层 `.meta-kv` 作用域限定）。 */
function MetaRows({ rows }: { rows: MetaRow[] }): JSX.Element {
  return (
    <div className="kv meta-kv">
      {rows.map((row, index) => (
        <Fragment key={`${index}-${row.label}`}>
          <span>{row.label}</span>
          <span className={row.mono ? "mono" : undefined}>{row.value}</span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * 一个明细区：结构化表在前，原始 JSON 折叠在后。
 *
 * 结构化表**总是渲染**（解析失败/无缓存时显示空态文案）；原始 JSON 是 `<details>`，
 * 默认收起——它是"不丢信息的底账"，不是主视图。切文件时由调用方用 `key` 重置折叠态。
 */
function MetaDetailSection({
  title,
  rows,
  rawJson,
  t,
}: {
  title: string;
  rows: MetaRow[];
  rawJson: string | null;
  t: Translate;
}): JSX.Element {
  return (
    <section className="meta-section">
      <div className="section-title">{title}</div>
      {rows.length > 0 ? (
        <MetaRows rows={rows} />
      ) : (
        <span className="placeholder meta-empty">{t("metadata.noData")}</span>
      )}
      <details className="meta-raw">
        <summary>{t("metadata.rawJson")}</summary>
        <pre className="json-block">{pretty(rawJson)}</pre>
      </details>
    </section>
  );
}

export interface MetadataPanelProps {
  /** dockview 面板 API（可选）：面板回到前台时补读一次设置（四条触发源的第 4 条）。 */
  api?: PanelRenderCtx["api"];
}

export function MetadataPanel({ api: panelApi }: MetadataPanelProps = {}): JSX.Element {
  const app = useApp();
  const [meta, setMeta] = useState<FileMetadataResult | null>(null);
  const [probed, setProbed] = useState<ProbedFacts>(NO_FACTS);

  const sizeUnit = resolveSizeUnit(useHostSettingValue(SETTING_KEYS.sizeUnit, panelApi));
  const dateFormat = resolveDateFormat(useHostSettingValue(SETTING_KEYS.dateFormat, panelApi));
  const dateShowTime = resolveDateShowTime(
    useHostSettingValue(SETTING_KEYS.dateShowTime, panelApi),
  );

  useEffect(() => {
    let cancelled = false;
    const file = app.selectedFile;
    if (!app.repoId || !file) {
      setMeta(null);
      return;
    }
    void (async () => {
      try {
        const result = await api.fileMetadata({ repoId: app.repoId!, fileId: file.id });
        if (!cancelled) setMeta(result);
      } catch (e) {
        if (!cancelled) {
          setMeta(null);
          app.status(app.t("metadata.readFailed", { err: errorTextOf(app.t, e) }), "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, app.repoId, app.selectedFile, app.refreshKey]);

  /**
   * 索引里取不到的那几项，前端按需探一次：图像解码取像素、视频容器取时长与像素、音频读时长。
   *
   * 视频**必须**有这条兜底：`media_info_json` 只在扫描时 ffprobe 可用才写入，早于该状态的
   * 索引行永远是空的（库内实测存在这种行）。DOM 只给得出**尺寸与时长**；编码 / 码率 / 帧率
   * 只有 ffprobe 缓存能给，拿不到就如实显示 `—`。
   *
   * 三者都**只对当前选中文件**做一次，且用令牌丢弃过期结果（快速切换不串数据）；
   * 清理时解绑回调并释放媒体元素（音频/视频必须 `load()` 复位才会放开文件）。
   */
  useEffect(() => {
    setProbed(NO_FACTS);
    const repoId = app.repoId;
    const file = app.selectedFile;
    const type = file?.media_type;
    if (!repoId || !file || (type !== "image" && type !== "video" && type !== "audio")) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void (async () => {
      try {
        const path = await api.filePath({ repoId, fileId: file.id });
        if (cancelled) return;
        const url = convertFileSrc(path);
        if (type === "image") {
          const image = new Image();
          image.onload = () => {
            if (!cancelled) {
              setProbed({ width: image.naturalWidth, height: image.naturalHeight, durationMs: null });
            }
          };
          image.src = url;
          release = () => {
            image.onload = null;
            image.onerror = null;
            image.removeAttribute("src");
          };
        } else if (type === "video") {
          const video = document.createElement("video");
          video.preload = "metadata";
          video.onloadedmetadata = () => {
            if (cancelled) return;
            const seconds = video.duration;
            setProbed({
              width: video.videoWidth || null,
              height: video.videoHeight || null,
              durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
            });
          };
          video.src = url;
          release = () => {
            video.onloadedmetadata = null;
            video.onerror = null;
            video.removeAttribute("src");
            video.load();
          };
        } else {
          const audio = new Audio();
          audio.preload = "metadata";
          audio.onloadedmetadata = () => {
            const seconds = audio.duration;
            if (!cancelled && Number.isFinite(seconds)) {
              setProbed({ width: null, height: null, durationMs: Math.round(seconds * 1000) });
            }
          };
          audio.src = url;
          release = () => {
            audio.onloadedmetadata = null;
            audio.removeAttribute("src");
            audio.load();
          };
        }
      } catch {
        /* 探不到就显示 `—`（该行仍然渲染，原始 JSON 也照旧展示） */
      }
    })();
    return () => {
      cancelled = true;
      release?.();
    };
  }, [app.repoId, app.selectedFile, app.refreshKey]);

  const mediaFacts = useMemo(() => parseMediaInfo(meta?.media_info_json), [meta]);
  const exifFacts = useMemo(() => parseExifSummary(meta?.exif_json), [meta]);

  const rows = useMemo<MetaRow[]>(() => {
    if (!meta) return [];
    const isVideo = meta.media_type === "video";
    const isImage = meta.media_type === "image";
    const isAudio = meta.media_type === "audio";
    const out: MetaRow[] = [
      { label: app.t("metadata.type"), value: meta.media_type },
      // 文件后缀紧跟类型：两者一起回答"这是什么文件"（`.png`，取 `relative_path`，无后缀显示 `—`）。
      { label: app.t("metadata.extension"), value: fileSuffix(meta.relative_path) || "—" },
      { label: app.t("metadata.size"), value: formatByteSize(meta.size, sizeUnit) },
      {
        label: app.t("metadata.mtime"),
        value: formatDateValue(meta.mtime, dateFormat, dateShowTime),
      },
    ];
    // 图像：解码优先、EXIF 兜底（EXIF 的像素尺寸对 PNG 等为空）。
    // 视频：ffprobe 缓存优先、前端容器探测兜底。
    if (isImage || isVideo) {
      out.push({
        label: app.t("metadata.dimensions"),
        value: isImage
          ? formatPixelSize(probed.width ?? exifFacts?.width, probed.height ?? exifFacts?.height)
          : formatPixelSize(mediaFacts?.width ?? probed.width, mediaFacts?.height ?? probed.height),
      });
    }
    // 图像拍摄参数（焦距/光圈/快门/ISO）放第一段，**自动模式：有就显示、无就不显示**
    // （2026-11-08 / D145）。数据来自后端 extract_exif 实时提取，缺哪项哪项不占行。
    if (isImage) {
      out.push(...buildShootingRows(app.t, exifFacts));
    }
    if (isVideo || isAudio) {
      out.push({
        label: app.t("metadata.duration"),
        // **音频改走索引里的 ffprobe 缓存**（2026-10-17 / D115）：音频不再是 D11
        // 占位行，扫描期就用 ffprobe 缓存了时长。前端探测退为**兜底**——旧库尚未
        // 升级、或 `ffprobe_bin` 缺失时那一段为空，仍可用元素读一次。
        value: formatDurationMs(mediaFacts?.durationMs ?? probed.durationMs),
      });
    }
    if (isAudio) {
      // 音频专属两行：采样率与声道数（ffprobe 给得出，DOM 拿不到）。
      out.push({ label: app.t("metadata.codec"), value: mediaFacts?.codec ?? "—" });
      out.push({
        label: app.t("metadata.sampleRate"),
        value: formatSampleRate(mediaFacts?.sampleRate),
      });
    }
    if (isVideo) {
      // 这三项 DOM 拿不到：只有 ffprobe 缓存能给，缺就如实 `—`。
      out.push({ label: app.t("metadata.codec"), value: mediaFacts?.codec ?? "—" });
      out.push({ label: app.t("metadata.bitrate"), value: formatBitRate(mediaFacts?.bitRate) });
      out.push({
        label: app.t("metadata.frameRate"),
        value: formatFrameRate(mediaFacts?.frameRate),
      });
    }
    out.push({ label: app.t("metadata.verifyStatus"), value: meta.verify_status });
    out.push({
      label: app.t("metadata.contentHash"),
      value: meta.content_hash ?? "—",
      mono: true,
    });
    return out;
  }, [meta, app, sizeUnit, dateFormat, dateShowTime, probed, mediaFacts, exifFacts]);

  const exifRows = useMemo(
    () => buildExifRows(app.t, exifFacts, dateFormat, dateShowTime),
    [app, exifFacts, dateFormat, dateShowTime],
  );
  const mediaRows = useMemo(() => buildMediaRows(app.t, mediaFacts), [app, mediaFacts]);

  const isImage = meta?.media_type === "image";
  const hasMediaInfo = meta?.media_type === "video" || meta?.media_type === "audio";
  // 切文件时重置两个 <details> 的折叠态（上一个文件展开的底账不该跟到下一个文件）。
  const fileKey = meta ? `${meta.source_id}:${meta.id}` : "none";

  return (
    <div className="panel metadata-panel">
      {!meta && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {meta && (
        <>
          <MetaRows rows={rows} />
          {isImage && (
            <MetaDetailSection
              key={`exif:${fileKey}`}
              title={app.t("metadata.exif")}
              rows={exifRows}
              rawJson={meta.exif_json}
              t={app.t}
            />
          )}
          {hasMediaInfo && (
            <MetaDetailSection
              key={`media:${fileKey}`}
              title={app.t("metadata.mediaInfo")}
              rows={mediaRows}
              rawJson={meta.media_info_json}
              t={app.t}
            />
          )}
        </>
      )}
    </div>
  );
}