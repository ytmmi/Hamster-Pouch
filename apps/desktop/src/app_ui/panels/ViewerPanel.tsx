/**
 * 查看器面板（`panel.viewer`）— 大图 / 视频 / 音频 / **"书"（txt / md / epub / pdf）**预览。
 *
 * 面板设置（「全部设置 → 面板 → 查看器」，声明在 `packages/config/src/panels.ts`）：
 * - `infoBarEnabled`：**顶部基础信息栏**（`relative_path` + 媒体类型 · 体积）是否显示；
 *   缺省显示 = 与既有观感一致（零行为变化），关掉即只留预览舞台。
 *
 * 设置的读取与热加载走 `shared/settingValue.ts`（四条独立触发源），本文件只消费结果。
 *
 * ## 音频（2026-10-17 / D115）
 *
 * 音频舞台上除了 `<audio controls>`，还叠一条**后端生成的波形图**
 * （`shared/AudioWaveform`）：单看一根进度条看不出"哪里有声、哪里有留白"，
 * 波形把整段的起伏摊开——这本来就是"看一眼就知道这是什么音频"的信息。
 *
 * **点波形即定位**：点击 / 拖动波形把播放位置跳到该处（换算在纯函数
 * `shared/waveformView.ts`，与游标同一份映射，两者不会漂移）。
 * 时长与位置都取自 `<audio>` 元素本身（`loadedmetadata` / `timeupdate`）：
 * 索引里的 `media_info_json` 也有时长，但元素读数**永远与正在播的这份文件一致**
 * （换源 / 转码 / 索引未升级时都不会错位）。
 *
 * ## "书"：正文阅读区（2026-10-09；PDF 于 2026-10-11）
 *
 * `txt` / `md` / `epub` / `pdf` 不再落到"空舞台 + 占位提示"，而是交给
 * `panels/viewer/ViewerReader`：显示书的**开头内容**、范围为**面板大小**、
 * 滚动看更多时**按需取下一页**。
 * - 文本类（`txt` / `md` / `epub`）：epub 按面板宽度**纯自动**单栏 / 双栏
 *   （用户口径"默认为单栏"，且不做设置项）；
 * - **PDF**：后端把每一页**栅格化**成整页位图（`hp-pdf`），阅读区逐页纵向堆叠、
 *   **恒单栏**（整页位图不该被断成两栏）——用户口径："逐页栅格化为图片，滚动看后续页"。
 *
 * 分文件（单文件 ≤ 1200 行）：`viewer/ViewerReader.tsx` 阅读区装配、
 * `viewer/BookBlocks.tsx` EPUB / Markdown / **PDF** 块渲染（**不注入 HTML**）、
 * `viewer/useViewerBookContent.ts` 分页取数、`viewer/viewerReaderView.ts` 纯逻辑。
 */

import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { AudioWaveform } from "../shared/AudioWaveform";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { needsPreview, resolvePreviewUrl } from "../shared/previewUrl";
import { usePanelSwitch } from "../shared/settingValue";
import { ViewerReader } from "./viewer/ViewerReader";

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；设置落库键 `panel.viewer.<key>`）。 */
const VIEWER_PANEL_ID = "viewer";

/**
 * 是否走**正文阅读区**：`txt` / `md` / `epub` / **`pdf`** 走阅读器，
 * 其余走既有的图像 / 视频 / 音频舞台。
 *
 * 判据用**媒体类型**而不是按扩展名：媒体类型由扫描期的扩展名表给出
 * （`hp-scanner` 的 `ext_to_media_type`），**只有一处**口径；在面板里再列一遍扩展名
 * 就是第二份口径，迟早与扫描器漂移（`md` / `markdown` 这类就很容易漏）。
 *
 * PDF 与文本类**合在一条判据里**：对查看器而言两者的行为一致（都要 `book.content`
 * 分页取正文、都不取 `file.path`），差别只在阅读区内部怎么渲染（`format` 决定）。
 */
function isBookMedia(file: { media_type: string } | null): boolean {
  return file?.media_type === "text" || file?.media_type === "pdf";
}

export interface ViewerPanelProps {
  /**
   * dockview 面板 API（可选）。
   *
   * 用途只有一个：面板从后台标签回到前台时补读一次设置——用户在后台标签期间改了设置，
   * 切回来必须已经生效。独立单面板窗口（`SinglePanelHost`）传的是恒激活替身，同样可用。
   */
  api?: PanelRenderCtx["api"];
}

export function ViewerPanel({ api: panelApi }: ViewerPanelProps = {}): JSX.Element {
  const app = useApp();
  const showInfoBar = usePanelSwitch(VIEWER_PANEL_ID, "infoBarEnabled", { api: panelApi });
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * 音频的时长与当前位置（ms）——**取自 `<audio>` 元素本身**，而不是索引里的元数据。
   *
   * 判据是"永远与正在播的这份文件一致"：索引里的 `media_info_json` 可能缺失
   * （旧库未升级）、可能与换源后的文件不符。元素读数没有这两种风险。
   */
  const [audioMeta, setAudioMeta] = useState<{ durationMs: number | null; positionMs: number }>({
    durationMs: null,
    positionMs: 0,
  });
  const audioRef = useRef<HTMLAudioElement>(null);

  const file = app.selectedFile;
  /**
   * "书"走**正文阅读区**，不取 `file.path` / 预览 URL：
   * 正文由 `book.content` 提供，阅读区自己按游标分页（见 `ViewerReader`）。
   */
  const bookMode = isBookMedia(file);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    // 换文件即重置音频读数：不然切到下一首时波形游标还停在上一首的位置。
    setAudioMeta({ durationMs: null, positionMs: 0 });
    const selected = app.selectedFile;
    // "书"没有"取图"这一步：直接跳过（否则会白发一次 file.path / preview.get）。
    if (!app.repoId || !selected || isBookMedia(selected)) return;
    void (async () => {
      try {
        // Chromium 可解的格式（AVIF/JPEG/PNG/WebP…）加载原图（全分辨率）；
        // 其余图片走后端**全分辨率预览**（`preview.get`，缺陷 0019；2026-10-11 起
        // 判据是白名单取反，见 `shared/previewUrl.ts`）。
        //
        // **必须限定图片**：`needsPreview` 的口径是"Chromium 画不了这张图"，
        // 对视频/音频没有意义——`preview.get` 对非图片一律返回 `null`，
        // 拿它去判视频会把"能播的视频"变成"不可用"。
        const path =
          selected.media_type === "image" && needsPreview(selected.relative_path)
            ? await api.previewGet({ repoId: app.repoId!, fileId: selected.id })
            : await api.filePath({ repoId: app.repoId!, fileId: selected.id });
        if (!cancelled) {
          if (path) {
            setUrl(convertFileSrc(path));
          } else {
            setFailed(true);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          app.status(app.t("viewer.previewFailed", { err: errorTextOf(app.t, e) }), "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, app.repoId, app.selectedFile]);

  return (
    <div className="panel viewer-panel">
      {!file && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {file && (
        <>
          {/* 基础信息栏：由面板设置 `infoBarEnabled` 控制（缺省显示）。 */}
          {showInfoBar && (
            <div className="viewer-info">
              <span>{file.relative_path}</span>
              <span className="dim">
                {file.media_type} · {file.size} bytes
              </span>
            </div>
          )}
          {/* "书"：正文阅读区（txt / md / epub / pdf），按面板大小显示开头、滚动按需取下一页。 */}
          {bookMode ? (
            <ViewerReader />
          ) : (
            <div className="viewer-stage">
              {failed && <span className="placeholder">{app.t("viewer.unavailable")}</span>}
              {!failed && url && file.media_type === "image" && (
                <img
                  src={url}
                  alt={file.relative_path}
                  onError={() => {
                    // 原图加载失败：若当前不是预览，回退到有界预览**一次**
                    //（Chromium 意外不支持的格式，缺陷 0019）；预览也失败 → 不可用。
                    if (url && !needsPreview(file.relative_path)) {
                      setUrl(null);
                      void resolvePreviewUrl(app.repoId ?? "", file.id).then((previewUrl) => {
                        if (previewUrl) setUrl(previewUrl);
                        else setFailed(true);
                      });
                    } else {
                      setFailed(true);
                    }
                  }}
                />
              )}
              {!failed && url && file.media_type === "video" && (
                <video src={url} controls preload="metadata" />
              )}
              {!failed && url && file.media_type === "audio" && (
                /* 音频舞台：`<audio controls>` + **后端波形图**（2026-10-17 / D115）。
                   波形在进度条上方铺开整段起伏，点 / 拖即定位（`onSeek` 把它换算成秒）。
                   时长与位置都读元素本身，因此游标永远与正在播的这份文件一致。 */
                <div className="viewer-audio">
                  <AudioWaveform
                    repoId={app.repoId ?? ""}
                    fileId={file.id}
                    durationMs={audioMeta.durationMs}
                    positionMs={audioMeta.positionMs}
                    onSeek={(seconds) => {
                      const audio = audioRef.current;
                      if (audio) audio.currentTime = seconds;
                    }}
                    className="viewer-audio-wave"
                    t={app.t}
                  />
                  <audio
                    ref={audioRef}
                    src={url}
                    controls
                    onLoadedMetadata={(e) => {
                      const seconds = e.currentTarget.duration;
                      setAudioMeta((prev) => ({
                        ...prev,
                        durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
                      }));
                    }}
                    onTimeUpdate={(e) => {
                      const seconds = e.currentTarget.currentTime;
                      setAudioMeta((prev) => ({
                        ...prev,
                        positionMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
                      }));
                    }}
                  />
                </div>
              )}
              {!failed && !url && (
                <span className="placeholder">{app.t("common.loading")}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
