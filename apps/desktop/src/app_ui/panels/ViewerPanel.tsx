/**
 * 查看器面板（`panel.viewer`）— 大图 / 视频 / 音频预览（选中文件）。
 *
 * 面板设置（「全部设置 → 面板 → 查看器」，声明在 `packages/config/src/panels.ts`）：
 * - `infoBarEnabled`：**顶部基础信息栏**（`relative_path` + 媒体类型 · 体积）是否显示；
 *   缺省显示 = 与既有观感一致（零行为变化），关掉即只留预览舞台。
 *
 * 设置的读取与热加载走 `shared/panelSetting.ts`（四条独立触发源），本文件只消费结果。
 */

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { usePanelSwitch } from "../shared/panelSetting";

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；设置落库键 `panel.viewer.<key>`）。 */
const VIEWER_PANEL_ID = "viewer";

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

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    const file = app.selectedFile;
    if (!app.repoId || !file) return;
    void (async () => {
      try {
        const path = await api.filePath({ repoId: app.repoId!, fileId: file.id });
        if (!cancelled) setUrl(convertFileSrc(path));
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

  const file = app.selectedFile;

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
          <div className="viewer-stage">
            {failed && <span className="placeholder">{app.t("viewer.unavailable")}</span>}
            {!failed && url && file.media_type === "image" && (
              <img src={url} alt={file.relative_path} />
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
        </>
      )}
    </div>
  );
}
