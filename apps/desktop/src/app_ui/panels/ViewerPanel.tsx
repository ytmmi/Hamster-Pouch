/**
 * 查看器面板（`panel.viewer`）— 大图 / 视频 / 音频 / **文本类（txt / md / epub）**预览。
 *
 * 面板设置（「全部设置 → 面板 → 查看器」，声明在 `packages/config/src/panels.ts`）：
 * - `infoBarEnabled`：**顶部基础信息栏**（`relative_path` + 媒体类型 · 体积）是否显示；
 *   缺省显示 = 与既有观感一致（零行为变化），关掉即只留预览舞台。
 *
 * 设置的读取与热加载走 `shared/settingValue.ts`（四条独立触发源），本文件只消费结果。
 *
 * ## 文本类：正文阅读区（2026-10-09）
 *
 * `txt` / `md` / `epub` 不再落到"空舞台 + 占位提示"，而是交给 `panels/viewer/ViewerReader`：
 * 显示书的**开头内容**、范围为**面板大小**、滚动看更多时**按需取下一页**。
 * epub 按面板宽度**纯自动**单栏 / 双栏（用户口径"默认为单栏"，且不做设置项）。
 *
 * 分文件（单文件 ≤ 1200 行）：`viewer/ViewerReader.tsx` 阅读区装配、
 * `viewer/BookBlocks.tsx` EPUB 块渲染（**不注入 HTML**）、
 * `viewer/useViewerBookContent.ts` 分页取数、`viewer/viewerReaderView.ts` 纯逻辑。
 */

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { needsPreview, resolvePreviewUrl } from "../shared/previewUrl";
import { usePanelSwitch } from "../shared/settingValue";
import { ViewerReader } from "./viewer/ViewerReader";

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；设置落库键 `panel.viewer.<key>`）。 */
const VIEWER_PANEL_ID = "viewer";

/**
 * 是否走**正文阅读区**：文本类文件（`txt` / `md` / `epub`）走阅读器，
 * 其余走既有的图像 / 视频 / 音频舞台。
 *
 * 判据用 `media_type === "text"` 而不是按扩展名：媒体类型由扫描期的扩展名表给出
 * （`hp-scanner` 的 `ext_to_media_type`），**只有一处**口径；在面板里再列一遍扩展名
 * 就是第二份口径，迟早与扫描器漂移（`md` / `markdown` 这类就很容易漏）。
 */
function isTextMedia(file: { media_type: string } | null): boolean {
  return file?.media_type === "text";
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

  const file = app.selectedFile;
  /**
   * 文本类走**正文阅读区**，不取 `file.path` / 预览 URL：
   * 正文由 `book.content` 提供，阅读区自己按游标分页（见 `ViewerReader`）。
   */
  const textMode = isTextMedia(file);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    const selected = app.selectedFile;
    // 文本类没有"取图"这一步：直接跳过（否则会白发一次 file.path / preview.get）。
    if (!app.repoId || !selected || isTextMedia(selected)) return;
    void (async () => {
      try {
        // Chromium 可解的格式（AVIF/JPEG/PNG/WebP…）加载原图（全分辨率）；
        // HEIC/HEIF 走后端**有界预览**（`preview.get`，缺陷 0019）。
        const path = needsPreview(selected.relative_path)
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
          {/* 文本类：正文阅读区（txt / md / epub），按面板大小显示开头、滚动按需取下一页。 */}
          {textMode ? (
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
                <audio src={url} controls />
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
