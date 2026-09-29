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
 * | `ui.dateShowTime` | 日期后是否再显示 ` HH:MM:SS`（缺省关） |
 *
 * **按类型自适应显示**（每项各占一行；**取不到值就显示 `—`，不静默消失**——否则"索引里没数据"
 * 与"面板坏了"看起来一模一样）：
 *
 * | 类型 | 显示 | 数据来源 |
 * | --- | --- | --- |
 * | 图像 | 尺寸 | 前端解码取真实像素（EXIF 的 `PixelXDimension` 对 PNG 等为 null，仅作兜底） |
 * | 视频 | 尺寸 / 时长 / 编码 / 码率 / 帧率 | 优先 `media_info_json`（ffprobe 原始 JSON）；索引里没有缓存时用前端 `<video>` 探测**兜底尺寸与时长**（编码 / 码率 / 帧率 DOM 拿不到，如实显示 `—`） |
 * | 音频 | 时长 | 索引里**没有**音频元数据（D11 占位行），只能前端 `preload="metadata"` 读一次 |
 *
 * 两坨原始 JSON（EXIF / 媒体信息）照旧原样展示：派生行是"看得懂的摘要"，原始 JSON 是
 * 不丢信息的底账。
 */

import { Fragment, useEffect, useMemo, useState } from "react";
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
import {
  formatBitRate,
  formatByteSize,
  formatDateValue,
  formatDurationMs,
  formatFrameRate,
  formatPixelSize,
} from "../shared/format";
import { useHostSettingValue } from "../shared/settingValue";
import type { FileMetadataResult } from "../shared/types";
import { parseExifSummary, parseMediaInfo } from "./metadataInfo";

function pretty(json: string | null): string {
  if (!json) return "—";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** 表格里的一行（标签 + 值）。 */
interface MetaRow {
  label: string;
  value: string;
  /** 等宽（哈希这类定长十六进制串）。 */
  mono?: boolean;
}

/** 前端探测到的补充事实（索引里没有的那些）。 */
interface ProbedFacts {
  /** 图像解码 / 视频容器的真实像素（EXIF 常缺、视频可能没有 ffprobe 缓存）。 */
  width: number | null;
  height: number | null;
  /** 视频 / 音频时长（音频是 D11 占位行，索引里没有；视频可能没探过）。 */
  durationMs: number | null;
}

const NO_FACTS: ProbedFacts = { width: null, height: null, durationMs: null };

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
    if (isVideo || isAudio) {
      out.push({
        label: app.t("metadata.duration"),
        value: formatDurationMs(
          isAudio ? probed.durationMs : (mediaFacts?.durationMs ?? probed.durationMs),
        ),
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

  return (
    <div className="panel">
      {!meta && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {meta && (
        <>
          <div className="kv">
            {rows.map((row) => (
              <Fragment key={row.label}>
                <span>{row.label}</span>
                <span className={row.mono ? "mono" : undefined}>{row.value}</span>
              </Fragment>
            ))}
          </div>
          <div className="section-title">{app.t("metadata.exif")}</div>
          <pre className="json-block">{pretty(meta.exif_json)}</pre>
          <div className="section-title">{app.t("metadata.mediaInfo")}</div>
          <pre className="json-block">{pretty(meta.media_info_json)}</pre>
        </>
      )}
    </div>
  );
}
